/**
 * The indexing worker's entry point: run one walk+resolve pass over the `workerData` input and post
 * the structured-clone outcome — or one serialized failure — back to the parent (`worker.ts`).
 *
 * Loaded two ways: as the compiled `lib/worker-main.js` in production, and as `src/worker-main.ts`
 * under vitest (Node ≥22.19 strips types natively in the child). That is why this file must stay
 * erasable-only TypeScript — no enums, namespaces, or parameter properties — and why its imports
 * stay type-only where they name `worker.ts`'s types.
 * @module @huanlin/dsh-plugin-codegraph-tree-sitter/worker-main
 */

import { parentPort, workerData } from 'node:worker_threads'
import { walkAndExtract } from './walk.ts'
import { resolveWorkspace } from './resolve.ts'
import type { WorkerIndexInput, WorkerResultMessage } from './worker.ts'

if (parentPort === null) {
  throw new Error('codegraph-tree-sitter: worker-main must run inside a worker_threads Worker')
}
// A local const: the guard's narrowing above does not reach into the closures below.
const port = parentPort

const input = workerData as WorkerIndexInput

void walkAndExtract(input.projectRoot, input.config)
  .then(({ files, filesSkipped }) => {
    const indexedAt = Date.now()
    const graph = resolveWorkspace(files, indexedAt)
    const message: WorkerResultMessage = { files, filesSkipped, graph, indexedAt }
    port.postMessage(message)
  })
  .catch((error: unknown) => {
    const message: WorkerResultMessage = {
      workerError: {
        name: error instanceof Error ? error.name : 'Error',
        message: error instanceof Error ? error.message : String(error),
      },
    }
    port.postMessage(message)
  })
