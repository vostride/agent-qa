import { readFile } from 'node:fs/promises'
import { parse as parseYaml } from 'yaml'
import { SuiteDefinitionSchema } from '../schema/suite-schema.js'
import type { SuiteDefinition } from '../suite/types.js'

export async function parseSuiteFile(filePath: string): Promise<SuiteDefinition> {
  const content = await readFile(filePath, 'utf-8')
  const raw = parseYaml(content)
  return SuiteDefinitionSchema.parse(raw)
}
