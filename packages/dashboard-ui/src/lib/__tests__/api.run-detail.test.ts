// THE PAGE'S DURABLE READ.
//
// `fetchRunDetail` is the ONE door the rebuilt run-detail page reads its projection from, and the
// only thing this file has to say about it is that it asks the right URL and hands back what the
// op returned. Both halves matter for a reason the type system cannot state:
//
// THE URL IS ENCODED ONCE, BY US. A run id is opaque and may legitimately carry a slash or a
// space (the `r 1/x` fixture below is not hypothetical — suite-scoped ids have carried both), and
// an unencoded id would silently address a DIFFERENT path with more segments than the route
// registered. `/api/runs/:id/detail` is registered ABOVE the `/api/runs/:id` catch-all precisely
// because that catch-all claims every four-segment GET (405-01, RESEARCH Pitfall 2), so an id
// that smuggles a slash past `encodeURIComponent` would land somewhere nobody routed.
//
// THE RESULT IS THE OP'S OWN TYPE, NOT A UI TWIN. `RunDetailProjection` is imported from
// `@vostride/agent-qa-schema`; the UI mirrors the op's output rather than re-declaring it, so a
// field the op grows is a field the page can read without a second edit, and a field the op drops
// is a compile error here rather than an `undefined` in a text node.

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
