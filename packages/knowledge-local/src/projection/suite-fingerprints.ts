// The suite-fingerprint table: gate 3's comparison substrate.
//
// A SIBLING of `run-outcomes.ts` inside the same derived-index discipline, not a new store. It
// lives in the gitignored index, is computed at the SAME post-run fold from the SAME handoff
// evidence, is keyed by the project-wide stable test identity (`filePath` + `testName`, never
// `testId`), and is reproduced byte-identically by the rebuild — which is why bumping
// `RUN_OUTCOMES_PROJECTION_VERSION` IS this table's migration (L12: derived state is disposable).
//
// WHAT A ROW IS. One `(product, filePath, testName, seq)` row per fingerprint element, where the
// element bytes are minted by schema's `actionAnchorElement` (D-13's v1 recipe). No element
// serialization exists in this package: a second spelling of "what is the same exercised surface"
// is exactly what the sibling-recipe design in `verdict/action-anchor-fingerprint.ts` exists to
// prevent, and gate 3 compares a draft's elements against these bytes.
//
// WHY THE ROWS CARRY `run_id` AND `build_ordinal`. "Latest evidence wins" has to mean something
// order-independent, or the incremental fold and the rebuild would disagree the moment two runs
// arrived in a different order than the rebuild scans them in (the rebuild sorts run dirs by
// name). The replacement rule is therefore a COMPARISON — a fold replaces an identity's rows only
// when its `(buildOrdinal, runId)` is strictly greater than what the table already holds — rather
// than a last-writer-wins overwrite. That makes the table CONVERGENT: any permutation of the same
// runs, and a full rebuild over them, land on the same rows. It is also why re-applying one run is
// a no-op without needing the applied-runs marker to make it one.
//
// THE EXCLUSION (WTST-06, Pitfall 8). A gate-run handoff must never seed the union it is later
// compared against — a draft would then be measured against its own evidence and every element
// would read as already covered. The production path enforces this WITHOUT a second read: the one
// `excludedFromOutcomes` read in `projectRunOutcomes` gates ONE member list, and both the outcome
// deltas and the fingerprint deltas are computed from that already-gated list. The standalone
// `foldSuiteFingerprints` door below takes the same decision as an argument for the same reason —
// this module does not re-decide a fact the fold already established.

import type { DatabaseSync } from 'node:sqlite'

import { testFingerprintElements } from '@vostride/agent-qa-schema'
import type { CompletedRunHandoff, PerTestOutcome } from '@vostride/agent-qa-schema'

import { ensureRunOutcomeTables } from '../index-open.js'

/** The one table name, so the read port and every writer cannot spell it apart. */
export const SUITE_FINGERPRINTS_TABLE = 'suite_fingerprints'

/**
 * The element walk, re-exported from its home in `schema`.
 *
 * It lived here until gate 3's DRAFT side became its second reader. `agent` names neither this
 * package nor `core` and never will, so a walk that stayed here could only have been mirrored on
 * the draft side — and a mirrored recipe is two recipes, free to disagree the first time either
 * is retuned. Its own doc comment already promised that "the draft's own fingerprint is computed
 * by this same function at the consumer"; moving it is what makes that sentence true rather than
 * aspirational. `ASSERT_ACTION_TYPES` moved with it on the trigger its comment named.
 *
 * Re-exported rather than dropped because this module is where the fold's readers look for it,
 * and the package barrel already publishes the name.
 */
export { testFingerprintElements }

/** One test's ordered fingerprint elements, keyed by the stable identity. */
export interface SuiteFingerprintTestDelta {
  filePath: string
  testName: string
  /** `actionAnchorElement` bytes, in exercised order. Never empty — see `testFingerprint`. */
  elements: string[]
}

/** The row set one run contributes, plus the provenance the replacement rule compares on. */
export interface SuiteFingerprintsProjection {
  product: string
  runId: string
  buildOrdinal: number
  tests: SuiteFingerprintTestDelta[]
}

export interface FoldSuiteFingerprintsOptions {
  /**
   * The projection partition — `projectionPartition(handoff.scope).product`. Supplied by the
   * caller so this module never re-spells the partition law that `run-outcomes.ts` owns (and so
   * the two modules do not have to import each other).
   */
  product: string
  /**
   * The `excludedFromOutcomes` decision, CARRIED rather than re-read. See the exclusion note in
   * this module's header: a gate-run contributes no rows.
   */
  excluded: boolean
}

/**
 * The per-identity deltas for a member list (pure).
 *
 * Takes MEMBERS rather than a handoff because the production caller has already applied the one
 * exclusion gate to them — see the exclusion note in the header. A test contributing zero
 * elements yields no delta at all, which is what stops an evidence-less run from ERASING an
 * identity's accumulated coverage: the union only ever moves through evidence.
 */
export function suiteFingerprintDeltas(
  members: readonly PerTestOutcome[],
): SuiteFingerprintTestDelta[] {
  const byIdentity = new Map<string, SuiteFingerprintTestDelta>()
  for (const member of members) {
    const elements = testFingerprintElements(member)
    if (elements.length === 0) continue
    // Within ONE run the same identity can appear more than once (a retried member). Later
    // evidence inside a single handoff wins, matching the cross-run rule below.
    byIdentity.set(`${member.filePath}\u0000${member.testName}`, {
      filePath: member.filePath,
      testName: member.testName,
      elements,
    })
  }
  return [...byIdentity.values()]
}

interface ExistingProvenance {
  build_ordinal: number
  run_id: string
}

/**
 * Whether incoming evidence supersedes what the table holds for one identity.
 *
 * Strictly greater, with `runId` as the tiebreak inside one build ordinal, so the answer does not
 * depend on which run folded first. Equality is deliberately NOT a supersession: re-applying the
 * same run rewrites nothing.
 */
function supersedes(
  incoming: { buildOrdinal: number; runId: string },
  existing: ExistingProvenance | undefined,
): boolean {
  if (existing === undefined) return true
  if (incoming.buildOrdinal !== existing.build_ordinal) {
    return incoming.buildOrdinal > existing.build_ordinal
  }
  return incoming.runId > existing.run_id
}

/**
 * Writer against the one index connection.
 *
 * Deliberately opens NO transaction of its own. On the production path it runs inside
 * `applyRunOutcomes`'s `BEGIN IMMEDIATE`, so the fingerprint rows and the outcome counters commit
 * or roll back together and the two tables can never describe different runs; SQLite has no
 * nested transactions, so a second `BEGIN IMMEDIATE` here would fail exactly on that path. Called
 * standalone it rides autocommit, which is sound because the replacement rule is convergent.
 */
export function applySuiteFingerprints(
  db: DatabaseSync,
  projection: SuiteFingerprintsProjection,
): number {
  const readProvenance = db.prepare(`
    SELECT build_ordinal, run_id
    FROM ${SUITE_FINGERPRINTS_TABLE}
    WHERE product = ? AND file_path = ? AND test_name = ?
    LIMIT 1
  `)
  const clearIdentity = db.prepare(`
    DELETE FROM ${SUITE_FINGERPRINTS_TABLE}
    WHERE product = ? AND file_path = ? AND test_name = ?
  `)
  const insertElement = db.prepare(`
    INSERT INTO ${SUITE_FINGERPRINTS_TABLE} (
      product, file_path, test_name, seq, element, run_id, build_ordinal
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `)

  let written = 0
  for (const test of projection.tests) {
    const existing = readProvenance.get(projection.product, test.filePath, test.testName) as
      | ExistingProvenance
      | undefined
    if (!supersedes(projection, existing)) continue
    clearIdentity.run(projection.product, test.filePath, test.testName)
    for (const [seq, element] of test.elements.entries()) {
      insertElement.run(
        projection.product,
        test.filePath,
        test.testName,
        seq,
        element,
        projection.runId,
        projection.buildOrdinal,
      )
      written += 1
    }
  }
  return written
}

/**
 * The standalone fold door: project one handoff's fingerprints and write them.
 *
 * The production path does NOT come through here — it folds both projections in one pass through
 * `projectRunOutcomes`/`applyRunOutcomes` so a single transaction and a single applied-runs marker
 * cover both tables. This entry exists for callers that hold a handoff and want only the
 * fingerprint half (the gate evaluator's own harness, and this module's corpus).
 */
export function foldSuiteFingerprints(
  db: DatabaseSync,
  handoff: CompletedRunHandoff,
  opts: FoldSuiteFingerprintsOptions,
): SuiteFingerprintsProjection {
  ensureRunOutcomeTables(db)
  const projection: SuiteFingerprintsProjection = {
    product: opts.product,
    runId: String(handoff.runId),
    buildOrdinal: handoff.buildOrdinal,
    tests: suiteFingerprintDeltas(opts.excluded ? [] : (handoff.tests ?? [])),
  }
  applySuiteFingerprints(db, projection)
  return projection
}

/**
 * The read port gate 3 consumes through composition.
 *
 * MINIMAL BY DESIGN. Conservatism lives in the normalizer, not here: this port answers
 * what the table holds and nothing more, so a later retune of "near-same elements normalize
 * equal" moves in exactly one place. There is no similarity verb here because there is no
 * similarity threshold to defend — gate 3's value test is set membership, spec §6.3 verbatim.
 */
export interface SuiteFingerprintIndex {
  /** The union D-14's novel-element test compares against. Empty table, empty union. */
  elementUnion(): Set<string>
  /**
   * The identities that HAVE fingerprint rows, sorted. The consumer subtracts these from the
   * authored-test universe to derive the evidence-less set that rides D-16's text lane — which is
   * why this port reports coverage rather than trying to enumerate the suite, a fact it does not
   * own and could only guess at.
   */
  coveredTests(): Array<{ filePath: string; testName: string }>
  /** One identity's elements in exercised order; `[]` for an identity with no rows. */
  elementsForTest(filePath: string, testName: string): string[]
}

export interface SuiteFingerprintIndexOptions {
  /**
   * The partition to read. REQUIRED rather than optional: an unscoped union would compare a draft
   * against another product's suite, and "everything in the table" is never the question gate 3 is
   * asking.
   */
  product: string
}

export function createSuiteFingerprintIndex(
  db: DatabaseSync,
  opts: SuiteFingerprintIndexOptions,
): SuiteFingerprintIndex {
  return {
    elementUnion() {
      const rows = db.prepare(`
        SELECT DISTINCT element FROM ${SUITE_FINGERPRINTS_TABLE} WHERE product = ?
      `).all(opts.product) as unknown as Array<{ element: string }>
      return new Set(rows.map((row) => row.element))
    },
    coveredTests() {
      const rows = db.prepare(`
        SELECT DISTINCT file_path, test_name FROM ${SUITE_FINGERPRINTS_TABLE}
        WHERE product = ?
        ORDER BY file_path, test_name
      `).all(opts.product) as unknown as Array<{ file_path: string; test_name: string }>
      return rows.map((row) => ({ filePath: row.file_path, testName: row.test_name }))
    },
    elementsForTest(filePath: string, testName: string) {
      const rows = db.prepare(`
        SELECT element FROM ${SUITE_FINGERPRINTS_TABLE}
        WHERE product = ? AND file_path = ? AND test_name = ?
        ORDER BY seq
      `).all(opts.product, filePath, testName) as unknown as Array<{ element: string }>
      return rows.map((row) => row.element)
    },
  }
}
