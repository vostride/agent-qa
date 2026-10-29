// The PostHog transport. It reads no environment and
// decides nothing: the opt-out was answered in `compose.ts`, and the answer is whether a transport
// exists at all. There is no module-level state in this file.

import { PostHog } from 'posthog-node'
import type { PostHogOptions } from 'posthog-node'
import { maskEventForSend } from './masking-seam.js'
import type { AnalyticsMaskingContext } from './masking-seam.js'
import type { AnalyticsCapturePayload, AnalyticsTransport } from './port.js'

/**
 * The subset of the PostHog client this transport uses.
 *
 * `flush` is REQUIRED, not optional, and that is the whole content of the fix: the
 * interface previously declared only `capture`/`shutdown`, so the type system could not express the
 * correct per-boundary call and the transport reached for `shutdown` instead. An optional member
 * with a shutdown fallback would reinstate the same defect behind a spelling. posthog-node 5.33.2
 * exposes both. The contract being honoured is stated at `port.ts:49-51`.
 */
export interface PosthogAnalyticsClient {
  capture(input: {
    distinctId: string
    event: string
    properties: Record<string, unknown>
  }): void
  flush(): void | Promise<void>
  shutdown(): void | Promise<void>
}

export interface PosthogTransportOptions {
  readonly projectKey: string
  readonly host: string
  readonly disableGeoip?: boolean
  /**
   * posthog-node's own `fetch` option, passed straight through.
   *
   * this exists for plan 06's sandboxed-sink arm of the zero-network
   * differential. posthog-node 5.33.2 sends through `this.options.fetch ?? fetch`, so injecting here
   * observes the SHIPPED send path rather than a parallel one built for the test — which is the
   * difference between measuring the product and measuring the fixture.
   */
  readonly fetch?: PostHogOptions['fetch']
  /** The host's declared-secret mask, applied at the send seam. Absent means no masking. */
  readonly maskingContext?: AnalyticsMaskingContext
  /** An already-constructed client, for tests that need to observe construction itself. */
  readonly client?: PosthogAnalyticsClient
}

class PosthogTransport implements AnalyticsTransport {
  private readonly client: PosthogAnalyticsClient
  private readonly maskingContext: AnalyticsMaskingContext | undefined

  constructor(options: PosthogTransportOptions) {
    this.maskingContext = options.maskingContext
    this.client = options.client ?? new PostHog(options.projectKey, {
      host: options.host,
      disableGeoip: options.disableGeoip ?? false,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    })
  }

  /**
   * THE SEND CHOKE POINT. Masking is the first thing that happens here and it happens exactly once
   * (a cell counts the call sites in shipped source and refuses any number but one).
   *
   * `flush`/`shutdown` are not second seams: everything they drain arrived through this method, so
   * masking here ranges the whole queue. `is_internal` is added AFTER the mask because it is a
   * boolean this file writes — there is no caller string in it to mask. It is an event property,
   * sent only when true.
   */
  capture(payload: AnalyticsCapturePayload): void {
    let masked: AnalyticsCapturePayload
    try {
      masked = maskEventForSend(payload, this.maskingContext)
    } catch {
      return
    }
    const properties: Record<string, unknown> = { ...masked.event.properties }
    if (masked.isInternal === true) {
      properties.is_internal = true
    }

    this.client.capture({
      distinctId: masked.distinctId,
      event: masked.event.name,
      properties,
    })
  }

  async flush(): Promise<void> {
    await this.client.flush()
  }

  async shutdown(): Promise<void> {
    await this.client.shutdown()
  }
}

export function createPosthogTransport(options: PosthogTransportOptions): AnalyticsTransport {
  return new PosthogTransport(options)
}

/** The factory shape `composeAnalytics` calls, so a cell can spy on whether it was called at all. */
export type PosthogTransportFactory = (options: PosthogTransportOptions) => AnalyticsTransport
