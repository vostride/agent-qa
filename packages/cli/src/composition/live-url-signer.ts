// The signing key is per process: a dashboard restart invalidates every outstanding `liveUrl`.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

import type { LiveUrlSigner } from '@vostride/agent-qa-schema'

// `equals` checks length first, because `timingSafeEqual` throws on unequal-length buffers.
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
