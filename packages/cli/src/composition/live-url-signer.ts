// The `liveUrl` SIGNER — the only file in the system that holds a live-view signing key.
//
// PER-PROCESS AND EPHEMERAL, BY DESIGN. There is no key file, no config field and no env var: the
// key is 32 random bytes minted at composition and reachable only through this closure. A dashboard
// restart therefore invalidates every outstanding `liveUrl` — which is the correct behaviour, since
// every run those links pointed at died with the process that was running them.
//
// It lives in `packages/cli/src/composition` because `node:crypto` is forbidden in `agent`,
// `schema` and `runner` (all storageNeutral) — the function layer takes the signer as a PORT.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

import type { LiveUrlSigner } from '@vostride/agent-qa-schema'

/**
 * Mint a fresh per-process signer.
 *
 * `equals` checks LENGTH FIRST (Pitfall 9): `timingSafeEqual` throws on unequal-length buffers, so
 * a bare call would turn a malformed signature into a crash on the refusal path — the one path that
 * must stay boring. The length comparison leaks only the digest width, which is a constant.
 */
export function createEphemeralLiveUrlSigner(): LiveUrlSigner {
  const key = randomBytes(32)
  const sign = (data: string): string => createHmac('sha256', key).update(data, 'utf8').digest('base64url')
  return {
    sign,
    equals(a: string, b: string): boolean {
      const left = Buffer.from(a, 'utf8')
      const right = Buffer.from(b, 'utf8')
      if (left.length !== right.length) return false
      return timingSafeEqual(left, right)
    },
  }
}
