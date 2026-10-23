/**
 * THE PHASE-405 DELETION INVENTORY (D-21, DETL-06) — grep-clean, plus the current DDL's closed shape.
 *
 * WHAT THIS PROVES, AND WHY A GREEN SUITE DOES NOT PROVE IT. Phase 405 deleted three v1 projection
 * tables, five `runs` columns, two path-addressed artifact routes, the legacy live feed, the v1 UI
 * step shape and one orphaned analytics field. Every one of those is a set that got SMALLER, and a
 * set that got smaller has a failure mode a passing suite cannot see: the removed member coming
 * back. Nothing in a green run fails when a retired column, route or field is re-added — an
 * assertion that a shape CONTAINS what it should contain is satisfied by a shape that contains
 * more. So the deletions are pinned by cells that RED on their return, and
 * the phase's mutation driver (since removed) proved each of those cells actually reds by re-adding the thing.
 *
 * TWO CLAIMS, TWO INSTRUMENTS.
 *
 *   THE INVENTORY (lexical). Every needle in the D-21 list has ZERO occurrences across the
 *   PRODUCTION sources of every workspace package — `packages/<pkg>/src`, `.ts`/`.tsx`, with
 *   `__tests__`, `*.test.*`, `*.test-d.*`, `dist` and `node_modules` excluded. COMMENTS COUNT. A
 *   retirement note that spells a retired token is a hit exactly like a live reference is, because
 *   the inventory's promise is "this string is not in the shipped tree", not "no code calls it".
 *   Three plans in this phase have been sent back for tripping on their own prose.
 *
 *   THE DDL (structural). The joined version-2 migration carries none of the retired column
 *   families and DOES carry the five surviving tables — the second half is what stops the cell
 *   passing because the migration went empty.
 *
 * THIS FILE CANNOT MATCH ITSELF. Every needle is assembled at runtime from two halves, so the whole
 * token is never spelled in this source. That is not decoration: this cell scans the workspace and
 * counts comments, so a needle spelled literally here would be reported by a repo-wide grep as the
 * very reappearance the inventory exists to forbid, and the last cell below asserts the property
 * over this file's own bytes. Convention lifted verbatim from
 * `packages/core/src/__tests__/v1-retry-machinery-deleted.test.ts` (LOOP-02, phase 353).
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { MIGRATIONS, SCHEMA_VERSION } from '../db/schema.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const THIS_FILE = fileURLToPath(import.meta.url)
/** `packages/dashboard-server/src/__tests__` -> `packages`. */
const PACKAGES_DIR = join(HERE, '..', '..', '..')

// ---------------------------------------------------------------------------------------------
// The inventory
// ---------------------------------------------------------------------------------------------

/**
 * The D-21 needle list, in CONTEXT.md's order, with the planner's four additions at the end
 * (the artifact path resolver, the live-feed replay-buffer getter, the parent-link column and the
 * run-level recording column — the server-side names 405-07 deleted, which the CONTEXT entry left
 * to the planner to finalise; each is spelled ONLY as a two-half needle below).
 *
 * `subActionsData` is NOT a needle, deliberately, and the omission is measured rather than assumed:
 * it is the LIVE-EDITOR socket's wire key, produced today by `dashboard-server`'s ws handler and
 * read at exactly one named boundary in the UI (`liveSubActionsOf` in `hooks/use-live-editor.ts`).
 * A name with a live producer is not debris; D-14 is about run-detail ARTIFACT addressing, and
 * renaming another package's wire contract is not what this inventory measures.
 */
const FORBIDDEN: { label: string; needle: string }[] = [
  { label: 'the legacy execution-events SSE route', needle: '/api/execution/' + 'events' },
  { label: 'the legacy live-event type', needle: 'LiveExecution' + 'Event' },
  { label: 'the retired live-event hook', needle: 'useExecution' + 'Events' },
  { label: 'the retired live-event subscriber', needle: 'subscribeToExecution' + 'Events' },
  { label: 'the retired v1 live projection module', needle: 'live-' + 'timeline' },
  { label: 'the path-addressed screenshot route', needle: '/api/screen' + 'shots/' },
  { label: 'the path-addressed video route', needle: '/api/vid' + 'eos/' },
  { label: 'the v1 UI artifact media module', needle: 'artifact-' + 'media' },
  { label: 'the v1 step screenshot column', needle: 'screenshot' + '_path' },
  { label: 'the v1 step before-screenshot column', needle: 'screenshot_bef' + 'ore_path' },
  { label: 'the v1 UI screenshot field', needle: 'screenshot' + 'Path' },
  { label: 'the v1 UI before-screenshot field', needle: 'screenshotBef' + 'orePath' },
  { label: 'the v1 UI healing screenshot list', needle: 'healingScreen' + 'shotPaths' },
  { label: 'the v1 healing screenshot column', needle: 'healing_screen' + 'shot_paths' },
  { label: 'the v1 healing attempt list', needle: 'healing_att' + 'empts' },
  { label: 'the v1 healing attempt list (short spelling)', needle: 'heal_att' + 'empts' },
  { label: 'the orphaned analytics healing counter', needle: 'healing_attempt' + '_count' },
  { label: 'the v1 reasoning-trace table', needle: 'reasoning_' + 'traces' },
  { label: 'the deleted artifact path resolver', needle: 'resolveArtifact' + 'Path' },
  { label: 'the deleted live-feed replay buffer getter', needle: 'getBuffered' + 'Events' },
  { label: 'the deleted parent-link column', needle: 'parent_run' + '_id' },
  { label: 'the deleted run-level recording column', needle: 'video' + '_path' },
  { label: 'the deleted accessibility summary helper', needle: 'fetchAccessibility' + 'Summary' },
  { label: 'the deleted accessibility route tail', needle: ')}/access' + 'ibility' },
]

const SCAN_EXCLUDED_DIRS = new Set(['dist', 'node_modules', '.turbo', 'coverage', '__tests__'])

function collectSourceFiles(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SCAN_EXCLUDED_DIRS.has(entry.name)) continue
      collectSourceFiles(full, out)
      continue
    }
    if (!/\.tsx?$/.test(entry.name)) continue
    if (/\.(test|spec)\.tsx?$/.test(entry.name)) continue
    if (/\.test-d\.tsx?$/.test(entry.name)) continue
    out.push(full)
  }
}

/** The packages that HAVE a `src` directory, discovered from disk — never a pinned list. */
function discoverSourceRoots(): Array<{ pkg: string; dir: string }> {
  const roots: Array<{ pkg: string; dir: string }> = []
  for (const pkg of readdirSync(PACKAGES_DIR)) {
    const dir = join(PACKAGES_DIR, pkg, 'src')
    try {
      if (statSync(dir).isDirectory()) roots.push({ pkg, dir })
    } catch {
      /* a package without src contributes nothing */
    }
  }
  return roots
}

function scanFileUniverse(): string[] {
  const files: string[] = []
  for (const root of discoverSourceRoots()) collectSourceFiles(root.dir, files)
  return files
}

interface Hit { file: string; line: number; text: string }

/** The extractor. Reads raw text: a token in a comment is a hit, by design (see the header). */
function findNeedle(needle: string, source: string, label: string): Hit[] {
  const hits: Hit[] = []
  source.split('\n').forEach((text, index) => {
    if (text.includes(needle)) hits.push({ file: label, line: index + 1, text: text.trim() })
  })
  return hits
}

const SOURCES = scanFileUniverse()

describe('the D-21 deletion inventory is grep-clean across production sources (DETL-06)', () => {
  // The universe control. A resolution bug that silently narrowed the scan would report the same
  // clean zero as a clean tree — 401-10's self-certifying guard, in inventory form.
  it('scans every package that has a src directory, and a non-trivial number of files', () => {
    const roots = discoverSourceRoots()
    expect(roots.length).toBeGreaterThan(5)

    const packagesSeen = new Set(SOURCES.map((f) => relative(PACKAGES_DIR, f).split(sep)[0]))
    const missing = roots.map((r) => r.pkg).filter((pkg) => !packagesSeen.has(pkg))
    expect(
      missing,
      `packages with src/ that contributed no scanned file: ${missing.join(', ')}`,
    ).toEqual([])

    for (const root of roots) {
      const forThisPackage = SOURCES.filter(
        (f) => relative(PACKAGES_DIR, f).split(sep)[0] === root.pkg,
      )
      expect(forThisPackage.length, `${root.pkg} contributed no scanned file`).toBeGreaterThan(0)
    }

    expect(SOURCES.length).toBeGreaterThan(500)
  })

  // The known-positive control. Every needle is planted in a synthetic source and must be found —
  // otherwise a typo'd needle reports zero hits forever and the inventory measures nothing.
  it('finds every planted needle — the known-positive control for the extractor', () => {
    for (const { label, needle } of FORBIDDEN) {
      const planted = ['const untouched = 1', `const planted = '${needle}'`, '// tail'].join('\n')
      const hits = findNeedle(needle, planted, 'synthetic/planted.ts')
      expect(hits.length, `the extractor could not find the planted ${label}`).toBe(1)
      expect(hits[0]?.line).toBe(2)
    }
  })

  // The extractor reads COMMENTS too. Stated as its own cell because it is the property three
  // plans in this phase were sent back for, and a property nobody asserted is a property that
  // drifts the first time somebody "helpfully" strips comments before scanning.
  it('counts a needle inside a comment as a hit', () => {
    const { needle } = FORBIDDEN[0] as { needle: string }
    const commented = `// a retirement note naming ${needle} in prose`
    expect(findNeedle(needle, commented, 'synthetic/commented.ts')).toHaveLength(1)
  })

  for (const { label, needle } of FORBIDDEN) {
    it(`no production source spells ${label}`, () => {
      const hits: string[] = []
      for (const file of SOURCES) {
        const rel = relative(PACKAGES_DIR, file).split(sep).join('/')
        for (const hit of findNeedle(needle, readFileSync(file, 'utf8'), rel)) {
          hits.push(`${hit.file}:${hit.line}: ${hit.text}`)
        }
      }
      expect(
        hits,
        `a retired 405 token reappeared in the shipped tree (D-21/DETL-06):\n${hits.join('\n')}`,
      ).toEqual([])
    })
  }

  // A cell that cannot match itself. The scan excludes `__tests__`, so this file would not be
  // reported even if it did spell a needle — which is precisely why the property has to be
  // asserted rather than trusted: a repo-wide grep run by a human has no such exclusion.
  it('spells none of its own needles — the inventory cannot be satisfied by this file', () => {
    const own = readFileSync(THIS_FILE, 'utf8')
    const selfHits = FORBIDDEN.filter(({ needle }) => own.includes(needle)).map((f) => f.label)
    expect(
      selfHits,
      `this cell spells a needle it forbids; build it from two halves: ${selfHits.join(', ')}`,
    ).toEqual([])
  })
})

// ---------------------------------------------------------------------------------------------
// The current DDL's closed shape
// ---------------------------------------------------------------------------------------------

const DDL = MIGRATIONS.map((migration) => migration.sql.join('\n')).join('\n')

/**
 * Retired COLUMN FAMILIES, as prefixes rather than exact names. A prefix is the right shape here:
 * the failure being pinned is "a healing/recording/reasoning column came back", and somebody
 * restoring one will not necessarily restore its old spelling.
 */
const RETIRED_DDL_TOKENS: { label: string; needle: string }[] = [
  { label: 'healing column', needle: 'healing' + '_' },
  { label: 'recording-path column', needle: 'screensh' + 'ot_' },
  { label: 'reasoning-trace table', needle: 'reasoning_' + 'traces' },
  { label: 'run-level recording column', needle: 'video' + '_path' },
  { label: 'parent-link column', needle: 'parent_run' + '_id' },
  { label: 'v1 wide step table', needle: 'CREATE TABLE IF NOT EXISTS ' + 'steps' },
  { label: 'v1 log table', needle: 'CREATE TABLE IF NOT EXISTS ' + 'logs' },
]

/** The survivors. Without these the cell would pass over an empty migration. */
const SURVIVING_TABLES = [
  'run_members',
  'run_steps',
  'run_sub_actions',
  'token_events',
  'execution_logs',
]

describe('the current DDL is a closed shape (D-02, DETL-06)', () => {
  it('is one migration, at the declared version', () => {
    expect(MIGRATIONS).toHaveLength(1)
    expect(MIGRATIONS[0]?.version).toBe(SCHEMA_VERSION)
    expect(SCHEMA_VERSION).toBe(2)
  })

  for (const { label, needle } of RETIRED_DDL_TOKENS) {
    it(`the current DDL declares no ${label}`, () => {
      const offending = DDL.split('\n')
        .map((line, index) => ({ line: line.trim(), index: index + 1 }))
        .filter((entry) => entry.line.includes(needle))
        .map((entry) => `MIGRATIONS[0].sql:${entry.index}: ${entry.line}`)
      expect(
        offending,
        `a retired v1 column family returned to the current DDL:\n${offending.join('\n')}`,
      ).toEqual([])
    })
  }

  // NON-VACUITY. The five tables the census measured a live producer AND a live reader for must be
  // present, so the cell above cannot pass by the migration having lost its DDL wholesale.
  it('declares every table the census KEPT', () => {
    for (const table of SURVIVING_TABLES) {
      expect(DDL, `the current DDL no longer declares ${table}`).toContain(
        `CREATE TABLE IF NOT EXISTS ${table}`,
      )
    }
  })
})
