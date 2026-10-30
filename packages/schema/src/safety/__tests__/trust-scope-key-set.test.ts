// Every leg is imported relatively from source, so no case passes or fails on a stale dist.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import * as root from '../../index'
import * as safety from '../index'

const SAFETY_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(SAFETY_DIR, '..')

describe('the ONE scope key set', () => {
  it('CONTROL: the key set\'s module is deleted and no schema source declares the key set again', () => {
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
