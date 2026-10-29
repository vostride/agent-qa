// Reads no environment and decides nothing: `compose.ts` decides whether a transport exists.

import { PostHog } from 'posthog-node'
import type { PostHogOptions } from 'posthog-node'
import { maskEventForSend } from './masking-seam.js'
import type { AnalyticsMaskingContext } from './masking-seam.js'
import type { AnalyticsCapturePayload, AnalyticsTransport } from './port.js'

// `flush` is required: falling back to `shutdown` tears the client down between boundaries.
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
  // Passed straight through, so a test observes the shipped send path rather than a parallel one.
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

  // The one masking site; `is_internal` is added after the mask because this file writes it.
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
