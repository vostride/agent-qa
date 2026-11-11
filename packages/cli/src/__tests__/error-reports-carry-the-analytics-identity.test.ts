// A report and a span carry the anonymous analytics id and the analytics properties, from the one
// identity resolution of the process, which PostHog's host reuses.

import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DEFAULT_ANALYTICS_SHUTDOWN_TIMEOUT_MS,
  generateAnalyticsUserId,
  readAnalyticsIdentity,
} from '@vostride/agent-qa-analytics'
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
import {
  heldProcessAnalyticsIdentity,
  resolveCliAnalyticsIdentity,
} from '../composition/analytics-identity.js'
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
  readonly exception?: { readonly values?: ReadonlyArray<{ readonly value?: string }> }
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

// Every marker the run detector reads as CI, taken from the detector, whose package index does not
// re-export them.
const { CI_VENDOR_VARS } = (await import(
  new URL('../../../safety-local/src/execution-context-detector.js', import.meta.url).href
)) as { CI_VENDOR_VARS: ReadonlySet<string> }

function stubRunContext(context: { readonly ci: boolean }): void {
  for (const name of ['CI', ...CI_VENDOR_VARS]) vi.stubEnv(name, '')
  if (context.ci) vi.stubEnv('CI', 'true')
}

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

  it("resolves the host's own identity outside CI when the reporter's resolution failed or was cut off, and sends its events under it", async () => {
    stubRunContext({ ci: false })
    const arms: ReadonlyArray<{ readonly label: string; readonly identity: IdentityResolver }> = [
      {
        label: 'a resolver that rejects',
        identity: () => Promise.reject(new Error('the identity store cannot be read')),
      },
      {
        label: 'a resolver the cut-off gives up on',
        identity: () =>
          resolveCliAnalyticsIdentity({ env: {}, resolve: () => new Promise(() => {}) }),
      },
    ]
    for (const arm of arms) {
      await startReporting(arm.identity)
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

      expect(hostOwn, arm.label).toHaveBeenCalledTimes(1)
      expect(sent.map((payload) => payload.distinctId), arm.label).toEqual([own.distinctId])
      await closeErrorReporting()
    }
  })

  it("resolves no identity of the host's own in CI when the reporter's resolution failed, and sends no event", async () => {
    stubRunContext({ ci: true })
    await startReporting(() => Promise.reject(new Error('the identity store cannot be read')))
    const hostOwn = vi.fn(async () => internalUser())
    const sent: AnalyticsCapturePayload[] = []
    const host = await composeAnalyticsHost({
      surface: 'cli',
      env: {},
      transportOverride: recordingAnalytics(sent),
      resolveIdentity: hostOwn,
    })
    host.port.capture(analyticsEvent(host, 'agent-qa.explain.answered', { cited_row_count: 1 }))
    await host.flush()

    expect(host.transportKind).toBe('posthog')
    expect(hostOwn).not.toHaveBeenCalled()
    expect(sent).toEqual([])
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
    errorReporter()?.capture(new Error('an error through the starter'))
    await settleReporting()

    const stored = await readAnalyticsIdentity(join(dataHome, 'agent-qa', 'analytics.json'))
    const [event] = recordedEvents(recorder.envelopes)
    expect(stored).toEqual({ distinctId: expect.stringMatching(/^u_/), is_internal: false })
    expect(event?.user).toEqual({ id: stored?.distinctId })
    expect(event?.tags?.surface).toBe('cli')
  })
})

function deferred<T>(): { readonly promise: Promise<T>; resolve(value: T): void } {
  let settle: (value: T) => void = () => {}
  const promise = new Promise<T>((resolve) => {
    settle = resolve
  })
  return { promise, resolve: (value) => settle(value) }
}

const IDENTITY_TAGS = ['runtime_context', 'is_internal', 'agent_product']

function messageOf(event: RecordedEvent | undefined): string | undefined {
  return event?.exception?.values?.at(-1)?.value
}

describe('a report and a span made before the identity resolved', () => {
  it('send an error captured while the identity was pending with the id and the identity tags once it resolves before the settle', async () => {
    const pending = deferred<ResolvedAnalyticsIdentity | undefined>()
    const { recorder, reporter } = await startReporting(() => pending.promise)
    reporter.setFacts(factsFor('run'))

    reporter.capture(new Error('an error while the identity is pending'))
    const identity = internalUser()
    pending.resolve(identity)
    await settleReporting()

    const [event] = recordedEvents(recorder.envelopes)
    expect(event?.user).toEqual({ id: identity.distinctId })
    expect(event?.tags).toMatchObject({
      runtime_context: 'user',
      is_internal: 'true',
      agent_product: 'claude_code',
    })
  })

  it('send a span that ended while the identity was pending without it, and one that ends after it resolved and the command span with it', async () => {
    const pending = deferred<ResolvedAnalyticsIdentity | undefined>()
    const { recorder, reporter } = await startReporting(() => pending.promise)
    reporter.setFacts(factsFor('run'))
    reporter.beginCommandSpan('run', [])

    reporter.startSpan({ op: 'agent_qa.run', name: 'a run that ended first' }).end()
    const identity = internalUser()
    pending.resolve(identity)
    await heldProcessAnalyticsIdentity()
    reporter.startSpan({ op: 'agent_qa.run', name: 'a run that ended later' }).end()
    await settleReporting()

    const early = spanNamed(recorder.envelopes, 'a run that ended first')
    expect(early).toBeDefined()
    for (const key of ['user.id', ...IDENTITY_TAGS]) {
      expect(early?.attributes).not.toHaveProperty([key])
    }
    for (const name of ['a run that ended later', 'agent-qa run']) {
      const span = spanNamed(recorder.envelopes, name)
      expect(attributeOf(span, 'user.id'), name).toBe(identity.distinctId)
      expect(attributeOf(span, 'runtime_context'), name).toBe('user')
      expect(attributeOf(span, 'is_internal'), name).toBe(true)
      expect(attributeOf(span, 'agent_product'), name).toBe('claude_code')
    }
  })

  it('send a report with no user and no identity tag, but with the version and the surface, when the resolution fails or is cut off, and raise no unhandled rejection', async () => {
    const unhandled: unknown[] = []
    const keep = (reason: unknown) => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', keep)
    try {
      const arms: ReadonlyArray<{ readonly label: string; readonly identity: IdentityResolver }> = [
        {
          label: 'a resolver that rejects',
          identity: () => Promise.reject(new Error('the identity store cannot be read')),
        },
        {
          label: 'a resolver the cut-off gives up on',
          identity: () =>
            resolveCliAnalyticsIdentity({ env: {}, resolve: () => new Promise(() => {}) }),
        },
      ]
      for (const arm of arms) {
        const { recorder, reporter } = await startReporting(arm.identity)
        reporter.setFacts(factsFor('run'))
        reporter.capture(new Error(`an error beside ${arm.label}`))
        await settleReporting()
        await closeErrorReporting()

        const [event] = recordedEvents(recorder.envelopes)
        expect(messageOf(event), arm.label).toBe(`an error beside ${arm.label}`)
        expect(event, arm.label).not.toHaveProperty('user')
        for (const name of IDENTITY_TAGS) expect(event?.tags, arm.label).not.toHaveProperty([name])
        expect(event?.tags, arm.label).toMatchObject({
          agent_qa_version: CLI_ANALYTICS_AGENT_QA_VERSION,
          surface: 'cli',
        })
      }
      await new Promise((resolve) => setImmediate(resolve))
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', keep)
    }
  })
})

// Lower-case letters made at run time, never written here.
function randomWord(length: number): string {
  return Array.from(randomBytes(length), (byte) => String.fromCharCode(97 + (byte % 26))).join('')
}

describe('the masks over the identity', () => {
  it('leave the id and the five values byte for byte when a declared secret, a saved credential and a home are in play and none of them matches', async () => {
    const tag = randomWord(10)
    const declared = `declared-${tag}`
    const saved = `saved-${tag}`
    const home = folder()
    const authPath = join(folder(), 'auth.json')
    writeFileSync(
      authPath,
      JSON.stringify({ openai: { type: 'api', provider: 'openai', key: saved } }),
      'utf8',
    )
    const identity = internalUser()
    const recorder = recordingReportTransport()
    const reporter = await startErrorReporting({
      configPath: projectWithPrivacy({ secrets: { DECLARED_TOKEN: declared } }).configPath,
      dsn: INVENTED_DSN,
      transport: recorder.transport,
      authPath,
      homeDir: home,
      identity: async () => identity,
    })
    if (reporter === undefined) throw new Error('the reporter did not start')

    reporter.setFacts(factsFor('run'))
    reporter.capture(new Error(`an error quoting ${declared}, ${saved} and ${join(home, 'notes')}`))
    reporter.startSpan({ op: 'agent_qa.run', name: 'a run beside the masks' }).end()
    await settleReporting()

    const [event] = recordedEvents(recorder.envelopes)
    const span = spanNamed(recorder.envelopes, 'a run beside the masks')
    expect(messageOf(event)).toBe(
      'an error quoting [secret:DECLARED_TOKEN], [secret:SAVED_CREDENTIAL] and ~/notes',
    )
    expect(event?.user?.id).toBe(identity.distinctId)
    expect(attributeOf(span, 'user.id')).toBe(identity.distinctId)
    const values = {
      agent_qa_version: CLI_ANALYTICS_AGENT_QA_VERSION,
      surface: 'cli',
      runtime_context: 'user',
      agent_product: 'claude_code',
    }
    for (const [name, value] of Object.entries(values)) {
      expect(event?.tags?.[name], name).toBe(value)
      expect(attributeOf(span, name), name).toBe(value)
    }
    expect(event?.tags?.is_internal).toBe('true')
    expect(attributeOf(span, 'is_internal')).toBe(true)
  })

  it('read a declared secret that is one word of the id as its marker in the user id of the event and the span, and nowhere in clear', async () => {
    const word = randomWord(12)
    const words = generateAnalyticsUserId().slice('u_'.length).split('-')
    words[3] = word
    const distinctId = `u_${words.join('-')}`
    const recorder = recordingReportTransport()
    const reporter = await startErrorReporting({
      configPath: projectWithPrivacy({ secrets: { ID_WORD: word } }).configPath,
      dsn: INVENTED_DSN,
      transport: recorder.transport,
      identity: async () => ({ distinctId, runtimeContext: 'user' }),
    })
    if (reporter === undefined) throw new Error('the reporter did not start')

    reporter.capture(new Error('an error under an id that holds a declared secret'))
    reporter.startSpan({ op: 'agent_qa.run', name: 'a run under that id' }).end()
    await settleReporting()

    const marked = distinctId.replace(word, '[secret:ID_WORD]')
    const [event] = recordedEvents(recorder.envelopes)
    expect(event?.user).toEqual({ id: marked })
    const span = spanNamed(recorder.envelopes, 'a run under that id')
    expect(attributeOf(span, 'user.id')).toBe(marked)
    expect(serializedEnvelopes(recorder.envelopes)).not.toContain(word)
  })
})

describe('a reporter started after a close', () => {
  it('carries no user or identity tag, and a resolution that settles after its reporter closed writes nothing on it', async () => {
    const late = deferred<ResolvedAnalyticsIdentity | undefined>()
    await startReporting(() => late.promise)
    // The close waits its bound for the identity it released, here on a clock the cell moves.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const closing = closeErrorReporting()
      await vi.advanceTimersByTimeAsync(2 * DEFAULT_ANALYTICS_SHUTDOWN_TIMEOUT_MS)
      await closing
    } finally {
      vi.useRealTimers()
    }

    const { recorder, reporter } = await startReporting()
    late.resolve(internalUser())
    await late.promise
    await new Promise((resolve) => setImmediate(resolve))
    reporter.setFacts(factsFor('run'))
    reporter.capture(new Error('an error under the reporter started after the close'))
    reporter.startSpan({ op: 'agent_qa.run', name: 'a run after the close' }).end()
    await settleReporting()

    const [event] = recordedEvents(recorder.envelopes)
    const span = spanNamed(recorder.envelopes, 'a run after the close')
    expect(messageOf(event)).toBe('an error under the reporter started after the close')
    expect(event).not.toHaveProperty('user')
    for (const name of IDENTITY_TAGS) expect(event?.tags).not.toHaveProperty([name])
    for (const key of ['user.id', ...IDENTITY_TAGS]) {
      expect(span?.attributes).not.toHaveProperty([key])
    }
  })
})
