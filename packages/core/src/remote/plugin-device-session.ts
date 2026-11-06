import {
  MIN_PLUGIN_CONNECT_MS,
  releasingOnce,
  RemoteRefusalError,
  resolveSecretTemplatesInValue,
} from '@vostride/agent-qa-runner'
import type {
  RemoteDeviceConfig,
  RemoteLease,
  RemoteLeaseSource,
  RemotePluginDeviceConfig,
  RemoteRefusalMemory,
  SecretResolver,
} from '@vostride/agent-qa-runner'
import { remoteLabel, secretReferenceNames } from '@vostride/agent-qa-schema'
import {
  capabilityValue,
  mergeCapabilities,
  remoteAppCapability,
  runStartCapabilityContradictions,
  staticCapabilityContradictions,
} from '../mobile/device-plan.js'
import type { CapabilityMap, RunStartCapabilityInput } from '../mobile/device-plan.js'
import type { MobilePlatform } from '../mobile/launch-resolver.js'
import { remoteDeviceEndpoint } from './remote-device-connection.js'
import type { RemoteDeviceConnection } from './remote-device-connection.js'
import { deviceDebugLoggingRefusal, remoteDeviceRefusalKey } from './remote-device-session.js'

export function referencedSecretNames(value: unknown): string[] {
  if (typeof value === 'string') return secretReferenceNames(value)
  if (Array.isArray(value)) return value.flatMap(referencedSecretNames)
  if (typeof value === 'object' && value !== null) {
    return Object.values(value as Record<string, unknown>).flatMap(referencedSecretNames)
  }
  return []
}

export interface DeviceSecretsInput {
  readonly connectionSecrets?: SecretResolver | undefined
  readonly secretsFile?: string | undefined
}

// A reference the secrets file does not declare is refused before any request.
export function withDeviceSecretsResolved(
  capabilities: CapabilityMap,
  options: DeviceSecretsInput,
  subject: string,
  details: { remote?: string } = {},
): CapabilityMap {
  const secrets = options.connectionSecrets
  const missing = referencedSecretNames(capabilities).find((name) => secrets?.has(name) !== true)
  if (missing !== undefined) {
    const secretsFile = options.secretsFile ?? 'workspace.secretsFile'
    throw new RemoteRefusalError(
      `${subject} needs ${missing}, which ${secretsFile} does not declare. Add it there.`,
      details,
    )
  }
  return resolveSecretTemplatesInValue(capabilities, secrets)
}

export function rememberedDeviceRefusal(
  memory: RemoteRefusalMemory | undefined,
  remoteDevice: Pick<RemoteDeviceConfig, 'name'>,
  device: string,
): RemoteRefusalError | undefined {
  if (memory === undefined) return undefined
  return (
    memory.refusalFor(remoteDeviceRefusalKey(remoteDevice, device, undefined)) ??
    memory.refusalFor(remoteDeviceRefusalKey(remoteDevice, device, 'refused'))
  )
}

export function refuseLeakingDeviceLogs(
  device: string,
  remote: { name: string },
  label: string,
): void {
  const logging = deviceDebugLoggingRefusal(
    { WDIO_LOG_LEVEL: process.env.WDIO_LOG_LEVEL, NODE_DEBUG: process.env.NODE_DEBUG },
    { remote, device },
  )
  if (logging !== undefined) throw new RemoteRefusalError(logging, { remote: label })
}

export interface RemoteDeviceProfile {
  readonly name: string
  readonly model?: string | undefined
  readonly os?: string | undefined
  readonly id?: string | undefined
  readonly capabilities?: CapabilityMap | undefined
}

// What a device test asks of a remote, whichever kind serves it.
export interface RemoteDeviceTest {
  readonly platform: MobilePlatform
  readonly device: RemoteDeviceProfile
  readonly target: RunStartCapabilityInput['target']
  readonly appState: 'preserve' | 'reset'
  // The browser a mobile browser test opens; undefined for an app test.
  readonly browserName: string | undefined
  readonly appRef?: string | undefined
  readonly appPath?: string | undefined
  readonly testName?: string | undefined
  // What the platform derives for the test; the remote's and the device's capabilities go over it.
  readonly derived: CapabilityMap
}

export interface PluginDeviceSessionOptions extends DeviceSecretsInput {
  readonly refusalMemory?: RemoteRefusalMemory | undefined
  readonly pluginSessions?: RemoteLeaseSource | undefined
}

export interface PluginDeviceSessionInput<Driver> extends RemoteDeviceTest {
  readonly remote: RemotePluginDeviceConfig
  readonly options: PluginDeviceSessionOptions
  // Sends the new session to the answered server, with its capabilities resolved.
  open(session: {
    remote: RemoteDeviceConfig
    connection: RemoteDeviceConnection
    capabilities: CapabilityMap
  }): Promise<Driver>
}

export interface PluginDeviceSession<Driver> {
  readonly driver: Driver
  readonly lease: RemoteLease
  // Sends the lease back once, whoever asks first.
  readonly release: () => Promise<void>
  // The plugin's answer as a url remote, with the remote's own capabilities: what the session
  // connected to.
  readonly remote: RemoteDeviceConfig
}

// Derived, then the remote's capabilities, then the device's, with their references as written.
function statedCapabilities(
  test: RemoteDeviceTest,
  remoteCapabilities: CapabilityMap | undefined,
): CapabilityMap {
  return mergeCapabilities(test.derived, remoteCapabilities, test.device.capabilities)
}

// The answer is checked like a remote's capabilities, so it cannot change what the test runs on.
function answerContradictions(
  test: RemoteDeviceTest,
  remote: string,
  capabilities: CapabilityMap | undefined,
): string[] {
  if (capabilities === undefined) return []
  const { device } = test
  const layer = { name: remote, capabilities }
  return [
    ...staticCapabilityContradictions({
      device: device.name,
      platform: test.platform,
      ...(device.model !== undefined ? { model: device.model } : {}),
      ...(device.os !== undefined ? { os: device.os } : {}),
      ...(device.id !== undefined ? { id: device.id } : {}),
      remote: layer,
    }),
    ...runStartCapabilityContradictions({
      device: device.name,
      target: test.target,
      appState: test.appState,
      browserMode: test.browserName !== undefined,
      remote: layer,
    }),
  ]
}

// The app the session installs, when the target names one and the capabilities do not.
function remoteDeviceApp(
  test: RemoteDeviceTest,
  remote: RemoteDeviceConfig,
  capabilities: CapabilityMap,
): string | undefined {
  if (test.browserName !== undefined) return undefined
  const app = remoteAppCapability({
    device: test.device.name,
    remote: remote.name,
    target: test.target.name,
    ...(test.appRef !== undefined ? { appRef: test.appRef } : {}),
    ...(test.appPath !== undefined ? { appPath: test.appPath } : {}),
    capabilities,
  })
  if ('refusal' in app) throw new RemoteRefusalError(app.refusal, { remote: remoteLabel(remote) })
  return app.app
}

// The capabilities a url remote's device session sends; references resolve after the merge.
export function remoteDeviceCapabilities(
  test: RemoteDeviceTest,
  remote: RemoteDeviceConfig,
  options: DeviceSecretsInput,
): CapabilityMap {
  const merged = statedCapabilities(test, remote.capabilities)
  const app = remoteDeviceApp(test, remote, merged)
  if (app !== undefined) merged['appium:app'] = app
  const label = remoteLabel(remote)
  const subject = `Device ${test.device.name} on remote ${label}`
  return withDeviceSecretsResolved(merged, options, subject, { remote: label })
}

// A plugin's answer carries values, so it goes in as given between the derived capabilities and
// the remote's; only what the project states resolves, one layer at a time.
function answeredCapabilities(
  test: RemoteDeviceTest,
  remote: RemoteDeviceConfig,
  options: DeviceSecretsInput,
  answer: CapabilityMap | undefined,
): CapabilityMap {
  const label = remoteLabel(remote)
  const subject = `Device ${test.device.name} on remote ${label}`
  const resolved = (capabilities: CapabilityMap | undefined): CapabilityMap | undefined =>
    capabilities === undefined
      ? undefined
      : withDeviceSecretsResolved(capabilities, options, subject, { remote: label })
  const merged = mergeCapabilities(
    resolved(test.derived),
    answer,
    resolved(remote.capabilities),
    resolved(test.device.capabilities),
  )
  const app = remoteDeviceApp(test, remote, merged)
  if (app !== undefined) Object.assign(merged, resolved({ 'appium:app': app }))
  return merged
}

// The plugin leases the device; its answer then takes the url remote's path, so refusals, bounds
// and capability checks are the same as on a url remote.
export async function createPluginDeviceSession<Driver>(
  input: PluginDeviceSessionInput<Driver>,
): Promise<PluginDeviceSession<Driver>> {
  const { remote: pluginDevice, options, platform } = input
  const device = input.device.name
  const { name } = pluginDevice
  const entry = pluginDevice.plugin.entry
  const sessions = options.pluginSessions
  if (sessions === undefined) {
    throw new RemoteRefusalError(
      `Remote ${name} names plugin entry ${entry}, and this host started no plugin host for it.`,
      { remote: name, kind: 'refused' },
    )
  }
  refuseLeakingDeviceLogs(device, pluginDevice, name)
  const memory = options.refusalMemory
  const remembered = rememberedDeviceRefusal(memory, pluginDevice, device)
  if (remembered !== undefined) throw remembered
  const remember = (error: RemoteRefusalError): RemoteRefusalError =>
    memory?.remember(remoteDeviceRefusalKey(pluginDevice, device, error.kind), error) ?? error

  const capabilities = statedCapabilities(input, pluginDevice.capabilities)
  // A set app.ref, or an app the capabilities name, wins; only an app.path alone uploads.
  let appRef = input.appRef
  const appPath = input.appPath?.trim()
  if (
    input.browserName === undefined &&
    capabilityValue(capabilities, 'app') === undefined &&
    !appRef?.trim() &&
    appPath
  ) {
    if (sessions.uploadApp === undefined) {
      throw new RemoteRefusalError(
        `Remote ${name}: plugin entry ${entry} uploads no apps; set app.ref on the target to an app the service already has.`,
        { remote: name, kind: 'refused' },
      )
    }
    const uploaded = await sessions.uploadApp({
      remote: name,
      plugin: pluginDevice.plugin,
      platform,
      path: appPath,
      deadlineMs: pluginDevice.uploadTimeoutMs,
    })
    appRef = uploaded.ref
  }

  const startedAt = Date.now()
  let lease: RemoteLease
  try {
    lease = await sessions.acquire({
      remote: name,
      plugin: pluginDevice.plugin,
      deadlineMs: pluginDevice.connectTimeoutMs,
      session: { platform, capabilities },
      ...(input.testName === undefined ? {} : { testName: input.testName }),
    })
  } catch (error) {
    if (!(error instanceof RemoteRefusalError)) throw error
    throw remember(error)
  }
  const release = releasingOnce(lease)
  const answer = lease.connection
  const refuse = async (sentence: string): Promise<never> => {
    await release()
    throw remember(new RemoteRefusalError(sentence, { remote: name, kind: 'refused' }))
  }
  if (answer.protocol !== 'appium') {
    return refuse(
      `Remote ${name}: plugin entry ${entry} answered a device with a ${answer.protocol} session.`,
    )
  }
  const label = remoteLabel({ name, plugin: entry })
  const contradictions = answerContradictions(input, label, answer.capabilities)
  if (contradictions.length > 0) return refuse(contradictions.join('\n'))
  // The answer carries values, not references, and its query rides along on every request.
  const endpoint = URL.canParse(answer.url) ? remoteDeviceEndpoint(new URL(answer.url)) : undefined
  if (endpoint === undefined) {
    return refuse(
      `Remote ${name}: plugin entry ${entry} answered with a url that an appium connection cannot use.`,
    )
  }

  const remaining = pluginDevice.connectTimeoutMs - (Date.now() - startedAt)
  const remote: RemoteDeviceConfig = {
    name,
    protocol: 'appium',
    url: answer.url,
    ...(answer.headers === undefined ? {} : { headers: answer.headers }),
    connectTimeoutMs: Math.max(MIN_PLUGIN_CONNECT_MS, remaining),
    ...(pluginDevice.capabilities === undefined ? {} : { capabilities: pluginDevice.capabilities }),
  }
  try {
    const test = { ...input, appRef }
    const driver = await input.open({
      remote,
      connection: { ...endpoint, headers: { ...answer.headers } },
      capabilities: answeredCapabilities(test, remote, options, answer.capabilities),
    })
    return { driver, lease, release, remote }
  } catch (error) {
    await release()
    throw error
  }
}
