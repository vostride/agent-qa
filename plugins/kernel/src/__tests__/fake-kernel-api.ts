import {
  startLoopbackFake,
  type LoopbackFake,
  type LoopbackReply,
  type LoopbackRequest,
} from '@vostride/agent-qa-plugin-kit/testing'

export const CREATE_ROUTE = 'POST /browsers'
export const DELETE_ROUTE = 'DELETE /browsers/:id'
export const POOL_ACQUIRE_ROUTE = 'POST /browser_pools/:pool/acquire'
export const POOL_RELEASE_ROUTE = 'POST /browser_pools/:pool/release'
export const LIST_ROUTE = 'GET /browsers'
export const LIMITS_ROUTE = 'GET /org/limits'
export const POOL_ROUTE = 'GET /browser_pools/:pool'

export interface FakeKernelApiInput {
  // Served one per create before the fake falls back to answering a fresh browser.
  create?: readonly LoopbackReply[]
  delete?: readonly LoopbackReply[]
  // Served one per pool acquire before the fake falls back to handing out a pooled browser.
  poolAcquire?: readonly LoopbackReply[]
  // Every pool acquire answers 204, as for a pool with no free browser.
  poolEmpty?: boolean
  poolRelease?: readonly LoopbackReply[]
  list?: readonly LoopbackReply[]
  limits?: readonly LoopbackReply[]
  // The pools GET /browser_pools/{pool} finds; any other pool answers 404.
  pools?: readonly string[]
  // The cdp_ws_url every created browser answers, such as a loopback CDP browser's endpoint.
  cdpUrl?: string
}

export interface FakeKernelApi extends LoopbackFake {
  createdIds(): string[]
  deletedIds(): string[]
}

function kernelBrowser(id: string, headless: boolean, cdpUrl?: string) {
  return {
    session_id: id,
    cdp_ws_url: cdpUrl ?? `wss://cdp.example.invalid/${id}?jwt=${id}-jwt`,
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
  const scriptedPool = [...(input.poolAcquire ?? [])]
  let pooled = 0
  const created: string[] = []
  const live = new Set<string>()
  const fake = await startLoopbackFake({
    routes: {
      [CREATE_ROUTE]: (request) => {
        const reply = scripted.shift()
        if (reply !== undefined) return reply
        const id = `browser-${String(created.length + 1)}`
        created.push(id)
        live.add(id)
        return { status: 200, json: kernelBrowser(id, sentHeadless(request), input.cdpUrl) }
      },
      // Like Kernel, a browser deleted once is gone, so a second delete answers 404.
      [DELETE_ROUTE]:
        input.delete ??
        ((request) => {
          const id = request.params.id ?? ''
          if (!live.delete(id)) return { status: 404, json: { message: 'browser not found' } }
          return { status: 204 }
        }),
      [POOL_ACQUIRE_ROUTE]: (request) => {
        if (input.poolEmpty === true) return { status: 204 }
        const reply = scriptedPool.shift()
        if (reply !== undefined) return reply
        pooled += 1
        const id = `${request.params.pool ?? ''}-browser-${String(pooled)}`
        return { status: 200, json: kernelBrowser(id, true) }
      },
      [POOL_RELEASE_ROUTE]: input.poolRelease ?? [{ status: 204 }],
      [LIST_ROUTE]: input.list ?? [{ status: 200, json: [] }],
      [LIMITS_ROUTE]: input.limits ?? [
        { status: 200, json: { concurrent_sessions_available: 3, concurrent_sessions_used: 2 } },
      ],
      [POOL_ROUTE]: (request) => {
        const name = request.params.pool ?? ''
        if (!(input.pools ?? []).includes(name)) {
          return { status: 404, json: { message: 'browser pool not found' } }
        }
        return { status: 200, json: { id: `${name}-id`, name } }
      },
    },
  })
  return {
    ...fake,
    createdIds: () => [...created],
    deletedIds: () => fake.routeCalls(DELETE_ROUTE).map((request) => request.params.id ?? ''),
  }
}
