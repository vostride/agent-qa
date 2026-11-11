// The reporter decides from the raw config, loads the SDK only when on, and builds its client by
// hand with every option passed, through a recording transport that sends nothing.

import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { release, tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DEFAULT_ANALYTICS_SHUTDOWN_TIMEOUT_MS } from '@vostride/agent-qa-analytics'
import { pluginMaskName, RunSecretRedactor, SecretStore } from '@vostride/agent-qa-runner'
import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  projectWithPrivacy,
  recordingReportTransport,
  removeReportProjects,
  serializedEnvelopes,
} from '../../__tests__/error-report-recorder.js'
import type {
  RecordedEnvelope,
  RecordingReportTransport,
} from '../../__tests__/error-report-recorder.js'
import { CLI_ANALYTICS_AGENT_QA_VERSION } from '../analytics-host.js'
import { readSavedCredentialValues } from '../declared-secrets.js'
import {
  closeErrorReporting,
  decideErrorReporting,
  errorReporter,
  settleReporting,
  startErrorReporting,
} from '../error-reporting.js'
import type { SentrySdk } from '../error-reporting.js'
import { startCliErrorReporting } from '../error-reporting-start.js'

const INVENTED_DSN = 'http://key@127.0.0.1:9/1'
const SECRET = 'tok-7f3a9c2e5b'

const authDirs: string[] = []

function authFolder(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-qa-error-reporting-auth-'))
  authDirs.push(dir)
  return dir
}

function authStore(entries: Readonly<Record<string, unknown>>): string {
  const path = join(authFolder(), 'auth.json')
  writeFileSync(path, JSON.stringify(entries), 'utf8')
  return path
}

// No cell reads the auth store in the real home folder.
beforeEach(() => {
  vi.stubEnv('XDG_DATA_HOME', authFolder())
})

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  await closeErrorReporting()
  removeReportProjects()
  for (const dir of authDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

interface RecordedEvent {
  readonly release?: string
  readonly environment?: string
  readonly tags?: Readonly<Record<string, unknown>>
  readonly contexts?: Readonly<Record<string, Readonly<Record<string, unknown>>>>
  readonly breadcrumbs?: ReadonlyArray<{ readonly category?: string; readonly message?: string }>
  readonly exception?: {
    readonly values?: ReadonlyArray<{
      readonly value?: string
      readonly stacktrace?: { readonly frames?: readonly unknown[] }
    }>
  }
}

// Read back from the JSON text, as an envelope leaves the process.
function recordedEvents(envelopes: readonly RecordedEnvelope[]): RecordedEvent[] {
  const parsed = JSON.parse(serializedEnvelopes(envelopes)) as Array<
    [unknown, Array<[{ readonly type?: string }, unknown]>]
  >
  return parsed
    .flatMap(([, items]) => items)
    .filter(([header]) => header.type === 'event')
    .map(([, payload]) => payload as RecordedEvent)
}

function countingLoader() {
  const loader = {
    loads: 0,
    loadSdk: async () => {
      loader.loads += 1
      return await import('@sentry/node')
    },
  }
  return loader
}

interface ArmOutcome {
  readonly reporter: boolean
  readonly loads: number
  readonly envelopes: number
}

// Both arms run through one recorder and one loader, so a dead instrument cannot pass the off arm.
async function driveArm(
  input: { readonly configPath: string; readonly dsn: string },
  recorder: RecordingReportTransport,
  loader: ReturnType<typeof countingLoader>,
): Promise<ArmOutcome> {
  const loadsBefore = loader.loads
  const envelopesBefore = recorder.envelopes.length
  const reporter = await startErrorReporting({
    ...input,
    transport: recorder.transport,
    loadSdk: loader.loadSdk,
  })
  reporter?.capture(new Error('an error on this arm'))
  await settleReporting()
  await closeErrorReporting()
  return {
    reporter: reporter !== undefined,
    loads: loader.loads - loadsBefore,
    envelopes: recorder.envelopes.length - envelopesBefore,
  }
}

function expectOffBesideOn(off: ArmOutcome, on: ArmOutcome): void {
  if (off.envelopes === 0 && on.envelopes === 0) {
    throw new Error(
      'Neither arm recorded an envelope, so the recorder is off the send path and the off arm ' +
        'proves nothing.',
    )
  }
  expect(off).toEqual({ reporter: false, loads: 0, envelopes: 0 })
  expect(on.reporter).toBe(true)
  expect(on.loads).toBe(1)
  expect(on.envelopes).toBeGreaterThan(0)
}

describe('the error reporter', () => {
  it('sends a captured error and its cause with stack frames, the release and the production environment, and no server name or user', async () => {
    const recorder = recordingReportTransport()
    const reporter = await startErrorReporting({
      configPath: projectWithPrivacy().configPath,
      dsn: INVENTED_DSN,
      transport: recorder.transport,
    })
    expect(reporter).toBeDefined()

    reporter?.capture(new Error('outer', { cause: new Error('root') }))
    await settleReporting()

    const events = recordedEvents(recorder.envelopes)
    expect(events).toHaveLength(1)
    const event = events[0]
    const values = event?.exception?.values ?? []
    expect(values.map((value) => value.value).sort()).toEqual(['outer', 'root'])
    for (const value of values) expect(value.stacktrace?.frames?.length ?? 0).toBeGreaterThan(0)
    expect(event?.release).toBe(`agent-qa@${CLI_ANALYTICS_AGENT_QA_VERSION}`)
    expect(event?.environment).toBe('production')
    expect(event).not.toHaveProperty('server_name')
    expect(event).not.toHaveProperty('user')
  })

  it('loads no SDK and sends nothing for a project with analytics.privacy true, while the on arm sends through the same recorder', async () => {
    const recorder = recordingReportTransport()
    const loader = countingLoader()

    const off = await driveArm(
      { configPath: projectWithPrivacy({ privacy: true }).configPath, dsn: INVENTED_DSN },
      recorder,
      loader,
    )
    const on = await driveArm(
      { configPath: projectWithPrivacy().configPath, dsn: INVENTED_DSN },
      recorder,
      loader,
    )

    expectOffBesideOn(off, on)
  })

  it('loads no SDK and sends nothing with a blank DSN, while the on arm sends through the same recorder', async () => {
    const recorder = recordingReportTransport()
    const loader = countingLoader()
    const { configPath } = projectWithPrivacy()

    const off = await driveArm({ configPath, dsn: '' }, recorder, loader)
    const on = await driveArm({ configPath, dsn: INVENTED_DSN }, recorder, loader)

    expectOffBesideOn(off, on)
  })

  it('adds no uncaughtException or unhandledRejection listener and writes nothing to stdout when it starts', async () => {
    const { configPath } = projectWithPrivacy()
    const uncaught = process.listenerCount('uncaughtException')
    const unhandled = process.listenerCount('unhandledRejection')
    const write = vi.spyOn(process.stdout, 'write')

    const reporter = await startErrorReporting({
      configPath,
      dsn: INVENTED_DSN,
      transport: recordingReportTransport().transport,
    })

    expect(reporter).toBeDefined()
    expect(write).not.toHaveBeenCalled()
    expect(process.listenerCount('uncaughtException')).toBe(uncaught)
    expect(process.listenerCount('unhandledRejection')).toBe(unhandled)
  })

  it('lets no SENTRY_ or CI variable of the shell into an envelope', async () => {
    const traceId = '5e17c0de'.repeat(4)
    const spanId = '5a17c0de'.repeat(2)
    const shell = {
      SENTRY_DSN: 'http://dsnkeycanary@127.0.0.1:9/7',
      SENTRY_RELEASE: 'releasecanary',
      SENTRY_ENVIRONMENT: 'environmentcanary',
      SENTRY_NAME: 'servernamecanary',
      SENTRY_DEBUG: 'true',
      SENTRY_TRACES_SAMPLE_RATE: '0',
      SENTRY_USE_ENVIRONMENT: 'true',
      SENTRY_TRACE: `${traceId}-${spanId}-1`,
      SENTRY_BAGGAGE: [
        'sentry-environment=baggageenvcanary',
        'sentry-release=baggagereleasecanary',
        `sentry-trace_id=${traceId}`,
      ].join(','),
      GITHUB_SHA: 'githubshacanary',
      AWS_REGION: 'awsregioncanary',
    }
    const canaries = [
      'dsnkeycanary',
      'releasecanary',
      'environmentcanary',
      'servernamecanary',
      traceId,
      spanId,
      'baggageenvcanary',
      'baggagereleasecanary',
      'githubshacanary',
      'awsregioncanary',
    ]
    for (const [name, value] of Object.entries(shell)) vi.stubEnv(name, value)
    const recorder = recordingReportTransport()
    const reporter = await startErrorReporting({
      configPath: projectWithPrivacy().configPath,
      dsn: INVENTED_DSN,
      transport: recorder.transport,
    })

    reporter?.capture(new Error('an error while the shell sets Sentry variables'))
    await settleReporting()

    expect(recorder.envelopes.length).toBeGreaterThan(0)
    const sent = serializedEnvelopes(recorder.envelopes)
    for (const canary of canaries) {
      expect(sent).not.toContain(canary)
      expect(sent).not.toContain(JSON.stringify(canary).slice(1, -1))
    }
  })

  it('sends error events and span containers only, with no session, log, profile, replay or client report item', async () => {
    const recorder = recordingReportTransport()
    const reporter = await startErrorReporting({
      configPath: projectWithPrivacy().configPath,
      dsn: INVENTED_DSN,
      transport: recorder.transport,
    })

    reporter?.beginCommandSpan('run', ['--config'])
    console.log('a line printed before the error')
    reporter?.capture(new Error('an error beside a span'))
    await settleReporting()
    await closeErrorReporting()

    const parsed = JSON.parse(serializedEnvelopes(recorder.envelopes)) as Array<
      [unknown, Array<[{ readonly type?: string }, unknown]>]
    >
    const types = parsed.flatMap(([, items]) => items).map(([header]) => header.type)
    expect([...new Set(types)].sort()).toEqual(['event', 'span'])
  })

  it('returns the reporter the first start built when it is started again', async () => {
    const loader = countingLoader()
    const input = {
      configPath: projectWithPrivacy().configPath,
      dsn: INVENTED_DSN,
      transport: recordingReportTransport().transport,
      loadSdk: loader.loadSdk,
    }

    const first = await startErrorReporting(input)
    const second = await startErrorReporting(input)

    expect(first).toBeDefined()
    expect(second).toBe(first)
    expect(errorReporter()).toBe(first)
    expect(loader.loads).toBe(1)
  })
})

describe('the reporting decision', () => {
  it('is on when there is no config file', async () => {
    const { dir } = projectWithPrivacy()

    await expect(
      decideErrorReporting({ configPath: join(dir, 'missing.yaml'), dsn: INVENTED_DSN }),
    ).resolves.toEqual({ on: true })
  })

  it('stays on, and sends, when DO_NOT_TRACK is set', async () => {
    vi.stubEnv('DO_NOT_TRACK', '1')
    const { configPath } = projectWithPrivacy()
    const recorder = recordingReportTransport()

    await expect(decideErrorReporting({ configPath, dsn: INVENTED_DSN })).resolves.toMatchObject({
      on: true,
    })
    const on = await driveArm({ configPath, dsn: INVENTED_DSN }, recorder, countingLoader())

    expect(on.reporter).toBe(true)
    expect(on.envelopes).toBeGreaterThan(0)
  })

  it('is off when the config path is a folder or a file that is not YAML', async () => {
    const { dir } = projectWithPrivacy()
    const folder = join(dir, 'folder.yaml')
    mkdirSync(folder)
    const notYaml = join(dir, 'not-yaml.yaml')
    writeFileSync(notYaml, '{ analytics: [unclosed\n', 'utf8')

    await expect(decideErrorReporting({ configPath: folder, dsn: INVENTED_DSN })).resolves.toEqual({
      on: false,
    })
    await expect(
      decideErrorReporting({ configPath: notYaml, dsn: INVENTED_DSN }),
    ).resolves.toEqual({ on: false })
  })

  it('reads the privacy flag raw from a config that fails the schema', async () => {
    const { dir } = projectWithPrivacy()
    const declaring = join(dir, 'declaring.yaml')
    writeFileSync(declaring, 'workspace: 42\nanalytics:\n  privacy: true\n', 'utf8')
    const silent = join(dir, 'silent.yaml')
    writeFileSync(silent, 'workspace: 42\n', 'utf8')

    await expect(
      decideErrorReporting({ configPath: declaring, dsn: INVENTED_DSN }),
    ).resolves.toEqual({ on: false })
    await expect(decideErrorReporting({ configPath: silent, dsn: INVENTED_DSN })).resolves.toEqual({
      on: true,
      document: { workspace: 42 },
    })
  })
})

function exceptionValues(envelopes: readonly RecordedEnvelope[]): Array<string | undefined> {
  return recordedEvents(envelopes)
    .flatMap((event) => event.exception?.values ?? [])
    .map((value) => value.value)
}

// Replaces one marker word and keeps every text it was handed, so a cell reads what it saw.
function markerMask(word: string) {
  const mask = {
    inputs: [] as string[],
    apply: (text: string) => {
      mask.inputs.push(text)
      return text.replaceAll(word, `[${word} masked]`)
    },
  }
  return mask
}

describe('the report mask', () => {
  it('masks a declared secret in an error message and in its linked cause and keeps the other words', async () => {
    const recorder = recordingReportTransport()
    const reporter = await startErrorReporting({
      configPath: projectWithPrivacy({ secrets: { API_TOKEN: SECRET } }).configPath,
      dsn: INVENTED_DSN,
      transport: recorder.transport,
    })

    reporter?.capture(
      new Error(`outer request with ${SECRET} failed`, {
        cause: new Error(`root refusal of ${SECRET}`),
      }),
    )
    await settleReporting()

    const sent = serializedEnvelopes(recorder.envelopes)
    const values = exceptionValues(recorder.envelopes).join('\n')
    expect(recorder.envelopes.length).toBeGreaterThan(0)
    expect(sent).not.toContain(SECRET)
    expect(sent).not.toContain(JSON.stringify(SECRET).slice(1, -1))
    expect(values).toContain('outer request with')
    expect(values).toContain('failed')
    expect(values).toContain('root refusal of')
  })

  it('drops every envelope while the secrets file cannot be read, and the same recorder sees a readable one', async () => {
    const recorder = recordingReportTransport()
    const readable = projectWithPrivacy({ secrets: { API_TOKEN: SECRET } })
    const unreadable = projectWithPrivacy({ secrets: { API_TOKEN: SECRET } })
    rmSync(unreadable.secretsPath)
    mkdirSync(unreadable.secretsPath)
    const sentFrom = async (configPath: string) => {
      const before = recorder.envelopes.length
      const reporter = await startErrorReporting({
        configPath,
        dsn: INVENTED_DSN,
        transport: recorder.transport,
      })
      reporter?.capture(new Error(`an error quoting ${SECRET}`))
      await settleReporting()
      await closeErrorReporting()
      return recorder.envelopes.length - before
    }

    const blocked = await sentFrom(unreadable.configPath)
    const sent = await sentFrom(readable.configPath)

    expect(sent).toBeGreaterThan(0)
    expect(blocked).toBe(0)
  })

  it('sends the report of a project with no config file and of a config that names no secrets file', async () => {
    const recorder = recordingReportTransport()
    const { dir } = projectWithPrivacy()
    const unnamed = join(dir, 'names-no-secrets-file.yaml')
    writeFileSync(unnamed, 'use:\n  mobile:\n    appState: reset\n', 'utf8')
    const projects = [
      { configPath: join(dir, 'missing.yaml'), message: 'an error with no config file' },
      { configPath: unnamed, message: 'an error with no secrets file named' },
    ]

    for (const { configPath, message } of projects) {
      const reporter = await startErrorReporting({
        configPath,
        dsn: INVENTED_DSN,
        transport: recorder.transport,
      })
      reporter?.capture(new Error(message))
      await settleReporting()
      await closeErrorReporting()
    }

    expect(exceptionValues(recorder.envelopes)).toEqual([
      'an error with no config file',
      'an error with no secrets file named',
    ])
  })

  it('rewrites the home folder to a tilde in a captured message and in its stack frames', async () => {
    const home = '/Users/canary-user'
    const recorder = recordingReportTransport()
    const reporter = await startErrorReporting({
      configPath: projectWithPrivacy().configPath,
      dsn: INVENTED_DSN,
      homeDir: home,
      transport: recorder.transport,
    })
    const error = new Error(`cannot read ${home}/project/agent-qa.config.yaml`)
    error.stack = [
      `Error: cannot read ${home}/project/agent-qa.config.yaml`,
      `    at readConfig (${home}/project/node_modules/agent-qa/dist/cli.js:10:5)`,
      `    at file://${home}/project/hooks.mjs:3:1`,
    ].join('\n')

    reporter?.capture(error)
    await settleReporting()

    const sent = serializedEnvelopes(recorder.envelopes)
    expect(exceptionValues(recorder.envelopes)).toEqual([
      'cannot read ~/project/agent-qa.config.yaml',
    ])
    expect(sent).toContain('"filename":"~/project/node_modules/agent-qa/dist/cli.js"')
    expect(sent).toContain('"filename":"~/project/hooks.mjs"')
    expect(sent).not.toContain('canary-user')
  })

  it('applies a bound mask after the declared one while its binding is open, and two open bindings both', async () => {
    const recorder = recordingReportTransport()
    const reporter = await startErrorReporting({
      configPath: projectWithPrivacy({ secrets: { API_TOKEN: SECRET } }).configPath,
      dsn: INVENTED_DSN,
      transport: recorder.transport,
    })
    const alpha = markerMask('alpha')
    const beta = markerMask('beta')
    reporter?.bindMask(alpha.apply)
    reporter?.bindMask(beta.apply)

    reporter?.capture(new Error(`alpha beta gamma ${SECRET}`))
    await settleReporting()

    expect(exceptionValues(recorder.envelopes)).toEqual([
      '[alpha masked] [beta masked] gamma [secret:API_TOKEN]',
    ])
    expect(alpha.inputs.some((text) => text.includes('[secret:API_TOKEN]'))).toBe(true)
    expect(alpha.inputs.some((text) => text.includes(SECRET))).toBe(false)
    expect(beta.inputs.some((text) => text.includes('[alpha masked]'))).toBe(true)
  })

  it('keeps every mask that ended in the last minute, after other bindings ended, and the newest however old', async () => {
    const recorder = recordingReportTransport()
    let clock = 0
    const reporter = await startErrorReporting({
      configPath: projectWithPrivacy().configPath,
      dsn: INVENTED_DSN,
      transport: recorder.transport,
      now: () => clock,
    })
    const alpha = markerMask('alpha')
    const beta = markerMask('beta')
    const reported = async (message: string) => {
      const before = recorder.envelopes.length
      reporter?.capture(new Error(message))
      await settleReporting()
      return exceptionValues(recorder.envelopes.slice(before))
    }

    const endAlpha = reporter?.bindMask(alpha.apply)
    endAlpha?.()
    endAlpha?.()
    clock += 30_000
    reporter?.bindMask(beta.apply)()
    expect(await reported('alpha beta one')).toEqual(['[alpha masked] [beta masked] one'])

    clock += 30_001
    const alphaCalls = alpha.inputs.length
    expect(await reported('alpha beta two')).toEqual(['alpha [beta masked] two'])
    expect(alpha.inputs.length).toBe(alphaCalls)

    clock += 3_600_000
    expect(await reported('alpha beta three')).toEqual(['alpha [beta masked] three'])
  })

  it('keeps a bounded number of ended masks, the newest, however many end at once', async () => {
    const recorder = recordingReportTransport()
    const reporter = await startErrorReporting({
      configPath: projectWithPrivacy().configPath,
      dsn: INVENTED_DSN,
      transport: recorder.transport,
      now: () => 0,
    })
    const marks = Array.from({ length: 1_000 }, (_, index) => markerMask(`mark${index}x`))

    for (const mark of marks) reporter?.bindMask(mark.apply)()
    reporter?.capture(new Error('mark0x mark998x mark999x'))
    await settleReporting()

    expect(exceptionValues(recorder.envelopes)).toEqual([
      'mark0x [mark998x masked] [mark999x masked]',
    ])
    expect(marks[0]?.inputs).toEqual([])
  })
})

describe('saved credentials', () => {
  it('are the tokens and keys of the auth store, and none from a missing or malformed store', async () => {
    const authPath = authStore({
      anthropic: {
        type: 'oauth',
        provider: 'anthropic',
        tokens: {
          access: 'access-Hunter-42-zz',
          refresh: 'refresh-Hunter-42-zz',
          expires: 0,
          accountId: 'account-canary',
        },
      },
      openai: { type: 'api', provider: 'openai', key: 'key-Hunter-42-zz' },
      gateway: { type: 'bearer', provider: 'gateway', token: 'token-Hunter-42-zz' },
      broken: { type: 'oauth', provider: 'broken', tokens: null },
      blank: { type: 'api', provider: 'blank', key: '' },
    })
    const malformed = join(authFolder(), 'auth.json')
    writeFileSync(malformed, '{ "anthropic": ', 'utf8')

    await expect(readSavedCredentialValues(authPath)).resolves.toEqual([
      'access-Hunter-42-zz',
      'refresh-Hunter-42-zz',
      'key-Hunter-42-zz',
      'token-Hunter-42-zz',
    ])
    await expect(readSavedCredentialValues(join(authFolder(), 'auth.json'))).resolves.toEqual([])
    await expect(readSavedCredentialValues(malformed)).resolves.toEqual([])
  })

  it('are masked when an error message quotes a saved refresh token', async () => {
    const refresh = 'refresh-Hunter-42-zz'
    const authPath = authStore({
      anthropic: {
        type: 'oauth',
        provider: 'anthropic',
        tokens: { access: 'access-Hunter-42-zz', refresh, expires: 0 },
      },
    })
    const recorder = recordingReportTransport()
    const reporter = await startErrorReporting({
      configPath: projectWithPrivacy().configPath,
      dsn: INVENTED_DSN,
      authPath,
      transport: recorder.transport,
    })

    reporter?.capture(
      new Error(`Token refresh failed: {"error":"invalid_grant","refresh_token":"${refresh}"}`),
    )
    await settleReporting()

    expect(recorder.envelopes.length).toBeGreaterThan(0)
    expect(serializedEnvelopes(recorder.envelopes)).not.toContain(refresh)
    expect(exceptionValues(recorder.envelopes)).toEqual([
      'Token refresh failed: {"error":"invalid_grant","refresh_token":"[secret:SAVED_CREDENTIAL]"}',
    ])
  })
})

describe('repeats', () => {
  async function startRecording() {
    const recorder = recordingReportTransport()
    const reporter = await startErrorReporting({
      configPath: projectWithPrivacy().configPath,
      dsn: INVENTED_DSN,
      transport: recorder.transport,
    })
    return { recorder, reporter }
  }

  const errorFrom = (message: string) => new Error(message)

  it('sends error A and error B once each when A is captured, again, then B, then A', async () => {
    const { recorder, reporter } = await startRecording()

    for (const message of ['error A', 'error A', 'error B', 'error A']) {
      reporter?.capture(errorFrom(message))
    }
    await settleReporting()

    expect(exceptionValues(recorder.envelopes).sort()).toEqual(['error A', 'error B'])
  })

  it('sends the same message thrown from two call sites as two errors', async () => {
    const { recorder, reporter } = await startRecording()

    reporter?.capture(new Error('one message'))
    reporter?.capture(new Error('one message'))
    await settleReporting()

    expect(exceptionValues(recorder.envelopes)).toEqual(['one message', 'one message'])
  })

  it('sends forty distinct errors, since there is no cap', async () => {
    const { recorder, reporter } = await startRecording()

    const messages = Array.from({ length: 40 }, (_, index) => `distinct error ${index}`)
    for (const message of messages) reporter?.capture(errorFrom(message))
    await settleReporting()

    expect(exceptionValues(recorder.envelopes).sort()).toEqual(messages.sort())
  })

  it('sends two errors that wrap one cause in different messages', async () => {
    const { recorder, reporter } = await startRecording()
    const causeFrom = () => new Error('the shared cause')
    const wrapped = (message: string) => new Error(message, { cause: causeFrom() })

    // The unrelated error sits between them, since the SDK drops an event equal to the one before.
    for (const message of ['loading the config failed', 'loading the tests failed']) {
      reporter?.capture(wrapped(message))
      reporter?.capture(errorFrom('an unrelated error'))
    }
    await settleReporting()

    const reported = recordedEvents(recorder.envelopes).map(
      (event) => event.exception?.values?.at(-1)?.value,
    )
    expect(reported.sort()).toEqual([
      'an unrelated error',
      'loading the config failed',
      'loading the tests failed',
    ])
  })
})

const FACTS_CONFIG = [
  'registry:',
  '  targets:',
  '    shop: { platform: web, url: "https://shop.example" }',
  '    phone: { platform: android, appPackage: com.example.app }',
  '  llms:',
  '    - { name: main, provider: openai-compatible, model: gpt-y, baseURL: "http://127.0.0.1:9" }',
  'plugins:',
  "  - { name: kernel, package: '@vostride/agent-qa-plugin-kernel' }",
  '  - { name: local, path: ./plugins/local }',
  '',
].join('\n')

// `agent-qa --config <path> daemon status --json`, parsed by a tree shaped like the real one.
async function daemonStatus(configPath: string): Promise<{ root: Command; action: Command }> {
  const root = new Command('agent-qa')
    .exitOverride()
    .enablePositionalOptions()
    .option('--config <path>', 'config file path', 'agent-qa.config.yaml')
  const action = root
    .command('daemon')
    .command('status')
    .option('--json')
    .action(() => {})
  await root.parseAsync(['node', 'agent-qa', '--config', configPath, 'daemon', 'status', '--json'])
  return { root, action }
}

function consoleLines(event: RecordedEvent | undefined): Array<string | undefined> {
  return (event?.breadcrumbs ?? [])
    .filter((breadcrumb) => breadcrumb.category === 'console')
    .map((breadcrumb) => breadcrumb.message)
}

describe('environment facts and log lines', () => {
  it('sends the command, its flag names, the package manager, CI, the platforms, models and plugins, and the OS, architecture and Node version', async () => {
    vi.stubEnv('npm_config_user_agent', 'pnpm/10.20.0 npm/? node/v24.0.0 darwin arm64')
    vi.stubEnv('CI', 'true')
    const configPath = join(projectWithPrivacy().dir, 'facts.yaml')
    writeFileSync(configPath, FACTS_CONFIG, 'utf8')
    const { root, action } = await daemonStatus(configPath)
    const recorder = recordingReportTransport()
    await startCliErrorReporting(root, action, {
      start: (input) =>
        startErrorReporting({ ...input, dsn: INVENTED_DSN, transport: recorder.transport }),
      installHandlers: () => {},
    })

    errorReporter()?.capture(new Error('an error with the facts set'))
    await settleReporting()

    const [event] = recordedEvents(recorder.envelopes)
    expect(event?.tags).toEqual({ command: 'daemon status', package_manager: 'pnpm', ci: 'ci' })
    expect(event?.contexts?.agent_qa).toEqual({
      flags: ['--config', '--json'],
      platforms: ['android', 'web'],
      models: ['openai-compatible/gpt-y'],
      plugins: ['kernel', 'third_party'],
    })
    const os = event?.contexts?.os
    expect(os?.name).toEqual(expect.any(String))
    expect([os?.kernel_version, os?.version]).toContain(release())
    expect(event?.contexts?.device?.arch).toBe(process.arch)
    expect(event?.contexts?.runtime).toEqual({ name: 'node', version: process.version })
    expect(Object.keys(event?.contexts?.culture ?? {})).toEqual([])
    expect(event).not.toHaveProperty('modules')
    expect(JSON.stringify(event)).not.toMatch(/"(?:locale|timezone)":/)
  })

  it('sends the console lines printed before an error as its breadcrumbs, in order, with a declared secret masked', async () => {
    const recorder = recordingReportTransport()
    const reporter = await startErrorReporting({
      configPath: projectWithPrivacy({ secrets: { API_TOKEN: SECRET } }).configPath,
      dsn: INVENTED_DSN,
      transport: recorder.transport,
    })

    console.error('the first line printed before the error')
    console.error(`the second line quotes ${SECRET}`)
    reporter?.capture(new Error('the error after two printed lines'))
    await settleReporting()

    const [event] = recordedEvents(recorder.envelopes)
    expect(consoleLines(event).slice(-2)).toEqual([
      'the first line printed before the error',
      'the second line quotes [secret:API_TOKEN]',
    ])
    expect(serializedEnvelopes(recorder.envelopes)).not.toContain(SECRET)
  })

  it('sends no log line when no error follows it, and the line rides on the next error', async () => {
    const recorder = recordingReportTransport()
    const reporter = await startErrorReporting({
      configPath: projectWithPrivacy().configPath,
      dsn: INVENTED_DSN,
      transport: recorder.transport,
    })

    reporter?.beginCommandSpan('probe', [])
    console.error('a line printed with no error after it')
    console.error('another line printed with no error after it')
    await settleReporting()
    const sentWithNoError = recorder.envelopes.length
    const quiet = serializedEnvelopes(recorder.envelopes)
    reporter?.capture(new Error('an error printed later'))
    await settleReporting()

    expect(sentWithNoError).toBeGreaterThan(0)
    expect(quiet).not.toContain('a line printed with no error after it')
    expect(quiet).not.toContain('another line printed with no error after it')
    expect(consoleLines(recordedEvents(recorder.envelopes).at(-1)).slice(-2)).toEqual([
      'a line printed with no error after it',
      'another line printed with no error after it',
    ])
  })

  it('leaves none of the facts of a closed reporter on the reports of the next one', async () => {
    const recorder = recordingReportTransport()
    const { configPath } = projectWithPrivacy()
    const first = await startErrorReporting({
      configPath,
      dsn: INVENTED_DSN,
      transport: recorder.transport,
    })
    first?.setFacts({
      command: 'first command',
      flags: ['--json'],
      packageManager: 'npm',
      ci: false,
      platforms: ['web'],
      models: ['openai-compatible/gpt-y'],
      plugins: ['kernel'],
    })
    first?.capture(new Error('an error while the first reporter is open'))
    await settleReporting()
    await closeErrorReporting()

    const second = await startErrorReporting({
      configPath,
      dsn: INVENTED_DSN,
      transport: recorder.transport,
    })
    second?.capture(new Error('an error after the first reporter closed'))
    await settleReporting()

    const [before, after] = recordedEvents(recorder.envelopes)
    expect(before?.tags).toMatchObject({ command: 'first command' })
    expect(after?.tags ?? {}).toEqual({})
    expect(after?.contexts).not.toHaveProperty('agent_qa')
  })
})

// The SDK keeps this many breadcrumbs, as the reporter's client is built to.
const BREADCRUMB_BUFFER = 100

// Breadcrumbs sit on the SDK's process-wide scope, so each cell here starts and ends without any.
async function sdkWithNoBreadcrumbs(): Promise<SentrySdk> {
  const sdk = await import('@sentry/node')
  sdk.getIsolationScope().clearBreadcrumbs()
  return sdk
}

// The breadcrumbs of every event, as the envelope reached the transport, before it is serialized.
function breadcrumbsHandedToTransport(envelopes: readonly RecordedEnvelope[]): object[] {
  return (envelopes as unknown as Array<[unknown, Array<[unknown, { breadcrumbs?: object[] }]>]>)
    .flatMap(([, items]) => items)
    .flatMap(([, payload]) => payload.breadcrumbs ?? [])
}

describe('a line printed while a binding is open', () => {
  afterEach(async () => {
    await sdkWithNoBreadcrumbs()
  })

  it('leaves with the masks in force when it was printed, after other bindings ended and once the mask learned what it quotes', async () => {
    const recorder = recordingReportTransport()
    const reporter = await startErrorReporting({
      configPath: projectWithPrivacy().configPath,
      dsn: INVENTED_DSN,
      transport: recorder.transport,
      loadSdk: sdkWithNoBreadcrumbs,
    })
    // Minted here, so the only way into a report is the printed line.
    const token = ['lab', 'token', randomBytes(6).toString('hex')].join('-')
    const url = `wss://lab.invalid/playwright?token=${token}`
    const redactor = new RunSecretRedactor(new SecretStore([]))
    const end = reporter?.bindMask((text) => redactor.redactString(text))

    console.error(`connecting to ${url}`)
    redactor.addMaskExtras([
      [pluginMaskName('lab'), url],
      [pluginMaskName('lab'), token],
    ])
    end?.()
    console.error(`closed the session at ${url}`)
    reporter?.bindMask((text) => text)()
    console.error('a line printed after both bindings ended')
    reporter?.capture(new Error('an error after both bindings ended'))
    await settleReporting()

    const masked = `[secret:${pluginMaskName('lab')}]`
    expect(consoleLines(recordedEvents(recorder.envelopes).at(-1))).toEqual([
      `connecting to ${masked}`,
      `closed the session at ${masked}`,
      'a line printed after both bindings ended',
    ])
    expect(serializedEnvelopes(recorder.envelopes)).not.toContain(token)
    const marked = breadcrumbsHandedToTransport(recorder.envelopes).filter(
      (breadcrumb) => Object.getOwnPropertySymbols(breadcrumb).length > 0,
    )
    expect(marked, 'a breadcrumb reached the transport with a marker on it').toEqual([])
  })

  it('keeps the mask that ended last on a line printed just after its binding ended', async () => {
    const recorder = recordingReportTransport()
    const reporter = await startErrorReporting({
      configPath: projectWithPrivacy().configPath,
      dsn: INVENTED_DSN,
      transport: recorder.transport,
      loadSdk: sdkWithNoBreadcrumbs,
    })
    const kappa = markerMask('kappa')

    reporter?.bindMask(kappa.apply)()
    console.error('the kappa run has ended')
    reporter?.bindMask((text) => text)()
    reporter?.capture(new Error('an error after another binding ended'))
    await settleReporting()

    expect(consoleLines(recordedEvents(recorder.envelopes).at(-1))).toEqual([
      'the [kappa masked] run has ended',
    ])
  })

  it('masks a line printed after its binding and another one ended with the masks of both', async () => {
    const recorder = recordingReportTransport()
    const reporter = await startErrorReporting({
      configPath: projectWithPrivacy().configPath,
      dsn: INVENTED_DSN,
      transport: recorder.transport,
      loadSdk: sdkWithNoBreadcrumbs,
    })
    const kappa = markerMask('kappa')
    const lambda = markerMask('lambda')

    reporter?.bindMask(kappa.apply)()
    reporter?.bindMask(lambda.apply)()
    console.error('a late line from the kappa and the lambda sessions')
    reporter?.capture(new Error('an error after both sessions ended'))
    await settleReporting()

    expect(consoleLines(recordedEvents(recorder.envelopes).at(-1))).toEqual([
      'a late line from the [kappa masked] and the [lambda masked] sessions',
    ])
  })

  it('lets a mask go once every line printed under it has left the breadcrumb buffer and its minute has passed', async () => {
    const recorder = recordingReportTransport()
    let clock = 0
    const reporter = await startErrorReporting({
      configPath: projectWithPrivacy().configPath,
      dsn: INVENTED_DSN,
      transport: recorder.transport,
      loadSdk: sdkWithNoBreadcrumbs,
      now: () => clock,
    })
    const sdk = await import('@sentry/node')
    const kappa = markerMask('kappa')
    const end = reporter?.bindMask(kappa.apply)
    console.error('a line printed while kappa was bound')
    end?.()
    reporter?.bindMask((text) => text)()
    const reported = async (message: string) => {
      const before = { envelopes: recorder.envelopes.length, calls: kappa.inputs.length }
      reporter?.capture(new Error(message))
      await settleReporting()
      return {
        values: exceptionValues(recorder.envelopes.slice(before.envelopes)),
        calls: kappa.inputs.length - before.calls,
      }
    }

    const whileBuffered = await reported('kappa one')
    // The later lines are recorded once kappa's minute has passed, so none carries its mask.
    clock += 60_001
    for (let line = 0; line < BREADCRUMB_BUFFER; line += 1) {
      sdk.addBreadcrumb({ category: 'console', message: `a later line ${line}` })
    }
    const afterwards = await reported('kappa two')

    expect(whileBuffered.values).toEqual(['[kappa masked] one'])
    expect(whileBuffered.calls, 'kappa while its line is buffered').toBeGreaterThan(0)
    expect(afterwards.values).toEqual(['kappa two'])
    expect(afterwards.calls, 'kappa once its line has left the buffer').toBe(0)
  })
})

interface RecordedSpan {
  readonly name?: string
  readonly trace_id?: string
  readonly span_id?: string
  readonly parent_span_id?: string
  readonly status?: string
  readonly start_timestamp?: number
  readonly attributes?: Readonly<Record<string, { readonly value?: unknown }>>
}

// Streamed spans, read back from the JSON text like the events.
function recordedSpans(envelopes: readonly RecordedEnvelope[]): RecordedSpan[] {
  const parsed = JSON.parse(serializedEnvelopes(envelopes)) as Array<
    [unknown, Array<[{ readonly type?: string }, { readonly items?: RecordedSpan[] }]>]
  >
  return parsed
    .flatMap(([, items]) => items)
    .filter(([header]) => header.type === 'span')
    .flatMap(([, payload]) => payload.items ?? [])
}

function attributeOf(span: RecordedSpan | undefined, key: string): unknown {
  return span?.attributes?.[key]?.value
}

function commandSpans(envelopes: readonly RecordedEnvelope[]): RecordedSpan[] {
  return recordedSpans(envelopes).filter(
    (span) => attributeOf(span, 'sentry.op') === 'agent_qa.command',
  )
}

describe('spans', () => {
  async function startRecording(input: { readonly loadSdk?: () => Promise<SentrySdk> } = {}) {
    const recorder = recordingReportTransport()
    const reporter = await startErrorReporting({
      configPath: projectWithPrivacy().configPath,
      dsn: INVENTED_DSN,
      transport: recorder.transport,
      ...input,
    })
    if (reporter === undefined) throw new Error('the reporter did not start')
    return { recorder, reporter }
  }

  it('sends the command as an agent_qa.command root span named after its path, with its flag names, once the settle step ends it', async () => {
    const { recorder, reporter } = await startRecording()

    reporter.beginCommandSpan('daemon status', ['--config', '--json'])
    const beforeSettle = commandSpans(recorder.envelopes)
    await settleReporting()

    expect(beforeSettle).toEqual([])
    const spans = commandSpans(recorder.envelopes)
    expect(spans.map((span) => span.name)).toEqual(['agent-qa daemon status'])
    expect(attributeOf(spans[0], 'agent_qa.command')).toBe('daemon status')
    expect(attributeOf(spans[0], 'agent_qa.flags')).toEqual(['--config', '--json'])
    expect(spans[0]?.parent_span_id).toBeUndefined()
  })

  it('gives an error captured during the command the trace id of the command span', async () => {
    const { recorder, reporter } = await startRecording()

    reporter.beginCommandSpan('probe', [])
    reporter.capture(new Error('an error during the command'))
    await settleReporting()

    const spans = commandSpans(recorder.envelopes)
    const [event] = recordedEvents(recorder.envelopes)
    expect(spans).toHaveLength(1)
    expect(spans[0]?.trace_id).toMatch(/^[0-9a-f]{32}$/)
    expect(event?.contexts?.trace?.trace_id).toBe(spans[0]?.trace_id)
  })

  it('ends the command span once when it settles twice', async () => {
    const { recorder, reporter } = await startRecording()

    reporter.beginCommandSpan('probe', [])
    await settleReporting()
    await settleReporting()

    expect(commandSpans(recorder.envelopes)).toHaveLength(1)
  })

  it('starts a child under an explicit parent, a root in a new trace, and a span at the start time it is given', async () => {
    const { recorder, reporter } = await startRecording()
    const startTime = Date.now() - 60_000

    const run = reporter.startSpan({
      op: 'agent_qa.run',
      name: 'run',
      attributes: { 'agent_qa.platforms': ['web'] },
    })
    const test = reporter.startSpan({ op: 'agent_qa.test', name: 'test', parent: run })
    const tool = reporter.startSpan({
      op: 'agent_qa.mcp_tool',
      name: 'tool',
      newTrace: true,
      startTime,
    })
    test.setAttributes({ 'agent_qa.test_index': 0 })
    test.end('error')
    run.end('ok')
    tool.end()
    await settleReporting()

    const spans = recordedSpans(recorder.envelopes)
    expect(spans.map((span) => span.name).sort()).toEqual(['run', 'test', 'tool'])
    const [runSpan, testSpan, toolSpan] = ['run', 'test', 'tool'].map((name) =>
      spans.find((span) => span.name === name),
    )
    expect(testSpan?.parent_span_id).toBe(runSpan?.span_id)
    expect(testSpan?.trace_id).toBe(runSpan?.trace_id)
    expect(attributeOf(runSpan, 'agent_qa.platforms')).toEqual(['web'])
    expect(attributeOf(testSpan, 'agent_qa.test_index')).toBe(0)
    expect([runSpan?.status, testSpan?.status]).toEqual(['ok', 'error'])
    expect(toolSpan?.trace_id).toMatch(/^[0-9a-f]{32}$/)
    expect(toolSpan?.trace_id).not.toBe(runSpan?.trace_id)
    expect(toolSpan?.parent_span_id).toBeUndefined()
    expect(toolSpan?.start_timestamp).toBeCloseTo(startTime / 1000, 0)
  })

  it('hands back a span that does nothing when the SDK cannot start one, and no span call throws', async () => {
    const sdk = await import('@sentry/node')
    const refuse = () => {
      throw new Error('the SDK refused a span')
    }
    const { recorder, reporter } = await startRecording({
      loadSdk: async () => ({ ...sdk, startInactiveSpan: refuse, startNewTrace: refuse }),
    })

    const spans = [
      reporter.startSpan({ op: 'agent_qa.run', name: 'run' }),
      reporter.startSpan({ op: 'agent_qa.run', name: 'run in a new trace', newTrace: true }),
    ]
    for (const span of spans) {
      expect(() => span.setAttributes({ 'agent_qa.test_index': 1 })).not.toThrow()
      expect(() => span.end('error')).not.toThrow()
    }
    expect(() => reporter.beginCommandSpan('probe', [])).not.toThrow()
    await settleReporting()

    expect(recordedSpans(recorder.envelopes)).toEqual([])
  })
})

describe('settling', () => {
  it('only awaits the analytics shutdown it is handed when no reporter exists', async () => {
    const steps: string[] = []
    const analytics = {
      shutdown: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20))
        steps.push('analytics shut down')
      },
    }

    await settleReporting({ analytics })
    steps.push('settled')

    expect(errorReporter()).toBeUndefined()
    expect(steps).toEqual(['analytics shut down', 'settled'])
  })

  it('runs the analytics shutdown beside the flush and returns at the shared budget when the transport never settles', async () => {
    const recorder = recordingReportTransport({ hang: true })
    const reporter = await startErrorReporting({
      configPath: projectWithPrivacy().configPath,
      dsn: INVENTED_DSN,
      transport: recorder.transport,
    })
    reporter?.capture(new Error('an error on a dead network'))
    const shutdown = vi.fn(async () => {})

    const started = performance.now()
    await settleReporting({ analytics: { shutdown } })
    const waited = performance.now() - started

    expect(recorder.envelopes).toHaveLength(1)
    expect(shutdown).toHaveBeenCalledTimes(1)
    expect(waited).toBeGreaterThanOrEqual(DEFAULT_ANALYTICS_SHUTDOWN_TIMEOUT_MS - 50)
    expect(waited).toBeLessThan(DEFAULT_ANALYTICS_SHUTDOWN_TIMEOUT_MS + 1_500)
  })
})

const CLI_SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const ANALYTICS_SRC = resolve(CLI_SRC, '..', '..', 'analytics', 'src')
const REPORTER_FILE = join('composition', 'error-reporting.ts')

const REPO_ROOT = resolve(CLI_SRC, '..', '..', '..')
const ANY_SENTRY_IMPORT = /\b(?:from|import|require)\s*\(?\s*(['"`])@sentry\//

// Every workspace member's folder: each package and each plugin.
function memberDirs(): string[] {
  return ['packages', 'plugins'].flatMap((group) =>
    readdirSync(join(REPO_ROOT, group), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(REPO_ROOT, group, entry.name)),
  )
}

function memberSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : memberSourceFiles(path)
    return /\.(?:[cm]?[jt]s|[jt]sx)$/.test(entry.name) && !/\.test\./.test(entry.name) ? [path] : []
  })
}

function sentryDependencies(dir: string): Array<[string, string]> {
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Readonly<
    Record<string, Readonly<Record<string, string>> | undefined>
  >
  return ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
    .flatMap((field) => Object.entries(manifest[field] ?? {}))
    .filter(([name]) => name.startsWith('@sentry/'))
}

function shippedSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : shippedSourceFiles(path)
    return entry.name.endsWith('.ts') ? [path] : []
  })
}

// Comments go and string literals stay, so prose about the SDK is never read as an import.
function withoutComments(source: string): string {
  let out = ''
  let quote: string | undefined
  let index = 0
  while (index < source.length) {
    const char = source[index] as string
    const next = source[index + 1]
    if (quote !== undefined) {
      out += char
      if (char === '\\') {
        out += next ?? ''
        index += 2
        continue
      }
      if (char === quote) quote = undefined
      index += 1
      continue
    }
    if (char === '/' && next === '/') {
      const end = source.indexOf('\n', index)
      index = end === -1 ? source.length : end
      continue
    }
    if (char === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2)
      index = end === -1 ? source.length : end + 2
      continue
    }
    if (char === '"' || char === "'" || char === '`') quote = char
    out += char
    index += 1
  }
  return out
}

// The specifier where a module loads it; a name in a list, as in the ownership contract, is not.
const SDK_IMPORT = /\b(?:from|import|require)\s*\(?\s*(['"`])@sentry\/node(?:\/[^'"`]*)?\1/g
const SDK_TYPE_IMPORT =
  /\bimport\s+type\s+(?:\*\s+as\s+[\w$]+|\{[^}]*\}|[\w$]+)\s+from\s+(['"])@sentry\/node(?:\/[^'"]*)?\1/g
const SDK_DYNAMIC_IMPORT = /\bawait\s+import\(\s*(['"])@sentry\/node\1\s*\)/g

function sdkImports(code: string): { types: number; dynamic: number; other: number } {
  const count = (pattern: RegExp) => [...code.matchAll(pattern)].length
  const types = count(SDK_TYPE_IMPORT)
  const dynamic = count(SDK_DYNAMIC_IMPORT)
  return { types, dynamic, other: count(SDK_IMPORT) - types - dynamic }
}

const SENTRY_ENV_READS = [
  /\benv\s*(?:\?\.|\.)\s*SENTRY_/,
  /\benv\s*(?:\?\.)?\[\s*['"`]SENTRY_/,
  /\{[^}]*\bSENTRY_\w*[^}]*\}\s*=\s*(?:process\s*\.\s*)?env\b/,
]

function readsSentryVariable(code: string): boolean {
  return SENTRY_ENV_READS.some((pattern) => pattern.test(code))
}

describe('the shipped source', () => {
  it('imports the SDK by one dynamic import in the error reporter and elsewhere only as types', () => {
    expect(sdkImports("import * as Sentry from '@sentry/node'\n").other).toBe(1)
    expect(sdkImports("import { type NodeClient } from '@sentry/node'\n").other).toBe(1)
    expect(sdkImports("const sdk = require('@sentry/node')\n").other).toBe(1)
    expect(sdkImports("const sdk = import('@sentry/node')\n").other).toBe(1)
    expect(sdkImports("import type { NodeClient } from '@sentry/node'\n")).toEqual({
      types: 1,
      dynamic: 0,
      other: 0,
    })
    expect(sdkImports("const sdk = await import('@sentry/node')\n")).toEqual({
      types: 0,
      dynamic: 1,
      other: 0,
    })
    expect(sdkImports("export const NAMES = ['@sentry/node']\n").other).toBe(0)
    expect(sdkImports(withoutComments("// import * as Sentry from '@sentry/node'\n")).other).toBe(0)

    const files = shippedSourceFiles(CLI_SRC)
    const imports = new Map(
      files.map((file) => [
        relative(CLI_SRC, file),
        sdkImports(withoutComments(readFileSync(file, 'utf8'))),
      ]),
    )
    const offenders = [...imports]
      .filter(([file, found]) => found.other > 0 || (found.dynamic > 0 && file !== REPORTER_FILE))
      .map(([file]) => file)

    expect(files.length).toBeGreaterThan(10)
    expect(offenders).toEqual([])
    expect(imports.get(REPORTER_FILE)?.dynamic).toBe(1)
  })

  it('loads a Sentry SDK from no package or plugin but the CLI, which depends on one exact version', () => {
    expect(ANY_SENTRY_IMPORT.test("import { init } from '@sentry/browser'\n")).toBe(true)
    expect(ANY_SENTRY_IMPORT.test("const sdk = await import('@sentry/node')\n")).toBe(true)
    expect(ANY_SENTRY_IMPORT.test("export const NAMES = ['@sentry/node']\n")).toBe(false)

    const cliDir = resolve(CLI_SRC, '..')
    const others = memberDirs().filter((dir) => dir !== cliDir)
    const files = others.flatMap((dir) => memberSourceFiles(join(dir, 'src')))
    const importers = files.filter((file) =>
      ANY_SENTRY_IMPORT.test(withoutComments(readFileSync(file, 'utf8'))),
    )
    const dependents = others.filter((dir) => sentryDependencies(dir).length > 0)

    expect(others.length).toBeGreaterThan(10)
    expect(files.length).toBeGreaterThan(100)
    expect(importers.map((file) => relative(REPO_ROOT, file))).toEqual([])
    expect(dependents.map((dir) => relative(REPO_ROOT, dir))).toEqual([])
    expect(sentryDependencies(cliDir)).toEqual([
      ['@sentry/node', expect.stringMatching(/^\d+\.\d+\.\d+$/)],
    ])
  })

  it('reads no SENTRY_ environment variable in the CLI or analytics source', () => {
    for (const planted of [
      'process.env.SENTRY_DSN',
      "process.env['SENTRY_TRACE']",
      'env?.SENTRY_RELEASE',
      'const { SENTRY_DSN } = process.env',
    ]) {
      expect(readsSentryVariable(planted), planted).toBe(true)
    }
    expect(readsSentryVariable('export const AGENT_QA_SENTRY_DSN = ""')).toBe(false)

    const files = [...shippedSourceFiles(CLI_SRC), ...shippedSourceFiles(ANALYTICS_SRC)]
    const offenders = files.filter((file) =>
      readsSentryVariable(withoutComments(readFileSync(file, 'utf8'))),
    )

    expect(files.length).toBeGreaterThan(10)
    expect(offenders.map((file) => relative(CLI_SRC, file))).toEqual([])
  })
})
