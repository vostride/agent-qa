// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ApiError,
  createHook,
  createLiveEditorSession,
  createSuiteFile,
  createTestFile,
  fetchSuiteFiles,
} from '@/lib/api'
import {
  trackDashboardEntityCreated,
  trackDashboardLiveModeStarted,
} from '@/lib/analytics'

vi.mock('@/lib/analytics', () => ({
  trackDashboardEntityCreated: vi.fn(),
  trackDashboardLiveModeStarted: vi.fn(),
}))

let originalFetch: typeof fetch
const trackDashboardEntityCreatedMock = vi.mocked(trackDashboardEntityCreated)
const trackDashboardLiveModeStartedMock = vi.mocked(trackDashboardLiveModeStarted)

beforeEach(() => {
  originalFetch = globalThis.fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

describe('ApiError propagation through postJson', () => {
  it('preserves server JSON body (error, details, missingTests) on 400 responses', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      json: async () => ({
        error: 'Invalid suite content',
        details: [{ message: 'tests.0: Required' }],
        missingTests: [{ index: 0, test: 'tests/web/missing.yaml', id: 't_missing' }],
      }),
    }) as unknown as typeof fetch

    await expect(
      createSuiteFile('my-suite.suite.yaml', 'name: X\n'),
    ).rejects.toSatisfy((err: unknown) => {
      if (!(err instanceof ApiError)) return false
      if (err.status !== 400) return false
      if (err.message !== 'Invalid suite content') return false
      if (!Array.isArray(err.missingTests) || err.missingTests.length !== 1) return false
      if (err.missingTests[0].test !== 'tests/web/missing.yaml') return false
      if (err.missingTests[0].id !== 't_missing') return false
      return true
    })
  })

  it('falls back to statusText when the response body is not valid JSON', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      json: async () => {
        throw new SyntaxError('Unexpected token')
      },
    }) as unknown as typeof fetch

    await expect(
      createSuiteFile('x.suite.yaml', 'name: X\n'),
    ).rejects.toSatisfy((err: unknown) => {
      if (!(err instanceof ApiError)) return false
      if (err.message !== 'API error 500: Internal Server Error') return false
      if (err.payload !== null) return false
      if (err.missingTests !== undefined) return false
      return true
    })
  })

  it('does not copy payload fields when the body is a JSON primitive (defense against non-object payloads)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      json: async () => 'just a string, not an object',
    }) as unknown as typeof fetch

    await expect(
      createSuiteFile('x.suite.yaml', 'name: X\n'),
    ).rejects.toSatisfy((err: unknown) => {
      if (!(err instanceof ApiError)) return false
      if (err.payload !== null) return false
      if (err.missingTests !== undefined) return false
      if (err.message !== 'API error 400: Bad Request') return false
      return true
    })
  })

  it('uses payload.message as fallback when payload.error is absent', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 422,
      statusText: 'Unprocessable Entity',
      json: async () => ({ message: 'Custom validation message' }),
    }) as unknown as typeof fetch

    await expect(
      createSuiteFile('x.suite.yaml', 'name: X\n'),
    ).rejects.toSatisfy((err: unknown) => {
      if (!(err instanceof ApiError)) return false
      if (err.message !== 'Custom validation message') return false
      if (err.status !== 422) return false
      return true
    })
  })

  it('rejects arrays as payload (only non-null objects accepted)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      json: async () => ['not', 'an', 'object'],
    }) as unknown as typeof fetch

    await expect(
      createSuiteFile('x.suite.yaml', 'name: X\n'),
    ).rejects.toSatisfy((err: unknown) => {
      if (!(err instanceof ApiError)) return false
      if (err.payload !== null) return false
      if (err.message !== 'API error 400: Bad Request') return false
      return true
    })
  })

  it('also threads ApiError through GET-style request() (request helper)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      json: async () => ({ error: 'Suite file not found' }),
    }) as unknown as typeof fetch

    await expect(fetchSuiteFiles()).rejects.toSatisfy((err: unknown) => {
      if (!(err instanceof ApiError)) return false
      if (err.status !== 404) return false
      if (err.message !== 'Suite file not found') return false
      return true
    })
  })
})

describe('dashboard analytics instrumentation boundaries', () => {
  it('tracks successful test, suite, and hook creation only after the API call resolves', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({ path: 'tests/new.yaml', created: true }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({ path: 'suites/new.suite.yaml', created: true }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({
          hook: {
            id: 'h_phase244',
            name: 'Phase 244 Hook',
            runtime: 'node',
            file: 'hooks/phase244.js',
            timeout: '30s',
            network: true,
          },
          source: 'export default async function hook() {}',
          fieldErrors: [],
        }),
      }) as unknown as typeof fetch

    await expect(createTestFile('tests/new.yaml', 'name: New Test\n')).resolves.toEqual({
      path: 'tests/new.yaml',
      created: true,
    })
    await expect(createSuiteFile('suites/new.suite.yaml', 'name: New Suite\n')).resolves.toEqual({
      path: 'suites/new.suite.yaml',
      created: true,
    })
    await expect(createHook({
      hook: {
        name: 'Phase 244 Hook',
        runtime: 'node',
        file: 'hooks/phase244.js',
        timeout: '30s',
        network: true,
      },
      source: 'export default async function hook() {}',
    })).resolves.toMatchObject({
      hook: { id: 'h_phase244' },
    })

    expect(trackDashboardEntityCreatedMock).toHaveBeenCalledTimes(3)
    expect(trackDashboardEntityCreatedMock).toHaveBeenNthCalledWith(1, 'test')
    expect(trackDashboardEntityCreatedMock).toHaveBeenNthCalledWith(2, 'suite')
    expect(trackDashboardEntityCreatedMock).toHaveBeenNthCalledWith(3, 'hook')
  })

  it('does not track failed creation attempts', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      json: async () => ({ error: 'Invalid suite content' }),
    }) as unknown as typeof fetch

    await expect(createSuiteFile('bad.suite.yaml', 'bad: true\n')).rejects.toThrow('Invalid suite content')
    expect(trackDashboardEntityCreatedMock).not.toHaveBeenCalled()
  })

  it('tracks successful live mode starts without passing entity identifiers', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ sessionId: 'live_phase244', sessionNumber: 42 }),
    }) as unknown as typeof fetch

    await expect(createLiveEditorSession({
      platform: 'ios',
      entity: { type: 'suite', id: 's_secret' },
    })).resolves.toEqual({
      sessionId: 'live_phase244',
      sessionNumber: 42,
    })

    expect(trackDashboardLiveModeStartedMock).toHaveBeenCalledTimes(1)
    expect(trackDashboardLiveModeStartedMock).toHaveBeenCalledWith({
      platform: 'ios',
      entityType: 'suite',
    })
    expect(trackDashboardLiveModeStartedMock.mock.calls[0][0]).not.toHaveProperty('id')
  })
})
