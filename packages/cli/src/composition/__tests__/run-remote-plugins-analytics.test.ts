import { createAnalyticsPort } from '@vostride/agent-qa-analytics'
import type {
  AgentQaAnalyticsEvent,
  AnalyticsCapturePayload,
  AnalyticsTransport,
} from '@vostride/agent-qa-analytics'
import type { AgentQaConfig, DevicePlace, WebPlace } from '@vostride/agent-qa-core'
import { generateRunId, generateTestId } from '@vostride/agent-qa-ids'
import type { RunEventEnvelope, RunEventPayload, RunEventType } from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'

import { runRemotePlugins } from '../../commands/run.js'
import type { CliAnalyticsHost } from '../analytics-host.js'
import { buildAnalyticsRunSubscriber } from '../../run-session-composition.js'

const plugins = [
  { name: 'kernel', package: '@vostride/agent-qa-plugin-kernel' },
  { name: 'stack', package: '@vostride/agent-qa-plugin-browserstack' },
  { name: 'steel', package: '@vostride/agent-qa-plugin-steel' },
  { name: 'hyper', package: '@vostride/agent-qa-plugin-hyperbrowser' },
  { name: 'grid', package: '@acme/agent-qa-plugin-grid' },
  { name: 'lab', path: './tools/lab' },
] as AgentQaConfig['plugins']

function pluginPlace(entry: string): WebPlace {
  return {
    kind: 'remote',
    remote: { name: `${entry}-remote`, plugin: { entry }, connectTimeoutMs: 300_000 },
  }
}

describe('the plugins a run reports to analytics', () => {
  it('names each plugin place by its first-party id or third_party, never by package or path', () => {
    const places: (WebPlace | DevicePlace)[] = [
      pluginPlace('kernel'),
      pluginPlace('grid'),
      pluginPlace('lab'),
      pluginPlace('stack'),
      pluginPlace('steel'),
      pluginPlace('hyper'),
      { kind: 'local' },
      {
        kind: 'remote',
        remote: { name: 'url-grid', protocol: 'playwright', url: 'wss://grid.example.com/' },
      } as WebPlace,
      pluginPlace('undeclared'),
    ]

    expect(runRemotePlugins({ plugins }, places)).toEqual([
      'kernel',
      'third_party',
      'third_party',
      'browserstack',
      'steel',
      'hyperbrowser',
    ])
    expect(runRemotePlugins({}, [pluginPlace('kernel')])).toEqual([])
  })

  it('carries the ids through the run subscriber onto the run completion event', async () => {
    const payloads: AnalyticsCapturePayload[] = []
    const transport: AnalyticsTransport = {
      capture: (payload) => {
        payloads.push(payload)
      },
      flush() {},
      shutdown() {},
    }
    const analytics = {
      port: createAnalyticsPort<AgentQaAnalyticsEvent>({
        transport,
        identity: () => ({ distinctId: 'u_test-identity' }),
      }),
      properties: { surface: 'cli' },
    } as unknown as CliAnalyticsHost
    const subscriber = buildAnalyticsRunSubscriber({
      analytics,
      runner: 'remote',
      remotePlugins: runRemotePlugins({ plugins }, [pluginPlace('grid'), pluginPlace('kernel')]),
    })
    const runId = generateRunId()
    const testId = generateTestId()
    let seq = 0
    const envelope = (type: RunEventType, payload: unknown): RunEventEnvelope => {
      seq += 1
      return { seq, ts: seq, runId, type, payload: payload as RunEventPayload }
    }

    subscriber.handler(envelope('testStarted', { testId, testIndex: 0, name: 'a test' }))
    subscriber.handler(
      envelope('testFinished', { testId, testIndex: 0, outcome: 'passed', durationMs: 5 }),
    )
    subscriber.handler(envelope('runFinished', { aggregateVerdict: 'passed' }))
    await subscriber.flush?.()

    const completion = payloads
      .map((payload) => payload.event as AgentQaAnalyticsEvent)
      .find((event) => event.name === 'agent-qa.test_run.completed')
    expect(completion?.properties).toMatchObject({ remote_plugins: ['third_party', 'kernel'] })
    expect(JSON.stringify(payloads)).not.toContain('@acme')
  })
})
