import { createVendorApi, z } from '@vostride/agent-qa-plugin-kit'

export const HyperbrowserSessionSchema = z.object({
  id: z.string().min(1),
  wsEndpoint: z.string().min(1),
  liveUrl: z.string().min(1).optional(),
  token: z.string().min(1).optional(),
  sessionUrl: z.string().min(1).optional(),
})

interface HyperbrowserApiInput {
  apiUrl: string
  apiKey: string
}

export interface HyperbrowserApi {
  createSession(body: Record<string, unknown>): Promise<unknown>
  stop(id: string, signal?: AbortSignal): Promise<void>
  activeSessions(signal?: AbortSignal): Promise<unknown>
}

export function createHyperbrowserApi(input: HyperbrowserApiInput): HyperbrowserApi {
  const api = createVendorApi({
    vendor: 'Hyperbrowser',
    baseUrl: input.apiUrl,
    headers: { 'x-api-key': input.apiKey },
  })

  return {
    async createSession(body) {
      const response = await api.send('POST', 'api/session', {
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
      })
      if (!response.ok) throw await api.failure(response, 'POST /api/session')
      return api.json(response)
    },

    async stop(id, signal) {
      const response = await api.send('PUT', `api/session/${encodeURIComponent(id)}/stop`, {
        headers: { accept: 'application/json' },
        signal,
      })
      if (response.ok || response.status === 404) {
        await response.body?.cancel()
        return
      }
      throw await api.failure(response, 'PUT /api/session/{id}/stop')
    },

    async activeSessions(signal) {
      const response = await api.send('GET', 'api/sessions?status=active&page=1', {
        headers: { accept: 'application/json' },
        signal,
      })
      if (!response.ok) throw await api.failure(response, 'GET /api/sessions')
      return api.json(response)
    },
  }
}
