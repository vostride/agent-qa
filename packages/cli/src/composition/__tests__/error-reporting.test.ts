// The reporter decides from the raw config, loads the SDK only when on, and builds its client by
// hand with every option passed, through a recording transport that sends nothing.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DEFAULT_ANALYTICS_SHUTDOWN_TIMEOUT_MS } from '@vostride/agent-qa-analytics'
import { afterEach, describe, expect, it, vi } from 'vitest'

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
import {
  closeErrorReporting,
  decideErrorReporting,
  errorReporter,
  settleReporting,
  startErrorReporting,
} from '../error-reporting.js'

const INVENTED_DSN = 'http://key@127.0.0.1:9/1'

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  await closeErrorReporting()
  removeReportProjects()
})

interface RecordedEvent {
  readonly release?: string
  readonly environment?: string
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
