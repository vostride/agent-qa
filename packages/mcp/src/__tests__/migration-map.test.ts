// The migration map's shape checks (Phase 398 plan 02, D-13 · XPLN-03).
//
// The deletion inventory this map was once censused against is retired. The exact set of v1 names,
// with the arm each one was ruled onto, is pinned in `mapping-bump-guard.test.ts`; what stays here
// is what that pin cannot see.
//
// THE JOIN IS PRODUCED, NOT LITERAL. Every `renamed-to` target is checked against the live tool
// names enumerated from `AGENT_QA_TOOL_PROJECTIONS`, so a v2 tool renamed in `mapping.ts` reds here
// rather than leaving the map pointing at a name no listing will ever carry.

import { describe, expect, it } from 'vitest'

import { AGENT_QA_TOOL_PROJECTIONS } from '../mapping.js'
import { V1_TOOL_MIGRATION_MAP } from '../migration-map.js'

/** The live v2 tool names, enumerated from the declared projections. Never typed out here. */
function liveToolNames(): ReadonlySet<string> {
  return new Set(AGENT_QA_TOOL_PROJECTIONS.map((projection) => projection.name))
}

/** A date in the one spelling this repository writes them in. */
const ISO_DATE = /\b\d{4}-\d{2}-\d{2}\b/u

/**
 * The five `n/a -> projected by 396` inventory rows whose target ops ended up UNPROJECTED after
 * 396 plan 04's fold decisions (RESEARCH assumption A4). They are named here because the
 * adjudication that they are `retired` rather than `renamed-to` is a DECISION this plan made, and a
 * decision nobody pinned is a decision the next executor gets to make differently.
 */
const A4_ADJUDICATED_ROWS: readonly string[] = [
  'agent_qa_get_config',
  'agent_qa_get_run',
  'agent_qa_get_run_steps',
  'agent_qa_get_run_logs',
  'agent_qa_get_run_execution_logs',
]

describe('the v1 names (D-13)', () => {
  it('declares no duplicate v1 name', () => {
    const names = V1_TOOL_MIGRATION_MAP.map((entry) => entry.v1Name)
    expect(new Set(names).size).toBe(names.length)
  })
})

describe('the renamed-to join resolves against the live catalogue (D-13)', () => {
  it('names only tools mapping.ts actually declares', () => {
    const live = liveToolNames()
    // Integrity: the enumeration found something, so the loop below is a refusal rather than an
    // empty channel that would pass over an emptied projection table.
    expect(live.size).toBeGreaterThan(0)
    for (const entry of V1_TOOL_MIGRATION_MAP) {
      if (entry.arm !== 'renamed-to') continue
      expect(live.has(entry.v2Tool!), `${entry.v1Name} -> ${entry.v2Tool} is not a live tool`)
        .toBe(true)
    }
  })

  it('matches nothing for a near-miss target name', () => {
    const live = liveToolNames()
    expect(live.has('agent_qa_get_entity')).toBe(true)
    expect(live.has('agent_qa_get_entities')).toBe(false)
    expect(live.has('agent_qa_get')).toBe(false)
  })

  it('has renamed-to entries at all', () => {
    // Every cell in this block is a for-loop over a filtered set, and a filter that selects nothing
    // makes all of them pass. This is that block's denominator.
    const renamed = V1_TOOL_MIGRATION_MAP.filter((entry) => entry.arm === 'renamed-to')
    expect(renamed.length).toBeGreaterThan(0)
  })
})

describe('the arm shapes are closed (D-13)', () => {
  it('carries a v2Tool if and only if the arm is renamed-to', () => {
    for (const entry of V1_TOOL_MIGRATION_MAP) {
      expect(entry.v2Tool !== undefined, `${entry.v1Name}: v2Tool vs arm ${entry.arm}`)
        .toBe(entry.arm === 'renamed-to')
    }
  })

  it('carries an owner if and only if the arm is pending', () => {
    for (const entry of V1_TOOL_MIGRATION_MAP) {
      expect(entry.owner !== undefined, `${entry.v1Name}: owner vs arm ${entry.arm}`)
        .toBe(entry.arm === 'pending')
    }
  })

  it('gives every retired and pending entry the v2 route that answers the need', () => {
    for (const entry of V1_TOOL_MIGRATION_MAP) {
      if (entry.arm === 'renamed-to') continue
      expect(entry.route ?? '', `${entry.v1Name} has no route`).not.toBe('')
      expect((entry.route ?? '').length, entry.v1Name).toBeGreaterThan(20)
    }
  })

  it('gives every entry a dated, non-empty note', () => {
    for (const entry of V1_TOOL_MIGRATION_MAP) {
      expect(entry.note.length, entry.v1Name).toBeGreaterThan(20)
      expect(ISO_DATE.test(entry.note), `${entry.v1Name}: note carries no date`).toBe(true)
    }
  })

  it('declares exactly the three arm kinds and no fourth', () => {
    const arms = new Set(V1_TOOL_MIGRATION_MAP.map((entry) => entry.arm))
    expect([...arms].sort()).toEqual(['pending', 'renamed-to', 'retired'])
  })

  it('freezes every entry and the array', () => {
    expect(Object.isFrozen(V1_TOOL_MIGRATION_MAP)).toBe(true)
    for (const entry of V1_TOOL_MIGRATION_MAP) {
      expect(Object.isFrozen(entry), entry.v1Name).toBe(true)
    }
  })
})

describe('the A4 adjudication was made, not improvised', () => {
  it('rules each UNPROJECTED-target row retired, with a route and a dated A4 note', () => {
    const byName = new Map(V1_TOOL_MIGRATION_MAP.map((entry) => [entry.v1Name, entry]))
    for (const name of A4_ADJUDICATED_ROWS) {
      const entry = byName.get(name)
      expect(entry, `${name} is not in the map at all`).toBeDefined()
      expect(entry!.arm, name).toBe('retired')
      expect(entry!.v2Tool, name).toBeUndefined()
      expect(entry!.note, name).toContain('A4')
      expect(ISO_DATE.test(entry!.note), `${name}: A4 note carries no date`).toBe(true)
      expect((entry!.route ?? '').length, `${name} has no v2 route`).toBeGreaterThan(20)
    }
  })
})
