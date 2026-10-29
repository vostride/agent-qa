import { existsSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  COMPOSITION_CARVEOUT_PACKAGE_DIR,
  COMPOSITION_ONLY_PACKAGES,
  COMPOSITION_SUBTREE,
  findCompositionCarveoutOffenders,
  findCompositionCarveoutUnusedAllowances,
  isCompositionFile,
} from '../composition-carveout.js'
import { extractSpecifiers, sourceFilesFor } from '../extract-specifiers.js'
import type { SpecifierHit } from '../extract-specifiers.js'
import type { OwnershipContract } from '../../contract-types.js'

const testDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(testDir, '..', '..', '..', '..', '..')

const STORE_FILE = 'packages/agent-local/src/store/sqlite-job-store.ts'
const COMPOSITION_FILE = 'packages/agent-local/src/composition/run-composition.ts'
const A_SCOPED_PACKAGE = '@vostride/agent-qa-runner-local'

function guardedContract(overrides: Partial<OwnershipContract> = {}): OwnershipContract {
  return {
    packageName: '@vostride/agent-qa-agent-local',
    packageDir: COMPOSITION_CARVEOUT_PACKAGE_DIR,
    packageClasses: ['storageImplementation'],
    allowedResponsibilities: [],
    forbiddenResponsibilities: [],
    externalDependencies: [],
    internalDependencies: [],
    ...overrides,
  }
}

function hit(specifier: string, file: string, line = 1): SpecifierHit {
  return { specifier, file, line }
}

/** Every scoped package named once from a file the subtree prefix matches. */
function fullyUsedHits(): SpecifierHit[] {
  return Object.keys(COMPOSITION_ONLY_PACKAGES).map((pkgName, index) =>
    hit(pkgName, COMPOSITION_FILE, index + 1),
  )
}

function realAgentLocalHits(): SpecifierHit[] {
  return sourceFilesFor(COMPOSITION_CARVEOUT_PACKAGE_DIR, repoRoot)
    .flatMap(extractSpecifiers)
    .map(entry => ({ ...entry, file: relative(repoRoot, entry.file) }))
}

describe('composition-carveout scope', () => {
  // The rule is only worth anything if BOTH of the paths it distinguishes are real. A prefix that
  // matches nothing scopes nothing and passes forever; asserting against paths that do not exist
  // would be the same defect one level up, in the test.
  it('both control paths exist on disk, and the prefix separates them', () => {
    expect(existsSync(join(repoRoot, STORE_FILE))).toBe(true)
    expect(existsSync(join(repoRoot, COMPOSITION_FILE))).toBe(true)

    expect(isCompositionFile(COMPOSITION_FILE)).toBe(true)
    expect(isCompositionFile(STORE_FILE)).toBe(false)
    // A sibling directory whose name merely starts the same way is outside, not inside.
    expect(isCompositionFile('packages/agent-local/src/composition-notes.ts')).toBe(false)
    expect(isCompositionFile(COMPOSITION_FILE.replaceAll('/', '\\'))).toBe(true)
  })

  it('carries a non-empty rationale for every scoped package', () => {
    const entries = Object.entries(COMPOSITION_ONLY_PACKAGES)
    expect(entries.length).toBeGreaterThan(0)
    for (const [pkgName, rationale] of entries) {
      expect(pkgName.startsWith('@vostride/agent-qa-')).toBe(true)
      expect(rationale.trim()).not.toEqual('')
    }
  })
})

describe('composition-carveout direction 1 — a scoped package outside the subtree', () => {
  // The POSITIVE control: the rule must be able to fail. A store file reaching for the local run
  // adapters is exactly the accretion the carve-out exists to stop.
  it('rejects a store-file import of a scoped package, naming file, line and rationale', () => {
    expect(
      findCompositionCarveoutOffenders(guardedContract(), [
        ...fullyUsedHits(),
        hit(A_SCOPED_PACKAGE, STORE_FILE, 42),
      ]),
    ).toEqual([
      `composition-carveout: ${STORE_FILE}:42 ⇏ ${A_SCOPED_PACKAGE}`
      + ` (${COMPOSITION_ONLY_PACKAGES[A_SCOPED_PACKAGE]}; allowed only under ${COMPOSITION_SUBTREE}`
      + ' so the job store proper stays lean)',
    ])
  })

  // The NEGATIVE control: the rule must accept the thing it exists to permit, or the dissection
  // could not have landed at all.
  it('accepts the same import from inside the subtree', () => {
    expect(
      findCompositionCarveoutOffenders(guardedContract(), [
        ...fullyUsedHits(),
        hit(A_SCOPED_PACKAGE, COMPOSITION_FILE, 42),
      ]),
    ).toEqual([])
  })

  it('leaves the lean set and node builtins alone anywhere in the package', () => {
    expect(
      findCompositionCarveoutOffenders(guardedContract(), [
        ...fullyUsedHits(),
        hit('@vostride/agent-qa-agent', STORE_FILE, 3),
        hit('@vostride/agent-qa-schema', STORE_FILE, 4),
        hit('node:sqlite', STORE_FILE, 5),
        hit('./store-errors.js', STORE_FILE, 6),
      ]),
    ).toEqual([])
  })

  it('matches whole packages, never substrings, in both directions of the pair', () => {
    // safety-local is scoped and so is safety; neither is allowed to answer for the other, and a
    // prefix test would report the shorter name as covered the moment the longer one appeared.
    expect(
      findCompositionCarveoutOffenders(guardedContract(), [
        ...fullyUsedHits(),
        hit('@vostride/agent-qa-safety-local', COMPOSITION_FILE, 7),
        hit('@vostride/agent-qa-safety', STORE_FILE, 8),
      ]),
    ).toEqual([
      `composition-carveout: ${STORE_FILE}:8 ⇏ @vostride/agent-qa-safety`
      + ` (${COMPOSITION_ONLY_PACKAGES['@vostride/agent-qa-safety']}; allowed only under ${COMPOSITION_SUBTREE}`
      + ' so the job store proper stays lean)',
    ])
  })

  it('scopes a subpath entry to its own package', () => {
    expect(
      findCompositionCarveoutOffenders(guardedContract(), [
        ...fullyUsedHits(),
        hit('@vostride/agent-qa-knowledge-local/reader', STORE_FILE, 9),
      ]),
    ).toHaveLength(1)
  })

  it('guards only the package it names — another package with the same layout is untouched', () => {
    expect(
      findCompositionCarveoutOffenders(
        guardedContract({ packageDir: 'packages/knowledge-local' }),
        [hit(A_SCOPED_PACKAGE, 'packages/knowledge-local/src/store/x.ts', 1)],
      ),
    ).toEqual([])
  })
})

describe('composition-carveout direction 2 — an allowance nothing uses', () => {
  it('reports every scoped package the subtree does not name', () => {
    const [firstUsed, ...unused] = Object.keys(COMPOSITION_ONLY_PACKAGES)

    expect(
      findCompositionCarveoutUnusedAllowances(guardedContract(), [
        hit(firstUsed!, COMPOSITION_FILE, 1),
      ]),
    ).toEqual(
      unused.sort().map(pkgName => (
        `composition-carveout: ${pkgName} ⇏ no file under ${COMPOSITION_SUBTREE} names it`
        + ' (unused allowance — delete the entry rather than carry a permission nothing needs)'
      )),
    )
  })

  // The defect this direction exists for: usage from OUTSIDE the subtree must not count as usage,
  // or a mis-scoped prefix could be kept quiet by the very imports it failed to cover.
  it('does not count a use outside the subtree as a use', () => {
    expect(
      findCompositionCarveoutUnusedAllowances(
        guardedContract(),
        Object.keys(COMPOSITION_ONLY_PACKAGES).map(pkgName => hit(pkgName, STORE_FILE)),
      ),
    ).toHaveLength(Object.keys(COMPOSITION_ONLY_PACKAGES).length)
  })

  it('is silent when every allowance is load-bearing', () => {
    expect(findCompositionCarveoutUnusedAllowances(guardedContract(), fullyUsedHits())).toEqual([])
  })
})

describe('composition-carveout against the real package', () => {
  it('scans real files, finds real scoped imports, and reports no offender', () => {
    const hits = realAgentLocalHits()
    expect(hits.length).toBeGreaterThan(0)

    const insideSubtree = hits.filter(entry => isCompositionFile(entry.file))
    expect(insideSubtree.length).toBeGreaterThan(0)

    expect(findCompositionCarveoutOffenders(guardedContract(), hits)).toEqual([])
    expect(findCompositionCarveoutUnusedAllowances(guardedContract(), hits)).toEqual([])
  })

  it('the store subtree really is lean — no scoped package is named there today', () => {
    const storeHits = realAgentLocalHits().filter(entry =>
      entry.file.replaceAll('\\', '/').startsWith('packages/agent-local/src/store/'),
    )
    expect(storeHits.length).toBeGreaterThan(0)

    const scoped = storeHits.filter(entry => entry.specifier in COMPOSITION_ONLY_PACKAGES)
    expect(scoped.map(entry => `${entry.file}:${entry.line} ${entry.specifier}`)).toEqual([])
  })
})
