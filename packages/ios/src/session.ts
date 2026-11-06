import { remote } from 'webdriverio'
import {
  capabilityValue,
  classifyNewSessionFailure,
  createPluginDeviceSession,
  createRemoteDeviceRequestBounds,
  mergeCapabilities,
  REMOTE_COMMAND_BOUND_MS,
  referencedSecretNames,
  refuseLeakingDeviceLogs,
  rememberedDeviceRefusal,
  remoteDerivedIdentity,
  remoteDeviceCapabilities,
  remoteDeviceRefusalKey,
  remoteDeviceRefusalSentence,
  resolveRemoteDeviceConnection,
  serverReasonLine,
  withDeviceSecretsResolved,
} from '@vostride/agent-qa-core'
import type {
  CapabilityMap,
  PluginDeviceSession,
  RemoteDeviceConnection,
  RemoteDeviceTest,
} from '@vostride/agent-qa-core'
import { isPluginRemote, RemoteRefusalError } from '@vostride/agent-qa-runner'
import type { RemoteDeviceConfig, RemotePluginDeviceConfig } from '@vostride/agent-qa-runner'
import { connectionSecretNames, remoteLabel } from '@vostride/agent-qa-schema'
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

export function browserModeName(config: IOSAdapterConfig): string | undefined {
  const device = config.device
  const stated = mergeCapabilities(device?.remote?.capabilities, device?.capabilities)
  return statedText(stated, 'browserName')
}

// A simulator's default name and its log stream are this machine's business, never a remote's.
function derivedRemoteCapabilities(config: IOSAdapterConfig): CapabilityMap {
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
  return derived
}

function remoteDeviceTest(config: IOSAdapterConfig): RemoteDeviceTest {
  const profile = config.device
  return {
    platform: 'ios',
    device: {
      name: profile?.name ?? 'ios',
      model: profile?.model,
      os: profile?.os,
      id: profile?.id,
      capabilities: profile?.capabilities,
    },
    target: {
      name: config.targetName ?? 'ios',
      ...(config.bundleId ? { bundleId: config.bundleId } : {}),
    },
    appState: config.appState ?? 'preserve',
    browserName: browserModeName(config),
    appRef: config.appRef,
    appPath: config.appPath,
    testName: config.runFacts?.testName,
    derived: derivedRemoteCapabilities(config),
  }
}

// Nothing from WebdriverIO's error rides along: it holds the full url and the server's text.
async function connectRemoteIOSSession(
  config: IOSAdapterConfig,
  remoteDevice: RemoteDeviceConfig,
  connection: RemoteDeviceConnection,
  capabilities: CapabilityMap,
  options: IOSSessionOptions,
) {
  const device = config.device?.name ?? 'ios'
  const label = remoteLabel(remoteDevice)
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
        ...referencedSecretNames(config.device?.capabilities),
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

async function createRemoteIOSSession(
  config: IOSAdapterConfig,
  remoteDevice: RemoteDeviceConfig,
  options: IOSSessionOptions,
) {
  const device = config.device?.name ?? 'ios'
  const label = remoteLabel(remoteDevice)
  refuseLeakingDeviceLogs(device, remoteDevice, label)
  const remembered = rememberedDeviceRefusal(options.refusalMemory, remoteDevice, device)
  if (remembered !== undefined) throw remembered
  const connection = resolveRemoteDeviceConnection({
    remote: remoteDevice,
    device,
    secrets: options.connectionSecrets,
    secretsFile: options.secretsFile,
  })
  const capabilities = remoteDeviceCapabilities(remoteDeviceTest(config), remoteDevice, options)
  return connectRemoteIOSSession(config, remoteDevice, connection, capabilities, options)
}

export type PluginIOSSession = PluginDeviceSession<WebdriverIO.Browser>

export function createPluginIOSSession(
  config: IOSAdapterConfig,
  pluginDevice: RemotePluginDeviceConfig,
  options: IOSSessionOptions = {},
): Promise<PluginIOSSession> {
  return createPluginDeviceSession({
    ...remoteDeviceTest(config),
    remote: pluginDevice,
    options,
    open: ({ remote: answered, connection, capabilities }) =>
      connectRemoteIOSSession(config, answered, connection, capabilities, options),
  })
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
    capabilities: withDeviceSecretsResolved(
      mergeCapabilities(derived, stated),
      options,
      `Device ${profile?.name ?? 'ios'}`,
    ) as WebdriverIO.Capabilities,
  })
}
