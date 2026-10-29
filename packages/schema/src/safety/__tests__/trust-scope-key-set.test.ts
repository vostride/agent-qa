// What this file measures (Phase 391 plan 11, closing G-391-1; re-spelled by 432-18, 432-22 and
// 432-42).
//
// It was a two-leg differential between the scope key set `TRUST_SCOPE_KEYS` and the strict wire
// projection `TrustScopeSchema`. 432-18 deleted the ledger guard leg. 2026-10-01 (432-22, D-03/D-12):
// the run-service token DTO, the projection's last consumer, is deleted with
// `services.dashboard.runServiceTokens`, so the wire leg and its module (`grant-ops.ts`) are deleted
// too and their absence is pinned below.
//
// 2026-10-02 (432-42, D-12): the key set is deleted with `trust-credential.ts`, its last module.
// The caller types it ranged left in 432-39 and nothing in production read it. The two cells that
// pinned it published are re-spelled under their titles to pin its absence.
//
// Every leg is imported RELATIVELY from source, so no case can pass or fail on a stale built dist.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import * as root from '../../index'
import * as safety from '../index'

const SAFETY_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(SAFETY_DIR, '..')

describe('the ONE scope key set', () => {
  // RE-SPELLED 2026-10-02 (432-42, D-12): the key set's module is deleted and no source declares the
  // hand-spelled pair as a published constant again. RE-TITLED 2026-10-03 (quick-261003-tsr, IN-22):
  // was 'CONTROL B (fixed, fixture validity): the key set is exactly the hand-spelled {project, org}'.
  it('CONTROL B: the key set\'s module is deleted and no schema source declares the key set again', () => {
    expect(existsSync(join(SAFETY_DIR, 'trust-credential.ts')), 'trust-credential.ts is back').toBe(false)
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) {
          if (entry.name !== '__tests__') walk(path)
        } else if (entry.name.endsWith('.ts') && readFileSync(path, 'utf8').includes('TRUST_SCOPE_' + 'KEYS =')) {
          offenders.push(path)
        }
      }
    }
    walk(SRC)
    expect(offenders, 'a schema source declares the scope key set again').toEqual([])
  })

  // RE-SPELLED 2026-10-02 (432-42, D-12): neither barrel publishes the key set. RE-TITLED 2026-10-03
  // (quick-261003-tsr, IN-22): was 'the safety barrel publishes the key set and nothing that parses a
  // scope'.
  it('neither barrel publishes the key set, and the safety barrel exports nothing that parses a scope', () => {
    expect(Object.keys(safety)).not.toContain('TRUST_SCOPE_KEYS')
    expect(Object.keys(root)).not.toContain('TRUST_SCOPE_KEYS')
    expect(Object.keys(safety).filter((name) => /scope/iu.test(name))).toEqual([])
    // Non-vacuity: these are the real barrels.
    expect(Object.keys(safety)).toContain('scrubDisclosureFragment')
    expect(Object.keys(root)).toContain('FUNCTION_CALLER_ORIGINS')
  })
})

describe('the wire leg is gone', () => {
  it('no grant-ledger guard and no projection module is left to range the key set', () => {
    expect(existsSync(join(SAFETY_DIR, 'grant-ledger.ts')), 'safety/grant-ledger.ts is still present').toBe(false)
    expect(existsSync(join(SAFETY_DIR, 'grant-ops.ts')), 'safety/grant-ops.ts is still present').toBe(false)
  })

  it('the safety barrel exports no trust-scope schema', () => {
    expect(Object.keys(safety).filter(name => /TrustScope/.test(name))).toEqual([])
  })

  it('no schema source spells the projection any more', () => {
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) {
          if (entry.name !== '__tests__') walk(path)
        } else if (entry.name.endsWith('.ts') && readFileSync(path, 'utf8').includes('TrustScope' + 'Schema =')) {
          offenders.push(path)
        }
      }
    }
    walk(SRC)
    expect(offenders).toEqual([])
  })
})
