// The analytics port.
//
// WHAT SURVIVED THE RE-DERIVATION, and what did not. The v1 module's transport split — a small
// `capture`/`flush` interface with an injectable factory, every call wrapped best-effort — was the
// one part of it that was right, and it is carried over here deliberately. What is NOT carried:
// the `if (this.disabled) return` guard inside `capture()`, the per-instance privacy decision taken
// in the constructor, the module-level `defaultAnalyticsService` singleton, and the ambient
// `captureAnalytics`/`flushAnalytics` helpers that let any caller in the process reach telemetry
// without ever naming it as a dependency. The opt-out decision lives in
// `compose.ts` and nowhere else; there is no ambient anything here.
//
// WHY `capture` RETURNS `void`. A host emits an event on a path it does not want to await — a run
// finishing, a tool call returning. Making the caller await a telemetry write is how telemetry
// acquires the power to slow down or fail the thing it is measuring. The port takes the event,
// returns immediately, and keeps the resulting work internally so `flush()` has something to wait
// for. Nothing here throws: the port is the best-effort boundary, and the host side of it observes
// no exception even when every transport call rejects.

/**
 * The shape every member of the closed event union satisfies.
 *
 * The port is written against this rather than against the union itself so the transport layer
 * carries no knowledge of which events exist; `AnalyticsPort` is parameterised by the union at the
 * package surface, which is what keeps a non-member event from reaching `capture` at a call site.
 */
export interface AnalyticsEventEnvelope {
  readonly name: string
  readonly properties: Readonly<Record<string, AnalyticsPropertyValue>>
}

export type AnalyticsPropertyValue =
  | string
  | number
  | boolean
  | undefined
  | Readonly<Record<string, string | number | boolean | undefined>>

/** What a transport is handed: the event plus the identity it is attributed to. */
export interface AnalyticsCapturePayload {
  readonly distinctId: string
  readonly isInternal?: boolean
  readonly event: AnalyticsEventEnvelope
}

/**
 * The wire side. Implementations may be synchronous (test sinks) or asynchronous (PostHog);
 * the port normalises both and swallows either one's failures.
 *
 * `flush` and `shutdown` are separate on purpose. A host flushes at natural boundaries — a run
 * ending, a command returning — and shuts down once, at exit; collapsing them means either a
 * process that leaks a live client or a mid-session teardown of the thing still being used.
 */
export interface AnalyticsTransport {
  capture(payload: AnalyticsCapturePayload): void | Promise<void>
  flush(): void | Promise<void>
  shutdown(): void | Promise<void>
}

/** Resolves the anonymous distinct id an event is attributed to. */
export type AnalyticsIdentityResolver = () => AnalyticsIdentity | Promise<AnalyticsIdentity>

export interface AnalyticsIdentity {
  readonly distinctId: string
  readonly isInternal?: boolean
}

export interface AnalyticsPort<TEvent extends AnalyticsEventEnvelope = AnalyticsEventEnvelope> {
  capture(event: TEvent): void
  flush(): Promise<void>
  shutdown(): Promise<void>
}

export interface AnalyticsPortOptions {
  /** Absent when opted out or keyless: the port then drops every capture. */
  readonly transport?: AnalyticsTransport
  readonly identity: AnalyticsIdentityResolver
  /**
   * How long `shutdown` will wait for the transport before releasing its caller.
   *
   * A host calls `shutdown` on its way OUT — at a terminal exit, in a `finally`, on the error path.
   * Whatever it waits for is time a person spends looking at a terminal that has already finished
   * its work. posthog-node's own shutdown defaults to 30 000 ms and races retriable flushes against
   * it, so an unreachable network turns a completed run into half a minute of dead prompt.
   *
   * The default is deliberately small. This is the LAST thing a process does; delivering the final
   * batch is worth a couple of seconds and no more.
   */
  readonly shutdownTimeoutMs?: number
}

/** See `AnalyticsPortOptions.shutdownTimeoutMs`. */
export const DEFAULT_ANALYTICS_SHUTDOWN_TIMEOUT_MS = 2_000

/**
 * The only `AnalyticsPort` implementation, and the best-effort boundary itself.
 *
 * EVERY method is wrapped. That is not defensive habit: this object is held by a CLI process, a
 * chat session and a daemon, and an unhandled rejection out of a telemetry write would surface as
 * the host crashing on something the user never asked for. Losing in-flight events instead is the
 * trade the whole package is built around.
 */
class BestEffortAnalyticsPort<TEvent extends AnalyticsEventEnvelope> implements AnalyticsPort<TEvent> {
  private readonly transport: AnalyticsTransport | undefined
  private readonly identity: AnalyticsIdentityResolver
  private readonly shutdownTimeoutMs: number
  private inFlight: Promise<void>[] = []
  private capturedSinceFlush = 0
  private readonly sending = new Set<Promise<void>>()

  constructor(options: AnalyticsPortOptions) {
    this.transport = options.transport
    this.identity = options.identity
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_ANALYTICS_SHUTDOWN_TIMEOUT_MS
  }

  /**
   * There is NO try/catch here, and the absence is deliberate — measured, not assumed.
   *
   * 2026-08-17 (Phase 398 plan 03, mutation leg M6). This method was first written with the v1
   * module's `try { ... } catch {}` wrapper around the body. Deleting that wrapper outright left
   * every cell green, including the one named "never throws into the host", because there is no
   * synchronous throw for it to catch: an `async` function body's throw — including one out of the
   * identity resolver, the only caller-supplied code reachable from here — becomes a REJECTED
   * PROMISE, never a synchronous exception. The wrapper read like the boundary and guarded nothing.
   *
   * The real boundary is the `.catch` below, attached in the same tick the promise is created so a
   * rejection cannot become an unhandled rejection even if `flush()` is never called — which is the
   * normal case for a host that emits on a path it does not await. Leg M8 removes that `.catch` and
   * reds; that is the guard this method actually has.
   */
  capture(event: TEvent): void {
    const transport = this.transport
    if (transport === undefined) return
    this.capturedSinceFlush += 1
    this.inFlight.push(
      (async () => {
        const identity = await this.identity()
        await transport.capture({
          distinctId: identity.distinctId,
          ...(identity.isInternal === true ? { isInternal: true } : {}),
          event,
        })
      })().catch(() => {}),
    )
  }

  /**
   * EDGE ANLY-01/empty. A flush with nothing captured touches the transport at ALL — not "makes no
   * network call", but makes no call. The distinction matters because `flush` on the PostHog
   * transport is a send, so a host that flushes on every command return would otherwise poke the
   * wire once per invocation whether or not anything happened. Zero captures in, zero calls out,
   * and the promise still resolves.
   *
   * flush awaits the local captures and STARTS the send without awaiting
   * it, so a stalled network never holds a run's verdict or a command's return; `shutdown` waits
   * for the started sends inside its bound.
   */
  async flush(): Promise<void> {
    const transport = this.transport
    if (transport === undefined) return
    try {
      const pending = this.inFlight
      const captured = this.capturedSinceFlush
      this.inFlight = []
      this.capturedSinceFlush = 0

      await Promise.all(pending)
      if (captured === 0) return
      const send = (async () => {
        await transport.flush()
      })().catch(() => {})
      this.sending.add(send)
      void send.finally(() => this.sending.delete(send))
    } catch {
      // Best-effort.
    }
  }

  /**
   * Shutdown always reaches the transport, even with an empty queue: it releases whatever the
   * transport holds (a PostHog client owns timers), and "release nothing" is cheap while "leak a
   * timer because the session happened to be silent" keeps a process alive.
   */
  async shutdown(): Promise<void> {
    const transport = this.transport
    if (transport === undefined) return
    // THE TIME BOUND (T-398-35 / review WR-02). Everything below is still best-effort; what the
    // race adds is that "best effort" cannot mean "forever". The transport is ASKED to wind down
    // and given its budget — the bound releases the CALLER, it does not skip the drain, and events
    // still in flight when the budget expires are lost exactly as the package's stated trade says.
    //
    // The timer is `unref`'d: a bound that itself keeps the event loop alive would hold the very
    // exit it exists to release.
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        (async () => {
          await this.flush()
          await Promise.all([...this.sending])
          await transport.shutdown()
        })(),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, this.shutdownTimeoutMs)
          if (typeof timer.unref === 'function') timer.unref()
        }),
      ])
    } catch {
      // Best-effort.
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }
}

export function createAnalyticsPort<TEvent extends AnalyticsEventEnvelope = AnalyticsEventEnvelope>(
  options: AnalyticsPortOptions,
): AnalyticsPort<TEvent> {
  return new BestEffortAnalyticsPort<TEvent>(options)
}
