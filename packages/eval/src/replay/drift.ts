import { sha256hex } from '@vostride/agent-qa-schema'
import type { CassetteInputLeg } from '../cassette/input-leg'
import { canonicalizeInputLeg } from '../extract/receipt'

/**
 * D-02 receipt-drift result. `drift` is a stamped, reported signal — it is NEVER a gate on
 * replay. It is computed over the canonical input LEG (`canonicalizeInputLeg` + `sha256hex`),
 * never over assembled prompt bytes: the volatile prompt tier embeds the current date, so
 * byte-hashing the assembled prompt would report 100% drift (RESEARCH Pitfall 9). The recorded
 * hash is treated purely as opaque data — producer and consumer share ONE hash implementation.
 */
export interface ReplayDrift {
  drift: boolean
  harnessDrift: boolean
  recordedHash: string
  recomputedHash: string
}

/**
 * Recompute the canonical input-leg hash and compare it against the recorded receipt hash.
 * Returns both hashes stamped alongside the boolean so the divergence is always reportable;
 * the caller never gates replay on the result.
 */
export function computeReplayDrift(
  leg: CassetteInputLeg,
  recordedHash: string,
): ReplayDrift {
  const recomputedHash = sha256hex(canonicalizeInputLeg(leg))
  const drift = recomputedHash !== recordedHash
  return {
    drift,
    harnessDrift: drift,
    recordedHash,
    recomputedHash,
  }
}
