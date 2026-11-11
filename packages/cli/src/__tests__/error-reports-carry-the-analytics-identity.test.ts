// A report and a span carry the anonymous analytics id and the analytics properties, from the one
// identity resolution of the process, which PostHog's host reuses.

import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { generateAnalyticsUserId, readAnalyticsIdentity } from '@vostride/agent-qa-analytics'
import type {
  AnalyticsCapturePayload,
  AnalyticsTransport,
  ResolvedAnalyticsIdentity,
} from '@vostride/agent-qa-analytics'
import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  analyticsEvent,
  CLI_ANALYTICS_AGENT_QA_VERSION,
  composeAnalyticsHost,
} from '../composition/analytics-host.js'
import { heldProcessAnalyticsIdentity } from '../composition/analytics-identity.js'
import {
  closeErrorReporting,
  errorReporter,
  settleReporting,
  startErrorReporting,
} from '../composition/error-reporting.js'
import type { ErrorReporter, ReportFacts } from '../composition/error-reporting.js'
import { startCliErrorReporting } from '../composition/error-reporting-start.js'
import {
  projectWithPrivacy,
  recordingReportTransport,
  removeReportProjects,
  serializedEnvelopes,
} from './error-report-recorder.js'
import type { RecordedEnvelope, RecordingReportTransport } from './error-report-recorder.js'

const INVENTED_DSN = 'http://key@127.0.0.1:9/1'

const folders: string[] = []

function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-qa-report-identity-'))
  folders.push(dir)
  return dir
}

// No cell reads the auth store or the identity file in the real home folder.
beforeEach(() => {
  vi.stubEnv('XDG_DATA_HOME', folder())
})

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  await closeErrorReporting()
  removeReportProjects()
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true })
})

type IdentityResolver = () => Promise<ResolvedAnalyticsIdentity | undefined>

// Ids are made at run time, never written here: a report quotes the source lines around its frames.
function internalUser(): ResolvedAnalyticsIdentity {
  return {
    distinctId: generateAnalyticsUserId(),
    runtimeContext: 'user',
    agentProduct: 'claude_code',
    isInternal: true,
  }
}

function countingResolver(identity: ResolvedAnalyticsIdentity) {
  const resolver = {
    calls: 0,
    resolve: async () => {
      resolver.calls += 1
      return identity
    },
  }
  return resolver
}

function factsFor(command: string): ReportFacts {
  return {
    command,
    flags: [],
    packageManager: 'pnpm',
    ci: false,
    platforms: ['web'],
    models: [],
    plugins: [],
  }
}

async function startReporting(
  identity?: IdentityResolver,
): Promise<{ recorder: RecordingReportTransport; reporter: ErrorReporter }> {
  const recorder = recordingReportTransport()
  const reporter = await startErrorReporting({
    configPath: projectWithPrivacy().configPath,
    dsn: INVENTED_DSN,
    transport: recorder.transport,
    ...(identity === undefined ? {} : { identity }),
  })
  if (reporter === undefined) throw new Error('the reporter did not start')
  return { recorder, reporter }
}

function recordingAnalytics(sent: AnalyticsCapturePayload[]): AnalyticsTransport {
  return {
    capture: (payload) => {
      sent.push(payload)
    },
    flush: () => {},
    shutdown: () => {},
  }
}

interface RecordedEvent {
  readonly user?: Readonly<Record<string, unknown>>
  readonly tags?: Readonly<Record<string, unknown>>
}

interface RecordedSpan {
  readonly name?: string
  readonly attributes?: Readonly<Record<string, { readonly value?: unknown }>>
}

// Read back from the JSON text, as an envelope leaves the process.
function itemsOf<T>(envelopes: readonly RecordedEnvelope[], type: string): T[] {
  const parsed = JSON.parse(serializedEnvelopes(envelopes)) as Array<
    [unknown, Array<[{ readonly type?: string }, T]>]
  >
  return parsed
    .flatMap(([, items]) => items)
    .filter(([header]) => header.type === type)
    .map(([, payload]) => payload)
}

function recordedEvents(envelopes: readonly RecordedEnvelope[]): RecordedEvent[] {
  return itemsOf<RecordedEvent>(envelopes, 'event')
}

function spanNamed(envelopes: readonly RecordedEnvelope[], name: string): RecordedSpan | undefined {
  return itemsOf<{ readonly items?: RecordedSpan[] }>(envelopes, 'span')
    .flatMap((container) => container.items ?? [])
    .find((span) => span.name === name)
}

function attributeOf(span: RecordedSpan | undefined, key: string): unknown {
  return span?.attributes?.[key]?.value
}

const USER_FIELDS_LEFT_OUT = ['user.email', 'user.name', 'user.username', 'user.ip_address']

describe('a report and a span', () => {
  it('send a captured error with the anonymous id as its only user field and the analytics properties as tags, beside the facts', async () => {
    const identity = internalUser()
    const { recorder, reporter } = await startReporting(async () => identity)

    reporter.setFacts(factsFor('run'))
    reporter.capture(new Error('an error once the identity resolved'))
    await settleReporting()

    const [event] = recordedEvents(recorder.envelopes)
    expect(event?.user).toEqual({ id: identity.distinctId })
    expect(event?.tags).toEqual({
      command: 'run',
      package_manager: 'pnpm',
      ci: 'local',
      agent_qa_version: CLI_ANALYTICS_AGENT_QA_VERSION,
      surface: 'cli',
      runtime_context: 'user',
      is_internal: 'true',
      agent_product: 'claude_code',
    })
  })

  it('send a span that ends once the identity resolved with the id and the analytics properties as attributes, and no other user field', async () => {
    const identity = internalUser()
    const { recorder, reporter } = await startReporting(async () => identity)

    reporter.setFacts(factsFor('run'))
    reporter.startSpan({ op: 'agent_qa.run', name: 'a run once the identity resolved' }).end()
    await settleReporting()

    const span = spanNamed(recorder.envelopes, 'a run once the identity resolved')
    expect(attributeOf(span, 'user.id')).toBe(identity.distinctId)
    expect(attributeOf(span, 'agent_qa_version')).toBe(CLI_ANALYTICS_AGENT_QA_VERSION)
    expect(attributeOf(span, 'surface')).toBe('cli')
    expect(attributeOf(span, 'runtime_context')).toBe('user')
    expect(attributeOf(span, 'is_internal')).toBe(true)
    expect(attributeOf(span, 'agent_product')).toBe('claude_code')
    for (const key of USER_FIELDS_LEFT_OUT) expect(span?.attributes).not.toHaveProperty([key])
  })

  it('send a CI id with the runtime context ci and no is_internal or agent_product', async () => {
    const distinctId = `ci_${randomUUID()}`
    const { recorder, reporter } = await startReporting(async () => ({
      distinctId,
      runtimeContext: 'ci',
    }))

    reporter.setFacts(factsFor('run'))
    reporter.capture(new Error('an error under a CI id'))
    reporter.startSpan({ op: 'agent_qa.run', name: 'a run under a CI id' }).end()
    await settleReporting()

    const [event] = recordedEvents(recorder.envelopes)
    const span = spanNamed(recorder.envelopes, 'a run under a CI id')
    expect(event?.user).toEqual({ id: distinctId })
    expect(event?.tags?.runtime_context).toBe('ci')
    expect(attributeOf(span, 'user.id')).toBe(distinctId)
    expect(attributeOf(span, 'runtime_context')).toBe('ci')
    for (const key of ['is_internal', 'agent_product']) {
      expect(event?.tags).not.toHaveProperty([key])
      expect(span?.attributes).not.toHaveProperty([key])
    }
  })

  it('name the surface after the command path: mcp, chat and daemon themselves, and cli for every other path', async () => {
    const { recorder, reporter } = await startReporting()
    const surfaces: Readonly<Record<string, string>> = {
      mcp: 'mcp',
      chat: 'chat',
      daemon: 'daemon',
      run: 'cli',
      init: 'cli',
      'daemon status': 'cli',
      '': 'cli',
    }

    for (const command of Object.keys(surfaces)) {
      reporter.setFacts(factsFor(command))
      reporter.capture(new Error(`an error under the command path "${command}"`))
      reporter.startSpan({ op: 'agent_qa.probe', name: `a span under "${command}"` }).end()
      await settleReporting()
    }

    const tagged = recordedEvents(recorder.envelopes).map((event) => [
      event.tags?.command,
      event.tags?.surface,
    ])
    expect(tagged).toEqual(Object.entries(surfaces))
    for (const [command, surface] of Object.entries(surfaces)) {
      const span = spanNamed(recorder.envelopes, `a span under "${command}"`)
      expect(attributeOf(span, 'surface')).toBe(surface)
    }
  })
})

describe('one resolution for the report and the analytics event', () => {
  it("gives an analytics event the report's id and properties, and the host resolves nothing of its own", async () => {
    const identity = internalUser()
    const resolver = countingResolver(identity)
    const { recorder, reporter } = await startReporting(resolver.resolve)
    reporter.setFacts(factsFor('run'))
    reporter.capture(new Error('an error beside an analytics event'))

    const sent: AnalyticsCapturePayload[] = []
    const hostOwn = vi.fn(async () => internalUser())
    const host = await composeAnalyticsHost({
      surface: 'cli',
      env: {},
      transportOverride: recordingAnalytics(sent),
      resolveIdentity: hostOwn,
    })
    host.port.capture(analyticsEvent(host, 'agent-qa.explain.answered', { cited_row_count: 1 }))
    await host.flush()
    await settleReporting()

    const [event] = recordedEvents(recorder.envelopes)
    const [payload] = sent
    expect(payload?.distinctId).toBe(event?.user?.id)
    expect(event?.user).toEqual({ id: identity.distinctId })
    const shared = ['agent_qa_version', 'runtime_context', 'agent_product']
    const properties: Readonly<Record<string, unknown>> = payload?.event.properties ?? {}
    expect(shared.map((name) => properties[name])).toEqual(
      shared.map((name) => event?.tags?.[name]),
    )
    expect(payload?.isInternal).toBe(true)
    expect(event?.tags?.is_internal).toBe('true')
    expect(resolver.calls).toBe(1)
    expect(hostOwn).not.toHaveBeenCalled()
  })

  it('composes a keyless host that builds no transport and resolves nothing, while the report still carries the id', async () => {
    const identity = internalUser()
    const resolver = countingResolver(identity)
    const { recorder, reporter } = await startReporting(resolver.resolve)

    const factory = vi.fn(() => recordingAnalytics([]))
    const hostOwn = vi.fn(async () => internalUser())
    const host = await composeAnalyticsHost({
      surface: 'cli',
      env: {},
      projectKey: '   ',
      posthogTransportFactory: factory,
      resolveIdentity: hostOwn,
    })
    reporter.capture(new Error('an error beside a keyless analytics host'))
    await settleReporting()

    const [event] = recordedEvents(recorder.envelopes)
    expect(event?.user).toEqual({ id: identity.distinctId })
    expect(host.transportKind).toBe('none')
    expect(factory).not.toHaveBeenCalled()
    expect(hostOwn).not.toHaveBeenCalled()
    expect(resolver.calls).toBe(1)
  })

  it('calls no resolver and starts no reporter with analytics.privacy true or a blank DSN, and a host then resolves its own identity', async () => {
    const arms = [
      { label: 'analytics.privacy true', privacy: true, dsn: INVENTED_DSN },
      { label: 'a blank DSN', privacy: false, dsn: '' },
    ]
    for (const arm of arms) {
      const resolver = countingResolver(internalUser())
      const reporter = await startErrorReporting({
        configPath: projectWithPrivacy({ privacy: arm.privacy }).configPath,
        dsn: arm.dsn,
        transport: recordingReportTransport().transport,
        identity: resolver.resolve,
      })
      const own = internalUser()
      const hostOwn = vi.fn(async () => own)
      const sent: AnalyticsCapturePayload[] = []
      const host = await composeAnalyticsHost({
        surface: 'cli',
        env: {},
        transportOverride: recordingAnalytics(sent),
        resolveIdentity: hostOwn,
      })
      host.port.capture(analyticsEvent(host, 'agent-qa.explain.answered', { cited_row_count: 1 }))
      await host.flush()

      expect(reporter, arm.label).toBeUndefined()
      expect(resolver.calls, arm.label).toBe(0)
      expect(hostOwn, arm.label).toHaveBeenCalledTimes(1)
      expect(sent.map((payload) => payload.distinctId), arm.label).toEqual([own.distinctId])
      await closeErrorReporting()
    }
  })
})

// `agent-qa --config <path> run`, parsed by a tree shaped like the real one.
async function runAction(configPath: string): Promise<{ root: Command; action: Command }> {
  const root = new Command('agent-qa')
    .exitOverride()
    .enablePositionalOptions()
    .option('--config <path>', 'config file path', 'agent-qa.config.yaml')
  const action = root.command('run').action(() => {})
  await root.parseAsync(['node', 'agent-qa', '--config', configPath, 'run'])
  return { root, action }
}

describe('the starter', () => {
  it('sends the id the identity file under the data home holds, with surface cli for run', async () => {
    // The run detector reads the process's own environment; GITHUB_ACTIONS is stubbed blank too.
    vi.stubEnv('CI', '')
    const dataHome = folder()
    const { root, action } = await runAction(projectWithPrivacy().configPath)
    const recorder = recordingReportTransport()

    await startCliErrorReporting(root, action, {
      env: { XDG_DATA_HOME: dataHome },
      start: (input) =>
        startErrorReporting({ ...input, dsn: INVENTED_DSN, transport: recorder.transport }),
      installHandlers: () => {},
    })
    // The command's error comes once the identity is known, as it does when the SDK loads.
    await heldProcessAnalyticsIdentity()
    errorReporter()?.capture(new Error('an error through the starter'))
    await settleReporting()

    const stored = await readAnalyticsIdentity(join(dataHome, 'agent-qa', 'analytics.json'))
    const [event] = recordedEvents(recorder.envelopes)
    expect(stored).toEqual({ distinctId: expect.stringMatching(/^u_/), is_internal: false })
    expect(event?.user).toEqual({ id: stored?.distinctId })
    expect(event?.tags?.surface).toBe('cli')
  })
})
