import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { AGENT_QA_CORE_HOST_BASELINE } from '../../core-host-baseline.js'
import { AGENT_QA_CORE_SCOPED_HOST_BASELINE } from '../../core-host-scoped-baseline.js'
import { AGENT_QA_CORE_MIGRATION_LEDGER } from '../../../../core/src/ownership-contract.js'
import { applyLedger, transitionalLeaks } from '../apply-ledger.js'
import { configFilesFor, extractSpecifiers, sourceFilesFor } from '../extract-specifiers.js'
import type { LedgerEntry } from '../../contract-types.js'
import type { SpecifierHit } from '../extract-specifiers.js'

const testDir = dirname(fileURLToPath(import.meta.url))
const packagesRoot = join(testDir, '..', '..', '..', '..')
const repoRoot = join(packagesRoot, '..')

function hit(specifier: string, line = 1): SpecifierHit {
  return { specifier, file: 'packages/core/src/fixture.ts', line }
}

function ledger(targets: readonly string[]): LedgerEntry[] {
  return targets.map(target => ({
    rule: target.startsWith('@ai-sdk/') ? 'modelOwner' : 'storageImplementation',
    target,
    clearedBy: 'test',
    reason: 'fixture',
  }))
}

describe('transitionalLeaks', () => {
  it('keeps provider SDK, native-store, host external, and node hits', () => {
    expect(
      transitionalLeaks([
        hit('@ai-sdk/openai'),
        hit('better-sqlite3', 2),
        hit('sharp', 3),
        hit('node:fs', 4),
        hit('fs', 5),
        hit('zod', 6),
        hit('@vostride/agent-qa-schema', 7),
        hit('./local.js', 8),
        hit('glob', 9),
        hit('posthog-node', 10),
        hit('playwright-core', 11),
      ]).map(leak => leak.specifier),
    ).toEqual([
      '@ai-sdk/openai',
      'better-sqlite3',
      'sharp',
      'node:fs',
      'fs',
      'glob',
      'posthog-node',
      'playwright-core',
    ])
  })
})

describe('applyLedger', () => {
  it('waives core source leaks covered by the two-row migration ledger plus host baseline', () => {
    const coreHits = [
      ...sourceFilesFor('packages/core', repoRoot),
      ...configFilesFor('packages/core', repoRoot),
    ].flatMap(extractSpecifiers)

    expect(
      applyLedger(
        transitionalLeaks(coreHits),
        AGENT_QA_CORE_MIGRATION_LEDGER,
        new Set(AGENT_QA_CORE_HOST_BASELINE),
        AGENT_QA_CORE_SCOPED_HOST_BASELINE,
      ),
    ).toEqual([])
  })

  it('waives a scoped host module only in the file it is scoped to', () => {
    const scoped = [{ target: 'node:child_process', file: 'packages/core/src/a/b.ts', reason: 'x' }]
    const at = (file: string): SpecifierHit => ({ specifier: 'node:child_process', file, line: 1 })
    expect(
      applyLedger(
        [at('packages/core/src/a/b.ts'), at('/abs/agent-qa/packages/core/src/a/b.ts')],
        [],
        new Set(),
        scoped,
      ),
    ).toEqual([])
    expect(applyLedger([at('packages/core/src/a/c.ts')], [], new Set(), scoped)).toEqual([
      'packages/core | packages/core/src/a/c.ts:1 | node:child_process | unwaived transitional leak',
    ])
    const fs = { ...at('packages/core/src/a/b.ts'), specifier: 'node:fs' }
    expect(applyLedger([fs], [], new Set(), scoped)).toEqual([
      'packages/core | packages/core/src/a/b.ts:1 | node:fs | unwaived transitional leak',
    ])
  })

  it('flags an uncovered transitional leak', () => {
    expect(
      applyLedger([hit('@ai-sdk/mistral')], ledger(['@ai-sdk/openai']), new Set()),
    ).toEqual([
      'packages/core | packages/core/src/fixture.ts:1 | @ai-sdk/mistral | unwaived transitional leak',
      'packages/core | ledger | @ai-sdk/openai | stale ledger entry',
    ])
  })

  it('waives baseline-covered transitional leaks without adding ledger hits', () => {
    expect(
      applyLedger([hit('node:fs')], ledger(['sharp']), new Set(['node:fs'])),
    ).toEqual(['packages/core | ledger | sharp | stale ledger entry'])
  })

  it('flags stale ledger rows that do not match current leaks', () => {
    expect(
      applyLedger([hit('@ai-sdk/openai')], ledger(['@ai-sdk/openai', 'sharp']), new Set()),
    ).toEqual(['packages/core | ledger | sharp | stale ledger entry'])
  })

  it('matches scoped provider targets and exact native-store targets', () => {
    expect(
      applyLedger(
        [
          hit('@ai-sdk/openai/provider'),
          hit('better-sqlite3'),
          hit('sharp'),
        ],
        ledger(['@ai-sdk/openai', 'better-sqlite3', 'sharp']),
        new Set(),
      ),
    ).toEqual([])
  })
})
