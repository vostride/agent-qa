import { z } from 'zod'

export interface DeviceConfig {
  name: string
  platform: 'android' | 'ios'
  model?: string
  os?: string
  id?: string
  capabilities?: Record<string, unknown>
  remote?: string
}

export const deviceConfigSchema = z.strictObject({
  name: z.string(),
  platform: z.enum(['android', 'ios']),
  model: z.string().optional(),
  os: z.string().optional(),
  id: z.string().optional(),
  capabilities: z.record(z.string(), z.unknown()).optional(),
  remote: z.string().optional(),
})
