import type { AnalyticsEventProperties, AnalyticsSurface, BuiltAnalyticsEvent } from './events.js'
import { resolveAnalyticsIdentity } from './identity.js'
import { AGENT_QA_POSTHOG_HOST, AGENT_QA_POSTHOG_KEY } from './posthog-project.js'
import { PostHogAnalyticsTransport } from './posthog-transport.js'
import { NoopAnalyticsTransport, type AnalyticsTransport } from './transport.js'
import { getAgentQaVersion } from '../version.js'

export const EMPTY_POSTHOG_KEY_WARNING = 'PostHog analytics initialization failed because AGENT_QA_POSTHOG_KEY is empty. Analytics telemetry is disabled.'

export interface AnalyticsServiceConfig {
  analytics?: {
    privacy?: true
  }
}

export interface AnalyticsPostHogTransportFactoryOptions {
  projectKey: string
  host: string
  disableGeoip: false
}

export interface AnalyticsServiceOptions {
  config?: AnalyticsServiceConfig
  surface?: AnalyticsSurface
  transport?: AnalyticsTransport
  warningSink?: (message: string) => void
  projectKey?: string
  projectHost?: string
  identityPath?: string
  env?: Record<string, string | undefined>
  posthogTransportFactory?: (options: AnalyticsPostHogTransportFactoryOptions) => AnalyticsTransport
}

export interface AnalyticsService {
  capture(event: BuiltAnalyticsEvent): Promise<void>
  flush(): Promise<void>
}

export interface AnalyticsStandardPropertiesOptions {
  surface?: AnalyticsSurface
  identityPath?: string
  env?: Record<string, string | undefined>
  agentQaVersion?: string
}

export async function resolveAnalyticsStandardProperties(
  options: AnalyticsStandardPropertiesOptions = {},
): Promise<AnalyticsEventProperties> {
  const identity = await resolveAnalyticsIdentity({
    env: options.env,
    identityPath: options.identityPath,
  })

  return {
    agent_qa_version: options.agentQaVersion ?? getAgentQaVersion(),
    surface: options.surface,
    runtime_context: identity.runtimeContext,
    ...(identity.agentProduct ? { agent_product: identity.agentProduct } : {}),
  }
}

class DefaultAnalyticsService implements AnalyticsService {
  private readonly transport: AnalyticsTransport
  private readonly disabled: boolean
  private readonly identityPath?: string
  private readonly env?: Record<string, string | undefined>

  constructor(options: AnalyticsServiceOptions = {}) {
    const privacyEnabled = options.config?.analytics?.privacy === true
    this.disabled = privacyEnabled || (!options.transport && !(options.projectKey ?? AGENT_QA_POSTHOG_KEY).trim())
    this.identityPath = options.identityPath
    this.env = options.env

    if (privacyEnabled) {
      this.transport = new NoopAnalyticsTransport()
      return
    }

    if (options.transport) {
      this.transport = options.transport
      return
    }

    const projectKey = options.projectKey ?? AGENT_QA_POSTHOG_KEY
    if (!projectKey.trim()) {
      ;(options.warningSink ?? console.warn)(EMPTY_POSTHOG_KEY_WARNING)
      this.transport = new NoopAnalyticsTransport()
      return
    }

    const host = options.projectHost ?? AGENT_QA_POSTHOG_HOST
    this.transport = (options.posthogTransportFactory ?? ((factoryOptions) => new PostHogAnalyticsTransport({
      projectKey: factoryOptions.projectKey,
      host: factoryOptions.host,
      disableGeoip: factoryOptions.disableGeoip,
    })))({
      projectKey,
      host,
      disableGeoip: false,
    })
  }

  async capture(event: BuiltAnalyticsEvent): Promise<void> {
    if (this.disabled) return

    try {
      const identity = await resolveAnalyticsIdentity({
        env: this.env,
        identityPath: this.identityPath,
      })
      await this.transport.capture({
        distinctId: identity.distinctId,
        ...(identity.isInternal === true ? { isInternal: true } : {}),
        event,
      })
    } catch {
      // Analytics is intentionally best-effort.
    }
  }

  async flush(): Promise<void> {
    if (this.disabled) return

    try {
      await this.transport.flush()
    } catch {
      // Analytics is intentionally best-effort.
    }
  }
}

let defaultAnalyticsService: AnalyticsService | undefined

export function createAnalyticsService(options: AnalyticsServiceOptions = {}): AnalyticsService {
  return new DefaultAnalyticsService(options)
}

export function getAnalyticsService(options: AnalyticsServiceOptions = {}): AnalyticsService {
  defaultAnalyticsService ??= createAnalyticsService(options)
  return defaultAnalyticsService
}

export function resetAnalyticsServiceForTests(): void {
  defaultAnalyticsService = undefined
}

export async function captureAnalytics(event: BuiltAnalyticsEvent, options?: AnalyticsServiceOptions): Promise<void> {
  if (options?.config?.analytics?.privacy === true) return
  await getAnalyticsService(options).capture(event)
}

export async function flushAnalytics(options?: AnalyticsServiceOptions): Promise<void> {
  if (options?.config?.analytics?.privacy === true) return
  await getAnalyticsService(options).flush()
}
