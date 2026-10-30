// Pure: every input arrives as data and `now` is an argument, so each threshold pins without flake.

import {
  CURRENT_QUARANTINE_LEDGER_SCHEMA_VERSION,
  QUARANTINE_UNASSIGNED_OWNER,
  VERDICT_CLASSES,
} from '@vostride/agent-qa-schema'
import type {
  QuarantineEntryState,
  QuarantineLedgerEvent,
  QuarantineOwner,
  Verdict,
  VerdictClass,
} from '@vostride/agent-qa-schema'

// The identity key lives in a zero-import leaf, because three sites key on it.
import { quarantineIdentityKey } from './identity.js'
import type { QuarantineIdentity } from './identity.js'

// §7.3's locked window is spelled ONCE, beside the table it slides over. Re-exported here because
// the ladder's own contract is incomplete without it, and a second declaration is how a threshold
// and the window it is counted against drift apart.
export { QUARANTINE_WINDOW_ORDINALS } from '../projection/fingerprint-window-read.js'

// Distinct occurrence ordinals, not runs, at which a fingerprint is flagged as suspected flaky.
export const QUARANTINE_FLAG_FLOOR = 2

// The same fingerprint at this many distinct ordinals inside the window escalates.
export const QUARANTINE_ESCALATE_THRESHOLD = 3

// Per-run cap on floor-arm entries; overflow escalates and may enter on the next applied run.
export const QUARANTINE_FLOOR_AUTO_QUARANTINE_CAP = 2

// Consecutive passing distinct build ordinals that release a test; within `LAST_OUTCOMES_LIMIT`.
export const QUARANTINE_AUTO_EXIT_PASSES = 5

// A review cadence, not a cap: a still-crossing fingerprint re-enters with a fresh deadline.
export const QUARANTINE_DEFAULT_EXPIRY_DAYS = 30

/** What escalation does with a verdict class. */
export type QuarantineDisposition = 'auto-quarantine' | 'escalate-only'

// `satisfies Record<VerdictClass, …>` makes a ninth verdict class a compile error here.
export const QUARANTINE_CLASS_DISPOSITIONS = {
  flake: 'auto-quarantine',
  environment: 'auto-quarantine',
  timeout: 'auto-quarantine',
  app_bug: 'escalate-only',
  test_bug: 'escalate-only',
  config_error: 'escalate-only',
  llm_error: 'escalate-only',
  unknown: 'escalate-only',
} as const satisfies Record<VerdictClass, QuarantineDisposition>

// Derived from the disposition table, so the set and the table cannot disagree about a class.
export const AUTO_QUARANTINE_CLASSES: readonly VerdictClass[] = VERDICT_CLASSES.filter(
  (name) => QUARANTINE_CLASS_DISPOSITIONS[name] === 'auto-quarantine',
)

// Never sufficient alone: the floor arm also needs the crossing's own `sameBuildPassAndFail`.
export type QuarantineFloorEligibility = 'floor-eligible' | 'authored-required'

// This table licenses a class; the per-run cap, not this table, bounds run-scoped fan-out.
export const QUARANTINE_FLOOR_ELIGIBILITY = {
  flake: 'floor-eligible',
  environment: 'authored-required',
  timeout: 'floor-eligible',
  app_bug: 'authored-required',
  test_bug: 'authored-required',
  config_error: 'authored-required',
  llm_error: 'authored-required',
  unknown: 'authored-required',
} as const satisfies Record<VerdictClass, QuarantineFloorEligibility>

// The cap counts floor admissions and exempts authored ones, so the arm must be named.
type QuarantineAdmission = 'authored' | 'floor' | 'refused'

// The floor needs both: class alone admits a hung `timeout`, signature alone an `environment`.
function autoQuarantines(failure: QuarantineDetectionFailure): QuarantineAdmission {
  if (QUARANTINE_CLASS_DISPOSITIONS[failure.verdictClass] !== 'auto-quarantine') return 'refused'
  if (failure.producer === 'analyze-run') return 'authored'
  return QUARANTINE_FLOOR_ELIGIBILITY[failure.verdictClass] === 'floor-eligible'
    && failure.sameBuildPassAndFail
    ? 'floor'
    : 'refused'
}

// A crossing names its test, so identity rides with the fingerprint, which recurrence keys on.
export interface QuarantineDetectionFailure {
  product: string
  filePath: string
  testName: string
  fingerprint: string
  verdictClass: VerdictClass
  // Only the crossing run's producer: that run authors the `entered` line the entry rests on.
  producer: Verdict['producer']
  // Required, so `tsc` finds every construction site; scoped to the crossing's recurrence window.
  sameBuildPassAndFail: boolean
  /** DISTINCT build ordinals inside the window carrying this fingerprint. */
  occurrenceOrdinals: number
  /** DISTINCT build ordinals inside the window carrying ANY failure — the honest denominator. */
  windowOrdinals: number
}

/** One recorded outcome, ordinal-keyed. Mirrors the projection's per-test outcome window entry. */
export interface QuarantineOrdinalOutcome {
  buildOrdinal: number
  passed: boolean
}

/** One quarantined test's recent outcome window — the auto-exit's only input. */
export interface QuarantineDetectionTestWindow {
  product: string
  filePath: string
  testName: string
  /** May carry several entries per ordinal (two runs in one build); order is irrelevant. */
  ordinals: readonly QuarantineOrdinalOutcome[]
}

export interface EvaluateQuarantineDetectionInput {
  failures: readonly QuarantineDetectionFailure[]
  testWindows: readonly QuarantineDetectionTestWindow[]
  /** The ledger folded against this same `now` — the suppression and exit input. */
  entries: readonly QuarantineEntryState[]
  /** ISO-8601 instant. The ONLY way wall clock enters this rule. */
  now: string
}

/** A crossing the caller must SHOW: flagged, or escalated-and-deliberately-not-quarantined. */
export interface QuarantineDetectionSighting {
  product: string
  filePath: string
  testName: string
  fingerprint: string
  verdictClass: VerdictClass
  // Rendered on the withheld line; it cannot show a crossing refused only by a spent cap.
  producer: Verdict['producer']
  occurrenceOrdinals: number
  windowOrdinals: number
}

export interface QuarantineDetectionResult {
  /** Lifecycle events to append, entered-then-released, each group identity-sorted. */
  events: QuarantineLedgerEvent[]
  /** At the flag floor: suspected flaky, no state change, no ledger write. */
  flagged: QuarantineDetectionSighting[]
  /** Escalated but class-gated away from auto-quarantine — the build keeps failing. */
  escalatedNotQuarantined: QuarantineDetectionSighting[]
}

const MS_PER_DAY = 86_400_000

/** The subsystem's one ordering rule: code-unit order, total and the same under every locale. */
export function compareQuarantineIdentity(
  left: QuarantineIdentity,
  right: QuarantineIdentity,
): number {
  return compareBytes(quarantineIdentityKey(left), quarantineIdentityKey(right))
}

// Code units, not `localeCompare`: one locale-aware leg makes the whole chain host-dependent.
function compareBytes(left: string, right: string): number {
  if (left === right) return 0
  return left < right ? -1 : 1
}

function sighting(failure: QuarantineDetectionFailure): QuarantineDetectionSighting {
  return {
    product: failure.product,
    filePath: failure.filePath,
    testName: failure.testName,
    fingerprint: failure.fingerprint,
    verdictClass: failure.verdictClass,
    producer: failure.producer,
    occurrenceOrdinals: failure.occurrenceOrdinals,
    windowOrdinals: failure.windowOrdinals,
  }
}

/**
 * The deadline an auto-entry is licensed for. Derived from the SUPPLIED instant — `Date.parse` of a
 * caller's argument is arithmetic, not a clock read. An unparseable `now` is a caller bug, so it
 * surfaces as a thrown RangeError from `toISOString` rather than silently minting a forever entry.
 */
function expiryFrom(now: string): string {
  return new Date(Date.parse(now) + QUARANTINE_DEFAULT_EXPIRY_DAYS * MS_PER_DAY).toISOString()
}

// Two runs in one build are one ordinal; entry and exit share this so they cannot disagree.
function groupByBuildOrdinal(
  ordinals: readonly QuarantineOrdinalOutcome[],
): { buildOrdinal: number; anyPassed: boolean; anyFailed: boolean }[] {
  const byOrdinal = new Map<number, { anyPassed: boolean; anyFailed: boolean }>()
  for (const entry of ordinals) {
    const seen = byOrdinal.get(entry.buildOrdinal) ?? { anyPassed: false, anyFailed: false }
    if (entry.passed) seen.anyPassed = true
    else seen.anyFailed = true
    byOrdinal.set(entry.buildOrdinal, seen)
  }
  return [...byOrdinal.entries()]
    .map(([buildOrdinal, seen]) => ({ buildOrdinal, ...seen }))
    .sort((a, b) => a.buildOrdinal - b.buildOrdinal)
}

// A mixed ordinal counts as not passed, so a same-build pass and fail can never buy an exit.
function distinctOrdinalOutcomes(
  window: QuarantineDetectionTestWindow,
): { buildOrdinal: number; passed: boolean }[] {
  return groupByBuildOrdinal(window.ordinals)
    .map(({ buildOrdinal, anyFailed }) => ({ buildOrdinal, passed: !anyFailed }))
}

// The fold scopes the window to the crossing's recurrence window; change both sites together.
export function hasSameBuildPassAndFail(
  ordinals: readonly QuarantineOrdinalOutcome[],
): boolean {
  return groupByBuildOrdinal(ordinals).some((entry) => entry.anyPassed && entry.anyFailed)
}

// The M most recent distinct ordinals exist and every one passed.
function releasesOnPasses(window: QuarantineDetectionTestWindow): boolean {
  const ordinals = distinctOrdinalOutcomes(window)
  if (ordinals.length < QUARANTINE_AUTO_EXIT_PASSES) return false
  return ordinals
    .slice(-QUARANTINE_AUTO_EXIT_PASSES)
    .every((entry) => entry.passed)
}

// `expired` keeps the prior owner; `released` reopens as unassigned. Same rule as the renew arm.
function ownerForAutoEntry(prior: QuarantineEntryState | undefined): QuarantineOwner {
  if (prior === undefined) return QUARANTINE_UNASSIGNED_OWNER
  switch (prior.state) {
    case 'expired':
      return prior.owner
    case 'released':
    case 'quarantined':
      return QUARANTINE_UNASSIGNED_OWNER
  }
}

// Ledger order is entered then released-auto, each sorted by a total code-unit identity comparator.
export function evaluateQuarantineDetection(
  input: EvaluateQuarantineDetectionInput,
): QuarantineDetectionResult {
  const activeKeys = new Set(
    input.entries
      .filter((entry) => entry.state === 'quarantined')
      .map((entry) => quarantineIdentityKey(entry)),
  )
  // A SECOND lookup, over ALL entries. `activeKeys` deliberately holds only the suppressing ones,
  // and a re-entry by definition has none — so the set that answers "is this test already
  // quarantined" cannot also answer "did somebody claim this test's last window".
  const priorByKey = new Map(
    input.entries.map((entry) => [quarantineIdentityKey(entry), entry] as const),
  )

  const flagged: QuarantineDetectionSighting[] = []
  const escalatedNotQuarantined: QuarantineDetectionSighting[] = []
  const entered: QuarantineLedgerEvent[] = []
  const expiresAt = expiryFrom(input.now)
  // PER CALL, and a call is one run's fold — which is what makes the cap PER RUN. Declaring it in
  // module scope instead would satisfy every single-evaluation assertion in the corpus while
  // silently turning this into a PROCESS-LIFETIME cap, under which the third genuine flake in a
  // project is never auto-quarantined again for the life of the daemon. The two-call drain leg in
  // detection.test.ts is the discriminator that reds if this declaration ever moves.
  let floorAdmissions = 0

  for (const failure of [...input.failures].sort(
    // Both legs compare code units, so the chain stays host-independent.
    (a, b) => compareQuarantineIdentity(a, b) || compareBytes(a.fingerprint, b.fingerprint),
  )) {
    // An already-suppressed test needs neither a flag nor an escalation: it is already quarantined,
    // which is louder than either. Checked before the ladder so the whole rung is a no-op.
    if (activeKeys.has(quarantineIdentityKey(failure))) continue

    if (failure.occurrenceOrdinals >= QUARANTINE_ESCALATE_THRESHOLD) {
      const admission = autoQuarantines(failure)
      // The cap counts FLOOR admissions only. Beyond it a floor-admissible crossing routes to
      // `escalatedNotQuarantined` exactly as a class-refused one does: build still failing,
      // identity visible, admitted on a later evaluation once the earlier ones are suppressing.
      const capped = admission === 'floor'
        && floorAdmissions >= QUARANTINE_FLOOR_AUTO_QUARANTINE_CAP
      if (admission !== 'refused' && !capped) {
        if (admission === 'floor') floorAdmissions += 1
        entered.push({
          schemaVersion: CURRENT_QUARANTINE_LEDGER_SCHEMA_VERSION,
          kind: 'entered',
          at: input.now,
          product: failure.product,
          filePath: failure.filePath,
          testName: failure.testName,
          fingerprint: failure.fingerprint,
          verdictClass: failure.verdictClass,
          owner: ownerForAutoEntry(priorByKey.get(quarantineIdentityKey(failure))),
          expiresAt,
        })
      } else {
        escalatedNotQuarantined.push(sighting(failure))
      }
      continue
    }
    if (failure.occurrenceOrdinals >= QUARANTINE_FLAG_FLOOR) flagged.push(sighting(failure))
  }

  const windowsByKey = new Map(
    input.testWindows.map((window) => [quarantineIdentityKey(window), window] as const),
  )
  const released: QuarantineLedgerEvent[] = []
  for (const entry of [...input.entries].sort(compareQuarantineIdentity)) {
    // Lapsed entries are still listed, so they release too; the fold's exit filter must match.
    if (entry.state === 'released') continue
    const window = windowsByKey.get(quarantineIdentityKey(entry))
    if (window === undefined || !releasesOnPasses(window)) continue
    released.push({
      schemaVersion: CURRENT_QUARANTINE_LEDGER_SCHEMA_VERSION,
      kind: 'released-auto',
      at: input.now,
      product: entry.product,
      filePath: entry.filePath,
      testName: entry.testName,
    })
  }

  return { events: [...entered, ...released], flagged, escalatedNotQuarantined }
}
