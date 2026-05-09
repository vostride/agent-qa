import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import type { AgentQaConfig } from '@vostride/agent-qa-core'

const LocalAppBindingSchema = z.object({
  path: z.string().optional(),
  browserstack: z.string().optional(),
}).strict()

const LocalDeviceBindingsSchema = z.object({
  devices: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
  providers: z.record(z.string(), z.object({
    username: z.string(),
    accessKey: z.string(),
  }).strict()).optional(),
  apps: z.record(z.string(), LocalAppBindingSchema).optional(),
}).strict()

function normalizeLocalBindings(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw ?? {}

  const normalized = { ...(raw as Record<string, unknown>) }
  for (const key of ['devices', 'providers', 'apps']) {
    if (normalized[key] === null) normalized[key] = {}
  }
  return normalized
}

export type LocalDeviceBindings = z.infer<typeof LocalDeviceBindingsSchema> & {
  filePath?: string
}

export interface ResolvedDevice {
  name: string
  platform: 'android' | 'ios'
  transport: 'local' | 'browserstack'
  match: Record<string, unknown>
}

const ENV_MAP: Record<string, { username: string; accessKey: string }> = {
  browserstack: {
    username: 'BROWSERSTACK_USERNAME',
    accessKey: 'BROWSERSTACK_ACCESS_KEY',
  },
}

const DISPLAY_NAMES: Record<string, string> = {
  browserstack: 'BrowserStack',
}

export function formatTransportProvider(transport?: string | null): string {
  if (!transport || transport === 'local') return 'Local'
  return DISPLAY_NAMES[transport] ?? 'Local'
}

export function loadLocalBindings(dir?: string): LocalDeviceBindings | null {
  const filePath = join(dir ?? process.cwd(), 'agent-qa.local.yaml')
  let content: string
  try {
    content = readFileSync(filePath, 'utf-8')
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
  const raw = normalizeLocalBindings(parseYaml(content))
  return { ...LocalDeviceBindingsSchema.parse(raw), filePath }
}

export function resolveDevice(
  config: AgentQaConfig,
  deviceName: string,
  localBindings?: LocalDeviceBindings | null,
): ResolvedDevice {
  const devices = (config as any).registry?.devices
  if (!devices || !(deviceName in devices)) {
    const available = devices ? Object.keys(devices).join(', ') : 'none'
    throw new Error(
      `Device "${deviceName}" not found in registry.devices. Available devices: ${available}`,
    )
  }

  const profile = devices[deviceName] as {
    platform: 'android' | 'ios'
    transport: 'local' | 'browserstack'
    match: Record<string, unknown>
  }

  const localMatch = localBindings?.devices?.[deviceName] ?? null

  if (profile.transport === 'local' && !localMatch) {
    throw new Error(
      `Device '${deviceName}' has transport: local but no binding found in agent-qa.local.yaml. Run \`agent-qa devices init\` to generate local bindings.`,
    )
  }

  const mergedMatch = { ...profile.match, ...(localMatch ?? {}) }

  return {
    name: deviceName,
    platform: profile.platform,
    transport: profile.transport,
    match: mergedMatch,
  }
}

export function resolveProviderCredentials(
  transport: string,
  localBindings?: LocalDeviceBindings | null,
): { username: string; accessKey: string } {
  const envKeys = ENV_MAP[transport]
  if (!envKeys) {
    throw new Error(`Unknown provider: "${transport}"`)
  }

  const localCreds = localBindings?.providers?.[transport]
  if (localCreds?.username && localCreds?.accessKey) {
    return { username: localCreds.username, accessKey: localCreds.accessKey }
  }

  const envUsername = process.env[envKeys.username]
  const envAccessKey = process.env[envKeys.accessKey]
  if (envUsername && envAccessKey) {
    return { username: envUsername, accessKey: envAccessKey }
  }

  const displayName = DISPLAY_NAMES[transport] ?? transport
  throw new Error(
    `${displayName} credentials not found. Set ${envKeys.username} and ${envKeys.accessKey} env vars, or add provider credentials to agent-qa.local.yaml.`,
  )
}
