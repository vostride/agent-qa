// 2026-09-26, 429-03 D-06: the published config schema's leaves, walked structurally and pinned
// against the schema's leaf list, so a new schema leaf reds here until it is listed. 2026-10-15
// (441-40, D-29): the list no longer carries masking classes.
import { CONFIG_SCHEMA_LEAVES } from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'

import { AgentQaConfigSchema } from '../schema/config-schema.js'

interface NodeDef {
  type: string
  innerType?: unknown
  getter?: () => unknown
  out?: unknown
  shape?: Record<string, unknown>
  valueType?: unknown
  element?: unknown
  options?: readonly unknown[]
  left?: unknown
  right?: unknown
}

const WRAPPERS = new Set([
  'optional',
  'nullable',
  'nonoptional',
  'default',
  'prefault',
  'catch',
  'readonly',
])

function defOf(node: unknown): NodeDef {
  return (node as { def: NodeDef }).def
}

function unwrap(node: unknown): unknown {
  let current = node
  for (;;) {
    const def = defOf(current)
    if (WRAPPERS.has(def.type)) current = def.innerType
    else if (def.type === 'lazy') current = def.getter!()
    else if (def.type === 'pipe') current = def.out
    else return current
  }
}

function walk(node: unknown, keys: readonly string[], leaves: Set<string>): void {
  const def = defOf(unwrap(node))
  switch (def.type) {
    case 'object':
      for (const [key, child] of Object.entries(def.shape!)) walk(child, [...keys, key], leaves)
      return
    case 'record':
      walk(def.valueType, [...keys, '*'], leaves)
      return
    case 'array':
      walk(def.element, [...keys.slice(0, -1), `${keys.at(-1)}[]`], leaves)
      return
    case 'union':
      for (const option of def.options!) walk(option, keys, leaves)
      return
    case 'intersection':
      walk(def.left, keys, leaves)
      walk(def.right, keys, leaves)
      return
    default:
      leaves.add(keys.join('.'))
  }
}

function schemaLeaves(): string[] {
  const leaves = new Set<string>()
  walk(AgentQaConfigSchema, [], leaves)
  return [...leaves].sort()
}

describe('config schema leaves', () => {
  it('CONFIG-SCHEMA-LEAVES-PINNED', () => {
    const walked = schemaLeaves()
    expect(walked).toEqual([...CONFIG_SCHEMA_LEAVES])
    for (const witness of [
      'use.timeout.step',
      'registry.llms[].name',
      'workspace.secretsFile',
      'plugins.auth[].package',
    ]) {
      expect(walked).toContain(witness)
    }
  })

  // The removed set is spelled by hand; the list/schema equality above is what makes an unlisted
  // leaf red here.
  it('C432-CONFIG-LEAVES: exactly the strict leaves, each classified, none of them retired', () => {
    const walked = schemaLeaves()
    expect(walked.filter((leaf) => leaf.startsWith('use.planner.max'))).toEqual(
      expect.arrayContaining(['use.planner.maxActions', 'use.planner.maxPlanningTurns']),
    )
    expect(CONFIG_SCHEMA_LEAVES).toEqual(
      expect.arrayContaining(['use.planner.maxActions', 'use.planner.maxPlanningTurns']),
    )
    expect([...CONFIG_SCHEMA_LEAVES].sort()).toEqual(walked)
    for (const leaf of walked) {
      expect((CONFIG_SCHEMA_LEAVES as readonly string[]).includes(leaf), leaf).toBe(true)
    }
    const retired = [
      'safety.trustMode',
      'services.dashboard.runServiceTokens[].name',
      'services.dashboard.runServiceTokens[].tokenEnvVar',
      'services.dashboard.runServiceTokens[].trustScope.org',
      'services.dashboard.runServiceTokens[].trustScope.project',
      'services.mcp.stdio.grantConfigWrite',
      'services.mcp.tokens[].name',
      'services.mcp.tokens[].scopes[]',
      'services.mcp.tokens[].tokenEnvVar',
      'use.planner.maxSubActions',
    ]
    expect(retired.filter(leaf => walked.includes(leaf))).toEqual([])
    expect(retired.filter(leaf => (CONFIG_SCHEMA_LEAVES as readonly string[]).includes(leaf))).toEqual([])
    expect(walked.filter(leaf => leaf.split('.')[0] === 'safety')).toEqual([])
    expect(walked.filter(leaf => /^services\.(mcp|dashboard)\./.test(leaf)).sort()).toEqual([
      'services.dashboard.artifactsDir',
      'services.dashboard.baseUrl',
      'services.dashboard.dbPath',
      'services.dashboard.host',
      'services.dashboard.port',
      'services.dashboard.workspace',
      'services.mcp.enabled',
      'services.mcp.port',
    ])
    expect(walked.filter(leaf => leaf.split('.')[0] === 'plugins')).toEqual([
      'plugins.auth[].package',
      'plugins.auth[].path',
      'plugins.providers[].package',
      'plugins.providers[].path',
    ])
  })
})
