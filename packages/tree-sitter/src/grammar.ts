/**
 * Lazy, process-cached grammar loading. `Parser.init()` boots one Emscripten runtime shared by every
 * grammar; each `Language` loads from its `tree-sitter-wasms` binary only the first time a matching
 * file is seen.
 *
 * Loading is lazy and per-language for a concrete reason: the reference implementation this package
 * targets loads its full grammar set eagerly and must run its bundled Node with `--liftoff-only` to
 * survive V8 running out of WASM code space. This harness cannot pass that flag to the Node process
 * that runs it, so it must never load a grammar the workspace does not use.
 * @module @huanlin/dsh-plugin-codegraph-tree-sitter/grammar
 */

import { createRequire } from 'node:module'
import { Language, Parser } from 'web-tree-sitter'
import type { LanguageSpec } from './languages.ts'

const require = createRequire(import.meta.url)

let initialized: Promise<void> | undefined

/** Boot the shared Emscripten runtime exactly once per process. */
function ensureInitialized(): Promise<void> {
  initialized ??= Parser.init()
  return initialized
}

const loaded = new Map<string, Promise<Language>>()

/**
 * The parsed grammar for one language, loading and caching it on first use.
 * @param spec - the language's extraction table entry, naming its wasm file.
 * @returns the loaded grammar, shared by every caller for the process lifetime.
 */
export async function loadGrammar(spec: LanguageSpec): Promise<Language> {
  let pending = loaded.get(spec.language)
  if (pending === undefined) {
    pending = (async () => {
      await ensureInitialized()
      const wasmPath = require.resolve(`tree-sitter-wasms/out/${spec.wasmFile}`)
      return Language.load(wasmPath)
    })()
    loaded.set(spec.language, pending)
  }
  return pending
}

/**
 * A parser configured for one language, built fresh per call because `Parser` carries mutable parse
 * state a concurrent caller must not share.
 * @param spec - the language's extraction table entry.
 * @returns a parser ready to parse source in this language.
 */
export async function createParser(spec: LanguageSpec): Promise<Parser> {
  const language = await loadGrammar(spec)
  const parser = new Parser()
  parser.setLanguage(language)
  return parser
}

/**
 * Whether a thrown value is web-tree-sitter's terminal WASM abort. When the shared Emscripten heap
 * is exhausted or a grammar assertion trips, the C side calls `abort()`, which surfaces here as a
 * `WebAssembly.RuntimeError` — or a plain `Error` whose message is `Aborted(). Build with
 * -sASSERTIONS for more info.` — and the module singleton behind `Parser.init()` (`if (!Module3) …`,
 * never rebuilt) is poisoned for the rest of the process: every later parse in this process fails
 * the same way. Callers route on this to fail the run as a diagnosable `CODEGRAPH_INDEXER_CRASHED`
 * instead of surfacing the bare abort, and to tell the caller what actually recovers it — restarting
 * the harness process — rather than a retry, which cannot help in-process.
 * @param error - the caught value.
 */
export function isWasmRuntimeCrash(error: unknown): boolean {
  if (error instanceof WebAssembly.RuntimeError) return true
  return error instanceof Error && /\bAborted\(\)/.test(error.message)
}
