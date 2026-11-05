import { remote } from 'webdriverio'
import {
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

function referencedNames(value: unknown): string[] {
  if (typeof value === 'string') return secretReferenceNames(value)
  if (Array.isArray(value)) return value.flatMap(referencedNames)
  if (typeof value === 'object' && value !== null) {
    return Object.values(value as Record<string, unknown>).flatMap(referencedNames)
  }
  return []
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
  const browserName = config.browserName
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

  const secrets = options.connectionSecrets
  const missing = referencedNames(merged).find((name) => secrets?.has(name) !== true)
  if (missing !== undefined) {
    const secretsFile = options.secretsFile ?? 'workspace.secretsFile'
    throw new RemoteRefusalError(
      `Device ${device} on remote ${label} needs ${missing}, which ${secretsFile} does not declare. Add it there.`,
      { remote: label },
    )
  }
  return resolveSecretTemplatesInValue(merged, secrets)
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

  const match = config.device?.match ?? {}
  const appiumUrl = process.env.AGENT_QA_APPIUM_URL ?? config.appiumUrl ?? 'http://localhost:4723'
  const url = new URL(appiumUrl)

  const browserName = config.browserName ?? (match.browserName as string | undefined)
  const appPath = config.appPath
  if (browserName && appPath) {
    throw new MobileSetupError({
      category: 'app-install',
      message: 'Mobile browser mode cannot be combined with app.path',
      platform: 'android',
      deviceName: config.device?.name,
      appId: appPath,
    })
  }

  const appStateNoReset =
    config.appState === 'preserve' ? true :
    config.appState === 'reset' ? false :
    undefined

  const capabilities: Record<string, unknown> = {
    platformName: 'Android',
    'appium:automationName': (match.automationName as string) ?? 'UiAutomator2',
    'appium:deviceName': config.device?.name ?? 'Android Emulator',
    'appium:newCommandTimeout': config.timeouts?.test ? Math.ceil(config.timeouts.test / 1000) : 300,
    'appium:chromedriverAutodownload': true,
  }

  if (match.platformVersion) capabilities['appium:platformVersion'] = match.platformVersion
  if (match.serial) capabilities['appium:udid'] = match.serial
  if (match.avd) capabilities['appium:avd'] = match.avd
  if (config.avd) capabilities['appium:avd'] = config.avd
  if (appPath) capabilities['appium:app'] = appPath

  if (browserName) {
    capabilities.browserName = browserName
    capabilities['appium:autoWebview'] = true
  } else {
    if (appStateNoReset !== undefined) capabilities['appium:noReset'] = appStateNoReset
    if (match.appPackage) capabilities['appium:appPackage'] = match.appPackage
    if (config.appPackage) capabilities['appium:appPackage'] = config.appPackage
    if (match.appActivity) capabilities['appium:appActivity'] = match.appActivity
    if (config.appActivity) capabilities['appium:appActivity'] = config.appActivity
  }

  // Strip undefined values
  for (const key of Object.keys(capabilities)) {
    if (capabilities[key] === undefined) {
      delete capabilities[key]
    }
  }

  return remote({
    hostname: url.hostname,
    port: parseInt(url.port || '4723', 10),
    path: url.pathname === '/' ? '/' : url.pathname,
    logLevel: config.verbose ? 'info' : 'silent',
    capabilities: capabilities as WebdriverIO.Capabilities,
  })
}
