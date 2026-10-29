// A run id may hold a slash or a space; unencoded, it would address a route nobody registered.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunDetailProjection } from '@vostride/agent-qa-schema'

import { fetchRunDetail } from '@/lib/api'

/** The op's answer for a one-member run: enough shape that a mistyped field would not compile. */
const PROJECTION: RunDetailProjection = {
  runId: 'r 1/x',
  members: [{ testIndex: 0, name: 'checkout', attempts: 1 }],
  steps: [],
  subActions: [],
  tokens: { measuredSteps: 0, unmeasuredSteps: 0 },
}

let urls: string[]
let originalFetch: typeof fetch

beforeEach(() => {
  urls = []
  originalFetch = globalThis.fetch
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    urls.push(String(input))
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => PROJECTION,
    } as unknown as Response
  }) as unknown as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.clearAllMocks()
})

describe('fetchRunDetail', () => {
  it('asks /api/runs/<encoded id>/detail, encoding the id exactly once', async () => {
    await fetchRunDetail('r 1/x')

    expect(urls).toHaveLength(1)
    expect(urls[0]).toBe('/api/runs/r%201%2Fx/detail')
  })

  it('resolves to the op result verbatim, typed as RunDetailProjection', async () => {
    const projection = await fetchRunDetail('r 1/x')

    expect(projection).toEqual(PROJECTION)
    // Read through the schema type: a UI twin that drifted from the op would not compile here.
    expect(projection.tokens.measuredSteps).toBe(0)
    expect(projection.members[0]?.testIndex).toBe(0)
  })
})
