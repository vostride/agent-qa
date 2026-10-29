// `capture` returns `void` and never throws: telemetry must not slow or fail what it measures.

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
  // posthog-node's own shutdown waits up to 30 s, which an exiting host spends on a dead prompt.
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

  // An async body never throws synchronously; the `.catch` below, attached at once, is the guard.
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

  // Zero captures make no transport call; `flush` starts the send without awaiting it.
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
    // The bound releases the caller, not the drain; the `unref`'d timer never holds the exit.
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
