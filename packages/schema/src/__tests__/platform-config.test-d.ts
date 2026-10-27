import { expectTypeOf } from 'vitest'
import type { z } from 'zod'
import type { PlatformBase } from '../config/base'
import type {
  AndroidPlatformConfig,
  IosPlatformConfig,
  PlatformConfig,
  WebPlatformConfig,
} from '../config/platform-config'
import { platformConfigSchema } from '../config/platform-config'

type LegOwnKeys<L> = Exclude<keyof L, keyof PlatformBase>

expectTypeOf<LegOwnKeys<WebPlatformConfig>>().toEqualTypeOf<'platform' | 'browser' | 'authState'>()
expectTypeOf<LegOwnKeys<AndroidPlatformConfig>>().toEqualTypeOf<
  | 'platform'
  | 'device'
  | 'appPackage'
  | 'appActivity'
  | 'bundleId'
  | 'appPath'
  | 'appState'
  | 'appiumUrl'
  | 'deepLinkAppId'
>()
expectTypeOf<LegOwnKeys<IosPlatformConfig>>().toEqualTypeOf<
  | 'platform'
  | 'device'
  | 'bundleId'
  | 'appPath'
  | 'appState'
  | 'appiumUrl'
  | 'deepLinkAppId'
>()

expectTypeOf<z.infer<typeof platformConfigSchema>>().toEqualTypeOf<PlatformConfig>()

const webBase: PlatformBase = {} as WebPlatformConfig
const androidBase: PlatformBase = {} as AndroidPlatformConfig
const iosBase: PlatformBase = {} as IosPlatformConfig

const web: PlatformConfig = {
  platform: 'web',
  browser: { name: 'chromium' },
}

const invalidWeb: PlatformConfig = {
  platform: 'web',
  browser: { name: 'chromium' },
  // @ts-expect-error web configs have no `bundleId` field.
  bundleId: 'com.x',
}

const invalidAndroid: PlatformConfig = {
  platform: 'android',
  device: { name: 'pixel', platform: 'android', match: {} },
  // @ts-expect-error android configs have no `browser` field.
  browser: { name: 'chromium' },
}

void webBase
void androidBase
void iosBase
void web
void invalidWeb
void invalidAndroid
