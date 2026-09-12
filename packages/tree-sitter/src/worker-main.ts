/**
 * The indexing worker's entry point: run one walk+resolve pass over the `workerData` input and post
 * the structured-clone outcome — or one serialized failure — back to the parent (`worker.ts`, which
 * owns the pass logic in {@link runWorkerPass}).
 *
 * Loaded two ways: as the compiled `lib/worker-main.js` in production, and as `src/worker-main.ts`
 * under vitest (Node ≥22.19 strips types natively in the child). That is why this file must stay
 * erasable-only TypeScript — no enums, namespaces, or parameter properties — and why its import of
 * `worker.ts` names types explicitly where it imports them as types.
 * @module @huanlin/dsh-plugin-codegraph-tree-sitter/worker-main
 */

import { parentPort, workerData } from 'node:worker_threads'
import { runWorkerPass } from './worker.ts'
import type { WorkerIndexInput } from './worker.ts'

if (parentPort === null) {
  throw new Error('codegraph-tree-sitter: worker-main must run inside a worker_threads Worker')
}
// A local const: the guard's narrowing above does not reach into the closure below otherwise.
const port = parentPort

void runWorkerPass(workerData as WorkerIndexInput).then(message => port.postMessage(message))
