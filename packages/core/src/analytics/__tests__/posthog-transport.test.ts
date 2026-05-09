import { describe, expect, it, vi } from 'vitest'
import { buildAnalyticsEvent } from '../events.js'
import { PostHogAnalyticsTransport, type PostHogAnalyticsClient } from '../posthog-transport.js'

function createClient(): PostHogAnalyticsClient {
  return {
    capture: vi.fn(),
    shutdown: vi.fn(),
  }
}

describe('PostHog analytics transport', () => {
  it('keeps person processing disabled for non-internal users', () => {
    const client = createClient()
    const transport = new PostHogAnalyticsTransport({
      projectKey: 'phc_test_key',
      host: 'https://us.i.posthog.com',
      client,
    })

    transport.capture({
      distinctId: 'u_external',
      event: buildAnalyticsEvent({
        name: 'agent-qa.analytics.test_event',
        properties: { surface: 'core', runtime_context: 'user' },
      }),
    })

    expect(client.capture).toHaveBeenCalledWith(expect.objectContaining({
      distinctId: 'u_external',
      event: 'agent-qa.analytics.test_event',
      properties: expect.objectContaining({
        surface: 'core',
        runtime_context: 'user',
        $process_person_profile: false,
      }),
    }))
    expect((client.capture as ReturnType<typeof vi.fn>).mock.calls[0][0].properties).not.toHaveProperty('$set')
  })

  it('sets PostHog person is_internal true for manually marked internal users', () => {
    const client = createClient()
    const transport = new PostHogAnalyticsTransport({
      projectKey: 'phc_test_key',
      host: 'https://us.i.posthog.com',
      client,
    })

    transport.capture({
      distinctId: 'u_internal',
      isInternal: true,
      event: buildAnalyticsEvent({
        name: 'agent-qa.analytics.test_event',
        properties: { surface: 'core', runtime_context: 'user' },
      }),
    })

    expect(client.capture).toHaveBeenCalledWith(expect.objectContaining({
      distinctId: 'u_internal',
      event: 'agent-qa.analytics.test_event',
      properties: expect.objectContaining({
        surface: 'core',
        runtime_context: 'user',
        $set: { is_internal: true },
      }),
    }))
    expect((client.capture as ReturnType<typeof vi.fn>).mock.calls[0][0].properties)
      .not.toHaveProperty('$process_person_profile')
  })
})
