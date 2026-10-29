/**
 * The embedder worker's half of the one process-identity vocabulary in this package.
 *
 * This is a separate module from `worker-registration.ts` on purpose. Registration reading and
 * socket probing are reachable from the read-only serving entry, and `reader-import-closure`
 * forbids that closure from crossing into `lease/`. The *signal decision* is a writer-side concern
 * that the reader never makes, so it lives here — which lets both kill paths in this package share
 * CR-04's single `resolveProcessIncarnation` definition instead of growing a second, subtly
 * different identity scheme.
 */
import { incarnationFormat, resolveProcessIncarnation } from '../lease/writer-lease.js'

import {
  EMBEDDER_WORKER_UNVERIFIABLE_INCARNATION,
  type EmbedderWorkerIncarnationVerdict,
  type EmbedderWorkerRegistration,
} from './worker-registration.js'

export { resolveProcessIncarnation }

/**
 * The token a worker records about ITSELF at registration time.
 *
 * The worker is the only party that can attribute the registration without a race: it is the
 * process being described, and it is alive while describing itself. A worker that cannot resolve
 * its own start time records the sentinel rather than fabricating a value, accepting that it will
 * later be replaced without a signal instead of terminated.
 */
export function ownEmbedderWorkerIncarnation(): string {
  return resolveProcessIncarnation(process.pid) ?? EMBEDDER_WORKER_UNVERIFIABLE_INCARNATION
}

/**
 * Compare the registration's recorded incarnation against the pid's CURRENT occupant.
 *
 * a schema-valid registration naming a live pid whose socket has stopped answering is not
 * proof that the worker is still there. Once the worker died, the kernel is free to hand its pid to
 * a stranger, and every decision keyed on that number alone targets whoever holds it now. The one
 * fact that separates them is assigned by the OS and cannot be forged from inside the file: when
 * the process at that pid started.
 *
 * `mismatch` means the registered worker is provably gone; `unverifiable` means we cannot say, and
 * that is a refusal rather than a default-allow. Neither may be signalled — and neither needs to
 * be, because generation-specific sockets (Plan 24) let a fresh worker take a clean address without
 * the old pid ever being touched.
 */
export function verifyEmbedderWorkerIncarnation(
  registration: EmbedderWorkerRegistration,
): EmbedderWorkerIncarnationVerdict {
  if (registration.incarnation === EMBEDDER_WORKER_UNVERIFIABLE_INCARNATION) {
    return 'unverifiable'
  }
  const occupant = resolveProcessIncarnation(registration.pid)
  if (occupant === undefined) return 'unverifiable'
  if (incarnationFormat(occupant) !== incarnationFormat(registration.incarnation)) {
    return 'unverifiable'
  }
  return occupant === registration.incarnation ? 'match' : 'mismatch'
}
