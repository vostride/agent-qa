// Drives two events through one composition, so a flush that tears the client down shows.

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

// The port bounds shutdown for every host; a client that never settles proves the bound releases.
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
      + 'held, so a terminal exit still waits on the network',
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
