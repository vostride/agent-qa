import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import { refuseRetiredLocalBindings, yamlParseFailureMessage } from '@vostride/agent-qa-core'

const LocalAppBindingSchema = z.strictObject({
  path: z.string().optional(),
})

const LocalDeviceBindingsSchema = z.strictObject({
  devices: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
  apps: z.record(z.string(), LocalAppBindingSchema).optional(),
})

function normalizeLocalBindings(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw ?? {}

  const normalized = { ...(raw as Record<string, unknown>) }
  for (const key of ['devices', 'apps']) {
    if (normalized[key] === null) normalized[key] = {}
  }
  return normalized
}

export type LocalDeviceBindings = z.infer<typeof LocalDeviceBindingsSchema> & {
  filePath?: string
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
  let parsed: unknown
  try {
    parsed = parseYaml(content)
  } catch (err: unknown) {
    // Names where the YAML failed, never its content, so a local bindings file is not echoed.
    throw new Error(`${filePath}: ${yamlParseFailureMessage(err)}`)
  }
  refuseRetiredLocalBindings(parsed, filePath)
  const raw = normalizeLocalBindings(parsed)
  return { ...LocalDeviceBindingsSchema.parse(raw), filePath }
}
