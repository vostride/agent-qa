import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { mkdir, writeFile, readdir } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import {
  BaseObservationSchema,
  BaseObservationWriteSchema,
  SuiteObservationSchema,
  SuiteObservationWriteSchema,
} from './schema.js'
import type { BaseObservation, SuiteObservation } from './schema.js'
import type { ObservationFrontmatter, SuiteObservationFrontmatter } from './types.js'

const MEMORY_TIERS = ['products', 'suites', 'tests'] as const

function toObservationFrontmatter(
  data: BaseObservation | SuiteObservation,
): ObservationFrontmatter | SuiteObservationFrontmatter {
  const { content, ...frontmatter } = data
  return frontmatter
}

export async function ensureMemoryDirs(root: string): Promise<void> {
  await Promise.all(
    MEMORY_TIERS.map(tier => mkdir(join(root, tier), { recursive: true }))
  )
}

export async function writeObservation(
  root: string,
  tier: 'products' | 'suites' | 'tests',
  scope: string,
  data: BaseObservation | SuiteObservation,
): Promise<string> {
  const dir = join(root, tier, scope)
  const resolved = resolve(dir)
  const boundary = resolve(root)
  if (!resolved.startsWith(boundary + sep)) {
    throw new Error(`Scope "${scope}" escapes memory root`)
  }
  const schema = 'position' in data ? SuiteObservationWriteSchema : BaseObservationWriteSchema
  const validated = schema.parse(data)
  const frontmatter = toObservationFrontmatter(validated)
  await mkdir(dir, { recursive: true })
  const content = `---\n${stringifyYaml({ ...frontmatter }, { lineWidth: 0 })}---\n${validated.content}\n`
  const filePath = join(dir, `${data.id}.md`)
  await writeFile(filePath, content, 'utf-8')
  return filePath
}

export function parseObservation(
  content: string,
  filename: string,
): { data: BaseObservation | SuiteObservation | null; error: string | null } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) {
    return { data: null, error: 'No frontmatter delimiters found' }
  }

  let raw: unknown
  try {
    raw = parseYaml(match[1])
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    return { data: null, error: `YAML parse error: ${msg}` }
  }

  const documentBody = match[2].replace(/\r\n/g, '\n').replace(/\n$/, '')
  if (documentBody.trim().length === 0) {
    return { data: null, error: 'Observation markdown body is missing or blank' }
  }

  if (raw !== null && typeof raw === 'object' && 'content' in raw) {
    return { data: null, error: 'Observation content must live in the markdown body, not frontmatter' }
  }

  const expectedId = filename.replace(/\.md$/, '')
  if (raw !== null && typeof raw === 'object' && 'id' in raw && (raw as Record<string, unknown>).id !== expectedId) {
    return { data: null, error: `ID mismatch: file ${expectedId} vs frontmatter ${(raw as Record<string, unknown>).id}` }
  }

  const candidate = raw !== null && typeof raw === 'object'
    ? { ...(raw as Record<string, unknown>), content: documentBody }
    : raw

  const schema = raw !== null && typeof raw === 'object' && 'position' in raw
    ? SuiteObservationSchema
    : BaseObservationSchema

  const result = schema.safeParse(candidate)
  if (result.success) {
    return { data: result.data as BaseObservation | SuiteObservation, error: null }
  }
  return { data: null, error: result.error.message }
}

export async function listObservations(dir: string): Promise<string[]> {
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch (e: unknown) {
    if (e instanceof Error && 'code' in e && (e as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }
    throw e
  }
  return entries
    .filter(f => f.startsWith('obs_') && f.endsWith('.md'))
    .sort()
}
