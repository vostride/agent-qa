// 373-07: pins the D-04 baseline-probe contract — failure-as-value (never a rejection, the
// prohibition in 373-07-PLAN), raw un-redirected status, fixed abort budget. fetch is stubbed;
// no unit test touches the network.
import { afterEach, describe, expect, it, vi } from 'vitest'

import { runBaselineProbe } from '../commands/baseline-probe.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('runBaselineProbe', () => {
  it('returns the raw status without following redirects', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 503, body: undefined }) as unknown as Response))

    const result = await runBaselineProbe('https://app.example.test')

    expect(result.status).toBe(503)
    expect(result.error).toBeUndefined()
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0)
  })

  it('returns a fetch rejection as a value carrying the error string — never a rejection of its own', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('getaddrinfo ENOTFOUND app.example.test')
      }),
    )

    const result = await runBaselineProbe('https://app.example.test')

    expect(result.status).toBeUndefined()
    expect(result.error).toBe('getaddrinfo ENOTFOUND app.example.test')
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0)
  })

  it('probes with redirect manual and an abort-budget signal', async () => {
    const fetchSpy = vi.fn(async () => ({ status: 200, body: undefined }) as unknown as Response)
    vi.stubGlobal('fetch', fetchSpy)

    await runBaselineProbe('https://app.example.test', 1234)

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://app.example.test')
    expect(init.method).toBe('GET')
    expect(init.redirect).toBe('manual')
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })
})
