// The inherited adjudications, made checkable (Phase 397 plan 05 — D-16 / D-17 / D-20).
//
// WHY THIS FILE EXISTS. Earlier phases wrote promissory notes against 397: a reservation in
// `function-scope.ts` saying this phase would extend the scope union, and two `adjudication: '397'`
// entries in `mapping.ts`'s degraded-output list. The deletion inventory's pending rows were ruled
// too; that inventory is retired.
// D-20 pays them AT the artifact that carries the promise, dated and in place, rather than in a
// central adjudication document — so the artifacts answer and the phase SUMMARY only narrates.
//
// A RULING WRITTEN IN PROSE IS A RULING THAT CAN GO STALE SILENTLY, and this phase's whole thesis
// is that a claim nothing checks is not a claim. So each ruling above is joined here to the thing it
// describes: the scope union's LENGTH and MEMBERS beside its closure note, and the degraded entries
// beside their dated comments. Re-opening the union un-dated or deleting a disposition comment is a
// named RED in this file rather than a diff nobody reads.
//
// EVERY REGISTER HERE SELF-CHECKS IN BOTH DIRECTIONS. The lesson this project keeps re-learning is
// that a register asserting completeness over an artifact it silently failed to parse reports a
// clean bill of health for an empty set. So the unknown-scope census and the degraded-comment
// scanner are each a PURE function over text or data, driven both against the real artifact and
// against synthetic controls — one well-formed (must produce no finding) and one deliberately
// broken (must produce exactly one, naming the offender). The controls are spelled
// `..._397_05` so 397-09's mutation script can tell an intentional fixture from a planted one.
//
// WHAT THIS FILE DELIBERATELY DOES NOT ASSERT. The degraded contracts' ABSENCE of an advertised
// `outputSchema` is owned by `packages/mcp`'s own projection suite, which probes the conversion in
// both directions at server build (RESEARCH Pitfall 9). Re-pinning it here would be the
// redundant-mechanism trap: two registers over one universe, free to diverge. This file asserts the
// JOIN — that each entry names a real projected tool and op — and nothing more.

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

// ---- D-16: the scope union — RETIRED by 432-20 (D-12) ------------------------------------------

/**
 * The dated retirement note's anchor, and the two strings of the deleted growth rule.
 *
 * Until 432-20 this block pinned the union CLOSED at six members, its growth rule, and a census
 * ranging every declaration's scopes against it. D-12 deletes the scope union's purpose, its growth
 * rule and the census rows that range it; what this block pins now is that retirement.
 */
// 2026-10-02 (432-39): the retirement anchor's module is deleted; nothing reads it now.
const DELETED_GROWTH_RULE_CLAUSES: readonly string[] = [
  'GROWTH RULE. A seventh member requires',
  'the census cell reds on an op whose `requiredScopes` names',
]

/** Just enough of a declaration to ask whether it carries a permission key. */
interface KeyBearing {
  readonly id: string
}

/**
 * Declarations that still carry a scope or origin requirement — empty since 432-20.
 *
 * A PURE FUNCTION over declarations so the control below can drive it with one that does.
 */
function permissionBearingFindings(declarations: readonly KeyBearing[]): readonly string[] {
  return declarations.flatMap((declaration) =>
    ['requiredScopes', 'requiresHumanOrigin']
      .filter((key) => Object.keys(declaration).includes(key))
      .map((key) => `${declaration.id} carries ${key}`))
}

/** Every non-test schema source, read once (432-39: the scope module is deleted). */
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
  // RE-SPELLED 2026-10-01 (432-20, D-12) from 'D-16: the capability-scope union closes at six,
  // dated'. The union no longer gates anything; its growth rule and census are deleted.
  describe('retired: the capability-scope union gates nothing', () => {
    // RE-SPELLED 2026-10-02 (432-39, D-10/D-12): the union is DELETED, so the six members it held
    // until now are held nowhere. Title kept; the claim it guarded — a retired vocabulary cannot
    // quietly grow a member nothing reads — now holds because there is no vocabulary to grow.
    // RE-TITLED 2026-10-02 (432-42, 432-39 #5) from 'holds exactly the six members the closure note ratifies': the body asserts the absence, so the title does.
    it('exports the retired six-member scope union from no barrel', () => {
      expect(Object.keys(schema), 'the scope union is still exported').not.toContain('FunctionScopeSchema')
      expect(Object.keys(schema).filter((name) => /FunctionScope/.test(name))).toEqual([])
      // Non-vacuity: this is the real barrel.
      expect(Object.keys(schema)).toContain('FUNCTION_CALLER_ORIGINS')
    })

    // RE-SPELLED from 'carries the dated closure note, and no longer carries the reservation it
    // replaced' and 'states the growth rule and carries its three lineage dates'. RE-SPELLED again
    // 2026-10-02 (432-39, D-10/D-12): the module that carried the retirement note is deleted with
    // the union, and no schema source states the growth rule or declares the union again. The
    // lineage notes live in the repository history with the file.
    // RE-TITLED 2026-10-02 (432-42, 432-39 #5) from 'carries the dated retirement note, and no longer states the growth rule': the body asserts the absence, so the title does.
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
    // 2026-09-28 (431-03, D-03/D-07): 397 adjudicated two entries. `agent_qa_list_runs` left the
    // list when `runs.list` declared its canonical output contract, which converts in output mode;
    // `packages/mcp`'s probe would now refuse that row as stale. The start acknowledgement stays.
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
      // The JOIN only. Whether the tool advertises an outputSchema is probed at server build and
      // owned by the projection suite (Pitfall 9); a second pin here could disagree with it.
      for (const entry of DEGRADED_OUTPUT_CONTRACTS) {
        const projection = AGENT_QA_TOOL_PROJECTIONS.find((candidate) => candidate.name === entry.tool)
        expect(projection, `${entry.tool} is degraded but no longer a projected tool`).toBeDefined()
        expect([...(projection?.ops ?? [])], `${entry.tool} no longer projects ${entry.opId}`)
          .toContain(entry.opId)
      }
    })
  })
})
