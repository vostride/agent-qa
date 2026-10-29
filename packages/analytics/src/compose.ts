// The one opt-out decision site. It is made once, before any transport exists, and its answer is
// the transport: opted out or keyless builds none at all.
// `analytics.privacy: true` is the only input.

import { createAnalyticsPort } from './port.js'
import { createPosthogTransport } from './transports.js'
import { AGENT_QA_POSTHOG_HOST, AGENT_QA_POSTHOG_KEY } from './posthog-project.js'
import type { AnalyticsMaskingContext } from './masking-seam.js'
import type {
  AnalyticsEventEnvelope,
  AnalyticsIdentityResolver,
  AnalyticsPort,
  AnalyticsTransport,
} from './port.js'
import type { PosthogTransportFactory } from './transports.js'

export type AnalyticsOptOutReason = 'config-privacy'

export type AnalyticsTransportKind = 'none' | 'posthog'

export interface AnalyticsOptOutConfig {
  readonly analytics?: {
    readonly privacy?: boolean
  }
}

export interface ComposeAnalyticsOptions {
  readonly config?: AnalyticsOptOutConfig
  readonly identity?: AnalyticsIdentityResolver
  readonly projectKey?: string
  readonly projectHost?: string
  /**
   * The host's declared-secret mask, which the send seam applies. It reaches only
   * the opted-IN arm: the deny arm has no transport, so there is no payload to mask.
   */
  readonly maskingContext?: AnalyticsMaskingContext
  /** Replaces the transport on the OPTED-IN arm only. Never consulted once the answer is deny. */
  readonly transportOverride?: AnalyticsTransport
  /** Replaces the PostHog transport CONSTRUCTOR, so a cell can observe whether it was called. */
  readonly posthogTransportFactory?: PosthogTransportFactory
}

export interface ComposedAnalytics<TEvent extends AnalyticsEventEnvelope = AnalyticsEventEnvelope> {
  readonly port: AnalyticsPort<TEvent>
  /** The transport the port was built over; `undefined` when opted out or keyless. */
  readonly transport: AnalyticsTransport | undefined
  readonly optedOut: boolean
  readonly optOutReasons: readonly AnalyticsOptOutReason[]
  readonly transportKind: AnalyticsTransportKind
}

export function composeAnalytics<TEvent extends AnalyticsEventEnvelope = AnalyticsEventEnvelope>(
  options: ComposeAnalyticsOptions = {},
): ComposedAnalytics<TEvent> {
  const optedOut = options.config?.analytics?.privacy === true
  const optOutReasons: AnalyticsOptOutReason[] = optedOut ? ['config-privacy'] : []

  // The whole decision, in one expression, before any transport exists. The deny arm reaches
  // neither the override, the factory nor the project key, and builds no transport.
  const { transport, transportKind } = optedOut ? NO_TRANSPORT : enabledTransport(options)

  return {
    port: createAnalyticsPort<TEvent>({
      transport,
      identity: options.identity ?? noIdentity,
    }),
    transport,
    optedOut,
    optOutReasons,
    transportKind,
  }
}

// No shared default id: a port composed without a resolver sends nothing.
const noIdentity: AnalyticsIdentityResolver = () =>
  Promise.reject(new Error('no analytics identity was supplied'))

interface ChosenTransport {
  readonly transport: AnalyticsTransport | undefined
  readonly transportKind: AnalyticsTransportKind
}

const NO_TRANSPORT: ChosenTransport = { transport: undefined, transportKind: 'none' }

/**
 * The opted-in arm. A blank project key also builds no transport, and that is NOT an opt-out: the
 * committed key file ships blank, so a developer checkout must not report a user who declined.
 */
function enabledTransport(options: ComposeAnalyticsOptions): ChosenTransport {
  if (options.transportOverride) {
    return { transport: options.transportOverride, transportKind: 'posthog' }
  }

  const projectKey = (options.projectKey ?? AGENT_QA_POSTHOG_KEY).trim()
  if (projectKey === '') return NO_TRANSPORT

  const factory = options.posthogTransportFactory ?? createPosthogTransport
  return {
    transport: factory({
      projectKey,
      host: options.projectHost ?? AGENT_QA_POSTHOG_HOST,
      disableGeoip: false,
      ...(options.maskingContext ? { maskingContext: options.maskingContext } : {}),
    }),
    transportKind: 'posthog',
  }
}
