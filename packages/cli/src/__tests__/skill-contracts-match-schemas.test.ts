// The shipped contracts file is the config, test, suite, hook and remote entry schemas.

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
  RemoteEntrySchema,
  SuiteDefinitionSchema,
  SuiteTestEntrySchema,
  TestDefinitionSchema,
} from '@vostride/agent-qa-core'
import {
  CONFIG_SCHEMA_LEAVES,
  connectionSecretNames,
  REMOTE_PROTOCOLS,
  type RemoteEntryLike,
} from '@vostride/agent-qa-schema'
import { parse } from 'yaml'

const AGENT_QA_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const CONTRACTS_REFERENCE = path.join('agent-qa-authoring', 'references', 'agent-qa-contracts.json')
const CONTRACTS_COPIES = [
  path.join(AGENT_QA_ROOT, 'skills', CONTRACTS_REFERENCE),
  path.join(AGENT_QA_ROOT, 'packages', 'cli', 'skills', CONTRACTS_REFERENCE),
]
const SKILL_COPIES = CONTRACTS_COPIES.map((copy) =>
  path.join(path.dirname(path.dirname(copy)), 'SKILL.md'),
)
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
  remotes?: KeyLists & {
    path?: string
    keys?: Record<string, string>
    protocols?: string[]
    pick?: { key?: string }
  }
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

  it('remotes in both copies lists the remote entry keys in schema order, what each is for, the protocols and the pick key', () => {
    const entry = splitOf(RemoteEntrySchema)
    for (const copy of CONTRACTS_COPIES) {
      const { remotes } = readContracts(copy)
      const at = relativeCopy(copy)
      expect(remotes?.path, at).toBe('registry.remotes')
      const remoteLeaves = CONFIG_SCHEMA_LEAVES.filter((leaf) =>
        leaf.startsWith('registry.remotes[].'),
      )
      expect(remoteLeaves.length, at).toBeGreaterThan(0)
      expectKeyList(`${at} remotes.requiredKeys`, remotes?.requiredKeys, entry.required)
      expectKeyList(`${at} remotes.optionalKeys`, remotes?.optionalKeys, entry.optional)
      const purposes = remotes?.keys ?? {}
      expectKeyList(`${at} remotes.keys`, Object.keys(purposes), keysOf(RemoteEntrySchema))
      for (const [key, purpose] of Object.entries(purposes)) {
        expect(purpose.trim(), `${at} remotes.keys.${key}`).not.toBe('')
      }
      expect(remotes?.protocols, at).toEqual([...REMOTE_PROTOCOLS])
      expect(CONFIG_SCHEMA_LEAVES, at).toContain(remotes?.pick?.key)
    }
  })

  it("the authoring skill's remote example passes the strict parse in both copies", () => {
    const workspace = {
      testMatch: ['tests/**/*.yaml'],
      suiteMatch: ['suites/**/*.suite.yaml'],
      hooksFile: 'hooks.yaml',
      envFile: '.env',
      secretsFile: '.env.secrets.local',
    }
    for (const copy of SKILL_COPIES) {
      const body = readFileSync(copy, 'utf8')
      const at = relativeCopy(copy)
      const section = body.indexOf('\n## Remote browsers\n')
      expect(section, `${at} has no Remote browsers section`).toBeGreaterThan(-1)
      const example = /```yaml\n([\s\S]*?)```/.exec(body.slice(section))?.[1]
      expect(example, `${at} Remote browsers has no yaml example`).toBeDefined()
      const config: Record<string, unknown> = {
        workspace,
        ...(parse(example ?? '') as Record<string, unknown>),
      }
      const result = AgentQaConfigSchema.safeParse(config)
      const messages = result.success ? [] : result.error.issues.map((issue) => issue.message)
      expect(messages, at).toEqual([])
      const remotes = (config.registry as { remotes: RemoteEntryLike[] }).remotes
      expect(connectionSecretNames(remotes).length, at).toBeGreaterThan(0)
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
