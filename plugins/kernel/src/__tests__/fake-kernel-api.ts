import {
  startLoopbackFake,
  type LoopbackFake,
  type LoopbackReply,
  type LoopbackRequest,
} from '@vostride/agent-qa-plugin-kit/testing'

export const CREATE_ROUTE = 'POST /browsers'
export const DELETE_ROUTE = 'DELETE /browsers/:id'

export interface FakeKernelApiInput {
  // Served one per create before the fake falls back to answering a fresh browser.
  create?: readonly LoopbackReply[]
  delete?: readonly LoopbackReply[]
}

export interface FakeKernelApi extends LoopbackFake {
  createdIds(): string[]
  deletedIds(): string[]
}

function kernelBrowser(id: string, headless: boolean) {
  return {
    session_id: id,
    cdp_ws_url: `wss://cdp.example.invalid/${id}?jwt=${id}-jwt`,
    webdriver_ws_url: `wss://bidi.example.invalid/${id}?jwt=${id}-jwt`,
    headless,
    timeout_seconds: 60,
    ...(headless
      ? {}
      : { browser_live_view_url: `https://live.example.invalid/${id}?jwt=${id}-live` }),
  }
}

function sentHeadless(request: LoopbackRequest): boolean {
  const body = request.body
  return (
    typeof body !== 'object' || body === null || !('headless' in body) || body.headless !== false
  )
}

export async function startFakeKernelApi(input: FakeKernelApiInput = {}): Promise<FakeKernelApi> {
  const scripted = [...(input.create ?? [])]
  const created: string[] = []
  const fake = await startLoopbackFake({
    routes: {
      [CREATE_ROUTE]: (request) => {
        const reply = scripted.shift()
        if (reply !== undefined) return reply
        const id = `browser-${String(created.length + 1)}`
        created.push(id)
        return { status: 200, json: kernelBrowser(id, sentHeadless(request)) }
      },
      [DELETE_ROUTE]: input.delete ?? [{ status: 204 }],
    },
  })
  return {
    ...fake,
    createdIds: () => [...created],
    deletedIds: () => fake.routeCalls(DELETE_ROUTE).map((request) => request.params.id ?? ''),
  }
}
