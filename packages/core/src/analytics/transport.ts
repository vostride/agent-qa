import type { BuiltAnalyticsEvent } from './events.js'

export interface AnalyticsCapturePayload {
  distinctId: string
  isInternal?: boolean
  event: BuiltAnalyticsEvent
}

export interface AnalyticsTransport {
  capture(payload: AnalyticsCapturePayload): void | Promise<void>
  flush(): void | Promise<void>
}

export class NoopAnalyticsTransport implements AnalyticsTransport {
  capture(): void {}

  flush(): void {}
}

export class MockAnalyticsTransport implements AnalyticsTransport {
  readonly events: AnalyticsCapturePayload[] = []
  flushCount = 0

  capture(payload: AnalyticsCapturePayload): void {
    this.events.push(payload)
  }

  flush(): void {
    this.flushCount += 1
  }
}
