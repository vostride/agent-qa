import {
  MobileSetupError,
  chooseAppiumEndpoint,
  findDeviceHere,
  resolveMobileRunConfig,
} from '@vostride/agent-qa-core'
import type {
  AndroidHere,
  IOSHere,
  MobilePlatform,
  ResolvedMobileRunConfig,
} from '@vostride/agent-qa-core'
import type { PlatformConfig } from '@vostride/agent-qa-runner'
import type { AppiumManager } from '../execution/appium-manager.js'
import { readConfigValues, type ConfigManager } from '../config/index.js'

export interface MobileLiveAppiumLease {
  runId: string
  url: string
  release: (reason?: string) => boolean
}

export type LiveDevicesHereLister = (platform: MobilePlatform) => Promise<AndroidHere | IOSHere>

export const listLiveDevicesHereByDefault: LiveDevicesHereLister = async (platform) => {
  if (platform === 'android') {
    const { listAndroidDevicesHere } = await import('@vostride/agent-qa-android')
    return listAndroidDevicesHere()
  }
  const { listIOSSimulatorsHere } = await import('@vostride/agent-qa-ios')
  return listIOSSimulatorsHere()
}

export interface PreparedMobileLiveSession {
  platformConfig: PlatformConfig
  // Absent when nothing was leased: a remote device, or a device here on AGENT_QA_APPIUM_URL.
  appiumLease?: MobileLiveAppiumLease
  resolved: ResolvedMobileRunConfig
}

export interface PrepareMobileLiveSessionInput {
  sessionId: string
  platform: MobilePlatform
  targetName?: string
  // The edited draft's use.device; the target's device when unset.
  useDeviceName?: string
  appState?: 'preserve' | 'reset'
  configManager: ConfigManager
  configPath: string
  appiumManager: AppiumManager
  listDevicesHere?: LiveDevicesHereLister
  // The value of AGENT_QA_APPIUM_URL; the process environment when unset.
  envUrl?: string
}

function asMobileSetupError(
  err: unknown,
  category: MobileSetupError['category'],
  message: string,
  input: Pick<PrepareMobileLiveSessionInput, 'platform' | 'targetName'>,
): MobileSetupError {
  if (err instanceof MobileSetupError) return err
  const reason = err instanceof Error ? err.message : String(err)
  // A refusal is already the one line a person acts on.
  const refusal = err instanceof Error && err.name === 'RemoteRefusalError'
  return new MobileSetupError({
    category,
    message: refusal ? reason : `${message}: ${reason}`,
    platform: input.platform,
    targetName: input.targetName,
    cause: err,
  })
}

// A remote device asks for no listing and no Appium. A device here is found first; its Appium is
// AGENT_QA_APPIUM_URL, else a lease on the dashboard's own.
export async function prepareMobileLiveSession(
  input: PrepareMobileLiveSessionInput,
): Promise<PreparedMobileLiveSession> {
  if (!input.targetName) {
    throw new MobileSetupError({
      category: 'device-resolution',
      message: `No targetName provided for ${input.platform} live session`,
      platform: input.platform,
    })
  }
  const targetName = input.targetName

  const config = await readConfigValues(input.configManager)
  const configuredAppState = (
    config.use as { mobile?: { appState?: 'preserve' | 'reset' } } | undefined
  )?.mobile?.appState

  let resolved: ResolvedMobileRunConfig
  try {
    resolved = resolveMobileRunConfig({
      config,
      targetName,
      platform: input.platform,
      useDeviceName: input.useDeviceName,
      appState: input.appState ?? configuredAppState,
      configFilePath: input.configPath,
    })
  } catch (err) {
    throw asMobileSetupError(
      err,
      'device-resolution',
      'Failed to resolve mobile live target',
      input,
    )
  }

  const platformConfig: PlatformConfig = {
    platform: input.platform,
    targetName: resolved.targetName,
    ...(resolved.app.ref === undefined ? {} : { appRef: resolved.app.ref }),
    device: resolved.device,
    bundleId: resolved.app.bundleId,
    appPackage: resolved.app.appPackage,
    appActivity: resolved.app.appActivity,
    deepLinkAppId: resolved.app.deepLinkAppId,
    appPath: resolved.app.install?.path,
    appState: resolved.appState,
  }
  if (resolved.plan.kind === 'remote') return { resolved, platformConfig }

  const refused = (message: string): MobileSetupError =>
    new MobileSetupError({
      category: 'device-resolution',
      message,
      platform: input.platform,
      targetName,
      deviceName: resolved.deviceName,
    })

  const listing = await (input.listDevicesHere ?? listLiveDevicesHereByDefault)(resolved.platform)
  const finder = findDeviceHere({
    device: resolved.deviceName,
    platform: resolved.platform,
    ...resolved.plan.search,
    ...(resolved.platform === 'ios'
      ? { ios: listing as IOSHere }
      : { android: listing as AndroidHere }),
  })
  if ('refusal' in finder) throw refused(finder.refusal)
  const { udid, avd, name, os } = finder.found
  const device = {
    ...resolved.device,
    here: {
      ...(udid === undefined ? {} : { udid }),
      ...(avd === undefined ? {} : { avd }),
      ...(name === undefined ? {} : { name }),
      ...(os === undefined ? {} : { os }),
    },
  }

  const choice = chooseAppiumEndpoint({
    device: resolved.device,
    envUrl: input.envUrl ?? process.env.AGENT_QA_APPIUM_URL,
  })
  if ('refusal' in choice) throw refused(choice.refusal)
  if (choice.kind === 'given') {
    return { resolved, platformConfig: { ...platformConfig, device, appiumUrl: choice.url } }
  }

  try {
    await input.appiumManager.acquireLease({ runId: input.sessionId, platform: input.platform })
  } catch (err) {
    throw new MobileSetupError({
      category: 'appium-startup',
      message: `Failed to acquire Appium for ${input.platform} live session: ${err instanceof Error ? err.message : String(err)}`,
      platform: input.platform,
      targetName,
      deviceName: resolved.deviceName,
      appId: resolved.app.deepLinkAppId,
      sourceTrace: resolved.sourceTrace,
      cause: err,
    })
  }

  const appiumUrl = input.appiumManager.getUrl()
  let released = false
  const appiumLease: MobileLiveAppiumLease = {
    runId: input.sessionId,
    url: appiumUrl,
    release: (reason = 'completed') => {
      if (released) return false
      released = true
      return input.appiumManager.releaseLease(input.sessionId, reason)
    },
  }

  return {
    resolved,
    appiumLease,
    platformConfig: { ...platformConfig, device, appiumUrl },
  }
}
