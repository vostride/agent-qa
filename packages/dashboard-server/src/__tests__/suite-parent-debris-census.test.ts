/**
 * THE SUITE-PARENT / CHILD-RUN DEBRIS CENSUS (402-09, D-11).
 *
 * D-11, owner verbatim: "remove everything that's not required. Better to cleanup now than
 * maintain tumors." What counts as REQUIRED is decided by this census, not by judgment — the only
 * survivors are reads today's run-list / run-detail UI genuinely serves for HISTORICAL rows before
 * 405, and anything the one-run model leaves producer-less goes too.
 *
 * TWO PREDICATES THAT FAIL FOR DIFFERENT REASONS. This phase has already defeated four instrument
 * shapes: a symbol grep satisfied by an import line (402-01, 402-03), a source assertion satisfied
 * by its own file (402-07 / WINDOWS #253, 402-08 / #257), a fold from a DECLARED binding rather
 * than from what answered (402-07 / #251), and a behavioural differential blind to a byte-identical
 * private copy (402-08 / #257). Two greps with different regexes would be a fifth. So:
 *
 *   PREDICATE A — LEXICAL. Reads source TEXT. Discovers its own file universe by walking
 *   `packages/<pkg>/src` for every package that has one; never a pinned file list. Sees a token in
 *   a comment, sees a renamed-file copy, sees a type literal. Blind to a symbol that was RENAMED
 *   and to behaviour.
 *
 *   PREDICATE B — STRUCTURAL. Reads no source text at all. Discovers link-reading members by a
 *   RUNTIME DIFFERENTIAL: two byte-identically seeded databases that differ in exactly one fact —
 *   whether the child row's `parent_run_id` points at the parent — walked over the WHOLE
 *   `DashboardDatabase` and `JobQueue` prototypes and driven through the run route corpus. A member
 *   whose observable output or database effect differs between the two reads the parent link, under
 *   any name, in any file, however it is spelled. Blind to comments and to dead type breadth.
 *
 * Neither predicate can be satisfied by the other's evidence, and the register below is the ONE
 * vocabulary they are reconciled through: every site A discovers and every surface B discovers must
 * appear in it with a disposition.
 *
 * THE REGISTER IS FROZEN, NOT GENERATED. It is a hand-authored literal; the predicates measure
 * the tree AGAINST it. A register recomputed from
 * its own scan output is the self-certifying guard 401-10 warned about and can never fail.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { IncomingMessage, type ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import type { RunEventEnvelope, RunEventType } from '@vostride/agent-qa-schema'
import type { SuiteFileManager } from '../tests/suite-file-manager.js'
import { DashboardDatabase } from '../db/database.js'
import { createDashboardSqliteDatabase } from '../db/sqlite.js'
import { JobQueue } from '../queue/job-queue.js'
import { createDashboardRunIngest } from '../reporter/dashboard-subscriber.js'
import { createRouter } from '../server/routes.js'

const HERE = dirname(fileURLToPath(import.meta.url))
/** `packages/dashboard-server/src/__tests__` -> the `agent-qa` submodule root. */
const REPO_ROOT = join(HERE, '..', '..', '..', '..')
const PACKAGES_DIR = join(REPO_ROOT, 'packages')

// ---------------------------------------------------------------------------------------------
// PREDICATE A — the lexical census
// ---------------------------------------------------------------------------------------------

/**
 * The debris vocabulary. `getRunsByParent` / `cancelChildRuns` are the two named members of the
 * suite-parent DB modeling; `suite-parent` / `suite-child` are the two `RunArtifactKind` values
 * only that modeling ever minted.
 *
 * `parentRunId` / `parent_run_id` are deliberately NOT tokens here. The COLUMN is retained
 * wholesale: every `parent_run_id IS NULL` filter in the db module is a
 * top-level-run predicate that keeps working unchanged when nothing writes the column, and the
 * legacy `/api/execution/events` projection (`dashboard-ui/src/lib/live-timeline.ts`) carries
 * ~30 more references that 405 rebuilds. Scanning for it would produce a large all-keep set with no
 * discriminating power. Its SEMANTICS — who reads the link, who writes it — is exactly what
 * predicate B measures behaviourally, which is the sharper instrument for a column.
 */
export const DEBRIS_TOKENS = [
  'getRunsByParent',
  'cancelChildRuns',
  'suite-parent',
  'suite-child',
] as const

export interface DebrisSite {
  /** Repo-relative path. */
  readonly file: string
  readonly token: string
  /** The trimmed source line the token sits on — a site key that survives line-number drift. */
  readonly line: string
  /** How many times this exact (file, token, line) triple occurs today. */
  readonly before: number
  /** How many times it must occur after the D-11 deletion. */
  readonly after: number
  readonly disposition: 'keep' | 'delete'
  readonly why: string
}

const KEEP_RETAINED_UNION =
  'RETAINED union member, now as UNREACHABLE BREADTH (405-07). The v2 DDL narrowed its CHECK to '
  + 'the two kinds anything mints, so the store refuses these values and no row can carry one. The '
  + 'TYPE keeps them because the UI renders the field verbatim as a badge, and narrowing a union a '
  + 'render site switches on is 405-11\'s edit, not this plan\'s. Recorded here so the next reader '
  + 'finds a disposition rather than a survival.'

/**
 * 2026-08-27 (405-07, D-02): the disposition that flipped, and why it could only flip now.
 *
 * 402-09 kept every parent-link READ on one argument: the one-run model produced no new children,
 * but an OPERATOR's database still held rows written before it, and the run list and run detail had
 * to keep rendering them. That argument had a lifetime, and D-02 ended it — the v2 schema is a hard
 * cut with no migration, and a database stamped at any older version is refused by name on open.
 * There is no such thing as a pre-405 row in a database this build will open, so a read that exists
 * to render one reads a shape that cannot be present. The column, its index, its readers and the
 * response keys they filled all left together.
 */
const DELETE_HISTORICAL_READ =
  'A historical-row read retained by 402-09 for operator databases written before the one-run '
  + 'model. D-02 makes v2 a hard cut refused by name below its version, so no database this build '
  + 'opens can hold the rows this read existed to serve.'

export const DEBRIS_REGISTER: readonly DebrisSite[] = [
  // ---- cli ----------------------------------------------------------------------------------
  {
    file: 'packages/cli/src/commands/run.ts',
    token: 'getRunsByParent',
    line: 'const children = activeSuiteDb.getRunsByParent(run.id)',
    before: 1,
    after: 0,
    disposition: 'delete',
    why: 'CLI SIGINT child-cancellation fan-out. Under the one-run model the suite run IS the row '
      + 'the sweep already cancels; there are no children to fan out to.',
  },
  {
    file: 'packages/cli/src/commands/run.ts',
    token: 'suite-parent',
    line: "kind: 'suite-parent',",
    before: 1,
    after: 0,
    disposition: 'delete',
    why: 'The CLI-side parent-kind mint on the suite run artifact document. A kind claiming '
      + 'parenthood over rows nothing creates is exactly the label D-11 forbids.',
  },
  {
    file: 'packages/cli/src/commands/run.ts',
    token: 'suite-parent',
    line: "kind: 'test' | 'suite-parent' | 'suite-child'",
    before: 1,
    after: 0,
    disposition: 'delete',
    why: 'Local parameter breadth on buildRunArtifactContext. With the mint gone both call sites '
      + "pass 'test'; the surviving arms are unreachable breadth, not the retained schema union.",
  },
  {
    file: 'packages/cli/src/commands/run.ts',
    token: 'suite-child',
    line: "kind: 'test' | 'suite-parent' | 'suite-child'",
    before: 1,
    after: 0,
    disposition: 'delete',
    why: 'Same local parameter breadth (the suite-child arm of the same literal).',
  },
  {
    file: 'packages/cli/src/commands/run.ts',
    token: 'suite-parent',
    line: "}): { artifact: Record<string, unknown> & { kind: 'test' | 'suite-parent' | 'suite-child' } } {",
    before: 1,
    after: 0,
    disposition: 'delete',
    why: 'Local return-type breadth on buildRunArtifactContext.',
  },
  {
    file: 'packages/cli/src/commands/run.ts',
    token: 'suite-child',
    line: "}): { artifact: Record<string, unknown> & { kind: 'test' | 'suite-parent' | 'suite-child' } } {",
    before: 1,
    after: 0,
    disposition: 'delete',
    why: 'Same local return-type breadth (the suite-child arm).',
  },
  {
    file: 'packages/cli/src/commands/run.ts',
    token: 'suite-parent',
    line: "}) as { artifact: Record<string, unknown> & { kind: 'test' | 'suite-parent' | 'suite-child' } }",
    before: 1,
    after: 0,
    disposition: 'delete',
    why: 'Local cast breadth on buildRunArtifactContext.',
  },
  {
    file: 'packages/cli/src/commands/run.ts',
    token: 'suite-child',
    line: "}) as { artifact: Record<string, unknown> & { kind: 'test' | 'suite-parent' | 'suite-child' } }",
    before: 1,
    after: 0,
    disposition: 'delete',
    why: 'Same local cast breadth (the suite-child arm).',
  },

  // ---- dashboard-server: queue -----------------------------------------------------------------
  {
    file: 'packages/dashboard-server/src/queue/job-queue.ts',
    token: 'cancelChildRuns',
    line: 'private cancelChildRuns(parentRunId: string, endedAt: string): void {',
    before: 1,
    after: 0,
    disposition: 'delete',
    why: 'The child-run cancellation fan-out named in D-11.',
  },
  {
    file: 'packages/dashboard-server/src/queue/job-queue.ts',
    token: 'cancelChildRuns',
    line: 'this.cancelChildRuns(runId, now)',
    before: 2,
    after: 0,
    disposition: 'delete',
    why: 'Both call sites of the fan-out (pending-cancel and running-cancel arms).',
  },
  {
    file: 'packages/dashboard-server/src/queue/job-queue.ts',
    token: 'getRunsByParent',
    line: 'for (const child of this.db.getRunsByParent(parentRunId)) {',
    before: 1,
    after: 0,
    disposition: 'delete',
    why: 'The fan-out body; goes with the method.',
  },

  // ---- dashboard-server: reporter --------------------------------------------------------------
  {
    file: 'packages/dashboard-server/src/reporter/dashboard-subscriber.ts',
    token: 'suite-parent',
    line: "const kind: RunArtifactKind = mode === 'suite' ? 'suite-parent' : 'test'",
    before: 1,
    after: 0,
    disposition: 'delete',
    why: 'The ingest parent-kind mint. This module is the LIVE producer of new parent/child run '
      + 'records — the dashboard suite door still reaches it — so the truth "no producer survives" '
      + 'is false while it stands.',
  },
  {
    file: 'packages/dashboard-server/src/reporter/dashboard-subscriber.ts',
    token: 'suite-child',
    line: "insertArtifact(id, 'suite-child')",
    before: 1,
    after: 0,
    disposition: 'delete',
    why: 'The ingest child-row artifact mint, written per suite member alongside a run row carrying '
      + 'parent_run_id. Deleted with the suite ingest mode itself.',
  },

  // ---- dashboard-server: routes ----------------------------------------------------------------
  {
    file: 'packages/dashboard-server/src/server/routes.ts',
    token: 'suite-parent',
    line: "kind: isSuiteFile ? 'suite-parent' : 'test',",
    before: 1,
    after: 0,
    disposition: 'delete',
    why: 'The parent-kind mint on POST /api/queue/enqueue named in D-11.',
  },
  {
    file: 'packages/dashboard-server/src/server/routes.ts',
    token: 'suite-parent',
    line: "kind: isSuite ? 'suite-parent' : 'test',",
    before: 1,
    after: 0,
    disposition: 'delete',
    why: 'The same mint on POST /api/runs/trigger — the door the dashboard UI actually uses.',
  },
  {
    file: 'packages/dashboard-server/src/server/routes.ts',
    token: 'getRunsByParent',
    line: "'getRunsByParent',",
    before: 1,
    after: 0,
    disposition: 'delete',
    why: 'RESPONSE_SAFE_RUN_READ_METHODS membership. The 401-23 allowlist asserts SET EQUALITY with '
      + 'the database\'s run reads at construction, so the name leaves in the same commit as the '
      + 'method — keeping either alone throws at router build.',
  },
  {
    file: 'packages/dashboard-server/src/server/routes.ts',
    token: 'getRunsByParent',
    line: 'getRunsByParent: { value: (parentRunId: string) => scrubRows(db.getRunsByParent(parentRunId)) },',
    before: 1,
    after: 0,
    disposition: 'delete',
    why: 'The metadata-scrubbing override for the same read. It goes with the read it wrapped — a '
      + 'scrub for a method nobody can call is not a door, it is dead policy (401-23).',
  },
  {
    file: 'packages/dashboard-server/src/server/routes.ts',
    token: 'getRunsByParent',
    line: 'const tests = db.getRunsByParent(run.id).map(test => enrichRunRow(test, targetPlatforms))',
    before: 1,
    after: 0,
    disposition: 'delete',
    why: `GET /api/runs — the run-LIST enrich. ${DELETE_HISTORICAL_READ}`,
  },
  {
    file: 'packages/dashboard-server/src/server/routes.ts',
    token: 'getRunsByParent',
    line: 'const childRuns = db.getRunsByParent(id)',
    before: 1,
    after: 0,
    disposition: 'delete',
    why: `GET /api/runs/:id/execution-logs aggregated a suite's member logs across child rows. ${DELETE_HISTORICAL_READ} A suite's hook logs are written against the one run id, carrying the member handle.`,
  },
  {
    file: 'packages/dashboard-server/src/server/routes.ts',
    token: 'getRunsByParent',
    line: 'const attempts = db.getRunsByParent(id)',
    before: 1,
    after: 0,
    disposition: 'delete',
    why: `GET /api/runs/:id — the run-DETAIL attempts key. ${DELETE_HISTORICAL_READ}`,
  },
  {
    file: 'packages/dashboard-server/src/server/routes.ts',
    token: 'getRunsByParent',
    line: 'const tests = db.getRunsByParent(id)',
    before: 1,
    after: 0,
    disposition: 'delete',
    why: `GET /api/runs/:id — the run-DETAIL tests key for a suite parent. ${DELETE_HISTORICAL_READ}`,
  },

  // ---- dashboard-server: server ----------------------------------------------------------------
  {
    file: 'packages/dashboard-server/src/server/server.ts',
    token: 'getRunsByParent',
    line: 'const children = db.getRunsByParent(runId)',
    before: 1,
    after: 0,
    disposition: 'delete',
    why: 'Run-close suite fold: derives the parent row\'s status from its children. With no child '
      + 'producer this can only ever read an empty list, so it is dead code reading as live policy '
      + '— the same shape 401-07 retired for retry children at this exact site.',
  },
  {
    file: 'packages/dashboard-server/src/server/server.ts',
    token: 'getRunsByParent',
    line: 'const updatedChildren = db.getRunsByParent(runId)',
    before: 1,
    after: 0,
    disposition: 'delete',
    why: 'The second half of the same fold (re-read after forcing incomplete children).',
  },
  {
    file: 'packages/dashboard-server/src/server/server.ts',
    token: 'getRunsByParent',
    line: 'const children = db.getRunsByParent(run.id)',
    before: 1,
    after: 0,
    disposition: 'delete',
    why: 'Startup orphan-cleanup skip: leaves a suite parent stuck in `running` when a child still '
      + 'reads `running`. After a restart nothing is running, and with no child producer the skip '
      + 'can only strand historical rows in a state no process will ever finish.',
  },

  // ---- retained storage + type surface ---------------------------------------------------------
  {
    file: 'packages/dashboard-server/src/db/database.ts',
    token: 'getRunsByParent',
    line: 'getRunsByParent(parentRunId: string): RunRow[] {',
    before: 1,
    after: 0,
    disposition: 'delete',
    why: `The declaration of the read every site above called. ${DELETE_HISTORICAL_READ}`,
  },
  {
    file: 'packages/dashboard-server/src/db/database.ts',
    token: 'getRunsByParent',
    line: 'const children = this.getRunsByParent(runId).map((run) => ({',
    before: 1,
    after: 0,
    disposition: 'delete',
    why: `getRunArtifactBundle's child section, served by GET /api/runs/:id/artifact. ${DELETE_HISTORICAL_READ} `
      + 'The bundle is one run\'s artifact now, and the response key went with it — a structurally '
      + 'empty array on a response is worse than an absent one.',
  },
  {
    file: 'packages/dashboard-server/src/db/schema.ts',
    token: 'suite-parent',
    line: "kind TEXT NOT NULL CHECK(kind IN ('test', 'suite-parent', 'suite-child', 'unknown')),",
    before: 1,
    after: 0,
    disposition: 'delete',
    why: '402-09 kept this CHECK because narrowing it would have needed a table-rebuild migration '
      + 'on every operator database. D-02 removes that cost entirely: v2 is a hard cut, the table '
      + 'is CREATEd at its final shape and an older database is refused rather than rebuilt. So the '
      + 'store now admits only the two kinds anything mints (RESEARCH Open Q4).',
  },
  {
    file: 'packages/dashboard-server/src/db/schema.ts',
    token: 'suite-child',
    line: "kind TEXT NOT NULL CHECK(kind IN ('test', 'suite-parent', 'suite-child', 'unknown')),",
    before: 1,
    after: 0,
    disposition: 'delete',
    why: 'Same CHECK constraint (the suite-child arm).',
  },
  {
    file: 'packages/dashboard-ui/src/lib/api.ts',
    token: 'suite-parent',
    line: "export type RunArtifactKind = 'test' | 'suite-parent' | 'suite-child' | 'unknown'",
    before: 1,
    after: 0,
    disposition: 'delete',
    why: `${KEEP_RETAINED_UNION} 405-07 recorded this as a KEEP because the drawer switches on the `
      + 'value to paint a badge and narrowing a union a render site reads belongs with that render '
      + 'site. 405-11 rebuilt that render site and narrowed it there, closing the deferral.',
  },
  {
    file: 'packages/dashboard-ui/src/lib/api.ts',
    token: 'suite-child',
    line: "export type RunArtifactKind = 'test' | 'suite-parent' | 'suite-child' | 'unknown'",
    before: 1,
    after: 0,
    disposition: 'delete',
    why: 'Same UI-side union (the suite-child arm), narrowed by 405-11.',
  },
  {
    file: 'packages/schema/src/run/run-artifact.ts',
    token: 'suite-parent',
    line: "export type RunArtifactKind = 'test' | 'suite-parent' | 'suite-child' | 'unknown'",
    before: 1,
    after: 0,
    disposition: 'delete',
    why: `${KEEP_RETAINED_UNION} The canonical union; D-11 deleted the PRODUCERS of the value and `
      + "405-07 deleted the STORE's admission of it, leaving both members unreachable breadth on "
      + 'every reader. 405-11 narrowed it with the render site, so no reader can name the value.',
  },
  {
    file: 'packages/schema/src/run/run-artifact.ts',
    token: 'suite-child',
    line: "export type RunArtifactKind = 'test' | 'suite-parent' | 'suite-child' | 'unknown'",
    before: 1,
    after: 0,
    disposition: 'delete',
    why: 'Same canonical union (the suite-child arm), narrowed by 405-11.',
  },
]

function siteKey(site: { file: string; token: string; line: string }): string {
  return `${site.file} ${site.token} ${site.line}`
}

/** Every directory name the scan refuses to descend into, with the reason it is refused. */
const SCAN_EXCLUDED_DIRS: ReadonlyMap<string, string> = new Map([
  ['dist', 'build output — a copy of the sources already scanned'],
  ['node_modules', 'third-party code this project does not own'],
  ['__tests__', 'test fixtures legitimately seed historical parent/child rows (see the exclusion '
    + 'control below, which proves this region is where the excluded matches live)'],
])

function collectSourceFiles(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SCAN_EXCLUDED_DIRS.has(entry.name)) continue
      collectSourceFiles(full, out)
      continue
    }
    if (!/\.tsx?$/.test(entry.name)) continue
    if (/\.test\.tsx?$/.test(entry.name)) continue
    out.push(full)
  }
}

/** The packages that have a `src` directory, discovered from disk — never a pinned list. */
function discoverSourceRoots(): Array<{ pkg: string; dir: string }> {
  const roots: Array<{ pkg: string; dir: string }> = []
  for (const pkg of readdirSync(PACKAGES_DIR)) {
    const dir = join(PACKAGES_DIR, pkg, 'src')
    try {
      if (statSync(dir).isDirectory()) roots.push({ pkg, dir })
    } catch { /* a package without src contributes nothing */ }
  }
  return roots
}

function scanFileUniverse(): string[] {
  const files: string[] = []
  for (const root of discoverSourceRoots()) collectSourceFiles(root.dir, files)
  return files
}

interface ScannedSite { file: string; token: string; line: string }

function extractSites(relPath: string, contents: string): ScannedSite[] {
  const found: ScannedSite[] = []
  for (const line of contents.split('\n')) {
    for (const token of DEBRIS_TOKENS) {
      if (line.includes(token)) found.push({ file: relPath, token, line: line.trim() })
    }
  }
  return found
}

function scanDebrisSites(files: string[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const file of files) {
    const rel = relative(REPO_ROOT, file).split(sep).join('/')
    for (const site of extractSites(rel, readFileSync(file, 'utf8'))) {
      const key = siteKey(site)
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  }
  return counts
}

function registerCounts(phase: 'before' | 'after'): Map<string, number> {
  const counts = new Map<string, number>()
  for (const entry of DEBRIS_REGISTER) {
    const n = phase === 'before' ? entry.before : entry.after
    if (n === 0) continue
    counts.set(siteKey(entry), n)
  }
  return counts
}

function describeCounts(counts: Map<string, number>): string[] {
  return [...counts.entries()]
    .map(([key, n]) => `${n}x ${key.split(' ').join(' | ')}`)
    .sort()
}

// ---------------------------------------------------------------------------------------------
// PREDICATE B — the structural surface walk
//
// 2026-08-27 (405-07, D-02): THE DIFFERENTIAL IS RETIRED BECAUSE ITS DISCRIMINATOR WAS DELETED, AND
// SAYING SO IS THE WHOLE POINT OF RECORDING IT HERE.
//
// The arm worked by seeding two byte-identical databases that differed in exactly one fact —
// whether a member row's parent link pointed at the parent — and calling every prototype member and
// every run route against both. A member whose observable output or database effect differed read
// the link, under any name, in any file, however it was spelled. That instrument is why the twelve
// raw-SQL top-level filters and the cascade were found at all: predicate A cannot see a query.
//
// The column is gone. There is no second database to seed, because the fact the two differed in is
// no longer expressible — and a differential run over an absent discriminator can only ever report
// "no difference", which is precisely the vacuous instrument this file exists to refuse. Keeping it
// would have meant keeping the column alive so its own test could still run.
//
// WHAT REPLACES IT IS STRICTLY STRONGER FOR THE CLAIM IT NOW HAS TO MAKE. The differential proved
// "these members read the link"; the successor proves "no member CAN read it", structurally, at the
// storage layer — the table has no such column, and the store refuses the two artifact kinds the
// parent/child model minted. A reader reintroduced under any name would have to reintroduce the
// column first, and that reddens here before any behaviour is written.
// ---------------------------------------------------------------------------------------------

const PARENT_ID = 'r_parent-alpha-bravo-charlie-delta-echo-foxtrot-golf-hotel-india'
const CHILD_A = 'r_childa-alpha-bravo-charlie-delta-echo-foxtrot-golf-hotel-india'
const CHILD_B = 'r_childb-alpha-bravo-charlie-delta-echo-foxtrot-golf-hotel-india'
const SUITE_ID = 's_suite-alpha-bravo-charlie-delta-echo-foxtrot-golf-hotel-india'

/** The tokens no `runs` column may spell, split so this file is not its own scan hit. */
const FORBIDDEN_RUN_COLUMNS: readonly string[] = [
  'parent_run' + '_id',
  'attempt_' + 'number',
  'max_' + 'retries',
  'video_' + 'path',
]

/** The two artifact kinds the parent/child model minted, split for the same reason. */
const RETIRED_ARTIFACT_KINDS: readonly string[] = ['suite-' + 'parent', 'suite-' + 'child']

function runColumnNames(db: DashboardDatabase): string[] {
  const rows = (db as unknown as { db: { prepare(sql: string): { all(): unknown[] } } }).db
    .prepare('PRAGMA table_info(runs)')
    .all() as Array<{ name: string }>
  return rows.map((row) => row.name)
}

/**
 * ONE database seeded the way the retired fixture seeded its `linked` half — a suite run and two
 * members — MINUS the link, because the link cannot be written. It is what an operator's database
 * now looks like for a suite: one row per run, members on `run_members`.
 */
function seedSuiteShapedDatabase(): DashboardDatabase {
  const db = new DashboardDatabase({ dbPath: ':memory:' })
  db.insertRun({
    id: PARENT_ID,
    name: 'Checkout Suite',
    filePath: 'suites/checkout.suite.yaml',
    status: 'running',
    duration: 0,
    startedAt: '2026-08-01T00:00:00.000Z',
    endedAt: '2026-08-01T00:00:00.000Z',
    suiteId: SUITE_ID,
  })
  db.insertRunArtifact({ runId: PARENT_ID, kind: 'test' })
  let index = 0
  for (const childId of [CHILD_A, CHILD_B]) {
    db.upsertRunMember({
      runId: PARENT_ID,
      testIndex: index,
      name: `Member ${childId === CHILD_A ? 'A' : 'B'}`,
      filePath: 'tests/member.yaml',
      suiteId: SUITE_ID,
    })
    db.insertExecutionLog({
      id: `log-${childId}`,
      runId: PARENT_ID,
      testIndex: index,
      type: 'hook',
      name: 'setup',
      phase: 'setup',
      status: 'passed',
      duration: 1,
    })
    index += 1
  }
  return db
}

// --- routes -----------------------------------------------------------------------------------

interface ProbeResponse { status: number; body: string }

function suiteFileManagerStub(): SuiteFileManager {
  return {
    resolvePath: (filePath: string) => ({ storagePath: filePath, executionPath: filePath }),
    read: async () => 'name: Checkout Suite\ntests: []\n',
  } as unknown as SuiteFileManager
}

function buildRouter(db: DashboardDatabase): ReturnType<typeof createRouter> {
  const jobQueue = new JobQueue({ db, concurrency: 1 })
  return createRouter({
    db,
    jobQueue,
    suiteFileManager: suiteFileManagerStub(),
  } as unknown as Parameters<typeof createRouter>[0])
}

// A mock request that omits `Host` models no real client: HTTP/1.1 requires the header and every
// browser, `curl`, `fetch` and the conformance harness sends it. The display-seam read arms
// (405 CR-01) now refuse a request whose claimed Host is not a loopback name, so the default below
// is what keeps these direct-invoke probes speaking the wire's own shape. An explicit `host` in
// `options.headers` still wins, which is how the refusal itself is exercised.
const LOOPBACK_HOST_HEADER = { host: '127.0.0.1:3470' } as const

async function probeRoute(
  router: ReturnType<typeof createRouter>,
  url: string,
  options: { method?: string; body?: string } = {},
): Promise<ProbeResponse> {
  return await new Promise<ProbeResponse>((resolve) => {
    const req = new IncomingMessage(new Socket())
    req.method = options.method ?? 'GET'
    req.url = url
    req.headers = options.body === undefined
      ? { ...LOOPBACK_HOST_HEADER }
      : { ...LOOPBACK_HOST_HEADER, 'content-type': 'application/json' }
    process.nextTick(() => {
      if (options.body !== undefined) req.push(Buffer.from(options.body))
      req.push(null)
    })

    let status = 200
    let body = ''
    let settled = false
    const settle = (): void => {
      if (settled) return
      settled = true
      resolve({ status, body })
    }
    const timer = setTimeout(() => { status = -1; body = '[no response]'; settle() }, 5_000)
    timer.unref?.()

    const res = {
      writeHead(code: number) { status = code; return this },
      setHeader() { /* headers are not part of the census */ },
      getHeader() { return undefined },
      write(chunk: string | Buffer) {
        body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk
        return true
      },
      end(chunk?: string | Buffer) {
        if (chunk) body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk
        clearTimeout(timer)
        settle()
      },
      on() { return this },
      once() { return this },
      removeListener() { return this },
      get writableEnded() { return settled },
    } as unknown as ServerResponse

    try {
      router(req, res)
    } catch (error) {
      status = -2
      body = `[threw:${error instanceof Error ? error.name : typeof error}]`
      clearTimeout(timer)
      settle()
    }
  })
}

// --- production channels ------------------------------------------------------------------------

function envelope(runId: string, type: RunEventType, payload: Record<string, unknown> = {}, seq = 1): RunEventEnvelope {
  return { seq, ts: seq, runId, type, payload } as RunEventEnvelope
}

/**
 * Every channel through which this process can create a run record today. A channel counts as a
 * PRODUCER when, driven against an empty database, it leaves behind a run artifact of a
 * parent/child kind.
 *
 * 2026-08-27 (405-07): the linked-row half of that predicate is gone with the column. It is not
 * weakened — the store now REFUSES a parent/child kind outright, so a channel that tried to mint
 * one would fail its write rather than quietly produce a row this walk then has to notice.
 *
 * `JobQueue.enqueue` is deliberately absent: it stores whatever `kind` its caller hands it, so the
 * mint lives at the CALLERS (the two routes below), which is what this probes. A future caller
 * passing a parent kind would be caught by predicate A instead — the two predicates cover each
 * other here, which is the point of having two.
 */
const PRODUCTION_CHANNELS: ReadonlyArray<{ id: string; drive: (db: DashboardDatabase) => Promise<void> }> = [
  {
    id: 'route:POST /api/queue/enqueue (suite file)',
    drive: async (db) => {
      await probeRoute(buildRouter(db), '/api/queue/enqueue', {
        method: 'POST',
        body: JSON.stringify({ name: 'Checkout Suite', file: 'suites/checkout.suite.yaml' }),
      })
    },
  },
  {
    id: 'route:POST /api/runs/trigger (suite file)',
    drive: async (db) => {
      await probeRoute(buildRouter(db), '/api/runs/trigger', {
        method: 'POST',
        body: JSON.stringify({ file: 'suites/checkout.suite.yaml' }),
      })
    },
  },
  {
    id: 'ingest:createDashboardRunIngest suite correlation',
    drive: async (db) => {
      const ingest = createDashboardRunIngest({
        db,
        runId: PARENT_ID,
        sourceSnapshot: { kind: 'suite', name: 'Checkout Suite', suiteId: SUITE_ID },
        now: () => '2026-08-01T00:00:00.000Z',
      })
      ingest.handler(envelope('bus-1', 'runStarted', { memberTestCount: 2 }, 1))
      ingest.handler(envelope('bus-1', 'testStarted', { testIndex: 0, name: 'Member A' }, 2))
      ingest.handler(envelope('bus-1', 'testStarted', { testIndex: 1, name: 'Member B' }, 3))
      ingest.handler(envelope('bus-1', 'testFinished', { testIndex: 0, outcome: 'passed' }, 4))
      ingest.handler(envelope('bus-1', 'runFinished', { aggregateVerdict: 'passed', finalSeq: 5 }, 5))
    },
  },
  {
    id: 'ingest:createDashboardRunIngest retry correlation',
    drive: async (db) => {
      const ingest = createDashboardRunIngest({
        db,
        runId: CHILD_A,
        sourceSnapshot: { kind: 'test', name: 'Member A' },
        now: () => '2026-08-01T00:00:00.000Z',
      })
      ingest.handler(envelope('bus-2', 'runStarted', { memberTestCount: 1 }, 1))
      ingest.handler(envelope('bus-2', 'testStarted', { testIndex: 0, name: 'Member A' }, 2))
      ingest.handler(envelope('bus-2', 'runFinished', { aggregateVerdict: 'passed', finalSeq: 3 }, 3))
    },
  },
]

interface ProducerFinding { channel: string; parentKinds: string[] }

async function walkProductionChannels(): Promise<ProducerFinding[]> {
  const findings: ProducerFinding[] = []
  for (const channel of PRODUCTION_CHANNELS) {
    const db = new DashboardDatabase({ dbPath: ':memory:' })
    try {
      await channel.drive(db)
      const raw = db as unknown as { db: { prepare(sql: string): { all(...a: unknown[]): unknown[] } } }
      const parentKinds = (raw.db
        .prepare('SELECT kind FROM run_artifacts WHERE kind IN (?, ?)')
        .all(...RETIRED_ARTIFACT_KINDS) as Array<{ kind: string }>).map((r) => r.kind).sort()
      if (parentKinds.length > 0) {
        findings.push({ channel: channel.id, parentKinds })
      }
    } finally {
      db.close()
    }
  }
  return findings
}

// ---------------------------------------------------------------------------------------------
// The register's surface vocabulary — where predicates A and B are reconciled
// ---------------------------------------------------------------------------------------------

export interface DebrisSurface {
  readonly id: string
  readonly kind: 'producer' | 'reader'
  readonly disposition: 'keep' | 'delete'
  /** Register site keys (file|token|line) this surface is implemented by. */
  readonly sites: readonly string[]
  readonly why: string
}

const S = (file: string, token: string, line: string): string => siteKey({ file, token, line })

const DELETE_LINK_FILTER = 'A top-level-run filter over the parent link, spelled in raw SQL. '
  + 'Predicate A was structurally blind to these — they name no debris token — and predicate B '
  + 'found all of them by differential. 402-09 kept them because a linked row admitted as a '
  + 'top-level run would have double-counted every historical suite in the list, the counts and '
  + 'the trend series. D-02 makes such a row unreachable, and a predicate over a column the table '
  + 'does not have is an error rather than a filter, so each one is deleted with the column.'

const ROUTES = 'packages/dashboard-server/src/server/routes.ts'
const DATABASE = 'packages/dashboard-server/src/db/database.ts'
const SUBSCRIBER = 'packages/dashboard-server/src/reporter/dashboard-subscriber.ts'
const QUEUE = 'packages/dashboard-server/src/queue/job-queue.ts'
const SCHEMA_FILE = 'packages/dashboard-server/src/db/schema.ts'
const CHECK_LINE = "kind TEXT NOT NULL CHECK(kind IN ('test', 'suite-parent', 'suite-child', 'unknown')),"

/**
 * 2026-08-27 (405-07, D-02): EVERY SURFACE ON THIS TABLE IS NOW `delete`, AND THAT IS THE TERMINAL
 * STATE OF THE CENSUS RATHER THAN A LOSS OF COVERAGE.
 *
 * 402-09 recorded fourteen KEEP surfaces here: two link READS the run list and run detail served
 * for pre-402 rows, and twelve top-level-run filters spelled `parent_run_id IS NULL` in raw SQL —
 * which predicate A was structurally blind to (they name no debris token) and predicate B found by
 * differential. Every one of them was kept on the same argument: an operator's database still held
 * linked rows, and admitting a child row as a top-level run would double-count every historical
 * suite in the list, the counts and the trend series.
 *
 * D-02 ends that argument. v2 is a hard cut refused by name below its version, so no database this
 * build opens holds a linked row — and the twelve filters were therefore filtering nothing. Each
 * one is deleted rather than left as a predicate over an absent column, which SQLite would answer
 * with an error rather than with `true`.
 */
export const DEBRIS_SURFACES: readonly DebrisSurface[] = [
  {
    id: 'db:getRunsByParent',
    kind: 'reader',
    disposition: 'delete',
    sites: [
      S(DATABASE, 'getRunsByParent', 'getRunsByParent(parentRunId: string): RunRow[] {'),
      // The router's accounting for the same read. Both exist ONLY because the read did, and both
      // must go in the same commit: `assertRunReadsAccountedFor` compares the allowlist to the
      // database's live run-named surface at construction, so a name left behind throws at router
      // build and a name removed early throws the same way (401-23).
      S(ROUTES, 'getRunsByParent', "'getRunsByParent',"),
      S(ROUTES, 'getRunsByParent', 'getRunsByParent: { value: (parentRunId: string) => scrubRows(db.getRunsByParent(parentRunId)) },'),
    ],
    why: DELETE_HISTORICAL_READ,
  },
  {
    id: 'db:run_artifacts kind CHECK',
    kind: 'reader',
    disposition: 'delete',
    sites: [
      S(SCHEMA_FILE, 'suite-parent', CHECK_LINE),
      S(SCHEMA_FILE, 'suite-child', CHECK_LINE),
    ],
    why: 'The store\'s admission of the two parent/child artifact kinds. Observable directly — the '
      + 'predicate-B cell writes each kind and reads the refusal — which is why it is a surface and '
      + 'not an unobservable delete. 402-09 kept it because narrowing a CHECK meant a table rebuild '
      + 'on every operator database; D-02 removes that cost (RESEARCH Open Q4).',
  },
  {
    id: 'db:getRunArtifactBundle',
    kind: 'reader',
    disposition: 'delete',
    sites: [S(DATABASE, 'getRunsByParent', 'const children = this.getRunsByParent(runId).map((run) => ({')],
    why: `${DELETE_HISTORICAL_READ} The bundle answers one run's artifact; the child section and the `
      + 'response key it filled are gone.',
  },
  {
    id: 'db:deleteRun',
    kind: 'reader',
    disposition: 'delete',
    sites: [],
    why: 'The recursive `run_tree` cascade. 402-09 kept it so a historical suite parent could still '
      + 'take its members with it; with no linked row reachable the walk returns the one row it was '
      + 'seeded with, and every table that references a run declares ON DELETE CASCADE. '
      + `${DELETE_LINK_FILTER}`,
  },
  {
    id: 'db:getRuns',
    kind: 'reader',
    disposition: 'delete',
    sites: [],
    why: `The run-list query's first condition. ${DELETE_LINK_FILTER}`,
  },
  {
    id: 'db:getRunsBySuiteId',
    kind: 'reader',
    disposition: 'delete',
    sites: [],
    why: `Suite drill-down listing. ${DELETE_LINK_FILTER}`,
  },
  {
    id: 'db:getRunsBySuiteIdCount',
    kind: 'reader',
    disposition: 'delete',
    sites: [],
    why: `The paging total for the same listing. ${DELETE_LINK_FILTER}`,
  },
  {
    id: 'db:getRunsByTest',
    kind: 'reader',
    disposition: 'delete',
    sites: [],
    why: `Test-history listing. ${DELETE_LINK_FILTER}`,
  },
  {
    id: 'db:getRunsByTestCount',
    kind: 'reader',
    disposition: 'delete',
    sites: [],
    why: `The paging total for the same listing. ${DELETE_LINK_FILTER}`,
  },
  {
    id: 'db:getStats',
    kind: 'reader',
    disposition: 'delete',
    sites: [],
    why: `Dashboard headline counters. ${DELETE_LINK_FILTER}`,
  },
  {
    id: 'db:getSuiteTrends',
    kind: 'reader',
    disposition: 'delete',
    sites: [],
    why: `Suite trend series. ${DELETE_LINK_FILTER}`,
  },
  {
    id: 'db:getTestTrends',
    kind: 'reader',
    disposition: 'delete',
    sites: [],
    why: `Test trend series. ${DELETE_LINK_FILTER}`,
  },
  {
    id: 'db:getInsightsBreakdown',
    kind: 'reader',
    disposition: 'delete',
    sites: [],
    why: 'Insights breakdowns. Its `test` dimension additionally used the link to exclude suite '
      + 'PARENT rows, whose name is a suite\'s and not a test\'s; that exclusion survives, spelled '
      + `over the suite id alone. ${DELETE_LINK_FILTER}`,
  },
  {
    id: 'db:listRunsForInsights',
    kind: 'reader',
    disposition: 'delete',
    sites: [],
    why: `The private row source getInsightsBreakdown folds. ${DELETE_LINK_FILTER}`,
  },
  {
    id: 'queue:cancel',
    kind: 'reader',
    disposition: 'delete',
    sites: [
      S(QUEUE, 'cancelChildRuns', 'this.cancelChildRuns(runId, now)'),
      S(QUEUE, 'cancelChildRuns', 'private cancelChildRuns(parentRunId: string, endedAt: string): void {'),
      S(QUEUE, 'getRunsByParent', 'for (const child of this.db.getRunsByParent(parentRunId)) {'),
    ],
    why: 'The child-cancellation fan-out D-11 names. Deleted by 402-09; cancelling a run now reaches '
      + 'the run it names and nothing else.',
  },
  {
    id: 'route:GET /api/runs',
    kind: 'reader',
    disposition: 'delete',
    sites: [S(ROUTES, 'getRunsByParent', 'const tests = db.getRunsByParent(run.id).map(test => enrichRunRow(test, targetPlatforms))')],
    why: DELETE_HISTORICAL_READ,
  },
  {
    id: 'route:GET /api/runs/:id',
    kind: 'reader',
    disposition: 'delete',
    sites: [
      S(ROUTES, 'getRunsByParent', 'const attempts = db.getRunsByParent(id)'),
      S(ROUTES, 'getRunsByParent', 'const tests = db.getRunsByParent(id)'),
    ],
    why: `${DELETE_HISTORICAL_READ} The arm answers only the run row (D-03).`,
  },
  {
    id: 'route:GET /api/runs/:id/artifact',
    kind: 'reader',
    disposition: 'delete',
    sites: [],
    why: 'Serves getRunArtifactBundle and inherits its disposition.',
  },
  {
    id: 'route:GET /api/runs/:id/execution-logs',
    kind: 'reader',
    disposition: 'delete',
    sites: [S(ROUTES, 'getRunsByParent', 'const childRuns = db.getRunsByParent(id)')],
    why: DELETE_HISTORICAL_READ,
  },
  {
    id: 'route:DELETE /api/runs/:id',
    kind: 'reader',
    disposition: 'delete',
    sites: [],
    why: 'Serves db:deleteRun and inherits its disposition.',
  },
  {
    id: 'route:POST /api/runs/:id/cancel',
    kind: 'reader',
    disposition: 'delete',
    sites: [S(QUEUE, 'cancelChildRuns', 'this.cancelChildRuns(runId, now)')],
    why: 'The HTTP door onto queue:cancel. It stays a route; what went is its link-reading effect.',
  },
  {
    id: 'route:POST /api/queue/enqueue (suite file)',
    kind: 'producer',
    disposition: 'delete',
    sites: [S(ROUTES, 'suite-parent', "kind: isSuiteFile ? 'suite-parent' : 'test',")],
    why: 'The parent-kind mint D-11 names.',
  },
  {
    id: 'route:POST /api/runs/trigger (suite file)',
    kind: 'producer',
    disposition: 'delete',
    sites: [S(ROUTES, 'suite-parent', "kind: isSuite ? 'suite-parent' : 'test',")],
    why: 'The same mint on the door the dashboard UI uses.',
  },
  {
    id: 'ingest:createDashboardRunIngest suite correlation',
    kind: 'producer',
    disposition: 'delete',
    sites: [
      S(SUBSCRIBER, 'suite-parent', "const kind: RunArtifactKind = mode === 'suite' ? 'suite-parent' : 'test'"),
      S(SUBSCRIBER, 'suite-child', "insertArtifact(id, 'suite-child')"),
    ],
    why: 'The live producer of new parent/child run records: a parent row of kind suite-parent plus '
      + 'one linked child row per member. A parallel suite is ONE run row with member handles (D-11).',
  },
  {
    id: 'ingest:createDashboardRunIngest retry correlation',
    kind: 'producer',
    disposition: 'delete',
    sites: [],
    why: 'Already producer-less before 402-09 — 401-07 (D-12) retired the machinery that set '
      + 'the retired parent-run variable, so nothing could reach this mode. "Anything the '
      + 'one-run model leaves producer-less goes too" (D-11).',
  },
]

// ---------------------------------------------------------------------------------------------
// Cells
// ---------------------------------------------------------------------------------------------

describe('predicate A — the lexical debris census', () => {
  it('discovers its file universe from disk rather than a pinned list', () => {
    const roots = discoverSourceRoots()
    expect(roots.length).toBeGreaterThan(5)

    const files = scanFileUniverse()
    // A narrowing that silently drops packages is the 401-10 failure this control exists for:
    // every package that HAS a src directory must contribute at least one scanned file.
    const packagesSeen = new Set(
      files.map((f) => relative(PACKAGES_DIR, f).split(sep)[0]),
    )
    const missing = roots.map((r) => r.pkg).filter((pkg) => !packagesSeen.has(pkg))
    expect(missing, `packages with src/ that contributed no scanned file: ${missing.join(', ')}`).toEqual([])
    expect(files.length).toBeGreaterThan(500)
  })

  it('finds a planted token — the known-positive control for the extractor', () => {
    const planted = extractSites('synthetic/planted.ts', [
      'const rows = db.getRunsByParent(id)',
      "const kind = 'suite-parent'",
      'const untouched = 1',
    ].join('\n'))
    expect(planted.map((s) => s.token).sort()).toEqual(['getRunsByParent', 'suite-parent'])
  })

  it('the excluded regions DO contain debris tokens — the exclusion hides them, not a broken glob', () => {
    const testDir = join(PACKAGES_DIR, 'dashboard-server', 'src', '__tests__')
    const testFiles: string[] = []
    for (const entry of readdirSync(testDir, { withFileTypes: true })) {
      if (!entry.isFile() || !/\.tsx?$/.test(entry.name)) continue
      if (entry.name === 'suite-parent-debris-census.test.ts') continue
      testFiles.push(join(testDir, entry.name))
    }
    const inExcludedRegion = scanDebrisSites(testFiles)
    expect(inExcludedRegion.size).toBeGreaterThan(0)

    // ...and none of them leaked into the production scan.
    const production = scanDebrisSites(scanFileUniverse())
    for (const key of inExcludedRegion.keys()) {
      const file = key.split(' ')[0]
      expect(file.includes('__tests__')).toBe(true)
      expect(production.has(key) && key.includes('__tests__')).toBe(false)
    }
  })

  it("every debris site in the shipped sources is registered, and the register has no site the tree doesn't", () => {
    const scanned = scanDebrisSites(scanFileUniverse())
    expect(describeCounts(scanned)).toEqual(describeCounts(registerCounts(CENSUS_PHASE)))
  })

  it('the register is internally coherent — every entry dispositioned, deletes end at zero, keeps stay byte-intact', () => {
    for (const entry of DEBRIS_REGISTER) {
      expect(entry.why.length, `${entry.file} ${entry.token} has no rationale`).toBeGreaterThan(20)
      if (entry.disposition === 'delete') {
        expect(entry.after, `${entry.file} ${entry.token} is a delete that survives`).toBe(0)
      } else {
        expect(entry.after, `${entry.file} ${entry.token} is a keep whose count moved`).toBe(entry.before)
      }
    }
    // Site keys are unique — a duplicated key would let one disposition mask another.
    const keys = DEBRIS_REGISTER.map(siteKey)
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe('predicate B — the structural surface walk (no source text is read)', () => {
  it('the parent link is not a column any more — the discriminator the differential needed is gone', () => {
    const db = seedSuiteShapedDatabase()
    try {
      const columns = runColumnNames(db)
      // NON-VACUITY BEFORE ANY VERDICT: the reader must be seeing a real column list, or the
      // absence claim below is an absence of evidence. These four are the shape's own columns.
      expect(columns).toEqual(expect.arrayContaining(['id', 'name', 'status', 'suite_id']))

      for (const forbidden of FORBIDDEN_RUN_COLUMNS) {
        expect(columns, `runs still carries ${forbidden}`).not.toContain(forbidden)
      }
    } finally {
      db.close()
    }
  })

  it('the store refuses the two artifact kinds the parent/child model minted', () => {
    const db = new DashboardDatabase({ dbPath: ':memory:' })
    try {
      const runId = db.insertRun({
        name: 'kind check',
        status: 'passed',
        duration: 1,
        startedAt: '2026-08-01T00:00:00.000Z',
        endedAt: '2026-08-01T00:00:01.000Z',
      })
      // The control first: the kind the product DOES mint is accepted, so the refusals below are
      // refusals of these two values and not of every write.
      db.insertRunArtifact({ runId, kind: 'test' })
      expect(db.getRunArtifact(runId)?.kind).toBe('test')

      for (const kind of RETIRED_ARTIFACT_KINDS) {
        const refusedRunId = db.insertRun({
          name: `refused ${kind}`,
          status: 'passed',
          duration: 1,
          startedAt: '2026-08-01T00:00:00.000Z',
          endedAt: '2026-08-01T00:00:01.000Z',
        })
        expect(() => db.insertRunArtifact({ runId: refusedRunId, kind: kind as never }))
          .toThrow(`Run artifact ${refusedRunId} was not created`)
        expect(db.getRunArtifact(refusedRunId)).toBeNull()
      }
    } finally {
      db.close()
    }
  })

  it('a suite-shaped database serves the run list and the run detail with no link anywhere', async () => {
    const db = seedSuiteShapedDatabase()
    try {
      const router = buildRouter(db)

      const list = await probeRoute(router, '/api/runs')
      expect(list.status).toBe(200)
      const listBody = JSON.parse(list.body) as { runs: Array<Record<string, unknown>> }
      const row = listBody.runs.find((r) => r.id === PARENT_ID)
      expect(row, 'the suite run vanished from the run list').toBeTruthy()
      // The list used to attach a `tests` array walked off the link. It attaches nothing now, and
      // an absent key is the honest answer where a structurally empty array was a misleading one.
      expect(row).not.toHaveProperty('tests')

      const detail = await probeRoute(router, `/api/runs/${PARENT_ID}`)
      expect(detail.status).toBe(200)
      const detailBody = JSON.parse(detail.body) as Record<string, unknown>
      expect(Object.keys(detailBody)).toEqual(['run'])

      const artifact = await probeRoute(router, `/api/runs/${PARENT_ID}/artifact`)
      expect(artifact.status).toBe(200)
      const artifactBody = JSON.parse(artifact.body) as Record<string, unknown>
      expect(artifactBody).not.toHaveProperty('children')

      // The member logs are on the ONE run id, carrying the handle — no child walk required.
      const logs = await probeRoute(router, `/api/runs/${PARENT_ID}/execution-logs`)
      expect(logs.status).toBe(200)
      const logsBody = JSON.parse(logs.body) as { logs: Array<{ testIndex: number | null }> }
      expect(logsBody.logs.map((entry) => entry.testIndex).sort()).toEqual([0, 1])
    } finally {
      db.close()
    }
  }, 60_000)

  it('the superseded read arms are gone from the router, not merely unused', async () => {
    const db = seedSuiteShapedDatabase()
    try {
      const router = buildRouter(db)
      // 405-07 (D-03/D-14/D-19): each of these answered off a table or a path this census deleted.
      // A route that no longer exists is what a client should discover, so each is the router's
      // generic 404 — never a 200 with an empty body, which reads as "nothing happened here".
      for (const url of [
        `/api/runs/${PARENT_ID}/steps`,
        `/api/runs/${PARENT_ID}/steps/0/reasoning`,
        `/api/runs/${PARENT_ID}/logs`,
        `/api/runs/${PARENT_ID}/accessibility`,
        `/api/screenshots/${PARENT_ID}/shot.png`,
        `/api/videos/${PARENT_ID}/recording.webm`,
        '/api/execution/events',
        `/api/variables/captured/${PARENT_ID}`,
      ]) {
        const answer = await probeRoute(router, url)
        expect(answer.status, `${url} still answers ${String(answer.status)}`).toBe(404)
      }

      // The controls: the surviving arms on the same router still answer.
      expect((await probeRoute(router, `/api/runs/${PARENT_ID}`)).status).toBe(200)
      expect((await probeRoute(router, '/api/token-events/stats')).status).toBe(200)
      expect((await probeRoute(router, `/api/runs/${PARENT_ID}/execution-logs`)).status).toBe(200)
    } finally {
      db.close()
    }
  }, 60_000)

  it('deleting a run removes its rows and nothing beside them', async () => {
    const db = seedSuiteShapedDatabase()
    try {
      const router = buildRouter(db)
      const deleted = await probeRoute(router, `/api/runs/${PARENT_ID}`, { method: 'DELETE' })
      expect(deleted.status).toBe(200)
      expect(JSON.parse(deleted.body)).toEqual({ deleted: true, deletedRunIds: [PARENT_ID] })

      expect(db.getRun(PARENT_ID)).toBeUndefined()
      expect(db.getRunArtifact(PARENT_ID)).toBeNull()
      expect(db.readRunDetailRows(PARENT_ID)).toBeUndefined()
      expect(db.getExecutionLogs({ runId: PARENT_ID })).toEqual([])
    } finally {
      db.close()
    }
  }, 60_000)

  it('drives every production channel and reports which still mint parent/child run records', async () => {
    const findings = await walkProductionChannels()
    expect(findings.map((f) => f.channel).sort()).toEqual(PARENT_CHILD_PRODUCERS.slice().sort())
  }, 60_000)
})

describe('reconciliation — the two predicates meet in the register', () => {
  it('every surface names only registered sites', () => {
    const registered = new Set(DEBRIS_REGISTER.map(siteKey))
    for (const surface of DEBRIS_SURFACES) {
      for (const site of surface.sites) {
        expect(registered.has(site), `${surface.id} names an unregistered site: ${site.split(' ').join(' | ')}`).toBe(true)
      }
    }
  })

  it('every producer surface the walk can reach is registered with a disposition', async () => {
    const findings = await walkProductionChannels()
    const registeredProducers = new Set(
      DEBRIS_SURFACES.filter((s) => s.kind === 'producer').map((s) => s.id),
    )
    for (const finding of findings) {
      expect(registeredProducers.has(finding.channel), `unregistered producer: ${finding.channel}`).toBe(true)
    }
  }, 60_000)

  it('every delete-dispositioned site is justified by an observed surface, or says why it cannot be', () => {
    const namedByDeletingSurface = new Set(
      DEBRIS_SURFACES.filter((s) => s.disposition === 'delete').flatMap((s) => s.sites),
    )
    const unobserved = DEBRIS_REGISTER
      .filter((e) => e.disposition === 'delete')
      .filter((e) => !namedByDeletingSurface.has(siteKey(e)))
      .map((e) => `${e.file} | ${e.token} | ${e.line}`)
    expect(unobserved.sort()).toEqual(UNOBSERVABLE_DELETES.slice().sort())
  })

  it('no parent/child producer survives — the D-11 headline, measured', async () => {
    const findings = await walkProductionChannels()
    if (CENSUS_PHASE === 'before') {
      // Task 1 commits the register BEFORE the deletion, so the headline is not yet true. The cell
      // states what it is measuring rather than asserting a claim the tree does not yet support.
      expect(findings.length).toBeGreaterThan(0)
      return
    }
    expect(findings, `surviving producers: ${JSON.stringify(findings)}`).toEqual([])
  }, 60_000)
})

describe('the historical-row argument is retired, by name (405-07, D-02 · T-402-29)', () => {
  const roots: string[] = []
  afterAll(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  // 402-09's T-402-29 mitigation was "historical rows still render": every parent-link read was
  // kept, and a cell drove the run list, the run detail and the artifact door against a seeded
  // operator database to prove it. The mitigation was correct for its phase and is now MOOT rather
  // than abandoned — the two cells below say why in the terms the mitigation was written in.
  it('a database written before v2 is REFUSED by name, so no pre-405 row is ever rendered', () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-qa-census-'))
    roots.push(root)
    const file = join(root, 'runs.db')
    const raw = createDashboardSqliteDatabase(file)
    try {
      raw.pragma('user_version = 1')
    } finally {
      raw.close()
    }

    // 2026-10-16 (442-01, D-03): the refusal names the file and its version.
    expect(() => new DashboardDatabase({ dbPath: file }))
      .toThrow(`${file} was written by an older agent-qa (runs database version 1)`)
  })

  it('the retired artifact kinds are no longer writable — the union member is unreachable breadth', () => {
    const db = new DashboardDatabase({ dbPath: ':memory:' })
    try {
      const id = db.insertRun({
        name: 'historical shape',
        status: 'passed',
        duration: 1,
        startedAt: '2026-08-01T00:00:00.000Z',
        endedAt: '2026-08-01T00:00:01.000Z',
      })
      for (const kind of RETIRED_ARTIFACT_KINDS) {
        expect(() => db.insertRunArtifact({ runId: id, kind: kind as never })).toThrow()
      }
      // The TYPE still admits them (405-11 owns the UI-side narrowing), which is why this is a
      // recorded disposition rather than a survival: the STORE is what refuses.
      db.insertRunArtifact({ runId: id, kind: 'test' })
      expect(db.getRunArtifact(id)?.kind).toBe('test')
    } finally {
      db.close()
    }
  })
})

// ---------------------------------------------------------------------------------------------
// THE MEASURED SETS — the census's expectations for the tree as it stands
//
// These are EQUALITIES against measured sets, never bare zeroes over unfiltered files (T-402-31):
// while keeps exist the cells cannot be vacuous, and any NEW reference or reintroduced producer
// reds them. `CENSUS_PHASE` says which column of the register the lexical arm is measured against;
// the D-11 deletion flips it, and every constant below, in one auditable diff.
// ---------------------------------------------------------------------------------------------

/** `before` = the tree as 402-08 left it. `after` = the tree the deletion produces. */
const CENSUS_PHASE: 'before' | 'after' = 'after'

// 2026-08-27 (405-07, D-02): the two link-reader sets that stood here are gone with the
// differential that discovered them. `QUEUE_LINK_READERS` was already empty; `ROUTE_LINK_READERS`
// named the five routes whose response or database effect depended on the parent link, and every
// one of those dependencies was deleted with the column. A set expected to be empty, computed by a
// walk whose discriminator no longer exists, would be green for the wrong reason — so the claim is
// made structurally instead (predicate B's first cell), where re-adding the column is what reds.

/** Channels that still mint parent/child run records. */
const PARENT_CHILD_PRODUCERS: readonly string[] = []

/** Delete-dispositioned sites no behavioural surface can reach, each with its reason recorded. */
const UNOBSERVABLE_DELETES: readonly string[] = [
  // 2026-08-28 (405-11): the four `RunArtifactKind` union arms. A TYPE has no behavioural surface
  // to observe — no request can make a union member appear — so their deletion is measured
  // lexically (predicate A) rather than by a probe. 405-07 deleted the STORE's admission of both
  // values, which is the behavioural half, and its own surface still records that.
  "packages/dashboard-ui/src/lib/api.ts | suite-child | export type RunArtifactKind = 'test' | 'suite-parent' | 'suite-child' | 'unknown'",
  "packages/dashboard-ui/src/lib/api.ts | suite-parent | export type RunArtifactKind = 'test' | 'suite-parent' | 'suite-child' | 'unknown'",
  "packages/schema/src/run/run-artifact.ts | suite-child | export type RunArtifactKind = 'test' | 'suite-parent' | 'suite-child' | 'unknown'",
  "packages/schema/src/run/run-artifact.ts | suite-parent | export type RunArtifactKind = 'test' | 'suite-parent' | 'suite-child' | 'unknown'",
  "packages/cli/src/commands/run.ts | getRunsByParent | const children = activeSuiteDb.getRunsByParent(run.id)",
  "packages/cli/src/commands/run.ts | suite-child | kind: 'test' | 'suite-parent' | 'suite-child'",
  "packages/cli/src/commands/run.ts | suite-child | }) as { artifact: Record<string, unknown> & { kind: 'test' | 'suite-parent' | 'suite-child' } }",
  "packages/cli/src/commands/run.ts | suite-child | }): { artifact: Record<string, unknown> & { kind: 'test' | 'suite-parent' | 'suite-child' } } {",
  "packages/cli/src/commands/run.ts | suite-parent | kind: 'suite-parent',",
  "packages/cli/src/commands/run.ts | suite-parent | kind: 'test' | 'suite-parent' | 'suite-child'",
  "packages/cli/src/commands/run.ts | suite-parent | }) as { artifact: Record<string, unknown> & { kind: 'test' | 'suite-parent' | 'suite-child' } }",
  "packages/cli/src/commands/run.ts | suite-parent | }): { artifact: Record<string, unknown> & { kind: 'test' | 'suite-parent' | 'suite-child' } } {",
  'packages/dashboard-server/src/server/server.ts | getRunsByParent | const children = db.getRunsByParent(run.id)',
  'packages/dashboard-server/src/server/server.ts | getRunsByParent | const children = db.getRunsByParent(runId)',
  'packages/dashboard-server/src/server/server.ts | getRunsByParent | const updatedChildren = db.getRunsByParent(runId)',
]
