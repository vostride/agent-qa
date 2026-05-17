import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  ApiError,
  createHook,
  deleteHook,
  deleteTestObservation,
  fetchAuthStates,
  fetchHookCatalog,
  fetchHookDetail,
  fetchMemoryCatalog,
  fetchMemoryProductDetail,
  fetchMemoryScope,
  fetchRun,
  fetchRunArtifact,
  fetchRuns,
  fetchStats,
  fetchTestObservations,
  runHook,
  saveLiveAuthState,
  type HookRunRequest,
  type HookMutationRequest,
  updateHook,
} from '../lib/api.js'

const mockFetch = vi.fn()

beforeEach(() => {
  mockFetch.mockReset()
  vi.stubGlobal('fetch', mockFetch)
})

afterEach(() => {
  vi.restoreAllMocks()
})

function ok(data: unknown) {
  return Promise.resolve({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: () => Promise.resolve(data),
  })
}

function err(status: number, text: string) {
  return Promise.resolve({
    ok: false,
    status,
    statusText: text,
    json: () => Promise.resolve({}),
  })
}

function errJson(status: number, text: string, data: unknown) {
  return Promise.resolve({
    ok: false,
    status,
    statusText: text,
    json: () => Promise.resolve(data),
  })
}

describe('fetchRuns', () => {
  it('fetches /api/runs with no params', async () => {
    const data = { runs: [], total: 0 }
    mockFetch.mockReturnValue(ok(data))
    const result = await fetchRuns()
    expect(mockFetch).toHaveBeenCalledWith('/api/runs')
    expect(result).toEqual(data)
  })

  it('builds query string from filter options', async () => {
    mockFetch.mockReturnValue(ok({ runs: [], total: 0 }))
    await fetchRuns({ status: 'failed', name: 'login', limit: 10, offset: 5 })
    const url = mockFetch.mock.calls[0][0] as string
    expect(url).toContain('status=failed')
    expect(url).toContain('name=login')
    expect(url).toContain('limit=10')
    expect(url).toContain('offset=5')
  })

  it('throws on non-ok response', async () => {
    mockFetch.mockReturnValue(err(500, 'Internal Server Error'))
    await expect(fetchRuns()).rejects.toThrow('API error 500: Internal Server Error')
  })
})

describe('auth state API', () => {
  const metadata = {
    version: 1,
    kind: 'web' as const,
    target: 'staging-web',
    name: 'admin',
    capturedAt: '2026-05-17T10:00:00.000Z',
  }

  it('fetches safe auth-state metadata', async () => {
    mockFetch.mockReturnValue(ok({
      authStates: [{
        ...metadata,
        storageStatePath: '.agent-qa/auth-states/staging-web/admin/storage-state.json',
        payloadPath: '.agent-qa/auth-states/staging-web/admin/metadata.json',
        payload: { cookies: [{ name: 'sid', value: 'secret-session' }] },
        cookieCount: 1,
        localStorage: 'unsafe-storage-value',
        indexedDB: 'unsafe-indexed-db',
        capturedFrom: 'live-mode',
        createdAt: '2026-05-17T09:00:00.000Z',
        updatedAt: '2026-05-17T10:01:00.000Z',
        ttl: '7d',
        expiry: '2026-05-24T10:00:00.000Z',
      }],
    }))

    const result = await fetchAuthStates()

    expect(mockFetch).toHaveBeenCalledWith('/api/auth-states')
    expect(result).toEqual({ authStates: [metadata] })
    expect(Object.keys(result.authStates[0])).toEqual(['version', 'kind', 'target', 'name', 'capturedAt'])
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('.agent-qa/auth-states')
    expect(serialized).not.toContain('.json')
    expect(serialized).not.toContain('payload')
    expect(serialized).not.toContain('cookie')
    expect(serialized).not.toContain('cookieCount')
    expect(serialized).not.toContain('localStorage')
    expect(serialized).not.toContain('indexedDB')
    expect(serialized).not.toContain('capturedFrom')
    expect(serialized).not.toContain('createdAt')
    expect(serialized).not.toContain('updatedAt')
    expect(serialized).not.toContain('ttl')
    expect(serialized).not.toContain('expiry')
  })

  it('fetches auth-state metadata for a target', async () => {
    mockFetch.mockReturnValue(ok({ authStates: [metadata] }))

    await fetchAuthStates({ target: 'staging-web' })

    expect(mockFetch).toHaveBeenCalledWith('/api/auth-states?target=staging-web')
  })

  it('saves live auth state through the active session route', async () => {
    mockFetch.mockReturnValue(ok({ authState: metadata }))

    const result = await saveLiveAuthState('session-1', { name: 'admin', replace: true })

    expect(mockFetch).toHaveBeenCalledWith('/api/live-editor/sessions/session-1/auth-state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'admin', replace: true }),
    })
    expect(result).toEqual({ authState: metadata })
    expect(Object.keys(result.authState)).toEqual(['version', 'kind', 'target', 'name', 'capturedAt'])
  })
})

describe('fetchRun', () => {
  it('fetches /api/runs/:id', async () => {
    const data = { run: { id: 'abc' }, steps: [] }
    mockFetch.mockReturnValue(ok(data))
    const result = await fetchRun('abc')
    expect(mockFetch).toHaveBeenCalledWith('/api/runs/abc')
    expect(result).toEqual(data)
  })

  it('encodes special characters in id', async () => {
    mockFetch.mockReturnValue(ok({ run: {}, steps: [] }))
    await fetchRun('a/b c')
    expect(mockFetch).toHaveBeenCalledWith('/api/runs/a%2Fb%20c')
  })
})

describe('fetchRunArtifact', () => {
  it('fetches /api/runs/:id/artifact', async () => {
    const data = {
      run: { id: 'r_example' },
      artifact: {
        runId: 'r_example',
        kind: 'test',
        schemaVersion: 1,
        payload: { schemaVersion: 1, config: {}, source: {}, memory: {} },
        finalizedAt: '2026-05-01T10:00:00.000Z',
        createdAt: '2026-05-01T09:59:00.000Z',
        updatedAt: '2026-05-01T10:00:00.000Z',
      },
      children: [],
      missingSections: [],
    }
    mockFetch.mockReturnValue(ok(data))

    const result = await fetchRunArtifact('r_example')

    expect(mockFetch).toHaveBeenCalledWith('/api/runs/r_example/artifact')
    expect(result).toEqual(data)
  })

  it('encodes special characters in id', async () => {
    mockFetch.mockReturnValue(ok({ run: { id: 'a/b c' }, artifact: null, children: [], missingSections: ['artifact'] }))

    await fetchRunArtifact('a/b c')

    expect(mockFetch).toHaveBeenCalledWith('/api/runs/a%2Fb%20c/artifact')
  })
})

describe('fetchStats', () => {
  it('fetches /api/stats with no params', async () => {
    const data = { totalRuns: 5, passed: 3, failed: 2, flakeRate: 0.1, avgDuration: 1000, runs: [] }
    mockFetch.mockReturnValue(ok(data))
    const result = await fetchStats()
    expect(mockFetch).toHaveBeenCalledWith('/api/stats')
    expect(result).toEqual(data)
  })

  it('passes date range params', async () => {
    mockFetch.mockReturnValue(ok({ totalRuns: 0, passed: 0, failed: 0, flakeRate: 0, avgDuration: 0, runs: [] }))
    await fetchStats({ from: '2026-01-01', to: '2026-03-01' })
    const url = mockFetch.mock.calls[0][0] as string
    expect(url).toContain('from=2026-01-01')
    expect(url).toContain('to=2026-03-01')
  })
})

describe('fetchHookCatalog', () => {
  it('fetches /api/hooks', async () => {
    const data = {
      hooks: [
        { id: 'h_amber-birch-coral-delta-ember-falcon-garden-harbor-island-jungle', name: 'login', runtime: 'node', file: './scripts/login.js', timeout: 30000, network: true, fileMissing: false },
        { id: 'h_aster-bloom-cloud-drift-ember-field-glade-hollow-ivory-jasper', name: 'cleanup', runtime: 'bash', file: './scripts/cleanup.sh', timeout: 15000, network: true, fileMissing: true },
      ],
      filePath: './hooks.yaml',
      errors: [],
      missing: false,
    }
    mockFetch.mockReturnValue(ok(data))
    const result = await fetchHookCatalog()
    expect(mockFetch).toHaveBeenCalledWith('/api/hooks')
    expect(result).toEqual(data)
  })
})

describe('fetchHookDetail', () => {
  it('fetches /api/hooks/:id', async () => {
    const data = {
      hook: {
        id: 'h_alpha',
        name: 'login',
        runtime: 'bun',
        file: './hooks/login.ts',
        timeout: 30000,
        network: true,
        fileMissing: false,
      },
      source: 'export default async function hook() {}\n',
      fieldErrors: [],
    }

    mockFetch.mockReturnValue(ok(data))
    const result = await fetchHookDetail('h_alpha')

    expect(mockFetch).toHaveBeenCalledWith('/api/hooks/h_alpha')
    expect(result).toEqual(data)
  })
})

describe('createHook', () => {
  it('posts a hook mutation payload to /api/hooks', async () => {
    const payload: HookMutationRequest = {
      hook: {
        name: 'login',
        runtime: 'node',
        file: './hooks/login.js',
        timeout: '30s',
        network: true,
      },
      source: 'module.exports = async function hook() {}\n',
    }
    const data = {
      hook: {
        id: 'h_alpha',
        name: 'login',
        runtime: 'node',
        file: './hooks/login.js',
        timeout: 30000,
        network: true,
        fileMissing: false,
      },
      source: payload.source,
      fieldErrors: [],
    }

    mockFetch.mockReturnValue(ok(data))
    const result = await createHook(payload)

    expect(mockFetch).toHaveBeenCalledWith('/api/hooks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    expect(result).toEqual(data)
  })
})

describe('updateHook', () => {
  it('puts a hook mutation payload to /api/hooks/:id', async () => {
    const payload: HookMutationRequest = {
      hook: {
        id: 'h_alpha',
        name: 'login',
        runtime: 'bun',
        file: './hooks/login.ts',
        timeout: '45s',
        network: false,
      },
      source: 'export default async function hook() {}\n',
    }
    const data = {
      hook: {
        id: 'h_alpha',
        name: 'login',
        runtime: 'bun',
        file: './hooks/login.ts',
        timeout: 45000,
        network: false,
        fileMissing: false,
      },
      source: payload.source,
      fieldErrors: [],
    }

    mockFetch.mockReturnValue(ok(data))
    const result = await updateHook('h_alpha', payload)

    expect(mockFetch).toHaveBeenCalledWith('/api/hooks/h_alpha', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    expect(result).toEqual(data)
  })
})

describe('deleteHook', () => {
  it('deletes /api/hooks/:id', async () => {
    const data = { deleted: true, references: [] }
    mockFetch.mockReturnValue(ok(data))

    const result = await deleteHook('h_alpha')

    expect(mockFetch).toHaveBeenCalledWith('/api/hooks/h_alpha', {
      method: 'DELETE',
    })
    expect(result).toEqual(data)
  })

  it('passes ?force=true when requested', async () => {
    mockFetch.mockReturnValue(ok({ deleted: true, references: [] }))

    await deleteHook('h_alpha', { force: true })

    expect(mockFetch).toHaveBeenCalledWith('/api/hooks/h_alpha?force=true', {
      method: 'DELETE',
    })
  })

  it('preserves structured blocked-delete references in ApiError payload', async () => {
    mockFetch.mockReturnValue(
      errJson(409, 'Conflict', {
        error: 'hook_in_use',
        references: [
          {
            kind: 'test',
            label: 'Login flow',
            path: 'tests/auth/login.yaml',
            context: 'setup',
          },
        ],
      }),
    )

    await expect(deleteHook('h_alpha')).rejects.toMatchObject({
      status: 409,
      payload: {
        error: 'hook_in_use',
        references: [
          {
            kind: 'test',
            label: 'Login flow',
            path: 'tests/auth/login.yaml',
            context: 'setup',
          },
        ],
      },
    })
  })
})

describe('runHook', () => {
  it('posts standalone hook-run payloads to /api/hooks/:id/run', async () => {
    const payload: HookRunRequest = {
      overrides: [
        { key: 'FOO', value: 'bar' },
        { key: 'SHARED', value: 'override' },
      ],
    }
    const data = {
      success: true,
      status: 'passed',
      executedAt: '2026-04-22T10:00:00.000Z',
      duration: 42,
      output: 'ok',
      stdout: 'ok',
      stderr: '',
      error: null,
      variables: { TOKEN: 'abc' },
      sandbox: {
        runtime: 'bun',
        image: 'vostride/agent-qa-hook-runner-bun',
        networkMode: 'disabled',
        dockerVersion: null,
        networkLogsAvailable: false,
        networkLogs: [],
      },
    }

    mockFetch.mockReturnValue(ok(data))
    const result = await runHook('h_alpha', payload)

    expect(mockFetch).toHaveBeenCalledWith('/api/hooks/h_alpha/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    expect(result).toEqual(data)
  })

  it('preserves structured hook-run errors in ApiError payload', async () => {
    mockFetch.mockReturnValue(
      errJson(409, 'Conflict', {
        error: 'hook_not_runnable',
        fieldErrors: [
          {
            field: 'file',
            code: 'file_missing',
            message: 'Hook file missing',
          },
        ],
      }),
    )

    await expect(runHook('h_alpha', { overrides: [] })).rejects.toMatchObject({
      status: 409,
      payload: {
        error: 'hook_not_runnable',
        fieldErrors: [
          {
            field: 'file',
            code: 'file_missing',
            message: 'Hook file missing',
          },
        ],
      },
    })
  })
})

describe('memory api helpers', () => {
  it('fetches the product-first memory catalog', async () => {
    const data = {
      products: [
        {
          productKey: 'alpha-product',
          observationCount: 3,
          scopeCounts: { product: 1, suite: 1, test: 1 },
          freshness: '2026-04-22T08:00:00.000Z',
          sourceCoverage: 2,
          targetReferences: ['alpha-android', 'alpha-target'],
          sourceCounts: { suite: 1, test: 2 },
        },
      ],
    }

    mockFetch.mockReturnValue(ok(data))
    const result = await fetchMemoryCatalog()

    expect(mockFetch).toHaveBeenCalledWith('/api/memory/catalog')
    expect(result).toEqual(data)
  })

  it('fetches a canonical product detail payload', async () => {
    const data = {
      product: {
        productKey: 'alpha-product',
        observationCount: 3,
        scopeCounts: { product: 1, suite: 1, test: 1 },
        freshness: '2026-04-22T08:00:00.000Z',
        sourceCoverage: 2,
        observations: [
          {
            id: 'obs_product',
            title: 'Account entry point: sign-in stays in the top-right header',
            content: 'Users can sign in from the top-right account entry point.',
            trust: 0.82,
            created: '2026-04-18T08:00:00.000Z',
            last_confirmed: '2026-04-20T08:00:00.000Z',
            updated: '2026-04-20T09:15:00.000Z',
            confirmed_count: 2,
            contradicted_count: 0,
            source_test: 't_alpha',
            scope: 'product',
            scopeId: 'alpha-product',
            scopeRef: null,
            sourceTestRef: {
              kind: 'source_test',
              id: 't_alpha',
              label: 'Alpha login',
              targetName: 'alpha-target',
              href: '/test/t_alpha',
            },
          },
          {
            id: 'obs_suite',
            title: 'Smoke suite: authenticated landing flow is reused across runs',
            content: 'The alpha smoke suite reuses the authenticated landing flow.',
            trust: 0.76,
            created: '2026-04-19T08:00:00.000Z',
            last_confirmed: '2026-04-21T08:00:00.000Z',
            updated: '2026-04-21T09:15:00.000Z',
            confirmed_count: 3,
            contradicted_count: 0,
            source_test: 't_gamma',
            scope: 'suite',
            scopeId: 's_alpha',
            scopeRef: {
              kind: 'suite',
              id: 's_alpha',
              label: 'Alpha smoke',
              targetName: 'alpha-target',
              href: '/suite/s_alpha',
            },
            sourceTestRef: {
              kind: 'source_test',
              id: 't_gamma',
              label: 'Alpha smoke seed',
              targetName: 'alpha-target',
              href: '/test/t_gamma',
            },
          },
          {
            id: 'obs_test',
            title: 'Valid credentials: dashboard shell opens after submit',
            content: 'Submitting valid credentials lands on the dashboard shell.',
            trust: 0.91,
            created: '2026-04-20T08:00:00.000Z',
            last_confirmed: '2026-04-22T08:00:00.000Z',
            updated: '2026-04-22T09:15:00.000Z',
            confirmed_count: 4,
            contradicted_count: 0,
            source_test: 't_alpha',
            scope: 'test',
            scopeId: 't_alpha',
            scopeRef: {
              kind: 'test',
              id: 't_alpha',
              label: 'Alpha login',
              targetName: 'alpha-target',
              href: '/test/t_alpha',
            },
            sourceTestRef: {
              kind: 'source_test',
              id: 't_alpha',
              label: 'Alpha login',
              targetName: 'alpha-target',
              href: '/test/t_alpha',
            },
          },
        ],
        scopes: {
          product: {
            scope: 'product',
            observationCount: 1,
            freshness: '2026-04-20T08:00:00.000Z',
            sourceCoverage: 1,
            scopeIds: ['alpha-product'],
          },
          suite: {
            scope: 'suite',
            observationCount: 1,
            freshness: '2026-04-21T08:00:00.000Z',
            sourceCoverage: 1,
            scopeIds: ['s_alpha'],
          },
          test: {
            scope: 'test',
            observationCount: 1,
            freshness: '2026-04-22T08:00:00.000Z',
            sourceCoverage: 1,
            scopeIds: ['t_alpha'],
          },
        },
        invalidFiles: [
          {
            scope: 'test',
            scopeId: 't_alpha',
            filename: 'obs_legacy.md',
            code: 'parse_error',
            message: 'Invalid observation frontmatter: title is required.',
          },
        ],
      },
    }

    mockFetch.mockReturnValue(ok(data))
    const result = await fetchMemoryProductDetail('alpha/product')

    expect(mockFetch).toHaveBeenCalledWith('/api/memory/products/alpha%2Fproduct')
    expect(result).toEqual(data)
  })

  it('fetches shared memory scope reads and preserves legacy test-memory helpers', async () => {
    const scopeData = {
      scope: 'test',
      scopeId: 't_alpha',
      observations: [
        {
          id: 'obs_alpha',
          title: 'Valid credentials: dashboard shell opens after submit',
          content: 'Memory',
          trust: 0.7,
          created: '2026-04-20T08:00:00.000Z',
          last_confirmed: '2026-04-22T08:00:00.000Z',
          confirmed_count: 1,
          contradicted_count: 0,
          source_test: 't_alpha',
          updated: '2026-04-22T09:15:00.000Z',
          scopeRef: {
            kind: 'test',
            id: 't_alpha',
            label: 'Alpha login',
            targetName: 'alpha-target',
            href: '/test/t_alpha',
          },
          sourceTestRef: {
            kind: 'source_test',
            id: 't_alpha',
            label: 'Alpha login',
            targetName: 'alpha-target',
            href: '/test/t_alpha',
          },
        },
      ],
      invalidFiles: [
        {
          scope: 'test',
          scopeId: 't_alpha',
          filename: 'obs_legacy.md',
          code: 'parse_error',
          message: 'Invalid observation frontmatter: title is required.',
        },
      ],
    }
    const legacyData = { observations: scopeData.observations, invalidFiles: scopeData.invalidFiles }

    mockFetch
      .mockReturnValueOnce(ok(scopeData))
      .mockReturnValueOnce(ok(legacyData))
      .mockReturnValueOnce(ok({ deleted: true }))

    await expect(fetchMemoryScope('test', 't alpha')).resolves.toEqual(scopeData)
    await expect(fetchTestObservations('t alpha')).resolves.toEqual(legacyData)
    await expect(deleteTestObservation('t alpha', 'obs alpha')).resolves.toEqual({ deleted: true })

    expect(mockFetch.mock.calls[0][0]).toBe('/api/memory/scopes/test/t%20alpha')
    expect(mockFetch.mock.calls[1][0]).toBe('/api/memory/observations/t%20alpha')
    expect(mockFetch.mock.calls[2][0]).toBe('/api/memory/observations/t%20alpha/obs%20alpha')
  })
})
