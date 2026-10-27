// RE-SPELLED 2026-10-01 (432-19, D-15). This file pinned the remedy memberships after the dashboard
// left them (Phase 430, D-06): each kind's exact surfaces (C430-REMEDY-MEMBERSHIPS-EXACT), the five
// doors (C430-REMEDY-SURFACES-EXACT) and an empty dashboard projection
// (C430-DASHBOARD-PROJECTION-EMPTY). The execution gate that minted remedies is deleted, and the
// vocabulary goes with it, so every one of those memberships is now empty for the strongest reason
// there is: no kind, no surface table and no projection exist. The .test-d.ts twin pins the same
// absence by type. The plain refusal that replaced every denial is C432-PLAIN-REFUSAL (the mark
// refusal key set in `__tests__/432-deleted-runtime-sets.test.ts`, the run denial at the CLI door).
//
// Imported through the package barrel, so a value that came back through any re-export reds.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import * as schema from '../../index'
import * as safety from '../index'

const RETIRED_REMEDY_VALUES = [
  'GATE_REMEDY_KINDS',
  'GATE_REMEDY_SURFACES',
  'GATE_REMEDY_SURFACES_BY_KIND',
  'remediesRenderableBy',
] as const

const SAFETY_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')

// 2026-10-02 (432-44): the 430 mutation legs R12 and R13 each returned one dashboard membership.
// Their current owners walk every production source of this package — the remedy module's old home
// first among them — for a declaration of that one kind, with any member list, the dashboard
// included. Each kind is assembled from halves, so this file is never its own hit.
const SCHEMA_SRC = new URL('../../', import.meta.url)
const REMEDY_HOME = 'safety/'
const ANSWER_CONFIRM_KIND = ['answer', 'confirm'].join('-')
const SESSION_PIN_FINAL_KIND = ['session', 'pin', 'final'].join('-')

function schemaProductionSources(): readonly string[] {
  const files: string[] = []
  const walk = (dir: string, relative: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '__tests__') continue
      if (entry.isDirectory()) walk(join(dir, entry.name), `${relative}${entry.name}/`)
      else if (/\.tsx?$/.test(entry.name) && !/\.test(-d)?\.tsx?$/.test(entry.name)) {
        files.push(`${relative}${entry.name}`)
      }
    }
  }
  walk(fileURLToPath(SCHEMA_SRC), '')
  return files.sort()
}

/** Every production line that spells the kind as a quoted literal, as `file:line: text`. */
function kindDeclarations(kind: string): string[] {
  const quoted = [`'${kind}'`, `"${kind}"`, `\`${kind}\``]
  return schemaProductionSources().flatMap((file) =>
    readFileSync(new URL(file, SCHEMA_SRC), 'utf8').split('\n').flatMap((text, index) =>
      quoted.some((literal) => text.includes(literal)) ? [`${file}:${index + 1}: ${text.trim()}`] : []))
}

describe('the remedy memberships, exact (430 D-06)', () => {
  it('C432-REMEDY-TYPES-ABSENT: no remedy kind, surface table or projection is exported from either barrel', () => {
    for (const name of RETIRED_REMEDY_VALUES) {
      expect(Object.keys(schema), `root: ${name}`).not.toContain(name)
      expect(Object.keys(safety), `safety: ${name}`).not.toContain(name)
    }
    // Non-vacuity: these are the real barrels.
    expect(typeof schema.scrubDisclosureFragment).toBe('function')
    expect(typeof safety.scrubDisclosureFragment).toBe('function')
  })

  it('the remedy module and the policy-result DTO are deleted', () => {
    expect(existsSync(join(SAFETY_DIR, 'remedies.ts'))).toBe(false)
  })

  it('C432-REMEDY-TYPES-ABSENT: no denial DTO on any door carries a remedy list', () => {
    // The chat clause denial is gone, and the ask result carries no denials.
    expect(Object.keys(schema)).not.toContain('ClauseDenialSchema')
    expect(Object.keys(schema.AgentAskResultSchema.shape)).not.toContain('denials')
  })

  // 430 R12 (was C430-REMEDY-MEMBERSHIPS-EXACT / C430-DASHBOARD-PROJECTION-EMPTY for this kind).
  it('C432-430-R12-ANSWER-CONFIRM-ABSENT: no schema source declares the confirm-answering remedy, so no door, the dashboard included, is its member', () => {
    const sources = schemaProductionSources()
    // Non-vacuity: the walk read real sources, the remedy module's old home among them.
    expect(sources.filter((file) => file.startsWith(REMEDY_HOME)).length).toBeGreaterThan(0)
    expect(sources).toContain(`${REMEDY_HOME}action-descriptor.ts`)
    const hits = kindDeclarations(ANSWER_CONFIRM_KIND)
    expect(hits, `the confirm-answering remedy returned:\n${hits.join('\n')}`).toEqual([])
  })

  // 430 R13 (was C430-REMEDY-MEMBERSHIPS-EXACT / C430-DASHBOARD-PROJECTION-EMPTY for this kind).
  it('C432-430-R13-SESSION-PIN-ABSENT: no schema source declares the session-pin finality remedy, so no door, the dashboard included, is its member', () => {
    const sources = schemaProductionSources()
    expect(sources.filter((file) => file.startsWith(REMEDY_HOME)).length).toBeGreaterThan(0)
    expect(sources).toContain(`${REMEDY_HOME}action-descriptor.ts`)
    const hits = kindDeclarations(SESSION_PIN_FINAL_KIND)
    expect(hits, `the session-pin finality remedy returned:\n${hits.join('\n')}`).toEqual([])
  })
})
