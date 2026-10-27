import { z } from 'zod'

export interface DeviceConfig {
  name: string
  platform: 'android' | 'ios'
  /**
   * Permissive Appium capability and selector bag.
   * Common keys include deviceName, osVersion, and platformVersion.
   */
  match: Record<string, unknown>
}

export const deviceConfigSchema = z.object({
  name: z.string(),
  platform: z.enum(['android', 'ios']),
  match: z.record(z.string(), z.unknown()),
}).strict()
