// @vitest-environment jsdom

import { readFile } from 'node:fs/promises'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type DashboardAnalyticsModule = typeof import('@/lib/analytics')

const forbiddenPayloadFields = [
  'route',
  'path',
  'url',
  'query',
  'entity_id',
  'entity_name',
  'target_name',
  'target_url',
  'yaml',
  'source',
  'prompt',
  'logs',
  'screenshot',
  'dom_snapshot',
  'config_payload',
  'credentials',
] as const

let originalFetch: typeof fetch
let originalSendBeacon: typeof navigator.sendBeacon | undefined

async function loadAnalytics(): Promise<DashboardAnalyticsModule> {
  vi.resetModules()
  return await import('@/lib/analytics')
}

function installSendBeacon(returnValue = true): ReturnType<typeof vi.fn> {
  const sendBeacon = vi.fn(() => returnValue)
  Object.defineProperty(window.navigator, 'sendBeacon', {
    configurable: true,
    value: sendBeacon,
  })
  return sendBeacon
}

function removeSendBeacon(): void {
  Object.defineProperty(window.navigator, 'sendBeacon', {
    configurable: true,
    value: undefined,
  })
}

async function readBeaconPayload(sendBeacon: ReturnType<typeof vi.fn>, callIndex = 0): Promise<unknown> {
  const blob = sendBeacon.mock.calls[callIndex][1] as Blob
  return JSON.parse(await blob.text())
}

function readFetchPayload(fetchMock: ReturnType<typeof vi.fn>, callIndex = 0): unknown {
  const init = fetchMock.mock.calls[callIndex][1] as RequestInit
  return JSON.parse(String(init.body))
}

async function readProjectFile(relativePath: string): Promise<string> {
  return await readFile(new URL(relativePath, import.meta.url), 'utf-8')
}

function analyticsRelatedLines(source: string): string {
  return source
    .split('\n')
    .filter((line) => line.includes('trackDashboard') || line.includes('agent-qa.dashboard'))
    .join('\n')
}

beforeEach(() => {
  originalFetch = globalThis.fetch
  originalSendBeacon = window.navigator.sendBeacon
  globalThis.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 202 })) as unknown as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
  Object.defineProperty(window.navigator, 'sendBeacon', {
    configurable: true,
    value: originalSendBeacon,
  })
  vi.restoreAllMocks()
})

describe('dashboard analytics browser helper', () => {
  it('sends one dashboard-open event per loaded bundle', async () => {
    const sendBeacon = installSendBeacon()
    const { trackDashboardOpenedOnce } = await loadAnalytics()

    trackDashboardOpenedOnce()
    trackDashboardOpenedOnce()

    expect(sendBeacon).toHaveBeenCalledTimes(1)
    expect(sendBeacon).toHaveBeenCalledWith('/api/analytics/events', expect.any(Blob))
    await expect(readBeaconPayload(sendBeacon)).resolves.toEqual({
      name: 'agent-qa.dashboard.opened',
      properties: {},
    })
  })

  it('sends live-mode-started events with normalized platform and entity type only', async () => {
    const sendBeacon = installSendBeacon()
    const { trackDashboardLiveModeStarted } = await loadAnalytics()

    trackDashboardLiveModeStarted({ platform: 'android', entityType: 'test' })
    trackDashboardLiveModeStarted({ platform: 'desktop', entityType: 'run' })

    await expect(readBeaconPayload(sendBeacon, 0)).resolves.toEqual({
      name: 'agent-qa.dashboard.live_mode.started',
      properties: {
        platform: 'android',
        entity_type: 'test',
      },
    })
    await expect(readBeaconPayload(sendBeacon, 1)).resolves.toEqual({
      name: 'agent-qa.dashboard.live_mode.started',
      properties: {
        platform: 'unknown',
        entity_type: 'unknown',
      },
    })
  })

  it('sends entity-created events with entity type and created outcome only', async () => {
    const sendBeacon = installSendBeacon()
    const { trackDashboardEntityCreated } = await loadAnalytics()

    trackDashboardEntityCreated('hook')

    await expect(readBeaconPayload(sendBeacon)).resolves.toEqual({
      name: 'agent-qa.dashboard.entity.created',
      properties: {
        entity_type: 'hook',
        outcome: 'created',
      },
    })
  })

  it('falls back to keepalive fetch when sendBeacon is unavailable or declines payloads', async () => {
    const sendBeacon = installSendBeacon(false)
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 202 }))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const { trackDashboardLiveModeStarted } = await loadAnalytics()

    trackDashboardLiveModeStarted({ platform: 'ios', entityType: 'suite' })

    expect(sendBeacon).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith('/api/analytics/events', {
      method: 'POST',
      keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body: expect.any(String),
    })
    expect(readFetchPayload(fetchMock)).toEqual({
      name: 'agent-qa.dashboard.live_mode.started',
      properties: {
        platform: 'ios',
        entity_type: 'suite',
      },
    })

    removeSendBeacon()
    trackDashboardLiveModeStarted({ platform: 'web', entityType: 'test' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('swallows serialization, sendBeacon, and fetch failures', async () => {
    const sendBeacon = vi.fn(() => {
      throw new Error('phase244 beacon failed')
    })
    Object.defineProperty(window.navigator, 'sendBeacon', {
      configurable: true,
      value: sendBeacon,
    })
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('phase244 fetch failed')) as unknown as typeof fetch
    const { trackDashboardOpenedOnce, trackDashboardEntityCreated } = await loadAnalytics()

    expect(() => trackDashboardOpenedOnce()).not.toThrow()
    removeSendBeacon()
    expect(() => trackDashboardEntityCreated('test')).not.toThrow()
  })

  it('serializes no route, entity identifier, source, prompt, log, screenshot, config, or credential fields', async () => {
    const sendBeacon = installSendBeacon()
    const {
      trackDashboardOpenedOnce,
      trackDashboardLiveModeStarted,
      trackDashboardEntityCreated,
    } = await loadAnalytics()

    trackDashboardOpenedOnce()
    trackDashboardLiveModeStarted({ platform: 'android', entityType: 'test' })
    trackDashboardEntityCreated('suite')

    const serializedPayloads = await Promise.all(
      sendBeacon.mock.calls.map(async ([, blob]) => await (blob as Blob).text()),
    )

    expect(serializedPayloads.join('\n')).toContain('agent-qa.dashboard.opened')
    expect(serializedPayloads.join('\n')).toContain('agent-qa.dashboard.live_mode.started')
    expect(serializedPayloads.join('\n')).toContain('agent-qa.dashboard.entity.created')
    for (const field of forbiddenPayloadFields) {
      expect(serializedPayloads.join('\n')).not.toContain(field)
    }
  })

  it('does not add browser PostHog, autocapture, replay, route, or page analytics paths', async () => {
    const packageJson = JSON.parse(await readProjectFile('../../../package.json')) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    expect(packageJson.dependencies).not.toHaveProperty('posthog-js')
    expect(packageJson.devDependencies).not.toHaveProperty('posthog-js')

    const analyticsSource = await readProjectFile('../analytics.ts')
    const appSource = await readProjectFile('../../app.tsx')
    const apiSource = await readProjectFile('../api.ts')
    const combinedFullSource = [analyticsSource, appSource, apiSource].join('\n')

    for (const forbidden of [
      'posthog.init',
      'autocapture',
      'session_recording',
      'sessionReplay',
      'recording',
    ]) {
      expect(combinedFullSource).not.toContain(forbidden)
    }

    const analyticsOnlySource = [
      analyticsSource,
      analyticsRelatedLines(appSource),
      analyticsRelatedLines(apiSource),
    ].join('\n')
    for (const forbidden of [
      'useLocation',
      'window.location',
      'route_pattern',
      'routePattern',
      'query',
      'searchParams',
    ]) {
      expect(analyticsOnlySource).not.toContain(forbidden)
    }

    const dashboardEventNames = Array.from(new Set(
      analyticsSource.match(/agent-qa\.dashboard\.[a-z_.]+/g) ?? [],
    )).sort()
    expect(dashboardEventNames).toEqual([
      'agent-qa.dashboard.entity.created',
      'agent-qa.dashboard.live_mode.started',
      'agent-qa.dashboard.opened',
    ])
    expect(analyticsSource).not.toContain('agent-qa.dashboard.route')
    expect(analyticsSource).not.toContain('agent-qa.dashboard.page')
    expect(analyticsSource).not.toContain('route.viewed')
    expect(analyticsSource).not.toContain('page.accessed')
  })
})
