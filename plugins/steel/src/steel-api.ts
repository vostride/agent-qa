import { createVendorApi, z } from '@vostride/agent-qa-plugin-kit'

export const SteelSessionSchema = z.object({
  id: z.string().min(1),
  websocketUrl: z.string().min(1),
  debugUrl: z.string().min(1).optional(),
  sessionViewerUrl: z.string().min(1).optional(),
  timeout: z.number().optional(),
})

interface SteelApiInput {
  apiUrl: string
  apiKey?: string | undefined
}

export interface SteelApi {
  createSession(body: Record<string, unknown>): Promise<unknown>
  release(id: string, signal?: AbortSignal): Promise<void>
  session(id: string, signal?: AbortSignal): Promise<unknown>
  listSessions(signal?: AbortSignal): Promise<void>
}

export function createSteelApi(input: SteelApiInput): SteelApi {
  const api = createVendorApi({
    vendor: 'Steel',
    baseUrl: input.apiUrl,
    headers: input.apiKey === undefined ? {} : { 'steel-api-key': input.apiKey },
  })

  const sessionPath = (id: string) => `v1/sessions/${encodeURIComponent(id)}`

  return {
    async createSession(body) {
      const response = await api.send('POST', 'v1/sessions', {
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
      })
      if (!response.ok) throw await api.failure(response, 'POST /v1/sessions')
      return api.json(response)
    },

    async release(id, signal) {
      const response = await api.send('POST', `${sessionPath(id)}/release`, {
        headers: { accept: 'application/json' },
        signal,
      })
      if (response.ok || response.status === 404) {
        await response.body?.cancel()
        return
      }
      throw await api.failure(response, 'POST /v1/sessions/{id}/release')
    },

    async session(id, signal) {
      const response = await api.send('GET', sessionPath(id), {
        headers: { accept: 'application/json' },
        signal,
      })
      if (response.status === 404) {
        await response.body?.cancel()
        return undefined
      }
      if (!response.ok) throw await api.failure(response, 'GET /v1/sessions/{id}')
      return api.json(response)
    },

    async listSessions(signal) {
      const response = await api.send('GET', 'v1/sessions?limit=1', {
        headers: { accept: 'application/json' },
        signal,
      })
      if (!response.ok) throw await api.failure(response, 'GET /v1/sessions')
      await response.body?.cancel()
    },
  }
}
