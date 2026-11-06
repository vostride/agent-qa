import { remote } from 'webdriverio'
import {
  capabilityValue,
  classifyNewSessionFailure,
  createPluginDeviceSession,
  createRemoteDeviceRequestBounds,
  mergeCapabilities,
  MobileSetupError,
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
import type { AndroidAdapterConfig, AndroidSessionOptions } from './types.js'

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

export function browserModeName(config: AndroidAdapterConfig): string | undefined {
  const device = config.device
  const stated = mergeCapabilities(device?.remote?.capabilities, device?.capabilities)
  return statedText(stated, 'browserName') ?? textOf(config.browserName)
}

function derivedRemoteCapabilities(config: AndroidAdapterConfig): CapabilityMap {
  const profile = config.device
  const derived: CapabilityMap = {
    platformName: 'Android',
    'appium:automationName': 'UiAutomator2',
    ...remoteDerivedIdentity({
      ...(profile?.model !== undefined ? { model: profile.model } : {}),
      ...(profile?.os !== undefined ? { os: profile.os } : {}),
      ...(profile?.id !== undefined ? { id: profile.id } : {}),
    }),
    'appium:newCommandTimeout': REMOTE_NEW_COMMAND_TIMEOUT_S,
  }
  const browserName = browserModeName(config)
  if (browserName) {
    derived.browserName = browserName
    derived['appium:autoWebview'] = true
    // A server-given BiDi url would be dialled with the remote's headers.
    derived['wdio:enforceWebDriverClassic'] = true
  } else {
    if (config.appPackage) derived['appium:appPackage'] = config.appPackage
    if (config.appActivity) derived['appium:appActivity'] = config.appActivity
    if (config.appState === 'preserve') derived['appium:noReset'] = true
    if (config.appState === 'reset') derived['appium:noReset'] = false
  }
  return derived
}

function remoteDeviceTest(config: AndroidAdapterConfig): RemoteDeviceTest {
  const profile = config.device
  return {
    platform: 'android',
    device: {
      name: profile?.name ?? 'android',
      model: profile?.model,
      os: profile?.os,
      id: profile?.id,
      capabilities: profile?.capabilities,
    },
    target: {
      name: config.targetName ?? 'android',
      ...(config.appPackage ? { appPackage: config.appPackage } : {}),
      ...(config.appActivity ? { appActivity: config.appActivity } : {}),
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
async function connectRemoteAndroidSession(
  config: AndroidAdapterConfig,
  remoteDevice: RemoteDeviceConfig,
  connection: RemoteDeviceConnection,
  capabilities: CapabilityMap,
  options: AndroidSessionOptions,
) {
  const device = config.device?.name ?? 'android'
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
      ...(connection.query === undefined ? {} : { queryParams: { ...connection.query } }),
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

async function createRemoteAndroidSession(
  config: AndroidAdapterConfig,
  remoteDevice: RemoteDeviceConfig,
  options: AndroidSessionOptions,
) {
  const device = config.device?.name ?? 'android'
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
  return connectRemoteAndroidSession(config, remoteDevice, connection, capabilities, options)
}

export type PluginAndroidSession = PluginDeviceSession<WebdriverIO.Browser>

export function createPluginAndroidSession(
  config: AndroidAdapterConfig,
  pluginDevice: RemotePluginDeviceConfig,
  options: AndroidSessionOptions = {},
): Promise<PluginAndroidSession> {
  return createPluginDeviceSession({
    ...remoteDeviceTest(config),
    remote: pluginDevice,
    options,
    open: ({ remote: answered, connection, capabilities }) =>
      connectRemoteAndroidSession(config, answered, connection, capabilities, options),
  })
}

export async function createAndroidSession(
  config: AndroidAdapterConfig,
  options: AndroidSessionOptions = {},
) {
  const remoteDevice = config.device?.remote
  if (remoteDevice !== undefined && isPluginRemote(remoteDevice)) {
    throw new RemoteRefusalError(
      `Device ${config.device?.name ?? 'android'} is on remote ${remoteDevice.name}, a plugin remote; its session opens through the Android adapter, which leases it.`,
      { remote: remoteDevice.name, kind: 'refused' },
    )
  }
  if (remoteDevice !== undefined) return createRemoteAndroidSession(config, remoteDevice, options)

  const profile = config.device
  const here = profile?.here
  const stated = profile?.capabilities

  const browserName = browserModeName(config)
  const appPath = config.appPath
  if (browserName && appPath) {
    throw new MobileSetupError({
      category: 'app-install',
      message: 'Mobile browser mode cannot be combined with app.path',
      platform: 'android',
      deviceName: profile?.name,
      appId: appPath,
    })
  }

  const udid = here?.udid ?? profile?.id
  const avd = here?.avd ?? config.avd
  const platformVersion = profile?.os

  const derived: CapabilityMap = {
    platformName: 'Android',
    'appium:automationName': 'UiAutomator2',
    'appium:deviceName': here?.name ?? profile?.model ?? profile?.name ?? 'Android Emulator',
    'appium:newCommandTimeout': config.timeouts?.test ? Math.ceil(config.timeouts.test / 1000) : 300,
    'appium:chromedriverAutodownload': true,
  }
  // The udid or AVD names the device; a version beside it could only disagree.
  if (udid !== undefined) derived['appium:udid'] = udid
  if (avd !== undefined) derived['appium:avd'] = avd
  if (udid === undefined && avd === undefined && platformVersion !== undefined) {
    derived['appium:platformVersion'] = platformVersion
  }
  if (appPath) derived['appium:app'] = appPath

  if (browserName) {
    derived.browserName = browserName
    derived['appium:autoWebview'] = true
  } else {
    if (config.appState === 'preserve') derived['appium:noReset'] = true
    if (config.appState === 'reset') derived['appium:noReset'] = false
    if (config.appPackage) derived['appium:appPackage'] = config.appPackage
    if (config.appActivity) derived['appium:appActivity'] = config.appActivity
  }

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
      `Device ${profile?.name ?? 'android'}`,
    ) as WebdriverIO.Capabilities,
  })
}
