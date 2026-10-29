import { afterEach, describe, expect, it, vi } from 'vitest'
import * as api from '../api'
import { ApiError, markRun } from '../api'

afterEach(() => { vi.unstubAllGlobals() })
describe('mark API scope and outcomes', () => {
  // RE-SPELLED 2026-10-01: was 'sends only the existing scope %s and the supplied mark
  // address'. The page holds no scope any more, so the claim that survives is the second half: one
  // request carrying exactly the supplied mark address and nothing else.
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
  // RE-SPELLED 432-09 from 'retains typed denial and canonical remedies on the real helper':
  // the denial is a plain reason, and the typed error carries nothing a reader must act on.
  // RE-SPELLED 2026-10-02 under the same title: no server produces the gate-era
  // `mark_denied` 403, so the helper keeps no typed denial at all. A legacy body of that shape is an
  // ordinary request failure, carrying neither a typed reason nor remedies. RE-TITLED 2026-10-03
  // (quick-261003-tsr, IN-30): was 'retains the typed denial as a plain reason on the real helper,
  // and carries no remedies'.
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
