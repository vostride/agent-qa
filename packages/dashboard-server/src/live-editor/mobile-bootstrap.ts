import { MobileSetupError, resolveMobileRunConfig } from '@vostride/agent-qa-core'
import type { MobilePlatform, ResolvedMobileRunConfig } from '@vostride/agent-qa-core'
import type { PlatformConfig } from '@vostride/agent-qa-runner'
import type { AppiumManager } from '../execution/appium-manager.js'
import { readConfigValues, type ConfigManager } from '../config/index.js'

export interface MobileLiveAppiumLease {
  runId: string
  url: string
  release: (reason?: string) => boolean
}

export interface PreparedMobileLiveSession {
  platformConfig: PlatformConfig
  appiumLease: MobileLiveAppiumLease
  resolved: ResolvedMobileRunConfig
}

export interface PrepareMobileLiveSessionInput {
  sessionId: string
  platform: MobilePlatform
  targetName?: string
  useDeviceName?: string
  appState?: 'preserve' | 'reset'
  configManager: ConfigManager
  configPath: string
  appiumManager: AppiumManager
}

function asMobileSetupError(
  err: unknown,
  category: MobileSetupError['category'],
  message: string,
  input: Pick<PrepareMobileLiveSessionInput, 'platform' | 'targetName'>,
): MobileSetupError {
  if (err instanceof MobileSetupError) return err
  return new MobileSetupError({
    category,
    message: `${message}: ${err instanceof Error ? err.message : String(err)}`,
    platform: input.platform,
    targetName: input.targetName,
    cause: err,
  })
}

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

  const config = await readConfigValues(input.configManager)
  const configuredAppState = (
    config.use as { mobile?: { appState?: 'preserve' | 'reset' } } | undefined
  )?.mobile?.appState

  let resolved: ResolvedMobileRunConfig
  try {
    resolved = resolveMobileRunConfig({
      config,
      targetName: input.targetName,
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

  try {
    await input.appiumManager.acquireLease({ runId: input.sessionId, platform: input.platform })
  } catch (err) {
    throw new MobileSetupError({
      category: 'appium-startup',
      message: `Failed to acquire Appium for ${input.platform} live session: ${err instanceof Error ? err.message : String(err)}`,
      platform: input.platform,
      targetName: input.targetName,
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
    resolved: {
      ...resolved,
      appium: {
        url: appiumUrl,
        managed: true,
      },
    },
    appiumLease,
    platformConfig: {
      platform: input.platform,
      device: resolved.device,
      appiumUrl,
      bundleId: resolved.app.bundleId,
      appPackage: resolved.app.appPackage,
      appActivity: resolved.app.appActivity,
      deepLinkAppId: resolved.app.deepLinkAppId,
      appPath: resolved.app.install?.path,
      appState: resolved.appState,
    },
  }
}
