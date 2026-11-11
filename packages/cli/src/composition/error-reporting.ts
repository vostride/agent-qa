// The CLI's error reporter. The decision is made before anything loads, so with reporting off the
// SDK is never imported; with it on, one client is built by hand and held for the process.

import { existsSync, realpathSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { resolve } from 'node:path'

import type * as SentryNode from '@sentry/node'
import {
  AGENT_QA_SENTRY_DSN,
  DEFAULT_ANALYTICS_SHUTDOWN_TIMEOUT_MS,
} from '@vostride/agent-qa-analytics'
import type { ResolvedAnalyticsIdentity } from '@vostride/agent-qa-analytics'

import { declaresAnalyticsPrivacy, readConfigDeclaration } from '../config.js'
import { CLI_ANALYTICS_AGENT_QA_VERSION } from './analytics-host.js'
import type { CliAnalyticsSurface } from './analytics-host.js'
import {
  heldProcessAnalyticsIdentity,
  holdProcessAnalyticsIdentity,
  releaseProcessAnalyticsIdentity,
} from './analytics-identity.js'
import type { HeldAnalyticsIdentity } from './analytics-identity.js'
import {
  createDeclaredSecretMask,
  createSavedCredentialMask,
  DeclaredSecretsUnavailableError,
} from './declared-secrets.js'
import type { DeclaredSecretMask } from './declared-secrets.js'
import {
  createHomeRewrite,
  createMaskingTransport,
  createRepeatFilter,
} from './error-reporting-mask.js'
import type { TextMask } from './error-reporting-mask.js'
import { boundedRequestModule } from './error-reporting-requests.js'
import type { ReportRequests } from './error-reporting-requests.js'

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

// Where a run is: closed values and indexes only, never a step's text.
export interface ReportRunState {
  readonly runner: string
  readonly platform?: string
  readonly adapter?: string
  readonly step?: number
  readonly action?: string
}

export interface ErrorReporter {
  readonly configDocument?: unknown
  // The command path the starter began, and its span until the settle step ends it.
  readonly command: string | undefined
  readonly commandSpan: ReportSpan | undefined
  capture(error: unknown): void
  flush(timeoutMs: number): Promise<boolean>
  bindMask(mask: TextMask): () => void
  setFacts(facts: ReportFacts): void
  startSpan(input: ReportSpanInput): ReportSpan
  beginCommandSpan(command: string, flags: readonly string[]): void
  // Sets, replaces or, with no state, removes one run's entry and never touches another's.
  setRunState(runId: string, state: ReportRunState | undefined): void
}

export interface StartErrorReportingInput {
  readonly configPath: string
  readonly dsn?: string
  readonly authPath?: string
  readonly homeDir?: string
  // The account's own home and user name; it can throw, as os.userInfo does.
  readonly userInfo?: () => { readonly homedir: string; readonly username: string }
  readonly transport?: ReportTransportFactory
  readonly loadSdk?: () => Promise<SentrySdk>
  // Milliseconds on a clock that never goes back; it times how long an ended mask is kept.
  readonly now?: () => number
  // Called once when reporting is on; with none, the reporter resolves no identity.
  readonly identity?: () => HeldAnalyticsIdentity
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
  readonly requests: ReportRequests
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
    // Started before the SDK loads, which takes far longer, and never awaited on the way to the
    // command.
    const identity = input.identity === undefined ? undefined : holdIdentity(input.identity)

    const masks = createReportMasks(
      configPath,
      createSavedCredentialMask(input.authPath),
      input.now ?? (() => performance.now()),
    )
    const home = input.homeDir ?? homedir()
    const account = accountOf(input.userInfo ?? (() => userInfo()))
    const homes = [home, realPath(home)]
    // A process started with another HOME still hides the account's real home.
    if (account !== undefined) homes.push(account.home, realPath(account.home))
    const rewriteHome = createHomeRewrite({
      homes,
      ...(account === undefined ? {} : { userName: account.name }),
      ignoreCase: process.platform === 'win32' || process.platform === 'darwin',
    })
    const Sentry = await (input.loadSdk ?? loadSentrySdk)()
    const requests = boundedRequestModule(URL.parse(dsn)?.protocol ?? 'https:')
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
      // No Dedupe: it reads two errors around one cause as one, and the transport drops repeats.
      integrations: [
        Sentry.functionToStringIntegration(),
        Sentry.linkedErrorsIntegration(),
        Sentry.systemErrorIntegration({ includePaths: true }),
        Sentry.consoleIntegration(),
        Sentry.contextLinesIntegration(),
        Sentry.nodeContextIntegration({ cloudResource: false, culture: false }),
      ],
      stackParser: Sentry.defaultStackParser,
      transport: createMaskingTransport(
        input.transport ?? Sentry.makeNodeTransport,
        masks.resolve,
        { rewriteHome, dropRepeats: createRepeatFilter() },
      ),
      transportOptions: { httpModule: requests },
      beforeSend: (event, hint) => masks.keepCaptureBindings(event, hint),
      beforeBreadcrumb: (breadcrumb) => masks.keepRecordBindings(breadcrumb),
    })
    Sentry.setCurrentClient(client)
    client.init()
    try {
      const scope = Sentry.getGlobalScope()
      scope.setTag('agent_qa_version', CLI_ANALYTICS_AGENT_QA_VERSION)
      scope.setAttributes({ agent_qa_version: CLI_ANALYTICS_AGENT_QA_VERSION })
    } catch {
      // Reports go out without the version tag rather than fail the command.
    }
    // A resolution that settles after its reporter closed writes nothing on the next one.
    void identity?.then((resolved) => {
      if (resolved === undefined || heldProcessAnalyticsIdentity() !== identity) return
      try {
        const scope = Sentry.getGlobalScope()
        // The id alone: no IP address, user name or e-mail.
        scope.setUser({ id: resolved.distinctId })
        scope.setTags(identityTags(resolved))
        scope.setAttributes(identityAttributes(resolved))
      } catch {
        // Reports go out without the identity rather than fail the command.
      }
    })

    const startSpan = spanStarter(Sentry)
    let commandPath: string | undefined
    let commandSpan: ReportSpan | undefined
    const runStates = new Map<string, ReportRunState>()
    const reporter: ErrorReporter = {
      ...(decision.document === undefined ? {} : { configDocument: decision.document }),
      get command() {
        return commandPath
      },
      get commandSpan() {
        return commandSpan
      },
      capture: (error) => {
        try {
          Sentry.captureException(error, { data: masks.captureBindings() })
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
          const surface = commandSurface(facts.command)
          scope.setTags({
            command: facts.command,
            package_manager: facts.packageManager,
            ci: facts.ci ? 'ci' : 'local',
            surface,
          })
          scope.setAttributes({ surface })
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
        if (commandSpan !== undefined) return
        commandPath = command
        commandSpan = startSpan({
          op: 'agent_qa.command',
          name: command === '' ? 'agent-qa' : `agent-qa ${command}`,
          attributes: { 'agent_qa.command': command, 'agent_qa.flags': flags },
        })
      },
      // With several runs open, a capture cannot tell which one an error came from, so the
      // event names each open run under its id and none of them as the run.
      setRunState: (runId, state) => {
        try {
          if (state === undefined) runStates.delete(runId)
          else runStates.set(runId, state)
          const entries = [...runStates].map(([id, entry]) => [id, runContext(id, entry)] as const)
          const scope = Sentry.getGlobalScope()
          scope.setContext('run', entries.length === 1 ? entries[0]![1] : null)
          scope.setContext('runs', entries.length > 1 ? Object.fromEntries(entries) : null)
        } catch {
          // Reports go out without the run state rather than fail the run.
        }
      },
    }
    const endCommandSpan = () => {
      const span = commandSpan
      commandSpan = undefined
      span?.end()
    }
    started = { reporter, client, sdk: Sentry, requests, endCommandSpan }
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

function accountOf(
  read: () => { readonly homedir: string; readonly username: string },
): { readonly home: string; readonly name: string } | undefined {
  try {
    const info = read()
    return { home: info.homedir, name: info.username }
  } catch {
    // An account with no entry in the user database; HOME is all there is.
    return undefined
  }
}

// The surface each command's own analytics host names; a command that composes none is cli.
export function commandSurface(command: string): CliAnalyticsSurface {
  return command === 'mcp' || command === 'chat' || command === 'daemon' ? command : 'cli'
}

// The properties every PostHog event carries, under PostHog's names: tags on a report, attributes
// on a span.
const ANALYTICS_PROPERTY_NAMES = [
  'agent_qa_version',
  'surface',
  'runtime_context',
  'is_internal',
  'agent_product',
] as const

// Handled at once: with reporting on, an unhandled rejection would reach agent-qa's own handler.
function holdIdentity(resolve: () => HeldAnalyticsIdentity): HeldAnalyticsIdentity {
  let identity: HeldAnalyticsIdentity
  try {
    identity = Promise.resolve(resolve()).catch(() => undefined)
  } catch {
    identity = Promise.resolve(undefined)
  }
  holdProcessAnalyticsIdentity(identity)
  return identity
}

// is_internal is present only when true, as on an analytics event.
function identityTags(identity: ResolvedAnalyticsIdentity): Record<string, string> {
  return {
    runtime_context: identity.runtimeContext,
    ...(identity.agentProduct === undefined ? {} : { agent_product: identity.agentProduct }),
    ...(identity.isInternal === true ? { is_internal: 'true' } : {}),
  }
}

function identityAttributes(identity: ResolvedAnalyticsIdentity): Record<string, string | boolean> {
  return {
    runtime_context: identity.runtimeContext,
    ...(identity.agentProduct === undefined ? {} : { agent_product: identity.agentProduct }),
    ...(identity.isInternal === true ? { is_internal: true } : {}),
  }
}

function runContext(runId: string, state: ReportRunState): Record<string, string | number> {
  return {
    run_id: runId,
    runner: state.runner,
    ...(state.platform === undefined ? {} : { platform: state.platform }),
    ...(state.adapter === undefined ? {} : { adapter: state.adapter }),
    ...(state.step === undefined ? {} : { step: state.step }),
    ...(state.action === undefined ? {} : { action: state.action }),
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

interface CaptureBindings {
  readonly boundAtCapture: readonly TextMask[]
}

// The masks in force when a breadcrumb was recorded ride on it under a symbol: the SDK's copies of
// a breadcrumb keep it, and the envelope walk keeps string keys alone, so it never leaves.
const BOUND_AT_RECORD = Symbol('masks in force when the breadcrumb was recorded')

interface ReportMasks {
  resolve(envelope: unknown): TextMask
  bind(mask: TextMask): () => void
  // A capture hands the SDK the bindings in force as it is made, and its event keeps them.
  captureBindings(): CaptureBindings
  keepCaptureBindings<T extends object>(event: T, hint: { readonly data?: unknown }): T
  // A breadcrumb holds the bindings in force as it is recorded, so a mask is kept only while the
  // SDK keeps a line recorded under it.
  keepRecordBindings<T extends object>(breadcrumb: T): T
}

// An ended binding's mask is kept this long, so an error or a line that comes late from a finished
// run or session is still masked after others ended; the newest one is kept however old.
const ENDED_MASK_KEPT_MS = 60_000
// A long-lived host that ends many bindings keeps no more than this many, the newest.
const ENDED_MASKS_KEPT_AT_MOST = 100

// Each envelope passes the saved credentials, the declared secrets, then each binding's mask once:
// those in force when an event in it was captured or one of its breadcrumbs was recorded, those
// open now, and those that ended within the last minute. A report made just after a run still
// passes that run's mask, and so do one captured during a run and sent after it ended, and a line
// printed during a run, however many bindings ended since. The saved credentials are read at start,
// at each capture and at each send, so the mask holds every value the store held at any of them.
function createReportMasks(
  configPath: string,
  savedMask: () => TextMask,
  now: () => number,
): ReportMasks {
  const declared = createDeclaredSecretMask(configPath)
  const learnSaved = () => {
    try {
      savedMask()
    } catch {
      // A store that cannot be read now is read again at send, which drops the report then.
    }
  }
  learnSaved()
  const open = new Set<{ readonly mask: TextMask }>()
  // Oldest first.
  const ended: Array<{ readonly mask: TextMask; readonly at: number }> = []
  const atCapture = new WeakMap<object, readonly TextMask[]>()
  const inForce = (): TextMask[] => {
    const cutoff = now() - ENDED_MASK_KEPT_MS
    while (ended.length > 1 && ended[0]!.at < cutoff) ended.shift()
    return [...[...open].map((binding) => binding.mask), ...ended.map((entry) => entry.mask)]
  }
  return {
    resolve: (envelope) => {
      const bindings = new Set([
        ...capturedUnder(envelope, atCapture),
        ...recordedUnder(envelope),
        ...inForce(),
      ])
      const masks = [savedMask(), declaredSecretMask(configPath, declared), ...bindings]
      return (text) => masks.reduce((masked, mask) => mask(masked), text)
    },
    bind: (mask) => {
      const binding = { mask }
      open.add(binding)
      return () => {
        if (!open.delete(binding)) return
        ended.push({ mask, at: now() })
        if (ended.length > ENDED_MASKS_KEPT_AT_MOST) ended.shift()
      }
    },
    captureBindings: () => {
      learnSaved()
      return { boundAtCapture: inForce() }
    },
    // The SDK puts this same event object in the envelope it hands the transport.
    keepCaptureBindings: (event, hint) => {
      const bindings = (hint.data as Partial<CaptureBindings> | undefined)?.boundAtCapture
      if (Array.isArray(bindings)) atCapture.set(event, bindings)
      return event
    },
    keepRecordBindings: (breadcrumb) => {
      const bindings = inForce()
      return bindings.length === 0
        ? breadcrumb
        : Object.assign(breadcrumb, { [BOUND_AT_RECORD]: bindings })
    },
  }
}

function payloadsOf(envelope: unknown): object[] {
  const items: unknown = Array.isArray(envelope) ? envelope[1] : undefined
  if (!Array.isArray(items)) return []
  return items.flatMap((item: unknown) => {
    const payload: unknown = Array.isArray(item) ? item[1] : undefined
    return typeof payload === 'object' && payload !== null ? [payload] : []
  })
}

function capturedUnder(envelope: unknown, atCapture: WeakMap<object, readonly TextMask[]>) {
  return payloadsOf(envelope).flatMap((payload) => atCapture.get(payload) ?? [])
}

function recordedUnder(envelope: unknown): TextMask[] {
  return payloadsOf(envelope).flatMap((payload) => {
    const breadcrumbs: unknown = (payload as { readonly breadcrumbs?: unknown }).breadcrumbs
    if (!Array.isArray(breadcrumbs)) return []
    return breadcrumbs.flatMap((breadcrumb: unknown) => {
      const bindings: unknown =
        typeof breadcrumb === 'object' && breadcrumb !== null
          ? (breadcrumb as { readonly [BOUND_AT_RECORD]?: unknown })[BOUND_AT_RECORD]
          : undefined
      return Array.isArray(bindings) ? (bindings as TextMask[]) : []
    })
  })
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
  readonly budgetMs?: number
}

// Every settle in the process draws on one budget, whole while unset. A settle's wait is taken out
// of it, and time spent outside a settle puts it back, one millisecond for each, up to the whole.
let budgetLeftMs: number | undefined
let budgetUpdatedAt = 0
let lastSettle: Promise<void> = Promise.resolve()

// The command span ends first, so the flush sends it. The analytics drain and the report flush run
// together on what is left of the budget, and a report request still open after it is ended, so
// none holds the process once the settle returns.
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
  current.requests.abandon()
  const returnedAt = performance.now()
  budgetLeftMs = Math.max(0, wait - (returnedAt - startedAt))
  budgetUpdatedAt = returnedAt
}

export async function closeErrorReporting(): Promise<void> {
  budgetLeftMs = undefined
  // Released before anything is awaited, so a resolution that settles now writes on no reporter,
  // and waited for, so none still reads or writes the identity file once the close returns.
  const identity = heldProcessAnalyticsIdentity()
  releaseProcessAnalyticsIdentity()
  const current = started
  started = undefined
  if (identity !== undefined) await within(DEFAULT_ANALYTICS_SHUTDOWN_TIMEOUT_MS, () => identity)
  if (current === undefined) return
  await within(DEFAULT_ANALYTICS_SHUTDOWN_TIMEOUT_MS, () =>
    current.client.close(DEFAULT_ANALYTICS_SHUTDOWN_TIMEOUT_MS),
  )
  // The facts, the identity and the run state sit on the SDK's process-wide scope; a reporter
  // started later begins without them.
  const scope = current.sdk.getGlobalScope()
  scope.setTags({ command: undefined, package_manager: undefined, ci: undefined })
  scope.setUser({})
  for (const name of ANALYTICS_PROPERTY_NAMES) {
    scope.setTag(name, undefined)
    scope.removeAttribute(name)
  }
  scope.setContext('agent_qa', null)
  scope.setContext('run', null)
  scope.setContext('runs', null)
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
