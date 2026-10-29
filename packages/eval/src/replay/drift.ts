import { sha256hex } from '@vostride/agent-qa-schema'
import type { CassetteInputLeg } from '../cassette/input-leg'
import { canonicalizeInputLeg } from '../extract/receipt'

// Computed over the canonical input leg, because the assembled prompt embeds the current date.
export interface ReplayDrift {
  drift: boolean
  harnessDrift: boolean
  recordedHash: string
  recomputedHash: string
}

// Both hashes are stamped beside the boolean; the caller never gates replay on the result.
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
