import { remote } from 'webdriverio'
import {
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
  serverReasonLine,
} from '@vostride/agent-qa-core'
import type { CapabilityMap } from '@vostride/agent-qa-core'
import { RemoteRefusalError, resolveSecretTemplatesInValue } from '@vostride/agent-qa-runner'
import type { RemoteDeviceConfig } from '@vostride/agent-qa-runner'
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

function referencedNames(value: unknown): string[] {
  if (typeof value === 'string') return secretReferenceNames(value)
  if (Array.isArray(value)) return value.flatMap(referencedNames)
  if (typeof value === 'object' && value !== null) {
    return Object.values(value as Record<string, unknown>).flatMap(referencedNames)
  }
  return []
}

function rememberedRefusal(
  options: IOSSessionOptions,
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

function remoteBrowserName(
  config: IOSAdapterConfig,
  remoteDevice: RemoteDeviceConfig,
): string | undefined {
  const named = config.device?.match?.browserName
  if (typeof named === 'string' && named.trim().length > 0) return named.trim()
  const stated = mergeCapabilities(remoteDevice.capabilities, config.device?.capabilities)
  const browserName = stated.browserName
  return typeof browserName === 'string' && browserName.trim().length > 0
    ? browserName.trim()
    : undefined
}

// Derived, then the remote's capabilities, then the device's; references resolve after the merge.
// A simulator's default name and its log stream are this machine's business, never a remote's.
function remoteCapabilities(
  config: IOSAdapterConfig,
  remoteDevice: RemoteDeviceConfig,
  device: string,
  options: IOSSessionOptions,
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
  const browserName = remoteBrowserName(config, remoteDevice)
  if (browserName) {
    derived.browserName = browserName
    // A server-given BiDi url would be dialled with the remote's headers.
    derived['wdio:enforceWebDriverClassic'] = true
  } else {
    if (config.bundleId) derived['appium:bundleId'] = config.bundleId
    if (config.appState === 'preserve') derived['appium:noReset'] = true
    if (config.appState === 'reset') derived['appium:noReset'] = false
  }

  const merged = mergeCapabilities(derived, remoteDevice.capabilities, profile?.capabilities)
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
async function createRemoteIOSSession(
  config: IOSAdapterConfig,
  remoteDevice: RemoteDeviceConfig,
  options: IOSSessionOptions,
) {
  const device = config.device?.name ?? 'ios'
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

export async function createIOSSession(
  config: IOSAdapterConfig,
  options: IOSSessionOptions = {},
) {
  const remoteDevice = config.device?.remote
  if (remoteDevice !== undefined) return createRemoteIOSSession(config, remoteDevice, options)

  const match = config.device?.match ?? {}
  const appiumUrl = process.env.AGENT_QA_APPIUM_URL ?? config.appiumUrl ?? 'http://localhost:4723'
  const url = new URL(appiumUrl)
  const browserName = typeof match.browserName === 'string' && match.browserName.trim().length > 0
    ? match.browserName.trim()
    : undefined
  const appStateNoReset =
    config.appState === 'preserve' ? true :
    config.appState === 'reset' ? false :
    undefined

  const capabilities: Record<string, unknown> = {
    platformName: 'iOS',
    'appium:automationName': (match.automationName as string) ?? 'XCUITest',
    'appium:deviceName': config.device?.name ?? 'iPhone Simulator',
    'appium:showIOSLog': true,
    'appium:newCommandTimeout': config.timeouts?.test ? Math.ceil(config.timeouts.test / 1000) : 300,
    [IOS_SNAPSHOT_DEPTH_CAPABILITY]: resolveIOSSnapshotDepth(),
  }

  if (!browserName && appStateNoReset !== undefined) capabilities['appium:noReset'] = appStateNoReset

  if (match.platformVersion) capabilities['appium:platformVersion'] = match.platformVersion
  if (match.bundleId) capabilities['appium:bundleId'] = match.bundleId
  if (config.bundleId) capabilities['appium:bundleId'] = config.bundleId
  if (config.appPath) capabilities['appium:app'] = config.appPath
  if (match.udid) capabilities['appium:udid'] = match.udid
  if (config.udid) capabilities['appium:udid'] = config.udid

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
