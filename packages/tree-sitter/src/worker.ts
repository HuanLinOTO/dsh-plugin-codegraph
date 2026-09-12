/**
 * Crash isolation for one indexing pass. The walk+resolve phases run inside a fresh
 * `worker_threads` Worker — plain structured-clone data in, plain structured-clone data out — so a
 * tree-sitter WASM abort (a poisoned grammar, an unknown assertion, heap exhaustion) wastes only
 * that pass: the parent process's shared Emscripten runtime (see `grammar.ts`) is never the one that
 * crashed, and the single retry runs on a brand-new WASM heap. Two consecutive crashes fail the run
 * as the raw crash, which `runIndex` wraps in `CODEGRAPH_INDEXER_CRASHED`.
 *
 * The worker receives no `AbortSignal` — one cannot cross `postMessage` — matching the phases as
 * they already were (no per-file cancellation inside a phase); the parent instead terminates the
 * worker when its own signal fires, and re-checks the signal between phases exactly as before.
 * A runtime where workers cannot be constructed at all falls back to running the pass in-process,
 * which is the pre-worker behavior — including its crash-wrapping contract.
 * @module @huanlin/dsh-plugin-codegraph-tree-sitter/worker
 */

import { Worker } from 'node:worker_threads'
import { isWasmRuntimeCrash } from './grammar.ts'
import { resolveWorkspace } from './resolve.ts'
import type { ExtractedFile, ResolvedGraph } from './resolve.ts'
import { walkAndExtract } from './walk.ts'
import type { WalkConfig } from './walk.ts'

/** What one indexing pass needs to run inside the worker. */
export interface WorkerIndexInput {
  readonly projectRoot: string
  readonly config: WalkConfig
}

/** What one indexing pass produced. Plain data only — every field must survive `postMessage`. */
export interface WorkerIndexOutput {
  readonly files: ExtractedFile[]
  readonly filesSkipped: number
  readonly graph: ResolvedGraph
  readonly indexedAt: number
}

/**
 * A worker-side failure serialized through `postMessage` — an `Error` does not survive the clone,
 * so only its name and message cross (the stack stays behind; the crash's shape, which is what
 * routing needs, is what arrives).
 */
export interface WorkerErrorPayload {
  readonly name: string
  readonly message: string
}

/** What the worker posts back: either the pass's outcome or one serialized failure. */
export type WorkerResultMessage = WorkerIndexOutput | { workerError: WorkerErrorPayload }

/** One disposable indexing worker. */
export interface IndexWorker {
  /** Run one walk+resolve pass. Rejects on any failure, however the worker died. */
  run(input: WorkerIndexInput): Promise<WorkerIndexOutput>
  /** Halt the worker immediately (caller abort or cleanup). Safe to call at any time, repeatedly. */
  stop(): void
}

/**
 * Builds one {@link IndexWorker}. Injectable so tests can script failures — crash, retry, success —
 * without spawning threads. The production factory is {@link nodeIndexWorkerFactory}.
 */
export type WorkerFactory = () => IndexWorker

/** How many attempts one pass gets in worker mode: the initial run plus one retry on a fresh heap. */
const WORKER_ATTEMPTS = 2

/**
 * The worker entry next to this module: the compiled `worker-main.js` sibling once this package is
 * built (lib/), or the `worker-main.ts` sibling when this module itself is running from src/ under
 * vitest — Node ≥22.19 (this package's engines floor) strips types natively, so the child can load
 * the source directly. That is also why `worker-main.ts` must stay erasable-only TypeScript.
 * @param selfUrl - this module's own `import.meta.url`.
 */
export function workerEntryUrl(selfUrl: string): URL {
  return new URL(selfUrl.endsWith('.ts') ? './worker-main.ts' : './worker-main.js', selfUrl)
}

/**
 * The promise side of one worker run: resolve on the outcome message, reject on a serialized
 * failure, on the worker's `error` event (a script that never loaded, an uncaught worker crash), or
 * on an `exit` before any result arrived — killed mid-parse, the OOM case this isolation exists for.
 * A settled promise silently ignores later resolve/reject calls, so an `exit` after the result
 * arrived (the normal shutdown) needs no settled bookkeeping here.
 */
export function awaitWorkerResult(worker: Worker): Promise<WorkerIndexOutput> {
  return new Promise<WorkerIndexOutput>((resolve, reject) => {
    worker.on('message', (message: WorkerResultMessage) => {
      if ('workerError' in message) reject(rewrapWorkerError(message.workerError))
      else resolve(message)
    })
    worker.on('error', (error: Error) => reject(error))
    worker.on('exit', (code: number) => reject(workerExitError(code)))
  })
}

/**
 * The production factory: one `worker_threads` Worker per {@link IndexWorker.run}.
 */
export const nodeIndexWorkerFactory: WorkerFactory = () => {
  let worker: Worker | undefined
  return {
    run(input) {
      const w = new Worker(workerEntryUrl(import.meta.url), { workerData: input })
      worker = w
      return awaitWorkerResult(w).finally(() => {
        // A completed worker exits on its own; terminating it here only reaps a lingering one.
        void w.terminate()
      })
    },
    stop() {
      void worker?.terminate()
    },
  }
}

/** The rejection used when a worker dies before posting anything — the crash-shaped case. */
function workerExitError(code: number): Error {
  return new Error(`codegraph index worker exited before returning a result (exit code ${code})`)
}

/** Rebuild a plain `Error` from the payload the worker serialized. */
function rewrapWorkerError(payload: WorkerErrorPayload): Error {
  const error = new Error(payload.message)
  error.name = payload.name
  return error
}

/**
 * One pass as the worker runs it: walk, resolve, and package the message back to the parent —
 * the outcome on success, a serialized `{ workerError }` on any failure (an `Error` does not
 * survive `postMessage`; its name and message do). Exported so `worker-main.ts` stays a thin
 * glue file and this logic stays testable in the parent's module graph.
 */
export async function runWorkerPass(input: WorkerIndexInput): Promise<WorkerResultMessage> {
  try {
    const { files, filesSkipped } = await walkAndExtract(input.projectRoot, input.config)
    const indexedAt = Date.now()
    const graph = resolveWorkspace(files, indexedAt)
    return { files, filesSkipped, graph, indexedAt }
  } catch (error) {
    return {
      workerError: {
        name: error instanceof Error ? error.name : 'Error',
        message: error instanceof Error ? error.message : String(error),
      },
    }
  }
}

/**
 * Run one indexing pass in-process: the worker path's fallback and the `indexInWorker: false` path.
 * The signal is checked between the walk and the resolve phases, exactly as `runIndex` always has.
 */
export async function runIndexingInProcess(projectRoot: string, config: WalkConfig, signal?: AbortSignal): Promise<WorkerIndexOutput> {
  const { files, filesSkipped } = await walkAndExtract(projectRoot, config, signal)
  signal?.throwIfAborted()
  const indexedAt = Date.now()
  const graph = resolveWorkspace(files, indexedAt)
  return { files, filesSkipped, graph, indexedAt }
}

/**
 * Run one indexing pass in a fresh worker, retrying a crash once on a new worker (a new WASM heap).
 *
 * Non-crash failures — a filesystem error the worker serialized back, a worker script that never
 * loaded — are rethrown as-is without consuming the retry: a fresh heap cannot fix them, and the
 * caller deserves the original error, not a "crashed" label. An abort that lands mid-run rethrows
 * the signal's own reason: a cancellation is not a crash. Only two consecutive WASM crashes
 * (`isWasmRuntimeCrash`) exhaust the budget and rethrow the second one, which `runIndex` wraps.
 * @param projectRoot - absolute path of the workspace to index.
 * @param config - the walk's bounds.
 * @param signal - the caller's signal; fires the worker's termination, checked at phase boundaries.
 * @param factory - builds the pass's worker; injectable for tests.
 */
export async function runIndexingPass(
  projectRoot: string,
  config: WalkConfig,
  signal: AbortSignal | undefined,
  factory: WorkerFactory = nodeIndexWorkerFactory,
): Promise<WorkerIndexOutput> {
  let worker: IndexWorker
  try {
    worker = factory()
  } catch {
    // Workers cannot even be constructed in this runtime; the pass still runs, in-process.
    return runIndexingInProcess(projectRoot, config, signal)
  }
  let lastCrash: unknown
  for (let attempt = 0; attempt < WORKER_ATTEMPTS; attempt++) {
    try {
      return await runOnce(worker, { projectRoot, config }, signal)
    } catch (error) {
      // An abort that landed while the pass was running is the caller's cancellation, not a crash:
      // surface the signal's own reason rather than counting it against the retry budget.
      signal?.throwIfAborted()
      if (!isWasmRuntimeCrash(error)) throw error
      lastCrash = error
    }
  }
  throw lastCrash
}

/** Run one worker attempt, terminating the worker when the caller's signal fires or the pass ends. */
async function runOnce(worker: IndexWorker, input: WorkerIndexInput, signal?: AbortSignal): Promise<WorkerIndexOutput> {
  const onAbort = (): void => worker.stop()
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    return await worker.run(input)
  } finally {
    signal?.removeEventListener('abort', onAbort)
    worker.stop()
  }
}
