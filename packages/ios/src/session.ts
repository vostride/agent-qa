import { remote } from 'webdriverio'
import {
  capabilityValue,
  classifyNewSessionFailure,
  createRemoteDeviceRequestBounds,
  deviceDebugLoggingRefusal,
  mergeCapabilities,
  REMOTE_COMMAND_BOUND_MS,
  remoteAppCapability,
  remoteDerivedIdentity,
  remoteDeviceRefusalKey,
  remoteDeviceRefusalSentence,
  resolveRemoteDeviceConnection,
  runStartCapabilityContradictions,
  serverReasonLine,
  staticCapabilityContradictions,
} from '@vostride/agent-qa-core'
import type { CapabilityMap, RemoteDeviceConnection } from '@vostride/agent-qa-core'
import {
  isPluginRemote,
  RemoteRefusalError,
  resolveSecretTemplatesInValue,
} from '@vostride/agent-qa-runner'
import type {
  RemoteDeviceConfig,
  RemoteLease,
  RemotePluginDeviceConfig,
} from '@vostride/agent-qa-runner'
import { connectionSecretNames, remoteLabel, secretReferenceNames } from '@vostride/agent-qa-schema'
import type { IOSAdapterConfig, IOSSessionOptions } from './types.js'

// WDA's default 50 cuts React Native trees, and deeper snapshots can fail inside XCTest on some hosts.
export const IOS_SNAPSHOT_MAX_DEPTH = 62
export const IOS_SNAPSHOT_FALLBACK_DEPTH = 50
export const IOS_SNAPSHOT_DEPTH_ENV = 'AGENT_QA_IOS_SNAPSHOT_MAX_DEPTH'
const IOS_SNAPSHOT_DEPTH_CAPABILITY = 'appium:settings[snapshotMaxDepth]'

function positiveInteger(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? value : undefined
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) return undefined
  const parsed = Number(value.trim())
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
}

export function resolveIOSSnapshotDepth(): number {
  return positiveInteger(process.env[IOS_SNAPSHOT_DEPTH_ENV]) ?? IOS_SNAPSHOT_MAX_DEPTH
}

const REMOTE_NEW_COMMAND_TIMEOUT_S = 90
const LOCAL_APPIUM_URL = 'http://localhost:4723'

function localEndpoint(appiumUrl: string | undefined) {
  const url = new URL(appiumUrl ?? LOCAL_APPIUM_URL)
  const protocol = url.protocol === 'https:' ? 'https' : 'http'
  return {
    protocol,
    hostname: url.hostname,
    port: url.port === '' ? (protocol === 'https' ? 443 : 80) : Number(url.port),
    path: url.pathname === '' ? '/' : url.pathname,
  }
}

function textOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function statedText(capabilities: CapabilityMap | undefined, name: string): string | undefined {
  return capabilities === undefined ? undefined : textOf(capabilityValue(capabilities, name))
}

function referencedNames(value: unknown): string[] {
  if (typeof value === 'string') return secretReferenceNames(value)
  if (Array.isArray(value)) return value.flatMap(referencedNames)
  if (typeof value === 'object' && value !== null) {
    return Object.values(value as Record<string, unknown>).flatMap(referencedNames)
  }
  return []
}

// A reference the secrets file does not declare is refused before any request.
function withSecretsResolved(
  capabilities: CapabilityMap,
  options: IOSSessionOptions,
  subject: string,
  details: { remote?: string } = {},
): CapabilityMap {
  const secrets = options.connectionSecrets
  const missing = referencedNames(capabilities).find((name) => secrets?.has(name) !== true)
  if (missing !== undefined) {
    const secretsFile = options.secretsFile ?? 'workspace.secretsFile'
    throw new RemoteRefusalError(
      `${subject} needs ${missing}, which ${secretsFile} does not declare. Add it there.`,
      details,
    )
  }
  return resolveSecretTemplatesInValue(capabilities, secrets)
}

function rememberedRefusal(
  options: IOSSessionOptions,
  remoteDevice: Pick<RemoteDeviceConfig, 'name'>,
  device: string,
): RemoteRefusalError | undefined {
  const memory = options.refusalMemory
  if (memory === undefined) return undefined
  return (
    memory.refusalFor(remoteDeviceRefusalKey(remoteDevice, device, undefined)) ??
    memory.refusalFor(remoteDeviceRefusalKey(remoteDevice, device, 'refused'))
  )
}

export function browserModeName(config: IOSAdapterConfig): string | undefined {
  const device = config.device
  const stated = mergeCapabilities(device?.remote?.capabilities, device?.capabilities)
  return statedText(stated, 'browserName')
}

// Derived, then the remote's capabilities, then the device's, with their references as written.
// A simulator's default name and its log stream are this machine's business, never a remote's.
function statedRemoteCapabilities(
  config: IOSAdapterConfig,
  remoteCapabilities: CapabilityMap | undefined,
): CapabilityMap {
  const profile = config.device
  const derived: CapabilityMap = {
    platformName: 'iOS',
    'appium:automationName': 'XCUITest',
    ...remoteDerivedIdentity({
      ...(profile?.model !== undefined ? { model: profile.model } : {}),
      ...(profile?.os !== undefined ? { os: profile.os } : {}),
      ...(profile?.id !== undefined ? { id: profile.id } : {}),
    }),
    'appium:newCommandTimeout': REMOTE_NEW_COMMAND_TIMEOUT_S,
    [IOS_SNAPSHOT_DEPTH_CAPABILITY]: resolveIOSSnapshotDepth(),
  }
  const browserName = browserModeName(config)
  if (browserName) {
    derived.browserName = browserName
    // A server-given BiDi url would be dialled with the remote's headers.
    derived['wdio:enforceWebDriverClassic'] = true
  } else {
    if (config.bundleId) derived['appium:bundleId'] = config.bundleId
    if (config.appState === 'preserve') derived['appium:noReset'] = true
    if (config.appState === 'reset') derived['appium:noReset'] = false
  }
  return mergeCapabilities(derived, remoteCapabilities, profile?.capabilities)
}

// References resolve after the merge.
function remoteCapabilities(
  config: IOSAdapterConfig,
  remoteDevice: RemoteDeviceConfig,
  device: string,
  options: IOSSessionOptions,
): CapabilityMap {
  const merged = statedRemoteCapabilities(config, remoteDevice.capabilities)
  const browserName = browserModeName(config)
  const label = remoteLabel(remoteDevice)
  if (!browserName) {
    const app = remoteAppCapability({
      device,
      remote: remoteDevice.name,
      target: config.targetName ?? 'ios',
      ...(config.appRef !== undefined ? { appRef: config.appRef } : {}),
      ...(config.appPath !== undefined ? { appPath: config.appPath } : {}),
      capabilities: merged,
    })
    if ('refusal' in app) throw new RemoteRefusalError(app.refusal, { remote: label })
    if (app.app !== undefined) merged['appium:app'] = app.app
  }

  return withSecretsResolved(merged, options, `Device ${device} on remote ${label}`, {
    remote: label,
  })
}

function refuseLeakingLogs(device: string, remote: { name: string }, label: string): void {
  const logging = deviceDebugLoggingRefusal(
    { WDIO_LOG_LEVEL: process.env.WDIO_LOG_LEVEL, NODE_DEBUG: process.env.NODE_DEBUG },
    { remote, device },
  )
  if (logging !== undefined) throw new RemoteRefusalError(logging, { remote: label })
}

// A plugin's answer is already resolved: it carries values, not references.
function answeredConnection(remoteDevice: RemoteDeviceConfig): RemoteDeviceConnection {
  const url = new URL(remoteDevice.url)
  const protocol = url.protocol === 'https:' ? 'https' : 'http'
  return {
    protocol,
    hostname: url.hostname,
    port: url.port === '' ? (protocol === 'https' ? 443 : 80) : Number(url.port),
    path: url.pathname === '' ? '/' : url.pathname,
    headers: { ...remoteDevice.headers },
  }
}

// Nothing from WebdriverIO's error rides along: it holds the full url and the server's text.
async function createRemoteIOSSession(
  config: IOSAdapterConfig,
  remoteDevice: RemoteDeviceConfig,
  options: IOSSessionOptions,
  answered = false,
) {
  const device = config.device?.name ?? 'ios'
  const label = remoteLabel(remoteDevice)
  let connection: RemoteDeviceConnection
  if (answered) {
    connection = answeredConnection(remoteDevice)
  } else {
    refuseLeakingLogs(device, remoteDevice, label)
    const remembered = rememberedRefusal(options, remoteDevice, device)
    if (remembered !== undefined) throw remembered
    connection = resolveRemoteDeviceConnection({
      remote: remoteDevice,
      device,
      secrets: options.connectionSecrets,
      secretsFile: options.secretsFile,
    })
  }
  const capabilities = remoteCapabilities(config, remoteDevice, device, options)
  const bounds = createRemoteDeviceRequestBounds({
    connectTimeoutMs: remoteDevice.connectTimeoutMs,
    commandBoundMs: options.commandBoundMs ?? REMOTE_COMMAND_BOUND_MS,
  })

  let driver: WebdriverIO.Browser
  try {
    driver = await remote({
      protocol: connection.protocol,
      hostname: connection.hostname,
      port: connection.port,
      path: connection.path,
      headers: { ...connection.headers },
      connectionRetryCount: 0,
      enableDirectConnect: false,
      logLevel: 'silent',
      connectionRetryTimeout: bounds.clientTimeoutMs,
      transformRequest: (request) => bounds.boundRequest(request),
      transformResponse: (response) => {
        bounds.captureReply({ statusCode: response.statusCode, body: response.body })
        return response
      },
      capabilities: capabilities as WebdriverIO.Capabilities,
    })
  } catch (error) {
    const reply = bounds.newSessionReply()
    const kind = classifyNewSessionFailure(reply, error)
    const mask = options.mask ?? ((text: string) => text)
    const secretNames = [
      ...new Set([
        ...connectionSecretNames([remoteDevice]),
        ...referencedNames(config.device?.capabilities),
      ]),
    ]
    const sentence = remoteDeviceRefusalSentence(kind, {
      remote: remoteDevice,
      device,
      secretsFile: options.secretsFile,
      secretNames,
      reason: kind === 'refused' ? serverReasonLine({ reply, error }, mask) : undefined,
    })
    const refused = new RemoteRefusalError(sentence, { remote: label, kind })
    const key = remoteDeviceRefusalKey(remoteDevice, device, kind)
    throw options.refusalMemory?.remember(key, refused) ?? refused
  }
  bounds.markOpened()
  return driver
}

// A plugin's acquire spends the remote's connect budget; the new session still gets this much.
export const MIN_PLUGIN_CONNECT_MS = 1_000

export interface PluginIOSSession {
  readonly driver: WebdriverIO.Browser
  readonly lease: RemoteLease
  // The plugin's answer as a url remote: what the session connected to.
  readonly remote: RemoteDeviceConfig
}

function releasingOnce(lease: RemoteLease): () => Promise<void> {
  let released: Promise<void> | undefined
  return () => (released ??= lease.release().catch(() => undefined))
}

// The answer is checked like a remote's capabilities, so it cannot change what the test runs on.
function answerContradictions(
  config: IOSAdapterConfig,
  remote: string,
  capabilities: CapabilityMap | undefined,
): string[] {
  if (capabilities === undefined) return []
  const profile = config.device
  const device = profile?.name ?? 'ios'
  const layer = { name: remote, capabilities }
  return [
    ...staticCapabilityContradictions({
      device,
      platform: 'ios',
      ...(profile?.model !== undefined ? { model: profile.model } : {}),
      ...(profile?.os !== undefined ? { os: profile.os } : {}),
      ...(profile?.id !== undefined ? { id: profile.id } : {}),
      remote: layer,
    }),
    ...runStartCapabilityContradictions({
      device,
      target: {
        name: config.targetName ?? 'ios',
        ...(config.bundleId ? { bundleId: config.bundleId } : {}),
      },
      appState: config.appState ?? 'preserve',
      browserMode: browserModeName(config) !== undefined,
      remote: layer,
    }),
  ]
}

// The plugin leases the device; its answer then takes the url remote's path, so refusals, bounds
// and capability checks are the same as on a url remote.
export async function createPluginIOSSession(
  config: IOSAdapterConfig,
  pluginDevice: RemotePluginDeviceConfig,
  options: IOSSessionOptions = {},
): Promise<PluginIOSSession> {
  const device = config.device?.name ?? 'ios'
  const { name } = pluginDevice
  const entry = pluginDevice.plugin.entry
  const sessions = options.pluginSessions
  if (sessions === undefined) {
    throw new RemoteRefusalError(
      `Remote ${name} names plugin entry ${entry}, and this host started no plugin host for it.`,
      { remote: name, kind: 'refused' },
    )
  }
  refuseLeakingLogs(device, pluginDevice, name)
  const memory = options.refusalMemory
  const remembered = rememberedRefusal(options, pluginDevice, device)
  if (remembered !== undefined) throw remembered
  const remember = (error: RemoteRefusalError): RemoteRefusalError =>
    memory?.remember(remoteDeviceRefusalKey(pluginDevice, device, error.kind), error) ?? error

  const capabilities = statedRemoteCapabilities(config, pluginDevice.capabilities)
  // A set app.ref, or an app the capabilities name, wins; only an app.path alone uploads.
  let sessionConfig = config
  const appPath = config.appPath?.trim()
  if (
    !browserModeName(config) &&
    capabilityValue(capabilities, 'app') === undefined &&
    !config.appRef?.trim() &&
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
      platform: 'ios',
      path: appPath,
      deadlineMs: pluginDevice.uploadTimeoutMs,
    })
    sessionConfig = { ...config, appRef: uploaded.ref }
  }

  const startedAt = Date.now()
  let lease: RemoteLease
  try {
    lease = await sessions.acquire({
      remote: name,
      plugin: pluginDevice.plugin,
      deadlineMs: pluginDevice.connectTimeoutMs,
      session: { platform: 'ios', capabilities },
      ...(config.runFacts?.testName === undefined ? {} : { testName: config.runFacts.testName }),
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
  const contradictions = answerContradictions(config, label, answer.capabilities)
  if (contradictions.length > 0) return refuse(contradictions.join('\n'))

  const remaining = pluginDevice.connectTimeoutMs - (Date.now() - startedAt)
  const remote: RemoteDeviceConfig = {
    name,
    protocol: 'appium',
    url: answer.url,
    ...(answer.headers === undefined ? {} : { headers: answer.headers }),
    connectTimeoutMs: Math.max(MIN_PLUGIN_CONNECT_MS, remaining),
    capabilities: mergeCapabilities(answer.capabilities, pluginDevice.capabilities),
  }
  try {
    const driver = await createRemoteIOSSession(sessionConfig, remote, options, true)
    return { driver, lease, remote }
  } catch (error) {
    await release()
    throw error
  }
}

export async function createIOSSession(
  config: IOSAdapterConfig,
  options: IOSSessionOptions = {},
) {
  const remoteDevice = config.device?.remote
  if (remoteDevice !== undefined && isPluginRemote(remoteDevice)) {
    throw new RemoteRefusalError(
      `Device ${config.device?.name ?? 'ios'} is on remote ${remoteDevice.name}, a plugin remote; its session opens through the iOS adapter, which leases it.`,
      { remote: remoteDevice.name, kind: 'refused' },
    )
  }
  if (remoteDevice !== undefined) return createRemoteIOSSession(config, remoteDevice, options)

  const profile = config.device
  const here = profile?.here
  const stated = profile?.capabilities
  const browserName = browserModeName(config)

  const udid = here?.udid ?? profile?.id ?? config.udid
  // Without a version XCUITest picks the newest SDK, not the simulator that was found.
  const platformVersion = here?.os ?? profile?.os

  const derived: CapabilityMap = {
    platformName: 'iOS',
    'appium:automationName': 'XCUITest',
    'appium:deviceName': here?.name ?? profile?.model ?? profile?.name ?? 'iPhone Simulator',
    'appium:showIOSLog': true,
    'appium:newCommandTimeout': config.timeouts?.test ? Math.ceil(config.timeouts.test / 1000) : 300,
    [IOS_SNAPSHOT_DEPTH_CAPABILITY]: resolveIOSSnapshotDepth(),
  }
  if (udid !== undefined) derived['appium:udid'] = udid
  if (platformVersion !== undefined) derived['appium:platformVersion'] = platformVersion

  if (!browserName && config.appState === 'preserve') derived['appium:noReset'] = true
  if (!browserName && config.appState === 'reset') derived['appium:noReset'] = false
  if (config.bundleId) derived['appium:bundleId'] = config.bundleId
  if (config.appPath) derived['appium:app'] = config.appPath

  const endpoint = localEndpoint(config.appiumUrl)
  return remote({
    protocol: endpoint.protocol,
    hostname: endpoint.hostname,
    port: endpoint.port,
    path: endpoint.path,
    logLevel: config.verbose ? 'info' : 'silent',
    capabilities: withSecretsResolved(
      mergeCapabilities(derived, stated),
      options,
      `Device ${profile?.name ?? 'ios'}`,
    ) as WebdriverIO.Capabilities,
  })
}
