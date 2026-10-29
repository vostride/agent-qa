// Separate from `worker-registration.ts` because the reader closure must not reach `lease/`.
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

// A reused pid can belong to a stranger, so `mismatch` and `unverifiable` are never signalled.
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
