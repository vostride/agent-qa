// Each ruling is checked against the artifact it describes; each scanner also runs on controls.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { AGENT_QA_TOOL_PROJECTIONS, DEGRADED_OUTPUT_CONTRACTS } from '@vostride/agent-qa-mcp'
import * as schema from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'

import { registryDeclarations } from './adapters.js'

const HERE = dirname(fileURLToPath(import.meta.url))
/** `conformance` → `__tests__` → `src` → `cli` → `packages` → the workspace root. */
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..', '..')

const SCOPE_SOURCE_PATH = join(REPO_ROOT, 'packages/schema/src/functions/function-scope.ts')

// ---- The scope union, retired ----

const DELETED_GROWTH_RULE_CLAUSES: readonly string[] = [
  'GROWTH RULE. A seventh member requires',
  'the census cell reds on an op whose `requiredScopes` names',
]

/** Just enough of a declaration to ask whether it carries a permission key. */
interface KeyBearing {
  readonly id: string
}

// Pure over declarations, so the control below can drive it with one that carries a requirement.
function permissionBearingFindings(declarations: readonly KeyBearing[]): readonly string[] {
  return declarations.flatMap((declaration) =>
    ['requiredScopes', 'requiresHumanOrigin']
      .filter((key) => Object.keys(declaration).includes(key))
      .map((key) => `${declaration.id} carries ${key}`))
}

function schemaSources(): readonly string[] {
  const texts: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name !== '__tests__') walk(path)
      } else if (entry.name.endsWith('.ts')) {
        texts.push(readFileSync(path, 'utf8'))
      }
    }
  }
  walk(join(REPO_ROOT, 'packages/schema/src'))
  return texts
}

// ================================================================================================

describe('the inherited adjudications, discharged at their artifacts', () => {
  describe('retired: the capability-scope union gates nothing', () => {
    it('exports the retired six-member scope union from no barrel', () => {
      expect(Object.keys(schema), 'the scope union is still exported').not.toContain('FunctionScopeSchema')
      expect(Object.keys(schema).filter((name) => /FunctionScope/.test(name))).toEqual([])
      // Non-vacuity: this is the real barrel.
      expect(Object.keys(schema)).toContain('FUNCTION_CALLER_ORIGINS')
    })

    it('keeps the union module deleted, and no schema source states the growth rule or declares the union', () => {
      expect(existsSync(SCOPE_SOURCE_PATH), 'function-scope.ts is still present').toBe(false)
      const sources = schemaSources()
      expect(sources.length, 'the schema source census read nothing').toBeGreaterThan(50)
      for (const clause of DELETED_GROWTH_RULE_CLAUSES) {
        expect(sources.filter((text) => text.includes(clause)), `the deleted growth rule is back: ${clause}`)
          .toEqual([])
      }
      expect(sources.filter((text) => text.includes('FunctionScopeSchema =')), 'the union is declared again')
        .toEqual([])
    })

    // RE-SPELLED from 'is a union every declared capability can be measured against'.
    it('is ranged by no declared capability: no declaration carries a scope or an origin requirement', () => {
      expect(registryDeclarations().length).toBeGreaterThan(0)
      expect(permissionBearingFindings(registryDeclarations())).toEqual([])
    })

    // RE-SPELLED from 'would name an op that minted a scope outside the union'.
    it('would name a declaration that carried a scope again', () => {
      const findings = permissionBearingFindings([
        { id: 'control.scope.probe', requiredScopes: ['read'] } as KeyBearing,
      ])
      expect(findings).toEqual(['control.scope.probe carries requiredScopes'])
    })
  })

  describe('the degraded output contracts', () => {
    it('declares exactly the entry that is still degraded', () => {
      expect(DEGRADED_OUTPUT_CONTRACTS.map((entry) => [entry.tool, entry.opId])).toEqual([
        ['agent_qa_start_run', 'runs.start'],
      ])
    })

    it('joins each degraded entry to a real projected tool and op, and asserts nothing more', () => {
      // Only the join: the projection suite owns whether a tool advertises an outputSchema.
      for (const entry of DEGRADED_OUTPUT_CONTRACTS) {
        const projection = AGENT_QA_TOOL_PROJECTIONS.find((candidate) => candidate.name === entry.tool)
        expect(projection, `${entry.tool} is degraded but no longer a projected tool`).toBeDefined()
        expect([...(projection?.ops ?? [])], `${entry.tool} no longer projects ${entry.opId}`)
          .toContain(entry.opId)
      }
    })
  })
})
