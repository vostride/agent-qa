// Each wall is measured on both arms with one instrument, so a dead interceptor cannot pass.

import net from 'node:net'
import { generateRunId, generateTestId } from '@vostride/agent-qa-ids'
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher, type Dispatcher } from 'undici'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { composeAnalytics } from '../compose.js'
import { AgentQaAnalyticsEventSchema, ANALYTICS_MCP_TOOL_NAMES } from '../events.js'
import { createPosthogTransport } from '../transports.js'
import { readOutgoingBody, startWireSink, type WireSink } from './wire-sink.js'
import type { AnalyticsOptOutConfig, ComposeAnalyticsOptions } from '../compose.js'
import type { AgentQaAnalyticsEvent } from '../events.js'

const PROJECT_KEY = 'phc_zero_network_differential'
const MOCK_ORIGIN = 'http://analytics.differential.test'
const OPTED_OUT: AnalyticsOptOutConfig = { analytics: { privacy: true } }

/**
 * The events the arms drive, PRODUCED through the shipped schema rather than written as literals.
 *
 * `.parse` is what makes them real members: a fixture that only type-checks can describe an event
 * the union would refuse, and a wall proven on an unsendable event is a wall proven on nothing.
 */
function realUnionEvents(): AgentQaAnalyticsEvent[] {
  return [
    AgentQaAnalyticsEventSchema.parse({
      name: 'agent-qa.test_run.completed',
      properties: {
        surface: 'cli',
        runtime_context: 'user',
        status: 'passed',
        run_id: generateRunId(),
        test_id: generateTestId(),
        duration_ms: 1234,
        step_count: 3,
        passed_step_count: 3,
      },
    }),
    AgentQaAnalyticsEventSchema.parse({
      name: 'agent-qa.mcp.tool.invoked',
      properties: {
        surface: 'mcp',
        tool_name: ANALYTICS_MCP_TOOL_NAMES[0],
        mcp_tool_status: 'success',
        mcp_transport: 'stdio',
        duration_ms: 12,
      },
    }),
    AgentQaAnalyticsEventSchema.parse({
      name: 'agent-qa.explain.abstained',
      properties: {
        surface: 'chat',
        suggested_row_count: 2,
        catalog_empty: false,
      },
    }),
  ]
}

/**
 * A FULL emit-and-flush cycle through the shipped port — every event, then `flush`, then
 * `shutdown`.
 *
 * `shutdown` is included because it is a second send opportunity: the PostHog client drains its
 * queue there too, so a wall that only holds until the process decides to exit is not a wall.
 */
async function driveEmitAndFlush(options: ComposeAnalyticsOptions): Promise<void> {
  const composed = composeAnalytics<AgentQaAnalyticsEvent>({
    ...options,
    identity: () => ({ distinctId: 'u_network-differential' }),
  })
  for (const event of realUnionEvents()) composed.port.capture(event)
  await composed.port.flush()
  await composed.port.shutdown()
}

/**
 * The torn-wire check, and the reason both arms exist.
 *
 * A guard that answers identically on both sides proves nothing about the guard — it proves the
 * instrument is dead. Two zeroes is therefore louder than a failed expectation: it is an error
 * naming the interception, because the natural reading of "opted-out observed zero" is that the
 * wall held.
 */
function assertTwoSidedOrFatal(label: string, optedOut: number, optedIn: number): void {
  if (optedOut === 0 && optedIn === 0) {
    throw new Error(
      `TORN WIRE (${label}): BOTH arms observed zero attempts. The opted-in arm is supposed to `
      + `send — a zero there means the interception is not attached to the shipped send path, so `
      + `the opted-out arm's zero measures the instrument rather than the wall. Fix the `
      + `interception before reading anything into the opt-out result.`,
    )
  }
  expect(optedOut, `${label}: analytics.privacy true must produce ZERO attempts`).toBe(0)
  expect(optedIn, `${label}: analytics.privacy unset must produce attempts (else the wire is torn)`)
    .toBeGreaterThan(0)
}

describe('zero-network under analytics.privacy', () => {
  let originalDispatcher: Dispatcher

  beforeEach(() => {
    originalDispatcher = getGlobalDispatcher()
  })

  afterEach(() => {
    setGlobalDispatcher(originalDispatcher)
    vi.restoreAllMocks()
  })

  // A DOM environment breaks MockAgent interception, so this fails first and says why.
  it('runs in the plain node environment — MockAgent interception depends on it (RESEARCH A2)', () => {
    expect(typeof (globalThis as { window?: unknown }).window).toBe('undefined')
    expect(typeof (globalThis as { document?: unknown }).document).toBe('undefined')
    expect(typeof process.versions.node).toBe('string')
  })

  // -------------------------------------------------------------------------------------------
  // Wall 1: the undici global dispatcher — the layer the shipped PostHog client actually sends on
  // -------------------------------------------------------------------------------------------

  describe('fetch layer (undici global dispatcher)', () => {
    interface DispatcherArm {
      dispatcherHits: number
      socketConnects: number
    }

    async function runArm(config?: AnalyticsOptOutConfig): Promise<DispatcherArm> {
      const agent = new MockAgent()
      agent.disableNetConnect()

      let dispatcherHits = 0
      // A catch-all path on the configured origin, not `/batch/`: pinning the path would make a
      // request to any OTHER path invisible (it would be refused by `disableNetConnect` and
      // silently swallowed), and "invisible" reads as zero.
      agent
        .get(MOCK_ORIGIN)
        .intercept({ path: /.*/u, method: 'POST' })
        .reply(200, () => {
          dispatcherHits += 1
          return { status: 1 }
        })
        .persist()
      setGlobalDispatcher(agent)

      const socketSpy = vi.spyOn(net.Socket.prototype, 'connect')
      try {
        await driveEmitAndFlush({
          config,
          projectKey: PROJECT_KEY,
          projectHost: MOCK_ORIGIN,
        })
        return { dispatcherHits, socketConnects: socketSpy.mock.calls.length }
      } finally {
        socketSpy.mockRestore()
        await agent.close()
      }
    }

    it('privacy true produces zero dispatches and zero sockets; privacy unset produces dispatches', async () => {
      const optedOut = await runArm(OPTED_OUT)
      const optedIn = await runArm()

      assertTwoSidedOrFatal('fetch layer', optedOut.dispatcherHits, optedIn.dispatcherHits)
      // The opted-out arm also touched no socket, so the zero above is not "it went somewhere the
      // interceptor could not see".
      expect(optedOut.socketConnects).toBe(0)
    })
  })

  // -------------------------------------------------------------------------------------------
  // Wall 2: the socket — transport-agnostic, against a real listening server
  // -------------------------------------------------------------------------------------------

  describe('socket layer (net.Socket.prototype.connect, real local server)', () => {
    let sink: WireSink

    beforeEach(async () => {
      sink = await startWireSink()
    })

    afterEach(async () => {
      await sink.close()
    })

    interface SocketArm {
      socketConnects: number
      serverRequests: number
    }

    async function runArm(config?: AnalyticsOptOutConfig): Promise<SocketArm> {
      // NO MockAgent here on purpose. This arm runs on the real global dispatcher so a real socket
      // is opened to a real listener — which is what makes the spy's zero on the other arm mean
      // "nothing was dialled" rather than "something intercepted it first".
      const before = sink.requests.length
      const socketSpy = vi.spyOn(net.Socket.prototype, 'connect')
      try {
        await driveEmitAndFlush({ config, projectKey: PROJECT_KEY, projectHost: sink.origin })
        return {
          socketConnects: socketSpy.mock.calls.length,
          serverRequests: sink.requests.length - before,
        }
      } finally {
        socketSpy.mockRestore()
      }
    }

    it('privacy true dials no socket; privacy unset dials one and the server sees the request', async () => {
      const optedOut = await runArm(OPTED_OUT)
      const optedIn = await runArm()

      assertTwoSidedOrFatal('socket layer', optedOut.socketConnects, optedIn.socketConnects)
      assertTwoSidedOrFatal('server receipt', optedOut.serverRequests, optedIn.serverRequests)
    })
  })

  // -------------------------------------------------------------------------------------------
  // Wall 3: the sandboxed sink — posthog-node's own `fetch` option, the last in-process seam
  // -------------------------------------------------------------------------------------------

  describe('sandboxed sink (posthog-node fetch option)', () => {
    interface SinkCall {
      url: string
      body: string
    }

    async function runArm(
      options: ComposeAnalyticsOptions,
    ): Promise<{ calls: SinkCall[]; socketConnects: number }> {
      const calls: SinkCall[] = []
      const socketSpy = vi.spyOn(net.Socket.prototype, 'connect')
      try {
        await driveEmitAndFlush({
          ...options,
          projectKey: PROJECT_KEY,
          projectHost: MOCK_ORIGIN,
          // The SHIPPED transport constructor, handed the SHIPPED options plus posthog-node's own
          // `fetch` hook. Nothing parallel is built for the test: this is the same object
          // production constructs, with its last hop pointed at a counter instead of a socket.
          posthogTransportFactory: (transportOptions) =>
            createPosthogTransport({
              ...transportOptions,
              fetch: async (url: string, init: { body?: unknown }) => {
                calls.push({ url, body: await readOutgoingBody(init.body) })
                return new Response(JSON.stringify({ status: 1 }), {
                  status: 200,
                  headers: { 'content-type': 'application/json' },
                }) as never
              },
            }),
        })
        return { calls, socketConnects: socketSpy.mock.calls.length }
      } finally {
        socketSpy.mockRestore()
      }
    }

    it('privacy true never reaches the sink; privacy unset reaches it with the real batch', async () => {
      const optedOut = await runArm({ config: OPTED_OUT })
      const optedIn = await runArm({})

      assertTwoSidedOrFatal('sandboxed sink', optedOut.calls.length, optedIn.calls.length)
      // No socket on either arm — the sink replaced the wire, so an observed connect would mean a
      // SECOND send path exists beside the one the sink is standing in for.
      expect(optedOut.socketConnects).toBe(0)
      expect(optedIn.socketConnects).toBe(0)

      const body = optedIn.calls[0]?.body ?? ''
      expect(optedIn.calls[0]?.url).toContain('/batch/')
      expect(body).toContain('agent-qa.test_run.completed')
    })
  })
})
