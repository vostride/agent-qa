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
}

export interface AndroidSessionOptions {
  readonly connectionSecrets?: SecretResolver | undefined
  readonly secretsFile?: string | undefined
}
