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
    // WHERE, NEVER WHAT — the SIBLING MEMBER of the set the config arm was hardened on
    // `hooks.yaml` is a member of the same file set `enumerateConfigFileSet`
    // pins, and this line used to interpolate the caught error's own text: `yaml` pretty-prints a
    // parse error with a verbatim excerpt of the source around the point it gave up, measured
    // carrying a planted credential out of `agent-qa validate`'s rendered output. One member
    // hardened while its sibling leaks is this codebase's recurring failure mode, so this arm
    // composes through the SAME core primitive the config arm uses — two spellings of one sentence
    // are two things that can drift apart. The path prefix is deliberate: these strings travel to
    // consumers that do not separately name the file — `validateHooksFile` (which builds a
    // diagnostic whose `file` field is the hooks path but whose rendered message stands alone) and
    // `run.ts`'s hooks load.
    //
    // THE DASHBOARD REGISTRY ROAD IS NOT ONE OF THEM, and the earlier revision of this comment said
    // it was (395-18, correcting the D-395-14-C doc-truth class). Measured, not inferred:
    // `hook-registry-manager.ts:307` returns on `registry.errors` — the registry's OWN parse copy at
    // `:753` — above the `parseHooksFile` call at `:315`, so on a malformed `hooks.yaml` the
    // dashboard road never reaches this arm at all. Those copies are a separate channel on a
    // separate surface and carry their own disposition. A comment that names a
    // consumer the code cannot reach is a claim a later round will act on.
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
