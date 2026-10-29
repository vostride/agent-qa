// The CLI's one binding of `composeAnalytics`. Every host calls it once per invocation at its
// composition root. It adds the standard properties and the identity gate (an identity is resolved
// only when the transport `composeAnalytics` chose will send) and never decides the opt-out itself.
// It holds no module-level state.

import { composeAnalytics, resolveAnalyticsIdentity } from '@vostride/agent-qa-analytics'
import type {
  AgentQaAnalyticsEvent,
  AgentQaAnalyticsPort,
  AnalyticsIdentity,
  AnalyticsMaskingContext,
  AnalyticsOptOutConfig,
  AnalyticsOptOutReason,
  AnalyticsRunStandardProperties,
  AnalyticsTransport,
  AnalyticsTransportKind,
  PosthogTransportFactory,
} from '@vostride/agent-qa-analytics'
import { createRequire } from 'node:module'

/**
 * Which process is emitting, taken from the subscriber's own standard-properties type rather than
 * restated. `ANALYTICS_EMITTING_HOSTS` is the array behind it; naming the type keeps this file from
 * carrying a second spelling of a vocabulary the union owns.
 */
export type CliAnalyticsSurface = NonNullable<AnalyticsRunStandardProperties['surface']>

/**
 * The shipped version, read from THIS package's own manifest.
 *
 * TWO ROUTES WERE TRIED FIRST AND BOTH ARE WORSE.
 *
 *   `getAgentQaVersion()` from `@vostride/agent-qa-core` is where the rest of this repo reads it,
 *   and the FUNC-02 surface firewall does not admit core: a surface may name the function layer,
 *   the vocabulary, the composition root and this analytics package, and nothing else.
 *
 *   `VERSION` from this package's own barrel (`src/index.ts`) has core's ledger entry and compiles
 *   — but the barrel re-exports the whole host, and pulling it in here puts the local-agent
 *   composition (and its durable filesystem layer) into the module graph of every command that
 *   composes analytics. Measured 2026-08-17: `init.test.ts`, whose partial `node:fs` mock does not
 *   carry `openSync`, fails at import on that graph — the same weight the `--agent` branch of
 *   `init.ts` already dodges with a lazy import.
 *
 * So it is read here, the same way core reads it: `require('../package.json').version`. That is a
 * SECOND reader of a version, which is a real cost, and `analytics-host.test.ts` pays it down by
 * pinning this constant equal to `getAgentQaVersion()` — a drift between the two reds rather than
 * shipping a version field that disagrees with `--version`.
 */
const require = createRequire(import.meta.url)

function readCliPackageVersion(): string {
  try {
    const manifest = require('../../package.json') as { version?: unknown }
    if (typeof manifest.version === 'string' && manifest.version.trim()) {
      return manifest.version.trim()
    }
  } catch {
    // Same posture as core's reader: a missing manifest must never fail a command.
  }
  return '0.0.0'
}

export const CLI_ANALYTICS_AGENT_QA_VERSION = readCliPackageVersion()

export const ANALYTICS_IDENTITY_TIMEOUT_MS = 1_000

export interface ComposeAnalyticsHostInput {
  /** Which process is emitting. A host names itself; nothing infers it. */
  surface: CliAnalyticsSurface
  /** The resolved project configuration, when this host has one. `undefined` is a real posture. */
  config?: AnalyticsOptOutConfig
  /** This host's environment slice. Defaults to `process.env`; passed in so a cell can drive it. */
  env?: Readonly<Record<string, string | undefined>>
  /** The project's declared-secret mask; the transport's send seam applies it, never the host. */
  maskingContext?: AnalyticsMaskingContext
  /** Cell seam: replaces the transport on the opted-IN arm only (the package's own rule). */
  transportOverride?: AnalyticsTransport
  /**
   * Cell seams that drive the SHIPPED send path rather than a stand-in beside it.
   *
   * `transportOverride` above replaces the transport wholesale, which also replaces the masking
   * seam that lives inside it — fine for a cell asserting attribution, useless for one asserting
   * masking. These two let a cell construct the real `PosthogTransport` over a fake client, so the
   * seam being measured is the one a user's events cross.
   */
  projectKey?: string
  posthogTransportFactory?: PosthogTransportFactory
  /** Cell seam: replaces the identity resolution so a suite never touches a real home directory. */
  resolveIdentity?: typeof resolveAnalyticsIdentity
}

/**
 * What a host holds for the life of its invocation.
 *
 * `port` is the only way to emit. `flush`/`shutdown` are forwarded rather than re-implemented so a
 * host's teardown is the port's teardown; `optedOut`/`optOutReasons`/`transportKind` are reported
 * for a `--verbose` or doctor line, so a host never re-derives the posture to describe it.
 */
export interface CliAnalyticsHost {
  readonly port: AgentQaAnalyticsPort
  readonly properties: AnalyticsRunStandardProperties
  readonly optedOut: boolean
  readonly optOutReasons: readonly AnalyticsOptOutReason[]
  readonly transportKind: AnalyticsTransportKind
  /**
   * The host binds the declared mask at composition; a run may rebind to its own once its secrets
   * are read. Binding replaces the target, and the seam reads it at send time.
   */
  bindMaskingContext(context: AnalyticsMaskingContext): void
  flush(): Promise<void>
  shutdown(): Promise<void>
}

/**
 * Compose this host's analytics. Called ONCE per invocation, at the composition root.
 *
 * Async because the identity store is on disk. The await happens on the opted-in arm only — see the
 * identity gate in the header — so an opted-out invocation pays no I/O and leaves no trace.
 */
export async function composeAnalyticsHost(
  input: ComposeAnalyticsHostInput,
): Promise<CliAnalyticsHost> {
  // Assigned below only when resolution succeeds; until then every capture is dropped.
  let identity: AnalyticsIdentity | undefined
  let masking: AnalyticsMaskingContext | undefined = input.maskingContext

  const composed = composeAnalytics<AgentQaAnalyticsEvent>({
    ...(input.config === undefined ? {} : { config: input.config }),
    // The forwarding seam — see `bindMaskingContext`. Always supplied, so the send path's masking
    // call exists from the first event whether or not a mask has been bound yet.
    maskingContext: { mask: (text) => masking?.mask(text) ?? text },
    ...(input.transportOverride === undefined ? {} : { transportOverride: input.transportOverride }),
    ...(input.projectKey === undefined ? {} : { projectKey: input.projectKey }),
    ...(input.posthogTransportFactory === undefined
      ? {}
      : { posthogTransportFactory: input.posthogTransportFactory }),
    identity: () => identity ?? Promise.reject(new Error('analytics identity unavailable')),
  })

  const properties: AnalyticsRunStandardProperties = {
    agent_qa_version: CLI_ANALYTICS_AGENT_QA_VERSION,
    surface: input.surface,
    // PostHog's own directive; see the union's base properties. Set on every event this CLI emits.
    $process_person_profile: false,
  }

  // The gate is "is there a transport", not "did they opt out": a blank-key checkout composes no
  // transport while reporting `optedOut: false`, and must not mint an identity either.
  if (composed.transportKind === 'posthog') {
    const resolve = input.resolveIdentity ?? resolveAnalyticsIdentity
    try {
      // CI is the run detector's answer, reached through agent-local (the firewall).
      const { resolveRunExecutionContext } = await import('@vostride/agent-qa-agent-local')
      const ci = resolveRunExecutionContext() === 'ci'
      const resolved = await withTimeout(
        resolve({ env: { ...(input.env ?? process.env) }, ci }),
        ANALYTICS_IDENTITY_TIMEOUT_MS,
      )
      identity = {
        distinctId: resolved.distinctId,
        ...(resolved.isInternal === true ? { isInternal: true } : {}),
      }
      properties.runtime_context = resolved.runtimeContext
      if (resolved.agentProduct !== undefined) properties.agent_product = resolved.agentProduct
    } catch {
      // Telemetry stays off for this invocation; nothing falls back to a shared id.
    }
  }

  return {
    port: composed.port,
    properties,
    optedOut: composed.optedOut,
    optOutReasons: composed.optOutReasons,
    transportKind: composed.transportKind,
    bindMaskingContext: (context) => {
      masking = context
    },
    flush: () => composed.port.flush(),
    shutdown: () => composed.port.shutdown(),
  }
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('analytics identity timed out')), ms)
      timer.unref?.()
    }),
  ]).finally(() => clearTimeout(timer))
}

/**
 * Build a full event from this host's standard properties and a member's own fields.
 *
 * Typed against the closed union rather than against `Record<string, unknown>`: the member name and
 * its properties are checked at every call site, so a field the union does not declare is a
 * compile error at the emitter rather than a `.strictObject` refusal at parse time. That is the
 * whole reason `AgentQaAnalyticsPort` is parameterised by the union.
 */
export function analyticsEvent<TName extends AgentQaAnalyticsEvent['name']>(
  host: CliAnalyticsHost,
  name: TName,
  properties: Omit<
    Extract<AgentQaAnalyticsEvent, { name: TName }>['properties'],
    keyof AnalyticsRunStandardProperties
  >,
): Extract<AgentQaAnalyticsEvent, { name: TName }> {
  return {
    name,
    properties: { ...host.properties, ...properties },
  } as Extract<AgentQaAnalyticsEvent, { name: TName }>
}
