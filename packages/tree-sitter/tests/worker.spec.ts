import { describe, expect, it, vi } from 'vitest'
import { Worker } from 'node:worker_threads'
import { Context } from '@deepseek-ai/cordis'
import Codegraph, { CodegraphError } from '@huanlin/dsh-plugin-codegraph-service'
import * as CodegraphTreeSitter from '../src/index.ts'
import { DEFAULT_INDEXER_ID, type ResolvedConfig } from '../src/index.ts'
import {
  awaitWorkerResult,
  nodeIndexWorkerFactory,
  runIndexingInProcess,
  runIndexingPass,
  workerEntryUrl,
  type WorkerFactory,
  type WorkerIndexOutput,
} from '../src/worker.ts'
import { writeProject } from './fixture.ts'

// The in-process pass goes through the real walk for every test below except the abort-between-
// phases one, which sets this stub to abort its controller mid-pass; the mock wrapper delegates to
// the real implementation whenever the stub is clear. (The real-worker tests below are unaffected:
// a worker thread loads the source from disk itself, outside this module graph.)
const walkStub = vi.hoisted(() => ({ onWalk: undefined as ((signal?: AbortSignal) => void) | undefined }))

vi.mock('../src/walk.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/walk.ts')>()
  return {
    ...actual,
    async walkAndExtract(...args: Parameters<typeof actual.walkAndExtract>) {
      walkStub.onWalk?.(args[2])
      if (walkStub.onWalk !== undefined) return { files: [], filesSkipped: 0 }
      return actual.walkAndExtract(...args)
    },
  }
})

function config(overrides?: Partial<ResolvedConfig>): ResolvedConfig {
  return {
    indexerId: DEFAULT_INDEXER_ID,
    languages: ['typescript'],
    exclude: ['node_modules', '.git', '.codegraph'],
    respectGitignore: true,
    maxFileBytes: 2_000_000,
    maxFiles: 50_000,
    concurrency: 2,
    watch: false,
    watchDebounceMs: 100,
    maxWatchedDirectories: 100,
    indexInWorker: true,
    ...overrides,
  }
}

function emptyOutput(): WorkerIndexOutput {
  return { files: [], filesSkipped: 0, graph: { nodes: [], edges: [], unresolved: [] }, indexedAt: Date.now() }
}

/** A worker factory whose runs follow a script, counting calls for the retry-budget assertions. */
function scriptedWorker(run: (attempt: number) => Promise<WorkerIndexOutput>): {
  factory: WorkerFactory
  state: { runs: number; stops: number }
} {
  const state = { runs: 0, stops: 0 }
  const factory: WorkerFactory = () => ({
    run: (_input) => {
      state.runs++
      return run(state.runs)
    },
    stop: () => {
      state.stops++
    },
  })
  return { factory, state }
}

const ABORT_MESSAGE = 'Aborted(). Build with -sASSERTIONS for more info.'

describe('workerEntryUrl', () => {
  it('names the compiled .js sibling for a module running from lib', () => {
    expect(workerEntryUrl('file:///pkg/lib/worker.js').href).toBe('file:///pkg/lib/worker-main.js')
  })

  it('names the .ts sibling for a module running from src, which Node strips types for natively', () => {
    expect(workerEntryUrl('file:///pkg/src/worker.ts').href).toBe('file:///pkg/src/worker-main.ts')
  })
})

describe('nodeIndexWorkerFactory', () => {
  it('stop() before any run is a no-op, not a crash', () => {
    expect(() => nodeIndexWorkerFactory().stop()).not.toThrow()
  })
})

describe('runIndexingPass', () => {
  it('retries one crash on a fresh worker and succeeds', async () => {
    const root = await writeProject({})
    const { factory, state } = scriptedWorker(async attempt => {
      if (attempt === 1) throw new Error(ABORT_MESSAGE)
      return emptyOutput()
    })
    const outcome = await runIndexingPass(root, config(), undefined, factory)
    expect(outcome.files).toEqual([])
    expect(state.runs).toBe(2)
  })

  it('gives up as a crash after two consecutive WASM aborts, preserving the second as the cause', async () => {
    const root = await writeProject({})
    const { factory, state } = scriptedWorker(async () => {
      throw new Error(ABORT_MESSAGE)
    })
    const error = await runIndexingPass(root, config(), undefined, factory).then(
      () => { throw new Error('expected a rejection') },
      (rejection: unknown) => rejection,
    )
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe(ABORT_MESSAGE)
    expect(state.runs).toBe(2)
  })

  it('rethrows a non-crash worker failure as-is, without spending the retry', async () => {
    const root = await writeProject({})
    const { factory, state } = scriptedWorker(async () => {
      throw new Error('ENOENT: no such file or directory, scandir')
    })
    await expect(runIndexingPass(root, config(), undefined, factory)).rejects.toThrow(/ENOENT/)
    expect(state.runs).toBe(1)
  })

  it('rejects with the signal reason when the caller aborts mid-run, and stops the worker', async () => {
    const root = await writeProject({})
    const controller = new AbortController()
    const state = { runs: 0, stops: 0 }
    let hang: ((error: unknown) => void) | undefined
    const factory: WorkerFactory = () => ({
      run: () => {
        state.runs++
        return new Promise<WorkerIndexOutput>((_resolve, reject) => { hang = reject })
      },
      stop: () => {
        state.stops++
        hang?.(new Error('worker terminated'))
      },
    })
    // worker.run is invoked synchronously inside runIndexingPass, so hang is set by the time the
    // abort fires; the termination rejection the stop produced is then superseded by the signal's
    // own reason — a cancellation, not a crash, so no retry is spent on it.
    const pending = runIndexingPass(root, config(), controller.signal, factory)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(state.stops).toBeGreaterThanOrEqual(1)
  })

  it('falls back to running the pass in-process when workers cannot be constructed at all', async () => {
    const root = await writeProject({ 'a.ts': 'export function a() {}\n' })
    const factory: WorkerFactory = () => {
      throw new Error('workers unavailable in this runtime')
    }
    const outcome = await runIndexingPass(root, config(), undefined, factory)
    expect(outcome.files.map(file => file.path)).toEqual(['a.ts'])
    expect(outcome.graph.nodes.length).toBeGreaterThan(0)
  })

  it('rechecks the signal between the walk and resolve phases of the in-process pass', async () => {
    const root = await writeProject({})
    const controller = new AbortController()
    walkStub.onWalk = () => controller.abort()
    try {
      await expect(runIndexingInProcess(root, config(), controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    } finally {
      walkStub.onWalk = undefined
    }
  })
})

describe('runIndex', () => {
  it('aborts before starting when the signal is already aborted', async () => {
    const root = await writeProject({ 'a.ts': 'export function a() {}\n' })
    const controller = new AbortController()
    controller.abort()
    await expect(CodegraphTreeSitter.runIndex(root, config(), controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('rejects with the signal reason when the pass succeeds but the caller aborted meanwhile', async () => {
    const root = await writeProject({})
    const controller = new AbortController()
    const { factory } = scriptedWorker(async () => {
      controller.abort()
      return emptyOutput()
    })
    await expect(CodegraphTreeSitter.runIndex(root, config(), controller.signal, factory)).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('wraps a twice-crashed worker run in CODEGRAPH_INDEXER_CRASHED with restart guidance', async () => {
    const root = await writeProject({})
    const { factory, state } = scriptedWorker(async () => {
      throw new WebAssembly.RuntimeError(ABORT_MESSAGE)
    })
    const error = await CodegraphTreeSitter.runIndex(root, config(), undefined, factory).then(
      () => { throw new Error('expected a rejection') },
      (rejection: unknown) => rejection,
    )
    expect(error).toBeInstanceOf(CodegraphError)
    expect((error as CodegraphError).code).toBe('CODEGRAPH_INDEXER_CRASHED')
    expect((error as Error).message).toContain('restarted')
    expect((error as { cause?: unknown }).cause).toBeInstanceOf(Error)
    expect(state.runs).toBe(2)
  })
})

describe('real worker threads', () => {
  it('indexes a real workspace end to end through a live worker', async () => {
    const root = await writeProject({
      'a.ts': "import { b } from './b'\nexport function a() { return b() }\n",
      'b.ts': 'export function b() { return 1 }\n',
    })
    const ctx = new Context()
    await ctx.plugin(Codegraph)
    await ctx.plugin(CodegraphTreeSitter, { watch: false, indexInWorker: true })
    try {
      const report = await ctx.codegraph.index(root)
      expect(report).toMatchObject({ filesIndexed: 2, filesSkipped: 0, nodeCount: expect.any(Number) })
      expect(report.nodeCount).toBeGreaterThan(0)
      expect(report.languages).toEqual([{ language: 'typescript', fileCount: 2 }])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('serializes a worker-side filesystem error back through the structured message', async () => {
    const missing = 'D:/does/not/exist/codegraph-worker-probe'
    const error = await runIndexingPass(missing, config()).then(
      () => { throw new Error('expected a rejection') },
      (rejection: unknown) => rejection,
    )
    // The worker walked a root that does not exist, serialized the ENOENT back, and the parent
    // rethrew it as-is: a filesystem failure, not a crash, so no retry was spent on it.
    expect((error as Error).message).toContain('ENOENT')
  })

  it('rejects with a synthesized error when a worker is killed before returning a result', async () => {
    const root = await writeProject({ 'a.ts': 'export function a() {}\n' })
    // The entry URL is derived from worker.ts's own location (src/), not this spec file's (tests/).
    const entry = workerEntryUrl(new URL('../src/worker.ts', import.meta.url).href)
    const worker = new Worker(entry, {
      workerData: { projectRoot: root, config: config() },
    })
    const pending = awaitWorkerResult(worker)
    await worker.terminate()
    await expect(pending).rejects.toThrow(/exited before returning a result/)
  })

  it('rejects through the error event when the worker script never loads', async () => {
    const worker = new Worker(new URL('file:///D:/definitely/not/a/worker-main.js'), {
      workerData: { projectRoot: 'irrelevant', config: config() },
    })
    await expect(awaitWorkerResult(worker)).rejects.toThrow()
  })
})

/** The guard only runs when worker-main is evaluated outside a worker — which is exactly what this
 * test does, proving the entry fails loud rather than hanging as a module with no parent port. */
describe('worker-main entry', () => {
  it('refuses to run outside a worker_threads Worker', async () => {
    await expect(import('../src/worker-main.ts')).rejects.toThrow(/worker_threads/)
  })
})
