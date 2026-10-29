import { readFile } from 'node:fs/promises'
import { parse as parseYaml } from 'yaml'
import { SuiteDefinitionSchema } from '../schema/suite-schema.js'
import { yamlParseFailureMessage } from '../validation/yaml-fault.js'
import type { SuiteDefinition } from '../suite/types.js'

export async function parseSuiteFile(filePath: string): Promise<SuiteDefinition> {
  const content = await readFile(filePath, 'utf-8')

  let raw: unknown
  try {
    raw = parseYaml(content)
  } catch (err) {
    // Still throws, with no `cause`: `util.inspect` would print the raw `YAMLParseError`.
    throw new Error(`${filePath}: ${yamlParseFailureMessage(err)}`)
  }

  return SuiteDefinitionSchema.parse(raw)
}
