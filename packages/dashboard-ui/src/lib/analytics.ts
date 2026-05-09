export type DashboardAnalyticsPlatform = 'web' | 'android' | 'ios' | 'unknown'
export type DashboardAnalyticsEntityType = 'test' | 'suite' | 'hook' | 'unknown'

type DashboardAnalyticsEvent =
  | { name: 'agent-qa.dashboard.opened'; properties: Record<string, never> }
  | {
    name: 'agent-qa.dashboard.live_mode.started'
    properties: { platform: DashboardAnalyticsPlatform; entity_type: Exclude<DashboardAnalyticsEntityType, 'hook'> }
  }
  | {
    name: 'agent-qa.dashboard.entity.created'
    properties: { entity_type: Exclude<DashboardAnalyticsEntityType, 'unknown'>; outcome: 'created' }
  }

const ANALYTICS_ENDPOINT = '/api/analytics/events'
const DASHBOARD_ANALYTICS_PLATFORMS = new Set<DashboardAnalyticsPlatform>(['web', 'android', 'ios', 'unknown'])
const DASHBOARD_LIVE_ENTITY_TYPES = new Set<Exclude<DashboardAnalyticsEntityType, 'hook'>>(['test', 'suite', 'unknown'])

let dashboardOpenedTracked = false

function normalizePlatform(value: unknown): DashboardAnalyticsPlatform {
  return typeof value === 'string' && DASHBOARD_ANALYTICS_PLATFORMS.has(value as DashboardAnalyticsPlatform)
    ? value as DashboardAnalyticsPlatform
    : 'unknown'
}

function normalizeLiveEntityType(value: unknown): Exclude<DashboardAnalyticsEntityType, 'hook'> {
  return typeof value === 'string' && DASHBOARD_LIVE_ENTITY_TYPES.has(value as Exclude<DashboardAnalyticsEntityType, 'hook'>)
    ? value as Exclude<DashboardAnalyticsEntityType, 'hook'>
    : 'unknown'
}

function sendDashboardAnalyticsEvent(event: DashboardAnalyticsEvent): void {
  try {
    const body = JSON.stringify(event)
    const sendBeacon = globalThis.navigator?.sendBeacon
    if (typeof sendBeacon === 'function') {
      const sent = sendBeacon.call(
        globalThis.navigator,
        ANALYTICS_ENDPOINT,
        new Blob([body], { type: 'application/json' }),
      )
      if (sent) return
    }

    void globalThis.fetch?.(ANALYTICS_ENDPOINT, {
      method: 'POST',
      keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body,
    })?.catch(() => {})
  } catch {
    // Dashboard analytics must never affect product workflows.
  }
}

export function trackDashboardOpenedOnce(): void {
  if (dashboardOpenedTracked) return
  dashboardOpenedTracked = true
  sendDashboardAnalyticsEvent({
    name: 'agent-qa.dashboard.opened',
    properties: {},
  })
}

export function trackDashboardLiveModeStarted(input: { platform?: unknown; entityType?: unknown }): void {
  sendDashboardAnalyticsEvent({
    name: 'agent-qa.dashboard.live_mode.started',
    properties: {
      platform: normalizePlatform(input.platform),
      entity_type: normalizeLiveEntityType(input.entityType),
    },
  })
}

export function trackDashboardEntityCreated(entityType: 'test' | 'suite' | 'hook'): void {
  sendDashboardAnalyticsEvent({
    name: 'agent-qa.dashboard.entity.created',
    properties: {
      entity_type: entityType,
      outcome: 'created',
    },
  })
}
