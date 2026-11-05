import type {
  PlatformConfig,
  RemoteRefusalMemory,
  RemoteSessionRegistry,
  SecretResolver,
} from '@vostride/agent-qa-runner'

export interface AndroidAdapterConfig extends PlatformConfig {
  appiumUrl?: string
  browserName?: string
  appPackage?: string
  appActivity?: string
  avd?: string
}

export interface AndroidAdapterOptions {
  // Every declared secret, so a remote's references resolve at connect and nowhere else.
  readonly connectionSecrets?: SecretResolver
  // The configured secrets file a missing-secret refusal names.
  readonly secretsFile?: string
  // Shared by every adapter of one run, so a remote that refused is not asked again.
  readonly refusalMemory?: RemoteRefusalMemory
  // The host process's open sessions, so a signal can release this one without waiting for cleanup.
  readonly sessions?: RemoteSessionRegistry
  // The run's declared mask, applied to a server's reason before it reaches a refusal.
  readonly mask?: (text: string) => string
  // Shorter bounds for tests; the CLI never sets them.
  readonly timing?: {
    readonly heartbeatIntervalMs?: number
    readonly commandBoundMs?: number
  }
}

export interface AndroidSessionOptions {
  readonly connectionSecrets?: SecretResolver | undefined
  readonly secretsFile?: string | undefined
  readonly refusalMemory?: RemoteRefusalMemory | undefined
  readonly mask?: ((text: string) => string) | undefined
  readonly commandBoundMs?: number | undefined
}
