import { remote } from 'webdriverio'
import {
  capabilityValue,
  classifyNewSessionFailure,
  createRemoteDeviceRequestBounds,
  deviceDebugLoggingRefusal,
  mergeCapabilities,
  MobileSetupError,
  REMOTE_COMMAND_BOUND_MS,
  remoteAppCapability,
  remoteDerivedIdentity,
  remoteDeviceRefusalKey,
  remoteDeviceRefusalSentence,
  resolveRemoteDeviceConnection,
  serverReasonLine,
} from '@vostride/agent-qa-core'
import type { CapabilityMap } from '@vostride/agent-qa-core'
import { RemoteRefusalError, resolveSecretTemplatesInValue } from '@vostride/agent-qa-runner'
import type { RemoteDeviceConfig } from '@vostride/agent-qa-runner'
import { connectionSecretNames, remoteLabel, secretReferenceNames } from '@vostride/agent-qa-schema'
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
  options: AndroidSessionOptions,
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
  options: AndroidSessionOptions,
  remoteDevice: RemoteDeviceConfig,
  device: string,
): RemoteRefusalError | undefined {
  const memory = options.refusalMemory
  if (memory === undefined) return undefined
  return (
    memory.refusalFor(remoteDeviceRefusalKey(remoteDevice, device, undefined)) ??
    memory.refusalFor(remoteDeviceRefusalKey(remoteDevice, device, 'refused'))
  )
}

// Derived, then the remote's capabilities, then the device's; references resolve after the merge.
function remoteCapabilities(
  config: AndroidAdapterConfig,
  remoteDevice: RemoteDeviceConfig,
  device: string,
  options: AndroidSessionOptions,
): CapabilityMap {
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

  const merged = mergeCapabilities(derived, remoteDevice.capabilities, profile?.capabilities)
  const label = remoteLabel(remoteDevice)
  if (!browserName) {
    const app = remoteAppCapability({
      device,
      remote: remoteDevice.name,
      target: config.targetName ?? 'android',
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

// Nothing from WebdriverIO's error rides along: it holds the full url and the server's text.
async function createRemoteAndroidSession(
  config: AndroidAdapterConfig,
  remoteDevice: RemoteDeviceConfig,
  options: AndroidSessionOptions,
) {
  const device = config.device?.name ?? 'android'
  const label = remoteLabel(remoteDevice)
  const logging = deviceDebugLoggingRefusal(
    { WDIO_LOG_LEVEL: process.env.WDIO_LOG_LEVEL, NODE_DEBUG: process.env.NODE_DEBUG },
    { remote: remoteDevice, device },
  )
  if (logging !== undefined) throw new RemoteRefusalError(logging, { remote: label })
  const remembered = rememberedRefusal(options, remoteDevice, device)
  if (remembered !== undefined) throw remembered

  const connection = resolveRemoteDeviceConnection({
    remote: remoteDevice,
    device,
    secrets: options.connectionSecrets,
    secretsFile: options.secretsFile,
  })
  const capabilities = remoteCapabilities(config, remoteDevice, device, options)
  const bounds = createRemoteDeviceRequestBounds({
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
      connectionRetryTimeout: remoteDevice.connectTimeoutMs,
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

export async function createAndroidSession(
  config: AndroidAdapterConfig,
  options: AndroidSessionOptions = {},
) {
  const remoteDevice = config.device?.remote
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
    capabilities: withSecretsResolved(
      mergeCapabilities(derived, stated),
      options,
      `Device ${profile?.name ?? 'android'}`,
    ) as WebdriverIO.Capabilities,
  })
}
