// The CLI's error reporter. The decision is made before anything loads, so with reporting off the
// SDK is never imported; with it on, one client is built by hand and held for the process.

import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'

import type * as SentryNode from '@sentry/node'
import {
  AGENT_QA_SENTRY_DSN,
  DEFAULT_ANALYTICS_SHUTDOWN_TIMEOUT_MS,
} from '@vostride/agent-qa-analytics'

import { declaresAnalyticsPrivacy, readConfigDeclaration } from '../config.js'
import { CLI_ANALYTICS_AGENT_QA_VERSION } from './analytics-host.js'
import {
  createDeclaredSecretMask,
  DeclaredSecretsUnavailableError,
  maskSavedCredentials,
  readSavedCredentialValues,
} from './declared-secrets.js'
import type { DeclaredSecretMask } from './declared-secrets.js'
import {
  createMaskingTransport,
  createRepeatFilter,
  homeSpellings,
} from './error-reporting-mask.js'
import type { TextMask } from './error-reporting-mask.js'

export const TRACE_SAMPLE_RATE = 1

export type SentrySdk = typeof SentryNode
export type ReportTransportFactory = typeof SentryNode.makeNodeTransport

export interface ErrorReporter {
  capture(error: unknown): void
  flush(timeoutMs: number): Promise<boolean>
  bindMask(mask: TextMask): () => void
}

export interface StartErrorReportingInput {
  readonly configPath: string
  readonly dsn?: string
  readonly authPath?: string
  readonly homeDir?: string
  readonly transport?: ReportTransportFactory
  readonly loadSdk?: () => Promise<SentrySdk>
}

export type ErrorReportingDecision =
  | { readonly on: false }
  | { readonly on: true; readonly document?: unknown }

export async function decideErrorReporting(input: {
  readonly configPath: string
  readonly dsn: string
}): Promise<ErrorReportingDecision> {
  if (input.dsn.trim() === '') return { on: false }
  const declaration = await readConfigDeclaration(input.configPath)
  if (declaration.state === 'missing') return { on: true }
  if (declaration.state === 'unreadable') return { on: false }
  return declaresAnalyticsPrivacy(declaration.document)
    ? { on: false }
    : { on: true, document: declaration.document }
}

interface StartedReporting {
  readonly reporter: ErrorReporter
  readonly client: SentryNode.NodeClient
}

let started: StartedReporting | undefined
let starting: Promise<ErrorReporter | undefined> | undefined

export async function startErrorReporting(
  input: StartErrorReportingInput,
): Promise<ErrorReporter | undefined> {
  if (started !== undefined) return started.reporter
  starting ??= buildReporter(input).finally(() => {
    starting = undefined
  })
  return await starting
}

export function errorReporter(): ErrorReporter | undefined {
  return started?.reporter
}

async function loadSentrySdk(): Promise<SentrySdk> {
  return await import('@sentry/node')
}

async function buildReporter(input: StartErrorReportingInput): Promise<ErrorReporter | undefined> {
  try {
    const dsn = input.dsn ?? AGENT_QA_SENTRY_DSN
    // Anchored now: the mask reads this project's secrets when a report is sent, maybe much later.
    const configPath = resolve(input.configPath)
    const decision = await decideErrorReporting({ configPath, dsn })
    if (!decision.on) return undefined

    const masks = createReportMasks(configPath, await readSavedCredentialValues(input.authPath))
    const home = input.homeDir ?? homedir()
    const spellings = homeSpellings(home, realPath(home))
    const Sentry = await (input.loadSdk ?? loadSentrySdk)()
    // Built by hand, since the SDK's init adopts the shell's trace variables whatever it is passed.
    const client = new Sentry.NodeClient({
      dsn,
      release: `agent-qa@${CLI_ANALYTICS_AGENT_QA_VERSION}`,
      environment: 'production',
      debug: false,
      spotlight: false,
      includeServerName: false,
      includeLocalVariables: false,
      enableRuntimeChannelInjection: false,
      enableOpenTelemetrySetup: false,
      sendClientReports: false,
      tracesSampleRate: TRACE_SAMPLE_RATE,
      traceLifecycle: 'stream',
      tracePropagationTargets: [],
      propagateTraceparent: false,
      maxBreadcrumbs: 100,
      dataCollection: {
        userInfo: false,
        cookies: false,
        httpHeaders: false,
        httpBodies: [],
        urlQueryParams: false,
        graphQL: { document: false, variables: false },
        genAI: { inputs: false, outputs: false },
        mcp: { inputs: false, outputs: false },
        databaseQueryData: false,
        queues: false,
        stackFrameVariables: false,
      },
      integrations: [
        Sentry.functionToStringIntegration(),
        Sentry.linkedErrorsIntegration(),
        Sentry.dedupeIntegration(),
        Sentry.systemErrorIntegration({ includePaths: true }),
        Sentry.consoleIntegration(),
        Sentry.contextLinesIntegration(),
        Sentry.nodeContextIntegration({ cloudResource: false, culture: false }),
      ],
      stackParser: Sentry.defaultStackParser,
      transport: createMaskingTransport(
        input.transport ?? Sentry.makeNodeTransport,
        masks.resolve,
        { homeSpellings: spellings, dropRepeats: createRepeatFilter() },
      ),
    })
    Sentry.setCurrentClient(client)
    client.init()

    const reporter: ErrorReporter = {
      capture: (error) => {
        try {
          Sentry.captureException(error)
        } catch {
          // A report that cannot be made never fails the command that hit the error.
        }
      },
      flush: async (timeoutMs) => {
        try {
          return await client.flush(timeoutMs)
        } catch {
          return false
        }
      },
      bindMask: masks.bind,
    }
    started = { reporter, client }
    return reporter
  } catch {
    return undefined
  }
}

function realPath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

interface ReportMasks {
  resolve(): TextMask
  bind(mask: TextMask): () => void
}

// Each envelope passes the saved credentials, the declared secrets, then every open binding's mask,
// then the mask of the binding that ended last: a report made just after a run still passes that
// run's mask.
function createReportMasks(configPath: string, savedCredentials: readonly string[]): ReportMasks {
  const declared = createDeclaredSecretMask(configPath)
  const saved = savedCredentials.length === 0 ? [] : [maskSavedCredentials(savedCredentials)]
  const open = new Set<{ readonly mask: TextMask }>()
  let endedLast: TextMask | undefined
  return {
    resolve: () => {
      const masks = [
        ...saved,
        declaredSecretMask(configPath, declared),
        ...[...open].map((binding) => binding.mask),
        ...(endedLast === undefined ? [] : [endedLast]),
      ]
      return (text) => masks.reduce((masked, mask) => mask(masked), text)
    },
    bind: (mask) => {
      const binding = { mask }
      open.add(binding)
      return () => {
        if (open.delete(binding)) endedLast = mask
      }
    },
  }
}

// No config file, no secrets file named, or a named one that is not there: no secrets are
// declared. Any other failure throws, and the envelope is dropped.
function declaredSecretMask(configPath: string, declared: DeclaredSecretMask): TextMask {
  if (!existsSync(configPath)) return (text) => text
  try {
    const redactor = declared.redactor()
    return (text) => redactor.redactString(text)
  } catch (err) {
    if (
      err instanceof DeclaredSecretsUnavailableError &&
      (err.gap === 'required' || err.gap === 'missing')
    ) {
      return (text) => text
    }
    throw err
  }
}

export interface SettleReportingInput {
  readonly analytics?: { shutdown(): Promise<void> }
}

// The analytics drain and the report flush share one budget: an exit waits two seconds, not four.
export async function settleReporting(input: SettleReportingInput = {}): Promise<void> {
  const reporter = started?.reporter
  if (reporter === undefined) {
    await input.analytics?.shutdown()
    return
  }
  await within(DEFAULT_ANALYTICS_SHUTDOWN_TIMEOUT_MS, () =>
    Promise.allSettled([
      input.analytics?.shutdown(),
      reporter.flush(DEFAULT_ANALYTICS_SHUTDOWN_TIMEOUT_MS),
    ]),
  )
}

export async function closeErrorReporting(): Promise<void> {
  const current = started
  started = undefined
  if (current === undefined) return
  await within(DEFAULT_ANALYTICS_SHUTDOWN_TIMEOUT_MS, () =>
    current.client.close(DEFAULT_ANALYTICS_SHUTDOWN_TIMEOUT_MS),
  )
}

// The guard stays ref'd: an unref'd timer lets Node end the process before the exit code is set.
async function within(ms: number, work: () => PromiseLike<unknown>): Promise<void> {
  let guard: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      work(),
      new Promise<void>((resolve) => {
        guard = setTimeout(resolve, ms)
      }),
    ])
  } catch {
    // Settling never throws into the exit it runs before.
  } finally {
    clearTimeout(guard)
  }
}
