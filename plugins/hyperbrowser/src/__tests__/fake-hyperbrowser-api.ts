import {
  startLoopbackFake,
  type LoopbackFake,
  type LoopbackReply,
} from '@vostride/agent-qa-plugin-kit/testing'

export const CREATE_ROUTE = 'POST /api/session'
export const STOP_ROUTE = 'PUT /api/session/:id/stop'
export const LIST_ROUTE = 'GET /api/sessions'

export interface FakeHyperbrowserApiInput {
  // Served one per create before the fake falls back to answering a fresh session.
  create?: readonly LoopbackReply[]
  stop?: readonly LoopbackReply[]
  list?: readonly LoopbackReply[]
  // The wsEndpoint every created session answers, such as a loopback CDP browser's endpoint.
  cdpUrl?: string
}

export interface FakeHyperbrowserApi extends LoopbackFake {
  createdIds(): string[]
  stoppedIds(): string[]
}

export async function startFakeHyperbrowserApi(
  input: FakeHyperbrowserApiInput = {},
): Promise<FakeHyperbrowserApi> {
  const scripted = [...(input.create ?? [])]
  const created: string[] = []
  const live = new Set<string>()
  const fake = await startLoopbackFake({
    routes: {
      [CREATE_ROUTE]: () => {
        const reply = scripted.shift()
        if (reply !== undefined) return reply
        const id = `session-${String(created.length + 1)}`
        const token = `${id}-token`
        created.push(id)
        live.add(id)
        return {
          status: 200,
          json: {
            id,
            status: 'active',
            wsEndpoint: input.cdpUrl ?? `wss://connect.example.invalid/?token=${token}`,
            liveUrl: `https://app.example.invalid/live?token=${token}`,
            token,
            sessionUrl: `https://app.example.invalid/sessions/${id}`,
          },
        }
      },
      // The fake forgets a stopped session, so a second stop answers 404, as for an unknown id.
      [STOP_ROUTE]:
        input.stop ??
        ((request) => {
          const id = request.params.id ?? ''
          if (!live.delete(id)) return { status: 404, json: { message: 'Session not found' } }
          return { status: 200, json: { success: true } }
        }),
      [LIST_ROUTE]: input.list ?? [
        { status: 200, json: { sessions: [], totalCount: 0, page: 1, pageSize: 20 } },
      ],
    },
  })
  return {
    ...fake,
    createdIds: () => [...created],
    stoppedIds: () => fake.routeCalls(STOP_ROUTE).map((request) => request.params.id ?? ''),
  }
}
