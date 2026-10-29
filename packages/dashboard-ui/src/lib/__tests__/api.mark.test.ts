import { afterEach, describe, expect, it, vi } from 'vitest'
import * as api from '../api'
import { ApiError, markRun } from '../api'

afterEach(() => { vi.unstubAllGlobals() })
describe('mark API scope and outcomes', () => {
  it('sends only the supplied mark address, in one request', async () => {
    const outcome = { kind: 'run-not-found', runId: 'opaque/id' }
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(outcome)))
    vi.stubGlobal('fetch', fetchMock)
    expect(await markRun('opaque/id', { kind: 'confirmed-bug', testId: 'member', stepIndex: 2 })).toEqual(outcome)
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith('/api/runs/opaque%2Fid/mark', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        kind: 'confirmed-bug', testId: 'member', stepIndex: 2,
      }),
    })
  })
  it('carries no typed denial on the real helper: a legacy mark_denied 403 is a plain ApiError with no reason or remedies', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'mark_denied',
      reason: 'The mark could not be recorded here.' }), { status: 403 })))
    const denied = await markRun('run', { kind: 'false-fail' }).catch((error: unknown) => error)
    expect(denied).toBeInstanceOf(ApiError)
    expect(Object.keys(api)).not.toContain('MarkDeniedError')
    expect(denied).not.toHaveProperty('reason')
    expect(denied).not.toHaveProperty('remedies')
  })
})
