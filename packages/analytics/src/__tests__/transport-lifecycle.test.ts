// The transport's flush/shutdown split, measured on ONE composition (Phase 398 plan 15 · CR-01).
//
// WHY THIS FILE EXISTS, AND WHY NOTHING ELSE COULD SEE THE DEFECT. Every other cell that builds a
// PostHog transport constructs a fresh one per send (`masking-seam.test.ts`, `network-differential
// .test.ts`), so a flush that tears the client down looks identical to a flush that flushes: the
// composition is discarded straight afterwards either way. The claim `port.ts:49-51` makes is about
// what happens to the SECOND event on the SAME composition, so that is what this cell drives.

import { describe, expect, it } from 'vitest'

import { createAnalyticsPort } from '../port.js'
import { createPosthogTransport } from '../transports.js'
import type { PosthogAnalyticsClient } from '../transports.js'

interface CountingClient extends PosthogAnalyticsClient {
  readonly capturedEvents: string[]
  /** The client's shutdown count observed AT each capture — the ordinal fact, recorded not inferred. */
  readonly shutdownCountAtCapture: number[]
  readonly counts: { capture: number; flush: number; shutdown: number }
}

function countingClient(): CountingClient {
  const counts = { capture: 0, flush: 0, shutdown: 0 }
  const capturedEvents: string[] = []
  const shutdownCountAtCapture: number[] = []
  return {
    counts,
    capturedEvents,
    shutdownCountAtCapture,
    capture(input) {
      counts.capture += 1
      capturedEvents.push(input.event)
      shutdownCountAtCapture.push(counts.shutdown)
    },
    flush() {
      counts.flush += 1
    },
    shutdown() {
      counts.shutdown += 1
    },
  }
}

/** The SHIPPED transport under the SHIPPED port — the seam a user's events actually cross. */
function composeOverCountingClient(): { client: CountingClient; port: ReturnType<typeof createAnalyticsPort> } {
  const client = countingClient()
  const transport = createPosthogTransport({
    projectKey: 'phc_test_key',
    host: 'https://analytics.invalid',
    client,
  })
  return {
    client,
    port: createAnalyticsPort({
      transport,
      identity: () => ({ distinctId: 'u_lifecycle' }),
    }),
  }
}

describe('the transport lifecycle on ONE composition', () => {
  it('flushes the client at each boundary and shuts it down exactly once, at the end', async () => {
    const { client, port } = composeOverCountingClient()

    port.capture({ name: 'agent-qa.explain.answered', properties: { cited_row_count: 1 } })
    await port.flush()
    port.capture({ name: 'agent-qa.explain.answered', properties: { cited_row_count: 2 } })
    await port.flush()
    await port.shutdown()

    expect(
      client.counts.flush,
      "the transport's per-boundary flush did not reach the client's own flush — a flush that calls "
      + 'shutdown is a mid-session teardown, which is the failure mode port.ts:49-51 names',
    ).toBe(2)
    expect(
      client.counts.shutdown,
      'the client was shut down more than once (or not at exit): shutdown is reserved for the '
      + `single teardown, and this composition saw ${client.counts.shutdown}`,
    ).toBe(1)
    expect(client.capturedEvents).toEqual([
      'agent-qa.explain.answered',
      'agent-qa.explain.answered',
    ])
    // THE ORDINAL FACT, asserted directly rather than inferred from the totals: the second event
    // was handed to a client that had not been torn down between the two flushes.
    expect(
      client.shutdownCountAtCapture,
      'an event reached a client that had already been shut down — the mid-session teardown is '
      + `still there: shutdown counts observed at each capture were [${client.shutdownCountAtCapture.join(', ')}]`,
    ).toEqual([0, 0])
  })

  it('a flush with nothing captured touches the client not at all', async () => {
    const { client, port } = composeOverCountingClient()

    await port.flush()

    expect(client.counts).toEqual({ capture: 0, flush: 0, shutdown: 0 })
  })
})

// The shutdown TIME BOUND (Phase 398 security gate, T-398-35 · review WR-02).
//
// WHY THIS EXISTS. T-398-35 is the high-severity DoS "`agent-qa run` exiting while holding a live
// client with an armed flush". Plan 15 mitigated it by draining at every terminal exit — and the
// drain was `await composedAnalytics.shutdown()` with NO bound, which routes to the port's
// `shutdown` below. posthog-node's own `shutdown` defaults to a 30 000 ms wait and races retriable
// flushes against it, so on a released build an offline or proxied machine held every
// `agent-qa run` at exit for up to half a minute, the error path included. The mitigation had
// re-admitted the threat class it closed, one layer down.
//
// The bound lives HERE, at the port, and not at `run.ts`'s drain, because the port is the choke
// point every host's shutdown already funnels through (run, chat, daemon, mcp, init). A bound at
// the drain would protect the one door that was named in the review and leave the other four
// hosts holding an unbounded await.
//
// A client that never resolves is the acceptance bar rather than a slow one: a threshold cell
// against a slow client measures the threshold, while a cell against a client that NEVER settles
// can only pass if the bound genuinely releases the caller.
describe('the port bounds its own shutdown', () => {
  function hangingClient(): PosthogAnalyticsClient & { counts: { shutdown: number } } {
    const counts = { shutdown: 0 }
    return {
      counts,
      capture() {},
      flush() {},
      shutdown() {
        counts.shutdown += 1
        // Never settles. A real client does this whenever the network is unreachable and its
        // retries are still pending.
        return new Promise<void>(() => {})
      },
    }
  }

  it('returns from shutdown even when the client never settles', async () => {
    const client = hangingClient()
    const port = createAnalyticsPort({
      transport: createPosthogTransport({ projectKey: 'phc_bound_cell', host: 'http://127.0.0.1:1', client }),
      identity: () => ({ distinctId: 'u_bound-cell' }),
      shutdownTimeoutMs: 250,
    })
    port.capture({ name: 'agent-qa.explain.answered', properties: {} } as never)

    const startedAt = Date.now()
    await port.shutdown()
    const elapsed = Date.now() - startedAt

    // The claim is release, and the budget is the evidence it was released rather than lucky.
    expect(
      elapsed,
      `port.shutdown() took ${elapsed}ms against a client that never settles — the caller is still `
      + 'held, so a terminal exit still waits on the network (T-398-35 / WR-02)',
    ).toBeLessThan(3000)
    // It still ASKED the client to wind down — the bound releases the caller, it does not skip
    // the drain. Losing in-flight events to the bound is the trade; never attempting is not.
    expect(client.counts.shutdown).toBe(1)
  })

  it('does not truncate a client that settles inside the budget', async () => {
    const counts = { shutdown: 0 }
    const prompt: PosthogAnalyticsClient = {
      capture() {},
      flush() {},
      async shutdown() {
        counts.shutdown += 1
      },
    }
    const port = createAnalyticsPort({
      transport: createPosthogTransport({ projectKey: 'phc_bound_cell', host: 'http://127.0.0.1:1', client: prompt }),
      identity: () => ({ distinctId: 'u_bound-cell' }),
      shutdownTimeoutMs: 250,
    })
    port.capture({ name: 'agent-qa.explain.answered', properties: {} } as never)

    await port.shutdown()

    // The control. Without it the cell above would pass on a port that skipped shutdown entirely.
    expect(counts.shutdown).toBe(1)
  })
})
