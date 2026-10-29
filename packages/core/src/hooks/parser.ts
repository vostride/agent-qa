import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { HooksFileSchema } from './schema.js'
import { yamlParseFailureMessage } from '../validation/yaml-fault.js'
import type { HookDefinition } from '@vostride/agent-qa-runner'

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
    // The message says where the parse failed, never the excerpt, which can carry a credential.
    return { hooks: [], errors: [`${filePath}: ${yamlParseFailureMessage(err)}`] }
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
