// Values no report may carry, a project that declares the secret ones, an error that quotes them,
// and the checks that a report leaves each of them out and keeps the rest of what it says.
//
// Every value is built when this module loads. A report quotes the source lines around each stack
// frame, so a value spelled out in a source file would reach the report from there.

import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'

import { pluginMaskName, RunSecretRedactor } from '@vostride/agent-qa-runner'
import { expect, vi } from 'vitest'

import { readDeclaredSecrets } from '../composition/declared-secrets.js'
import { startErrorReporting } from '../composition/error-reporting.js'
import type { ErrorReporter, SentrySdk } from '../composition/error-reporting.js'
import { serializedEnvelopes } from './error-report-recorder.js'
import type { RecordedEnvelope, RecordingReportTransport } from './error-report-recorder.js'

const INVENTED_DSN = 'http://key@127.0.0.1:9/1'

const tag = randomBytes(6).toString('hex')
const minted = (...words: readonly string[]): string => [...words, tag].join('-')

const DECLARED_SECRET_NAME = 'SHOP_PASSWORD'
const REMOTE_SECRET_NAME = 'GRID_PASSWORD'
const REMOTE_USER = 'grid-user'

// A quote and a backslash, so the value reads differently inside a JSON string.
const declaredSecret = `pass"word\\${tag}`
const remotePassword = minted('grid', 'password')
const basicPayload = Buffer.from(`${REMOTE_USER}:${remotePassword}`).toString('base64')
const basicHeader = `Basic ${basicPayload}`
const homeName = ['canary', 'user'].join('-')

// Environment values that nothing prints, stubbed before a reporter starts.
export const CANARIES: Readonly<Record<string, string>> = {
  UNPRINTED_VALUE: minted('unprinted'),
  AWS_REGION: minted('region'),
  GITHUB_SHA: minted('sha'),
}

// Each plugin answer this module mints, by value, so every check looks for it.
const answered = new Map<string, string>()

function canaryValues(): ReadonlyArray<readonly [string, string]> {
  const values: ReadonlyArray<readonly [string, string]> = [
    ['the declared secret', declaredSecret],
    ['the password the remote names', remotePassword],
    ["the remote's Basic header value", basicHeader],
    ["the remote's Basic payload", basicPayload],
    ...Object.entries(CANARIES).map(([name, value]) => [`the value of ${name}`, value] as const),
    ['the hostname', hostname()],
    ["the home folder's name", homeName],
    ...[...answered].map(([value, name]) => [name, value] as const),
  ]
  return values.filter(([, value]) => value !== '')
}

export interface CanaryProject {
  readonly dir: string
  readonly configPath: string
  readonly secretsPath: string
  readonly homeDir: string
  readonly authPath: string
}

const roots: string[] = []

// One declared secret, and one remote whose Basic credential is built from a second secret. The
// home folder sits beside the project, and the auth store path names no file.
export function canaryProject(): CanaryProject {
  const root = mkdtempSync(join(tmpdir(), 'agent-qa-report-canaries-'))
  roots.push(root)
  const dir = join(root, 'project')
  const homeDir = join(root, homeName)
  mkdirSync(dir)
  mkdirSync(homeDir)
  const configPath = join(dir, 'agent-qa.config.yaml')
  const secretsPath = join(dir, '.env.secrets.local')
  writeFileSync(
    configPath,
    `${JSON.stringify({
      workspace: {
        testMatch: ['tests/**/*.test.yaml'],
        suiteMatch: ['suites/**/*.suite.yaml'],
        hooksFile: 'hooks.yaml',
        envFile: '.env',
        secretsFile: '.env.secrets.local',
      },
      use: { mobile: { appState: 'reset' } },
      registry: {
        remotes: [
          {
            name: 'grid',
            protocol: 'playwright',
            url: 'wss://grid.invalid/playwright',
            basicAuth: { user: REMOTE_USER, password: `{{secret:${REMOTE_SECRET_NAME}}}` },
          },
        ],
      },
    })}\n`,
    'utf8',
  )
  writeFileSync(
    secretsPath,
    `${DECLARED_SECRET_NAME}=${declaredSecret}\n${REMOTE_SECRET_NAME}=${remotePassword}\n`,
    'utf8',
  )
  return { dir, configPath, secretsPath, homeDir, authPath: join(root, 'auth.json') }
}

export function removeCanaryProjects(): void {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
}

// Breadcrumbs sit on the SDK's process-wide scope. A reporter started after another in the same
// process would carry the lines printed under the first, whose home folder it does not rewrite.
async function sdkWithNoEarlierBreadcrumbs(): Promise<SentrySdk> {
  const sdk = await import('@sentry/node')
  sdk.getIsolationScope().clearBreadcrumbs()
  return sdk
}

// As the CLI's starter does before an action: decided from the canary project, with its home, its
// environment, the command's facts and the command span.
export async function startCanaryReporting(
  project: CanaryProject,
  recorder: RecordingReportTransport,
  command: string,
): Promise<ErrorReporter> {
  for (const [name, value] of Object.entries(CANARIES)) vi.stubEnv(name, value)
  const reporter = await startErrorReporting({
    configPath: project.configPath,
    dsn: INVENTED_DSN,
    transport: recorder.transport,
    homeDir: project.homeDir,
    authPath: project.authPath,
    loadSdk: sdkWithNoEarlierBreadcrumbs,
  })
  if (reporter === undefined) throw new Error('reporting did not start over the canary project')
  reporter.setFacts({
    command,
    flags: [],
    packageManager: 'unknown',
    ci: false,
    platforms: [],
    models: [],
    plugins: [],
  })
  reporter.beginCommandSpan(command, [])
  return reporter
}

const ERROR_WORDS = 'the canary run could not sign in with'
const CAUSE_WORDS = 'the grid answered 401 for'
const LINE_WORDS = 'signing the canary run in with'

function quoted(project: CanaryProject): string {
  return `${declaredSecret} as ${basicHeader} from ${project.homeDir}/projects/shop`
}

function maskedQuote(): string {
  const secret = `[secret:${DECLARED_SECRET_NAME}]`
  return `${secret} as Basic [secret:${REMOTE_SECRET_NAME}] from ~/projects/shop`
}

export function canaryError(project: CanaryProject): Error {
  return new Error(`${ERROR_WORDS} ${quoted(project)}`, {
    cause: new Error(`${CAUSE_WORDS} ${quoted(project)}`),
  })
}

// Printed just before an error, so the report carries it as a breadcrumb.
export function canaryLine(project: CanaryProject): string {
  return `${LINE_WORDS} ${quoted(project)}`
}

export interface PluginAnswerCanary {
  readonly url: string
  readonly token: string
  readonly redactor: RunSecretRedactor
}

// A run's redactor over the project's declared secrets, holding what a remote plugin answered for
// its session: the connection URL and the token in it, added under the entry's mask name as the
// run's plugin host adds an acquire answer's mask values.
export function pluginAnswerCanary(project: CanaryProject, entry = 'lab'): PluginAnswerCanary {
  const token = minted(entry, 'token')
  const url = `wss://${entry}.invalid/playwright?token=${token}`
  answered.set(url, `the connection URL the ${entry} plugin answered`)
  answered.set(token, `the token the ${entry} plugin answered`)
  const redactor = new RunSecretRedactor(readDeclaredSecrets(project.secretsPath))
  redactor.addMaskExtras([
    [pluginMaskName(entry), url],
    [pluginMaskName(entry), token],
  ])
  return { url, token, redactor }
}

interface ReportedEvent {
  readonly tags?: Readonly<Record<string, unknown>>
  readonly breadcrumbs?: ReadonlyArray<{ readonly category?: string; readonly message?: string }>
  readonly exception?: {
    readonly values?: ReadonlyArray<{
      readonly value?: string
      readonly stacktrace?: { readonly frames?: readonly unknown[] }
    }>
  }
}

type EnvelopeItems = Array<[unknown, Array<[{ readonly type?: string }, unknown]>]>

function reportedEvents(envelopes: readonly RecordedEnvelope[]): ReportedEvent[] {
  return (JSON.parse(serializedEnvelopes(envelopes)) as EnvelopeItems)
    .flatMap(([, items]) => items)
    .filter(([header]) => header.type === 'event')
    .map(([, payload]) => payload as ReportedEvent)
}

// Finding no canary proves something only once an error report was sent. Each value is looked for
// as it is and as it reads inside a JSON string, and a failure names the canaries it found.
export function expectNoCanary(envelopes: readonly RecordedEnvelope[]): void {
  const reports = reportedEvents(envelopes).length
  expect(reports, 'no error report reached the recorder').toBeGreaterThan(0)
  const sent = serializedEnvelopes(envelopes)
  const inJson = (value: string) => JSON.stringify(value).slice(1, -1)
  const found = canaryValues()
    .filter(([, value]) => sent.includes(value) || sent.includes(inJson(value)))
    .map(([name]) => name)
  expect(found, 'canaries found in the envelopes').toEqual([])
}

// The report of the canary error still says what failed with which words, where both errors were
// thrown, what was printed just before, and which command ran.
export function expectUsefulReport(envelopes: readonly RecordedEnvelope[], command: string): void {
  const events = reportedEvents(envelopes).filter((event) =>
    (event.exception?.values ?? []).some((value) => value.value?.startsWith(ERROR_WORDS)),
  )
  expect(events, 'one report of the canary error').toHaveLength(1)
  const [event] = events
  const values = event?.exception?.values ?? []
  for (const words of [ERROR_WORDS, CAUSE_WORDS]) {
    const value = values.find((candidate) => candidate.value?.startsWith(words))
    expect(value?.value).toBe(`${words} ${maskedQuote()}`)
    expect(value?.stacktrace?.frames?.length ?? 0, `frames of "${words}"`).toBeGreaterThan(0)
  }
  const printed = (event?.breadcrumbs ?? [])
    .filter((breadcrumb) => breadcrumb.category === 'console')
    .map((breadcrumb) => breadcrumb.message)
  expect(printed).toContain(`${LINE_WORDS} ${maskedQuote()}`)
  expect(event?.tags?.command).toBe(command)
}
