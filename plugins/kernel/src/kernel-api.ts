import {
  createVendorApi,
  vendorFailureKind,
  z,
  type VendorStatusKinds,
} from '@vostride/agent-qa-plugin-kit'

type KernelFailureKind = ReturnType<typeof vendorFailureKind>

const KERNEL_STATUS_KINDS: VendorStatusKinds = { 403: 'auth', 529: 'capacity' }

export const KernelBrowserSchema = z.object({
  session_id: z.string().min(1),
  cdp_ws_url: z.string().min(1),
  browser_live_view_url: z.string().min(1).optional(),
})

interface KernelApiInput {
  apiUrl: string
  apiKey: string
}

export type PoolAcquireAnswer = { acquired: true; browser: unknown } | { acquired: false }

export interface KernelApi {
  createBrowser(body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>
  deleteBrowser(id: string, signal?: AbortSignal): Promise<void>
  acquireFromPool(
    pool: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<PoolAcquireAnswer>
  releaseToPool(pool: string, sessionId: string, reuse: boolean, signal?: AbortSignal): Promise<void>
  listBrowsers(limit: number, signal?: AbortSignal): Promise<void>
  orgLimits(signal?: AbortSignal): Promise<unknown>
  getPool(pool: string, signal?: AbortSignal): Promise<boolean>
}

export function kernelFailureKind(status: number | undefined): KernelFailureKind {
  return vendorFailureKind(status, KERNEL_STATUS_KINDS)
}

export function createKernelApi(input: KernelApiInput): KernelApi {
  const api = createVendorApi({
    vendor: 'Kernel',
    baseUrl: input.apiUrl,
    headers: { authorization: `Bearer ${input.apiKey}` },
    kinds: KERNEL_STATUS_KINDS,
  })

  const jsonHeaders = { 'content-type': 'application/json', accept: 'application/json' }
  const poolPath = (pool: string, action = '') =>
    `browser_pools/${encodeURIComponent(pool)}${action === '' ? '' : `/${action}`}`

  return {
    async createBrowser(body, signal) {
      const response = await api.send('POST', 'browsers', {
        headers: jsonHeaders,
        body: JSON.stringify(body),
        signal,
      })
      if (!response.ok) throw await api.failure(response, 'POST /browsers')
      return api.json(response)
    },

    async deleteBrowser(id, signal) {
      const response = await api.send('DELETE', `browsers/${encodeURIComponent(id)}`, { signal })
      if (response.ok || response.status === 404) {
        await response.body?.cancel()
        return
      }
      throw await api.failure(response, 'DELETE /browsers/{id}')
    },

    async acquireFromPool(pool, body, signal) {
      const response = await api.send('POST', poolPath(pool, 'acquire'), {
        headers: jsonHeaders,
        body: JSON.stringify(body),
        signal,
      })
      if (response.status === 204) {
        await response.body?.cancel()
        return { acquired: false }
      }
      if (!response.ok) throw await api.failure(response, 'POST /browser_pools/{pool}/acquire')
      return { acquired: true, browser: await api.json(response) }
    },

    async releaseToPool(pool, sessionId, reuse, signal) {
      const response = await api.send('POST', poolPath(pool, 'release'), {
        headers: jsonHeaders,
        body: JSON.stringify({ session_id: sessionId, reuse }),
        signal,
      })
      if (response.ok || response.status === 404) {
        await response.body?.cancel()
        return
      }
      throw await api.failure(response, 'POST /browser_pools/{pool}/release')
    },

    async listBrowsers(limit, signal) {
      const response = await api.send('GET', `browsers?limit=${String(limit)}`, {
        headers: { accept: 'application/json' },
        signal,
      })
      if (!response.ok) throw await api.failure(response, 'GET /browsers')
      await response.body?.cancel()
    },

    async orgLimits(signal) {
      const response = await api.send('GET', 'org/limits', {
        headers: { accept: 'application/json' },
        signal,
      })
      if (!response.ok) throw await api.failure(response, 'GET /org/limits')
      return api.json(response)
    },

    async getPool(pool, signal) {
      const response = await api.send('GET', poolPath(pool), {
        headers: { accept: 'application/json' },
        signal,
      })
      if (response.status === 404) {
        await response.body?.cancel()
        return false
      }
      if (!response.ok) throw await api.failure(response, 'GET /browser_pools/{pool}')
      await response.body?.cancel()
      return true
    },
  }
}
