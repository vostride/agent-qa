import { PostHog } from 'posthog-node'
import type { AnalyticsCapturePayload, AnalyticsTransport } from './transport.js'

export interface PostHogAnalyticsTransportOptions {
  projectKey: string
  host: string
  disableGeoip?: boolean
  client?: PostHogAnalyticsClient
}

export interface PostHogAnalyticsClient {
  capture(input: {
    distinctId: string
    event: string
    properties: Record<string, string | number | boolean | undefined | Record<string, string | number | boolean | undefined>>
  }): void
  shutdown(): void | Promise<void>
}

export class PostHogAnalyticsTransport implements AnalyticsTransport {
  private readonly client: PostHogAnalyticsClient

  constructor(options: PostHogAnalyticsTransportOptions) {
    this.client = options.client ?? new PostHog(options.projectKey, {
      host: options.host,
      disableGeoip: options.disableGeoip ?? false,
    })
  }

  capture(payload: AnalyticsCapturePayload): void {
    const { $process_person_profile: _processPersonProfile, ...internalEventProperties } = payload.event.properties
    const properties = payload.isInternal === true
      ? { ...internalEventProperties, $set: { is_internal: true } }
      : payload.event.properties

    this.client.capture({
      distinctId: payload.distinctId,
      event: payload.event.name,
      properties,
    })
  }

  async flush(): Promise<void> {
    await this.client.shutdown()
  }
}
