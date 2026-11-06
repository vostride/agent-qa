import {
  startLoopbackFake,
  type LoopbackFake,
  type LoopbackReply,
  type LoopbackRequest,
} from '@vostride/agent-qa-plugin-kit/testing'

export const CREATE_ROUTE = 'POST /v1/sessions'
export const RELEASE_ROUTE = 'POST /v1/sessions/:id/release'
export const SESSION_ROUTE = 'GET /v1/sessions/:id'
export const LIST_ROUTE = 'GET /v1/sessions'

export interface FakeSteelApiInput {
  // Served one per create before the fake falls back to answering a fresh session.
  create?: readonly LoopbackReply[]
  release?: readonly LoopbackReply[]
  session?: readonly LoopbackReply[]
  list?: readonly LoopbackReply[]
  // The websocketUrl every created session answers, such as a loopback CDP browser's endpoint.
  cdpUrl?: string
  // The timeout every created session answers, as when Steel grants less than was asked.
  grantedTimeoutMs?: number
}

export interface FakeSteelApi extends LoopbackFake {
  createdIds(): string[]
  releasedIds(): string[]
}

function bodyField(request: LoopbackRequest, field: string): unknown {
  const body = request.body
  if (typeof body !== 'object' || body === null || !(field in body)) return undefined
  return (body as Record<string, unknown>)[field]
}

export async function startFakeSteelApi(input: FakeSteelApiInput = {}): Promise<FakeSteelApi> {
  const scripted = [...(input.create ?? [])]
  const created: string[] = []
  const live = new Set<string>()
  const fake = await startLoopbackFake({
    routes: {
      [CREATE_ROUTE]: (request) => {
        const reply = scripted.shift()
        if (reply !== undefined) return reply
        const chosen = bodyField(request, 'sessionId')
        const id =
          typeof chosen === 'string' && chosen !== ''
            ? chosen
            : `session-${String(created.length + 1)}`
        const asked = bodyField(request, 'timeout')
        created.push(id)
        live.add(id)
        return {
          status: 200,
          json: {
            id,
            websocketUrl: input.cdpUrl ?? `wss://connect.example.invalid/?sessionId=${id}`,
            debugUrl: `https://debug.example.invalid/sessions/${id}/player`,
            sessionViewerUrl: `https://app.example.invalid/sessions/${id}`,
            timeout: input.grantedTimeoutMs ?? (typeof asked === 'number' ? asked : 300_000),
            status: 'live',
          },
        }
      },
      // Like Steel, a session released once is gone, so a second release answers 404.
      [RELEASE_ROUTE]:
        input.release ??
        ((request) => {
          const id = request.params.id ?? ''
          if (!live.delete(id)) return { status: 404, json: { message: 'session not found' } }
          return { status: 200, json: { success: true } }
        }),
      [SESSION_ROUTE]:
        input.session ??
        ((request) => {
          const id = request.params.id ?? ''
          if (!created.includes(id)) return { status: 404, json: { message: 'session not found' } }
          return { status: 200, json: { id, status: live.has(id) ? 'live' : 'released' } }
        }),
      [LIST_ROUTE]: input.list ?? [{ status: 200, json: { sessions: [] } }],
    },
  })
  return {
    ...fake,
    createdIds: () => [...created],
    releasedIds: () => fake.routeCalls(RELEASE_ROUTE).map((request) => request.params.id ?? ''),
  }
}
