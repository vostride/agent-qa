import { existsSync } from 'node:fs'
import { dirname, resolve as resolvePath } from 'node:path'
import type { RemoteDeviceConfig } from '@vostride/agent-qa-runner'
import type { RemoteEntry } from '../schema/remote-schema.js'
import { selectDevicePlace } from './select-device.js'

export type MobilePlatform = 'android' | 'ios'
export type MobileAppState = 'preserve' | 'reset'

export type MobileSetupErrorCategory =
  | 'device-resolution'
  | 'appium-startup'
  | 'device-readiness'
  | 'adapter-load'
  | 'app-install'
  | 'app-launch'

export interface MobileSetupErrorOptions {
  category: MobileSetupErrorCategory
  message: string
  platform?: MobilePlatform
  targetName?: string
  deviceName?: string
  appId?: string
  cause?: unknown
  sourceTrace?: string[]
}

export class MobileSetupError extends Error {
  readonly category: MobileSetupErrorCategory
  readonly platform?: MobilePlatform
  readonly targetName?: string
  readonly deviceName?: string
  readonly appId?: string
  readonly sourceTrace?: string[]
  override readonly cause?: unknown

  constructor(options: MobileSetupErrorOptions) {
    super(options.message)
    this.name = 'MobileSetupError'
    this.category = options.category
    this.platform = options.platform
    this.targetName = options.targetName
    this.deviceName = options.deviceName
    this.appId = options.appId
    this.sourceTrace = options.sourceTrace
    this.cause = options.cause
  }
}

export interface ResolvedMobileDevice {
  name: string
  platform: MobilePlatform
  model?: string
  os?: string
  id?: string
  capabilities?: Record<string, unknown>
  remote?: RemoteDeviceConfig
}

export interface ResolvedMobileAppInstall {
  path?: string
  sourceTrace: Record<string, string>
}

export interface ResolvedMobileApp {
  bundleId?: string
  appPackage?: string
  appActivity?: string
  deepLinkAppId?: string
  install?: ResolvedMobileAppInstall
  sourceTrace: Record<string, string>
}

export interface ResolvedMobileRunConfig {
  platform: MobilePlatform
  targetName: string
  deviceName: string
  device: ResolvedMobileDevice
  app: ResolvedMobileApp
  appState: MobileAppState
  appium: { url?: string; managed?: boolean }
  sourceTrace: string[]
}

export interface ResolveMobileRunConfigInput {
  config: Record<string, any>
  targetName: string
  platform?: MobilePlatform
  explicitDeviceName?: string
  useDeviceName?: string
  appState?: MobileAppState
  configFilePath?: string
  appiumUrl?: string
}

interface TargetEntry {
  platform?: string
  bundleId?: string
  appPackage?: string
  appActivity?: string
  app?: {
    path?: string
  }
  device?: string
}

interface DeviceProfile {
  platform?: string
  model?: string
  os?: string
  id?: string
  capabilities?: Record<string, unknown>
  remote?: string
}

function isMobilePlatform(value: unknown): value is MobilePlatform {
  return value === 'android' || value === 'ios'
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isAbsoluteAppInstallValue(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')
}

function baseDirFor(filePath?: string): string {
  return filePath ? dirname(filePath) : process.cwd()
}

function setupError(
  message: string,
  input: ResolveMobileRunConfigInput,
  extras: Partial<Omit<MobileSetupErrorOptions, 'category' | 'message' | 'targetName'>> = {},
): MobileSetupError {
  return new MobileSetupError({
    category: 'device-resolution',
    message,
    targetName: input.targetName,
    ...extras,
  })
}

function appInstallError(
  message: string,
  input: ResolveMobileRunConfigInput,
  extras: Partial<Omit<MobileSetupErrorOptions, 'category' | 'message' | 'targetName'>> = {},
): MobileSetupError {
  return new MobileSetupError({
    category: 'app-install',
    message,
    targetName: input.targetName,
    ...extras,
  })
}

function chooseDeviceName(input: ResolveMobileRunConfigInput): { name?: string; source?: string } {
  const candidates = [
    ['explicitDeviceName', input.explicitDeviceName],
    ['use.device', input.useDeviceName],
  ] as const

  for (const [source, value] of candidates) {
    const name = asOptionalString(value)
    if (name) return { name, source }
  }

  return {}
}

function resolveAppField(
  field: 'bundleId' | 'appPackage' | 'appActivity',
  targetValue: unknown,
  targetName: string,
): { value?: string; source?: string } {
  const value = asOptionalString(targetValue)
  return value ? { value, source: `registry.targets.${targetName}.${field}` } : {}
}

function resolveAppInstall(
  target: TargetEntry,
  input: ResolveMobileRunConfigInput,
  platform: MobilePlatform,
  deviceName: string,
  sourceTrace: string[],
): ResolvedMobileAppInstall | undefined {
  const installSourceTrace: Record<string, string> = {}
  const pathValue = asOptionalString(target.app?.path)
  const pathSource = `agent-qa.config.yaml registry.targets.${input.targetName}.app.path`

  const install: ResolvedMobileAppInstall = { sourceTrace: installSourceTrace }

  if (pathValue) {
    if (isAbsoluteAppInstallValue(pathValue)) {
      throw appInstallError(`Configured app path must be relative: ${pathValue}`, input, {
        platform,
        deviceName,
        appId: pathValue,
        sourceTrace: [...sourceTrace, `app.path=${pathSource}`],
      })
    }
    const resolvedPath = resolvePath(baseDirFor(input.configFilePath), pathValue)
    if (!existsSync(resolvedPath)) {
      throw appInstallError(`Configured app path not found: ${resolvedPath}`, input, {
        platform,
        deviceName,
        appId: pathValue,
        sourceTrace: [...sourceTrace, `app.path=${pathSource}`],
      })
    }
    install.path = resolvedPath
    installSourceTrace['app.path'] = pathSource
    sourceTrace.push(`app.path=${pathSource}`)
  }

  return install.path ? install : undefined
}

export function resolveMobileRunConfig(input: ResolveMobileRunConfigInput): ResolvedMobileRunConfig {
  const targets = input.config.registry?.targets as Record<string, TargetEntry> | undefined
  const target = targets?.[input.targetName]
  if (!target) {
    const available = targets ? Object.keys(targets).join(', ') : 'none'
    throw setupError(
      `Target "${input.targetName}" not found in config. Available targets: ${available}`,
      input,
    )
  }

  const platformCandidate = input.platform ?? target.platform
  if (!isMobilePlatform(platformCandidate)) {
    throw setupError(
      `Target "${input.targetName}" is not a mobile target`,
      input,
    )
  }
  const platform = platformCandidate

  const appState = input.appState
  if (appState !== 'preserve' && appState !== 'reset') {
    throw setupError(
      'use.mobile.appState is required for native mobile app targets and must be one of: preserve | reset',
      input,
      { platform },
    )
  }

  const chosenDevice = chooseDeviceName(input)
  if (!chosenDevice.name) {
    throw setupError(
      `No device specified for mobile target "${input.targetName}"`,
      input,
      { platform },
    )
  }
  const deviceName = chosenDevice.name

  const devices = input.config.registry?.devices as Record<string, DeviceProfile> | undefined
  const deviceProfile = devices?.[deviceName]
  if (!deviceProfile) {
    const available = devices ? Object.keys(devices).join(', ') : 'none'
    throw setupError(
      `Device "${deviceName}" not found in registry.devices. Available devices: ${available}`,
      input,
      { platform, deviceName },
    )
  }

  if (deviceProfile.platform !== platform) {
    throw setupError(
      `Device "${deviceName}" platform "${deviceProfile.platform ?? 'unknown'}" does not match target "${input.targetName}" platform "${platform}"`,
      input,
      { platform, deviceName },
    )
  }

  let remote: RemoteDeviceConfig | undefined
  if (deviceProfile.remote !== undefined) {
    const selected = selectDevicePlace({
      devices: devices ?? {},
      remotes: (input.config.registry?.remotes ?? []) as readonly RemoteEntry[],
      device: deviceName,
    })
    if ('refusal' in selected) throw setupError(selected.refusal, input, { platform, deviceName })
    if (selected.place.kind === 'remote') remote = selected.place.remote
  }

  const appSourceTrace: Record<string, string> = {}
  const sourceTrace = [
    `target=registry.targets.${input.targetName}`,
    `platform=${platform}`,
    `device=${chosenDevice.source}:${deviceName}`,
    `appState=use.mobile.appState:${appState}`,
  ]

  let app: ResolvedMobileApp
  if (platform === 'android') {
    const appPackage = resolveAppField('appPackage', target.appPackage, input.targetName)
    const appActivity = resolveAppField('appActivity', target.appActivity, input.targetName)
    if (appPackage.source) appSourceTrace.appPackage = appPackage.source
    if (appActivity.source) appSourceTrace.appActivity = appActivity.source
    app = {
      appPackage: appPackage.value,
      appActivity: appActivity.value,
      deepLinkAppId: appPackage.value,
      sourceTrace: appSourceTrace,
    }
    if (appPackage.source) sourceTrace.push(`app.appPackage=${appPackage.source}`)
    if (appActivity.source) sourceTrace.push(`app.appActivity=${appActivity.source}`)
  } else {
    const bundleId = resolveAppField('bundleId', target.bundleId, input.targetName)
    if (bundleId.source) appSourceTrace.bundleId = bundleId.source
    app = {
      bundleId: bundleId.value,
      deepLinkAppId: bundleId.value,
      sourceTrace: appSourceTrace,
    }
    if (bundleId.source) sourceTrace.push(`app.bundleId=${bundleId.source}`)
  }

  const install = resolveAppInstall(target, input, platform, deviceName, sourceTrace)
  if (install) {
    app.install = install
  }

  return {
    platform,
    targetName: input.targetName,
    deviceName,
    device: {
      name: deviceName,
      platform,
      ...(asOptionalString(deviceProfile.model) ? { model: deviceProfile.model } : {}),
      ...(asOptionalString(deviceProfile.os) ? { os: deviceProfile.os } : {}),
      ...(asOptionalString(deviceProfile.id) ? { id: deviceProfile.id } : {}),
      ...(isRecord(deviceProfile.capabilities) ? { capabilities: deviceProfile.capabilities } : {}),
      ...(remote === undefined ? {} : { remote }),
    },
    app,
    appState,
    // A remote device's Appium is its remote, so no local one is named or managed.
    appium:
      remote === undefined
        ? { url: input.appiumUrl, managed: !input.appiumUrl }
        : { managed: false },
    sourceTrace,
  }
}
