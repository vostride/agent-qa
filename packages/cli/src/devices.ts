import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import { yamlParseFailureMessage } from '@vostride/agent-qa-core'

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
  match: Record<string, unknown>
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
    // WHERE, NEVER WHAT — `agent-qa.local.yaml` (395-18, found by Task 2's enumeration).
    // This call was unguarded, so a duplicate key in the person's own local bindings left the
    // process through Node's default uncaught printer: the library's excerpt, the caret, the stack
    // and the `linePos` object. Measured on the shipped `agent-qa devices list`. The file is
    // machine-local and typically holds device credentials, which makes it the WORST member of the
    // class to have left unguarded, not the most obscure one.
    //
    // The READ above keeps its own arm: an ENOENT answers `null` and any other filesystem fault is
    // rethrown untouched, because neither is a fact about what the file contains (395-14 · E1b).
    throw new Error(`${filePath}: ${yamlParseFailureMessage(err)}`)
  }
  const raw = normalizeLocalBindings(parsed)
  return { ...LocalDeviceBindingsSchema.parse(raw), filePath }
}
