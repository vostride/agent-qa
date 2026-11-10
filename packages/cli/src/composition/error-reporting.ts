// The CLI's error reporter. The decision is made before anything loads, so with reporting off the
// SDK is never imported; with it on, one client is built by hand and held for the process.

import { existsSync, realpathSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
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

export interface ReportFacts {
  readonly command: string
  readonly flags: readonly string[]
  readonly packageManager: string
  readonly ci: boolean
  readonly platforms: readonly string[]
  readonly models: readonly string[]
  readonly plugins: readonly string[]
}

export type ReportSpanOutcome = 'ok' | 'error'

export type ReportSpanAttributes = Readonly<
  Record<string, string | number | boolean | readonly string[]>
>

export interface ReportSpan {
  setAttributes(attributes: ReportSpanAttributes): void
  end(outcome?: ReportSpanOutcome): void
}

export interface ReportSpanInput {
  readonly op: string
  readonly name: string
  readonly attributes?: ReportSpanAttributes
  readonly parent?: ReportSpan
  readonly newTrace?: boolean
  // Milliseconds since the epoch.
  readonly startTime?: number
}

export interface ErrorReporter {
  readonly configDocument?: unknown
  capture(error: unknown): void
  flush(timeoutMs: number): Promise<boolean>
  bindMask(mask: TextMask): () => void
  setFacts(facts: ReportFacts): void
  startSpan(input: ReportSpanInput): ReportSpan
  beginCommandSpan(command: string, flags: readonly string[]): void
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
  readonly sdk: SentrySdk
  endCommandSpan(): void
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
      transportOptions: { httpModule: boundedRequestModule(URL.parse(dsn)?.protocol ?? 'https:') },
    })
    Sentry.setCurrentClient(client)
    client.init()

    const startSpan = spanStarter(Sentry)
    let commandSpan: ReportSpan | undefined
    const reporter: ErrorReporter = {
      ...(decision.document === undefined ? {} : { configDocument: decision.document }),
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
      setFacts: (facts) => {
        try {
          const scope = Sentry.getGlobalScope()
          scope.setTags({
            command: facts.command,
            package_manager: facts.packageManager,
            ci: facts.ci ? 'ci' : 'local',
          })
          scope.setContext('agent_qa', {
            flags: [...facts.flags],
            platforms: [...facts.platforms],
            models: [...facts.models],
            plugins: [...facts.plugins],
          })
        } catch {
          // Reports go out without the facts rather than fail the command.
        }
      },
      startSpan,
      beginCommandSpan: (command, flags) => {
        commandSpan ??= startSpan({
          op: 'agent_qa.command',
          name: command === '' ? 'agent-qa' : `agent-qa ${command}`,
          attributes: { 'agent_qa.command': command, 'agent_qa.flags': flags },
        })
      },
    }
    const endCommandSpan = () => {
      const span = commandSpan
      commandSpan = undefined
      span?.end()
    }
    started = { reporter, client, sdk: Sentry, endCommandSpan }
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

type SdkSpanAttributes = NonNullable<Parameters<SentrySdk['startInactiveSpan']>[0]['attributes']>

const SPAN_STATUS_ERROR = 2

const NO_SPAN: ReportSpan = { setAttributes: () => {}, end: () => {} }

// Every span is started inactive with its parent named: commander runs the action outside the
// preAction hook's async context, so no span is ever the active one.
function spanStarter(Sentry: SentrySdk): (input: ReportSpanInput) => ReportSpan {
  const sdkSpans = new WeakMap<ReportSpan, SentryNode.Span>()
  const wrap = (span: SentryNode.Span): ReportSpan => {
    const reportSpan: ReportSpan = {
      setAttributes: (attributes) =>
        quietly(() => {
          span.setAttributes(sdkAttributes(attributes))
        }),
      end: (outcome) =>
        quietly(() => {
          if (outcome === 'error') {
            span.setStatus({ code: SPAN_STATUS_ERROR, message: 'internal_error' })
          }
          span.end()
        }),
    }
    sdkSpans.set(reportSpan, span)
    return reportSpan
  }
  return (input) => {
    try {
      const options = {
        op: input.op,
        name: input.name,
        ...(input.attributes === undefined ? {} : { attributes: sdkAttributes(input.attributes) }),
        ...(input.startTime === undefined ? {} : { startTime: input.startTime }),
      }
      if (input.newTrace === true) {
        return wrap(
          Sentry.startNewTrace(() =>
            Sentry.startInactiveSpan({ ...options, forceTransaction: true }),
          ),
        )
      }
      const parent = input.parent === undefined ? undefined : sdkSpans.get(input.parent)
      return wrap(Sentry.startInactiveSpan({ ...options, parentSpan: parent ?? null }))
    } catch {
      return NO_SPAN
    }
  }
}

// A span that cannot be changed or ended never fails the work it times.
function quietly(work: () => void): void {
  try {
    work()
  } catch {
    // The span is left as it was.
  }
}

function sdkAttributes(attributes: ReportSpanAttributes): SdkSpanAttributes {
  return Object.fromEntries(
    Object.entries(attributes).map(([key, value]) => [
      key,
      typeof value === 'object' ? [...value] : value,
    ]),
  )
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

export type ReportRequestModule = NonNullable<Parameters<ReportTransportFactory>[0]['httpModule']>

// The SDK's agent times a silent socket out but leaves the request open, which holds a process that
// would otherwise end, so the request is destroyed when it times out.
export function boundedRequestModule(protocol: string): ReportRequestModule {
  return {
    request: (options, onResponse) => {
      const request =
        protocol === 'https:' ? httpsRequest(options, onResponse) : httpRequest(options, onResponse)
      request.on('timeout', () => {
        request.destroy(new Error('the report request timed out'))
      })
      return request
    },
  }
}

export interface SettleReportingInput {
  readonly analytics?: { shutdown(): Promise<void> }
  readonly budgetMs?: number
}

// Every settle in the process draws on one budget, whole while unset. A settle's wait is taken out
// of it, and time spent outside a settle puts it back, one millisecond for each, up to the whole.
let budgetLeftMs: number | undefined
let budgetUpdatedAt = 0
let lastSettle: Promise<void> = Promise.resolve()

// The command span ends first, so the flush sends it. The analytics drain and the report flush run
// together on what is left of the budget.
export async function settleReporting(input: SettleReportingInput = {}): Promise<void> {
  const current = started
  if (current === undefined) {
    await input.analytics?.shutdown()
    return
  }
  // One at a time, so two settles never count the same time twice.
  const previous = lastSettle
  let release: () => void = () => {}
  lastSettle = new Promise<void>((resolve) => {
    release = () => resolve()
  })
  try {
    await previous
    await settleOnce(current, input)
  } finally {
    release()
  }
}

async function settleOnce(current: StartedReporting, input: SettleReportingInput): Promise<void> {
  const whole = input.budgetMs ?? DEFAULT_ANALYTICS_SHUTDOWN_TIMEOUT_MS
  const startedAt = performance.now()
  const wait =
    budgetLeftMs === undefined
      ? whole
      : Math.min(whole, budgetLeftMs + (startedAt - budgetUpdatedAt))
  current.endCommandSpan()
  if (wait < 1) {
    // The SDK's flush waits without bound when it is given no time, so it is not called.
    try {
      void input.analytics?.shutdown().catch(() => {})
    } catch {
      // Settling never throws into the exit it runs before.
    }
  } else {
    await within(wait, () =>
      Promise.allSettled([input.analytics?.shutdown(), current.reporter.flush(wait)]),
    )
  }
  const returnedAt = performance.now()
  budgetLeftMs = Math.max(0, wait - (returnedAt - startedAt))
  budgetUpdatedAt = returnedAt
}

export async function closeErrorReporting(): Promise<void> {
  budgetLeftMs = undefined
  const current = started
  started = undefined
  if (current === undefined) return
  await within(DEFAULT_ANALYTICS_SHUTDOWN_TIMEOUT_MS, () =>
    current.client.close(DEFAULT_ANALYTICS_SHUTDOWN_TIMEOUT_MS),
  )
  // The facts sit on the SDK's process-wide scope; a reporter started later begins without them.
  const scope = current.sdk.getGlobalScope()
  scope.setTags({ command: undefined, package_manager: undefined, ci: undefined })
  scope.setContext('agent_qa', null)
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
