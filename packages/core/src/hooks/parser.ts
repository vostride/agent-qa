import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { HooksFileSchema } from './schema.js'
import type { HookDefinition } from './types.js'

export async function parseHooksFile(filePath: string): Promise<{ hooks: HookDefinition[]; errors: string[] }> {
  let raw: string
  try {
    raw = await readFile(filePath, 'utf-8')
  } catch (err) {
    return { hooks: [], errors: [`Failed to read hooks file: ${(err as Error).message}`] }
  }

  let parsed: unknown
  try {
    parsed = parseYaml(raw)
  } catch (err) {
    return { hooks: [], errors: [`Invalid YAML in hooks file: ${(err as Error).message}`] }
  }

  const result = HooksFileSchema.safeParse(parsed)
  if (!result.success) {
    const errors = result.error.issues.map((issue) =>
      `${issue.path.join('.')}: ${issue.message}`
    )
    return { hooks: [], errors }
  }

  const dir = dirname(filePath)
  const hooks: HookDefinition[] = result.data.hooks.map((h) => ({
    ...h,
    file: resolve(dir, h.file),
    deps: h.deps.map((d) => resolve(dir, d)),
    packageFile: h.packageFile ? resolve(dir, h.packageFile) : undefined,
  }))

  return { hooks, errors: [] }
}
