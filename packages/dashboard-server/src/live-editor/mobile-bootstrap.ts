import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import {
  MobileSetupError,
  resolveMobileRunConfig,
} from '@vostride/agent-qa-core'
import type {
  MobilePlatform,
  PlatformConfig,
  ResolvedMobileRunConfig,
} from '@vostride/agent-qa-core'
import type { AppiumManager } from '../execution/appium-manager.js'
import type { ConfigManager } from '../config/index.js'

interface LocalMobileBindings {
  devices?: Record<string, Record<string, unknown>>
  providers?: Record<string, Record<string, unknown>>
  apps?: Record<string, { path?: string; browserstack?: string }>
  filePath?: string
}

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

async function loadLocalBindings(configPath: string): Promise<LocalMobileBindings | null> {
  const filePath = join(dirname(configPath), 'agent-qa.local.yaml')
  try {
    const content = await readFile(filePath, 'utf-8')
    const parsed = parseYaml(content) as LocalMobileBindings | null
    return parsed && typeof parsed === 'object'
      ? {
          devices: parsed.devices,
          providers: parsed.providers,
          apps: parsed.apps,
          filePath,
        }
      : { filePath }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
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

  const config = await input.configManager.read()
  let localBindings: LocalMobileBindings | null = null

  try {
    localBindings = await loadLocalBindings(input.configPath)
  } catch (err) {
    throw asMobileSetupError(err, 'device-resolution', 'Failed to read local device bindings', input)
  }

  const configuredAppState = (config.use as { mobile?: { appState?: 'preserve' | 'reset' } } | undefined)?.mobile?.appState

  let resolved: ResolvedMobileRunConfig
  try {
    resolved = resolveMobileRunConfig({
      config,
      targetName: input.targetName,
      platform: input.platform,
      useDeviceName: input.useDeviceName,
      appState: input.appState ?? configuredAppState,
      localBindings,
      configFilePath: input.configPath,
      localConfigFilePath: localBindings?.filePath,
    })
  } catch (err) {
    throw asMobileSetupError(err, 'device-resolution', 'Failed to resolve mobile live target', input)
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
      browserstackApp: resolved.app.install?.browserstack,
      appState: resolved.appState,
    },
  }
}
