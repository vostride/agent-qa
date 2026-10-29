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
const MAPPING_SOURCE_PATH = join(REPO_ROOT, 'packages/mcp/src/mapping.ts')

const readSource = (path: string): string => readFileSync(path, 'utf8')

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

// ---- The fourth adjudication: the degraded output contracts --------------------------------------

const DEGRADED_ANCHOR = '397 DISPOSITION (2026-08-16 · D-20): keep-degraded'

/**
 * The literal source of the degraded list, so a comment can be asserted about.
 *
 * Read off DISK rather than off the built package, deliberately: comments do not survive the build,
 * and the ruling IS a comment. A cell asking `dist` about it would be asking the one artifact that
 * cannot answer.
 */
function degradedListBlock(source: string): string {
  const start = source.indexOf('export const DEGRADED_OUTPUT_CONTRACTS')
  if (start < 0) return ''
  const end = source.indexOf('] as const satisfies readonly OutputSchemaDegradation[])', start)
  return end < 0 ? '' : source.slice(start, end)
}

/**
 * What each entry's own comment window is missing.
 *
 * The window is the text between the previous entry's `tool:` line and this one's, which is exactly
 * where its comment lives. Walking forward with a cursor rather than searching the whole block
 * matters: a single anchor at the top of the list would otherwise satisfy both entries, and "one
 * entry was ruled and the other rode along" is the failure this scan exists to name.
 */
function degradedDispositionFindings(
  block: string,
  tools: readonly string[],
): readonly string[] {
  if (block === '') return ['mapping.ts no longer carries a readable DEGRADED_OUTPUT_CONTRACTS list']
  const findings: string[] = []
  let cursor = 0
  for (const tool of tools) {
    const at = block.indexOf(`tool: '${tool}'`, cursor)
    if (at < 0) {
      findings.push(`${tool}: no entry in the declared list`)
      continue
    }
    const window = block.slice(cursor, at)
    cursor = at
    if (!window.includes(DEGRADED_ANCHOR)) {
      findings.push(`${tool}: no dated 397 keep-degraded disposition above its entry`)
      continue
    }
    if (window.replace(/\s+/g, ' ').length < 300) {
      findings.push(`${tool}: carries the anchor with no reason under it`)
    }
  }
  return findings
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
        { id: 'control.scope.432.20', requiredScopes: ['read'] } as KeyBearing,
      ])
      expect(findings).toEqual(['control.scope.432.20 carries requiredScopes'])
    })
  })

  describe('the degraded output contracts adjudication', () => {
    it('declares exactly the adjudicated entry that is still degraded', () => {
      expect(DEGRADED_OUTPUT_CONTRACTS.map((entry) => [entry.tool, entry.opId])).toEqual([
        ['agent_qa_start_run', 'runs.start'],
      ])
      for (const entry of DEGRADED_OUTPUT_CONTRACTS) {
        expect(entry.adjudication, entry.tool).toBe('397')
      }
    })

    it('carries a dated keep-degraded disposition above each entry', () => {
      const block = degradedListBlock(readSource(MAPPING_SOURCE_PATH))
      expect(block, 'the degraded list read back empty').toContain('agent_qa_start_run')
      expect(degradedDispositionFindings(
        block,
        DEGRADED_OUTPUT_CONTRACTS.map((entry) => entry.tool),
      )).toEqual([])
    })

    it('names the entry whose disposition is missing, and does not let a sibling cover for it', () => {
      // The control: one anchor, two entries. A scan that searched the whole block would call this
      // ruled — which is precisely how a second degradation could land under a comment written
      // about the first.
      const control = [
        'export const DEGRADED_OUTPUT_CONTRACTS = Object.freeze([',
        `  // ${DEGRADED_ANCHOR}. ${'A reason long enough to be a reason rather than a stamp. '.repeat(5)}`,
        '  Object.freeze({',
        '    tool: \'control_degraded_397_05_a\',',
        '  }),',
        '  Object.freeze({',
        '    tool: \'control_degraded_397_05_b\',',
        '  }),',
      ].join('\n')
      const findings = degradedDispositionFindings(
        control,
        ['control_degraded_397_05_a', 'control_degraded_397_05_b'],
      )
      expect(findings.length).toBe(1)
      expect(findings[0]).toContain('control_degraded_397_05_b')
      expect(findings[0]).toContain('no dated 397 keep-degraded disposition')
    })

    it('names an entry whose disposition is an anchor with nothing under it', () => {
      const control = [
        'export const DEGRADED_OUTPUT_CONTRACTS = Object.freeze([',
        `  // ${DEGRADED_ANCHOR}.`,
        '  Object.freeze({',
        '    tool: \'control_degraded_397_05_c\',',
        '  }),',
      ].join('\n')
      const findings = degradedDispositionFindings(control, ['control_degraded_397_05_c'])
      expect(findings.length).toBe(1)
      expect(findings[0]).toContain('carries the anchor with no reason under it')
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
