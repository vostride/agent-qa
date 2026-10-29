// The shipped contracts file is the config, test, suite and hook schemas.

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import {
  AgentQaConfigSchema,
  HookDefinitionSchema,
  HooksFileSchema,
  McpConfigSchema,
  SuiteDefinitionSchema,
  SuiteTestEntrySchema,
  TestDefinitionSchema,
} from '@vostride/agent-qa-core'

const AGENT_QA_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const CONTRACTS_REFERENCE = path.join('agent-qa-authoring', 'references', 'agent-qa-contracts.json')
const CONTRACTS_COPIES = [
  path.join(AGENT_QA_ROOT, 'skills', CONTRACTS_REFERENCE),
  path.join(AGENT_QA_ROOT, 'packages', 'cli', 'skills', CONTRACTS_REFERENCE),
]
const UNSHIPPED_COPY = path.join(
  AGENT_QA_ROOT,
  'packages',
  'mcp',
  'references',
  'agent-qa-contracts.json',
)

type Shape = Record<string, { isOptional(): boolean }>
type KeyLists = Record<string, string[] | undefined>
type Contracts = {
  source?: unknown
  config?: KeyLists
  test?: KeyLists
  suite?: KeyLists
  hooks?: KeyLists
  secrets?: { source?: unknown }
}

function keysOf(schema: { shape: Shape }): string[] {
  return Object.keys(schema.shape)
}

function splitOf(schema: { shape: Shape }): { required: string[]; optional: string[] } {
  const keys = keysOf(schema)
  return {
    required: keys.filter((key) => !schema.shape[key]!.isOptional()),
    optional: keys.filter((key) => schema.shape[key]!.isOptional()),
  }
}

function keyListFindings(
  label: string,
  listed: readonly string[] | undefined,
  declared: readonly string[],
): string[] {
  const list = listed ?? []
  const findings = [
    ...declared
      .filter((key) => !list.includes(key))
      .map((key) => `${label} is missing ${key}, which the schema declares`),
    ...list
      .filter((key) => !declared.includes(key))
      .map((key) => `${label} lists ${key}, which the schema does not declare`),
  ]
  if (findings.length === 0 && list.join('\n') !== declared.join('\n')) {
    findings.push(
      `${label} is out of schema order: [${list.join(', ')}], schema order [${declared.join(', ')}]`,
    )
  }
  return findings
}

function expectKeyList(
  label: string,
  listed: readonly string[] | undefined,
  declared: readonly string[],
): void {
  expect(declared.length, `${label}: the schema declares no keys`).toBeGreaterThan(0)
  expect(listed, keyListFindings(label, listed, declared).join('; ')).toEqual(declared)
}

function readContracts(copy: string): Contracts {
  return JSON.parse(readFileSync(copy, 'utf8')) as Contracts
}

function relativeCopy(copy: string): string {
  return path.relative(AGENT_QA_ROOT, copy).split(path.sep).join('/')
}

describe('the contracts reference matches the schemas', () => {
  it('config.rootKeys in both copies are the config schema root keys in schema order', () => {
    expect(
      CONTRACTS_COPIES.every((copy) => existsSync(copy)),
      'a shipped contracts copy is missing',
    ).toBe(true)
    for (const copy of CONTRACTS_COPIES) {
      expectKeyList(
        `${relativeCopy(copy)} config.rootKeys`,
        readContracts(copy).config?.rootKeys,
        keysOf(AgentQaConfigSchema.out),
      )
    }
  })

  it('every other key list in both copies equals the schema it describes', () => {
    const test = splitOf(TestDefinitionSchema)
    const suite = splitOf(SuiteDefinitionSchema)
    for (const copy of CONTRACTS_COPIES) {
      const { config, test: testLists, suite: suiteLists, hooks } = readContracts(copy)
      const at = relativeCopy(copy)
      expectKeyList(`${at} config.mcpFields`, config?.mcpFields, keysOf(McpConfigSchema))
      expectKeyList(`${at} test.requiredKeys`, testLists?.requiredKeys, test.required)
      expectKeyList(`${at} test.optionalKeys`, testLists?.optionalKeys, test.optional)
      expectKeyList(`${at} suite.requiredKeys`, suiteLists?.requiredKeys, suite.required)
      expectKeyList(`${at} suite.optionalKeys`, suiteLists?.optionalKeys, suite.optional)
      expectKeyList(
        `${at} suite.testEntryKeys`,
        suiteLists?.testEntryKeys,
        keysOf(SuiteTestEntrySchema),
      )
      expectKeyList(`${at} hooks.rootKeys`, hooks?.rootKeys, keysOf(HooksFileSchema))
      expectKeyList(`${at} hooks.hookKeys`, hooks?.hookKeys, keysOf(HookDefinitionSchema))
    }
  })

  it('one contracts file ships and it names no source path', () => {
    expect(existsSync(UNSHIPPED_COPY), `${relativeCopy(UNSHIPPED_COPY)} still exists`).toBe(false)
    for (const copy of CONTRACTS_COPIES) {
      const contracts = readContracts(copy)
      const sourceLabel = `${relativeCopy(copy)} has a top-level source key`
      expect(Object.keys(contracts), sourceLabel).not.toContain('source')
      expect(contracts.secrets?.source, relativeCopy(copy)).toBe('workspace.secretsFile')
    }
  })

  it('a key added to or removed from a schema is named by the comparison', () => {
    const shape = AgentQaConfigSchema.out.shape
    const listed = keysOf(AgentQaConfigSchema.out)
    const removed = listed[listed.length - 1]!
    const added = z.object({ ...shape, plantedRootKey: z.string().optional() })
    const reduced = z.object(
      Object.fromEntries(Object.entries(shape).filter(([key]) => key !== removed)),
    )
    const reversed = [...listed].reverse()

    expect(listed.length).toBeGreaterThan(1)
    expect(keyListFindings('config.rootKeys', listed, keysOf(AgentQaConfigSchema.out))).toEqual([])
    expect(keyListFindings('config.rootKeys', listed, keysOf(added))).toEqual([
      'config.rootKeys is missing plantedRootKey, which the schema declares',
    ])
    expect(keyListFindings('config.rootKeys', listed, keysOf(reduced))).toEqual([
      `config.rootKeys lists ${removed}, which the schema does not declare`,
    ])
    expect(keyListFindings('config.rootKeys', reversed, listed)).toEqual([
      `config.rootKeys is out of schema order: [${reversed.join(', ')}], schema order [${listed.join(', ')}]`,
    ])
  })
})
