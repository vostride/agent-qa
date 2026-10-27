import { z } from 'zod'

import type { PlatformBase } from './base'
import { platformBase } from './base'
import type { BrowserConfig } from './browser'
import { appStateSchema, browserConfigSchema } from './browser'
import type { DeviceConfig } from './device'
import { deviceConfigSchema } from './device'

export interface WebAuthStateConfig {
  name: string
  load?: boolean
  capture?: boolean
}

export interface WebPlatformConfig extends PlatformBase {
  platform: 'web'
  browser: BrowserConfig
  authState?: WebAuthStateConfig
}

export interface AndroidPlatformConfig extends PlatformBase {
  platform: 'android'
  device: DeviceConfig
  appPackage?: string
  appActivity?: string
  bundleId?: string
  appPath?: string
  appState?: 'preserve' | 'reset'
  appiumUrl?: string
  deepLinkAppId?: string
}

export interface IosPlatformConfig extends PlatformBase {
  platform: 'ios'
  device: DeviceConfig
  bundleId?: string
  appPath?: string
  appState?: 'preserve' | 'reset'
  appiumUrl?: string
  deepLinkAppId?: string
}

export type PlatformConfig = WebPlatformConfig | AndroidPlatformConfig | IosPlatformConfig

export const webAuthStateSchema = z.object({
  name: z.string(),
  load: z.boolean().optional(),
  capture: z.boolean().optional(),
}).strict()

const webArm = platformBase.extend({
  platform: z.literal('web'),
  browser: browserConfigSchema,
  authState: webAuthStateSchema.optional(),
}).strict()

const androidArm = platformBase.extend({
  platform: z.literal('android'),
  device: deviceConfigSchema,
  appPackage: z.string().optional(),
  appActivity: z.string().optional(),
  bundleId: z.string().optional(),
  appPath: z.string().optional(),
  appState: appStateSchema.optional(),
  appiumUrl: z.string().optional(),
  deepLinkAppId: z.string().optional(),
}).strict()

const iosArm = platformBase.extend({
  platform: z.literal('ios'),
  device: deviceConfigSchema,
  bundleId: z.string().optional(),
  appPath: z.string().optional(),
  appState: appStateSchema.optional(),
  appiumUrl: z.string().optional(),
  deepLinkAppId: z.string().optional(),
}).strict()

export const platformConfigSchema = z.discriminatedUnion('platform', [webArm, androidArm, iosArm])
