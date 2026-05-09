import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildAnalyticsEvent } from '../events.js'
import { writeAnalyticsIdentity } from '../identity.js'
import { captureAnalytics, createAnalyticsService, flushAnalytics, resetAnalyticsServiceForTests } from '../service.js'
import { MockAnalyticsTransport, type AnalyticsTransport } from '../transport.js'

const EMPTY_KEY_WARNING = 'PostHog analytics initialization failed because AGENT_QA_POSTHOG_KEY is empty. Analytics telemetry is disabled.'

describe('analytics service', () => {
  let tempDir: string
  let identityPath: string
  let originalPostHogEnvKey: string | undefined

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'agent-qa-analytics-service-'))
    identityPath = join(tempDir, 'analytics.json')
    originalPostHogEnvKey = process.env.AGENT_QA_POSTHOG_KEY
    delete process.env.AGENT_QA_POSTHOG_KEY
  })

  afterEach(async () => {
    resetAnalyticsServiceForTests()
    if (originalPostHogEnvKey === undefined) {
      delete process.env.AGENT_QA_POSTHOG_KEY
    } else {
      process.env.AGENT_QA_POSTHOG_KEY = originalPostHogEnvKey
    }
    await rm(tempDir, { recursive: true, force: true })
  })

  it('uses quiet noop behavior when privacy is enabled', async () => {
    const warningSink = vi.fn()
    const transport: AnalyticsTransport = {
      capture: vi.fn(),
      flush: vi.fn(),
    }
    const service = createAnalyticsService({
      config: { analytics: { privacy: true } },
      transport,
      warningSink,
      identityPath,
    })

    await expect(service.capture(buildAnalyticsEvent({
      name: 'agent-qa.analytics.test_event',
      properties: { surface: 'core', runtime_context: 'user' },
    }))).resolves.toBeUndefined()
    await expect(service.flush()).resolves.toBeUndefined()

    expect(warningSink).not.toHaveBeenCalled()
    expect(transport.capture).not.toHaveBeenCalled()
    expect(transport.flush).not.toHaveBeenCalled()
  })

  it('uses noop behavior and warns once when the source PostHog key is empty', async () => {
    const warningSink = vi.fn()
    const service = createAnalyticsService({ projectKey: '', warningSink, identityPath })

    await service.capture(buildAnalyticsEvent({
      name: 'agent-qa.analytics.test_event',
      properties: { surface: 'core', runtime_context: 'user' },
    }))
    await service.capture(buildAnalyticsEvent({
      name: 'agent-qa.analytics.test_event',
      properties: { surface: 'core', runtime_context: 'user' },
    }))
    await service.flush()

    expect(warningSink).toHaveBeenCalledTimes(1)
    expect(warningSink).toHaveBeenCalledWith(EMPTY_KEY_WARNING)
  })

  it('uses the shared noop service for MCP events when the PostHog key is empty', async () => {
    const warningSink = vi.fn()
    const posthogTransportFactory = vi.fn(() => new MockAnalyticsTransport())
    const service = createAnalyticsService({
      projectKey: '',
      warningSink,
      identityPath,
      posthogTransportFactory,
    })

    await service.capture(buildAnalyticsEvent({
      name: 'agent-qa.mcp.tool.invoked',
      properties: {
        surface: 'mcp',
        runtime_context: 'agent',
        tool_name: 'agent_qa_discover',
        mcp_tool_category: 'discovery',
        mcp_tool_status: 'success',
        duration_ms: 0,
        mcp_transport: 'stdio',
      },
    }))
    await service.flush()

    expect(posthogTransportFactory).not.toHaveBeenCalled()
    expect(warningSink).toHaveBeenCalledTimes(1)
    expect(warningSink).toHaveBeenCalledWith(EMPTY_KEY_WARNING)
  })

  it('captures sanitized built events with an injected mock transport', async () => {
    const transport = new MockAnalyticsTransport()
    const service = createAnalyticsService({ transport, identityPath, env: {} })
    const event = buildAnalyticsEvent({
      name: 'agent-qa.analytics.test_event',
      properties: {
        surface: 'cli',
        runtime_context: 'user',
        agent_qa_version: '0.1.0',
        prompt: 'phase242-service-sensitive-sentinel',
      },
    })

    await service.capture(event)
    await service.flush()

    expect(transport.events).toHaveLength(1)
    expect(transport.events[0]).toEqual(expect.objectContaining({
      distinctId: expect.stringMatching(/^u_([a-z]+-){9}[a-z]+$/),
      event: expect.objectContaining({
        name: 'agent-qa.analytics.test_event',
        properties: expect.objectContaining({
          surface: 'cli',
          runtime_context: 'user',
          agent_qa_version: '0.1.0',
          $process_person_profile: false,
        }),
      }),
    }))
    expect(JSON.stringify(transport.events[0])).not.toContain('phase242-service-sensitive-sentinel')
    expect(transport.flushCount).toBe(1)
  })

  it('captures with injected transport when analytics privacy is absent', async () => {
    const transport: AnalyticsTransport = {
      capture: vi.fn(),
      flush: vi.fn(),
    }
    const service = createAnalyticsService({
      config: {},
      transport,
      identityPath,
      env: {},
    })

    await service.capture(buildAnalyticsEvent({
      name: 'agent-qa.analytics.test_event',
      properties: { surface: 'core', runtime_context: 'user' },
    }))
    await service.flush()

    expect(transport.capture).toHaveBeenCalledTimes(1)
    expect(transport.flush).toHaveBeenCalledTimes(1)
  })

  it('marks capture payloads as internal when local identity is manually marked internal', async () => {
    const transport = new MockAnalyticsTransport()
    await writeAnalyticsIdentity(
      'u_alpha-bravo-charlie-delta-echo-foxtrot-golf-hotel-india-juliet',
      identityPath,
      true,
    )
    const service = createAnalyticsService({ transport, identityPath, env: {} })

    await service.capture(buildAnalyticsEvent({
      name: 'agent-qa.analytics.test_event',
      properties: { surface: 'core', runtime_context: 'user' },
    }))

    expect(transport.events).toHaveLength(1)
    expect(transport.events[0]).toEqual(expect.objectContaining({
      distinctId: 'u_alpha-bravo-charlie-delta-echo-foxtrot-golf-hotel-india-juliet',
      isInternal: true,
    }))
  })

  it('does not reject when capture transport throws', async () => {
    const service = createAnalyticsService({
      identityPath,
      transport: {
        capture: vi.fn(() => { throw new Error('capture failed') }),
        flush: vi.fn(),
      },
    })

    await expect(service.capture(buildAnalyticsEvent({
      name: 'agent-qa.analytics.test_event',
      properties: { surface: 'core', runtime_context: 'user' },
    }))).resolves.toBeUndefined()
  })

  it('does not reject when flush transport throws', async () => {
    const service = createAnalyticsService({
      identityPath,
      transport: {
        capture: vi.fn(),
        flush: vi.fn(() => { throw new Error('flush failed') }),
      },
    })

    await expect(service.flush()).resolves.toBeUndefined()
  })

  it('creates the PostHog transport with the configured host and GeoIP enabled when the key is non-empty', () => {
    const transport = new MockAnalyticsTransport()
    const posthogTransportFactory = vi.fn(() => transport)

    createAnalyticsService({
      projectKey: 'phc_test_key',
      projectHost: 'https://us.i.posthog.com',
      warningSink: vi.fn(),
      posthogTransportFactory,
      identityPath,
    })

    expect(posthogTransportFactory).toHaveBeenCalledWith(expect.objectContaining({
      projectKey: 'phc_test_key',
      host: 'https://us.i.posthog.com',
      disableGeoip: false,
    }))
  })

  it('does not read a PostHog key from environment variables when the source key is empty', () => {
    process.env.AGENT_QA_POSTHOG_KEY = 'phc_should_not_be_used'
    const warningSink = vi.fn()
    const posthogTransportFactory = vi.fn(() => new MockAnalyticsTransport())

    createAnalyticsService({
      projectKey: '',
      warningSink,
      posthogTransportFactory,
      identityPath,
    })

    expect(posthogTransportFactory).not.toHaveBeenCalled()
    expect(warningSink).toHaveBeenCalledWith(EMPTY_KEY_WARNING)
  })

  it('privacy options short-circuit shared capture and flush helpers', async () => {
    const warningSink = vi.fn()
    await createAnalyticsService({
      projectKey: 'phc_test_key',
      identityPath,
      posthogTransportFactory: vi.fn(() => new MockAnalyticsTransport()),
    }).capture(buildAnalyticsEvent({
      name: 'agent-qa.analytics.test_event',
      properties: { surface: 'core', runtime_context: 'user' },
    }))

    await expect(captureAnalytics(buildAnalyticsEvent({
      name: 'agent-qa.analytics.test_event',
      properties: { surface: 'core', runtime_context: 'user' },
    }), {
      config: { analytics: { privacy: true } },
      warningSink,
      identityPath,
    })).resolves.toBeUndefined()
    await expect(flushAnalytics({
      config: { analytics: { privacy: true } },
      warningSink,
      identityPath,
    })).resolves.toBeUndefined()

    expect(warningSink).not.toHaveBeenCalled()
  })
})
