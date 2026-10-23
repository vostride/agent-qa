// The detection ladder: the pure rule that turns fingerprint recurrence into quarantine lifecycle
// events (Phase 390, D-05/D-06/D-07/D-10/D-11/D-12).
//
// PURE BY CONSTRUCTION. Every input arrives as plain data — recurrence answers the projection
// already computed, per-test ordinal windows, the folded ledger state, and `now`. This module reads
// no clock, opens no database and touches no filesystem, which is what lets every threshold be
// pinned one step either side with zero flake. `expiresAt` is DERIVED from the supplied `now`
// (390-01's wall-clock-purity-by-argument pattern, extended from the fold to the rule that authors).
//
// THE LADDER (D-06). Flag early, act at N. A fingerprint at QUARANTINE_FLAG_FLOOR distinct
// occurrence ordinals is FLAGGED — visibility only, zero ledger bytes — and at
// QUARANTINE_ESCALATE_THRESHOLD it ESCALATES. "Flags and then escalates" is temporally real: one
// build of warning before anything changes.
//
// THE GATE IS TWO TOTAL TABLES OVER ONE CLOSED UNION (D-05, extended by 390-16). Escalation routes
// through QUARANTINE_CLASS_DISPOSITIONS and QUARANTINE_FLOOR_ELIGIBILITY, both keyed on the CLOSED
// eight-member VerdictClass union rather than a set membership test. That shape is deliberate: a
// ninth verdict class cannot compile until someone decides BOTH answers for it, so each gate's
// INPUT DOMAIN is enumerated, not just its outputs.
//
//  - DISPOSITION answers "may this class ever auto-quarantine". Only the three classes
//    `eval-and-core-types.md` §A9 routes to A3 may. The other five escalate LOUDLY and append
//    nothing.
//  - FLOOR ELIGIBILITY answers the axis the class set alone cannot express: is the EVIDENCE behind
//    the class about THIS TEST, or about the run? It is one of TWO conjuncts on the floor arm
//    (390-19): the class answers whether the floor may decide this KIND of thing at all, and the
//    crossing's `sameBuildPassAndFail` answers whether there is per-test evidence in THIS crossing.
//    A crossing carrying an AUTHORED `analyze-run` verdict needs neither, because a model reading
//    this test's evidence IS the per-test statement.
//
// AND THE FLOOR ARM IS BUDGETED PER RUN (390-19). Neither table contains mass auto-quarantine on
// the floor path and neither should be read as doing so — `classifyRootCause` returns `timeout`
// before it ever reads its health probe, so a run-scoped hang arrives in the class the floor may
// act on. QUARANTINE_FLOOR_AUTO_QUARANTINE_CAP budgets that arm per run. It RATE-LIMITS a fan-out
// and does not contain one — a refused member is admitted on the next applied run (measured;
// 390-28 / WR-02) — so nothing in this module bounds eventual entries. See its docstring.
//
// A crossing that either table refuses lands in `escalatedNotQuarantined` — the build keeps
// failing, because auto-silencing a real regression is the one outcome this phase exists to
// prevent. There is deliberately NO third arm: a refused crossing that goes nowhere is the
// anti-silencing defect wearing another hat.
//
// THE UPSTREAM SHARPENING THIS MODULE DELIBERATELY DOES NOT TAKE. `classifyRootCause`'s two
// run-scoped probe arms arguably should not mint a PER-TEST verdict at all — a down dependency is
// a run-level condition, closer to `config_error` — and fixing it there would be more correct and
// would help every verdict consumer, not just this one. But that rewrites phase 373's documented,
// pinned branch order, which is that module's contract and not this one's. Named here so the next
// reader knows the producer gate closes the MEASURED path rather than the root cause.
//
// WHY THE OTHER FIVE ARE ESCALATE-ONLY, individually:
//
//  - `app_bug` / `test_bug`: a real regression and a genuinely broken test. Humans quarantine
//    known-broken tests deliberately through the `add` verb (D-12); nothing here does it for them.
//  - `unknown`: the LLM-judge abstention AND the deterministic floor's answer for any failure
//    carrying no verdict at all. Auto-quarantining it would silence essentially every recurring
//    failure on a project running without analysis, which is the anti-silencing defect wearing a
//    different hat.
//  - `config_error`: the harness or project is misconfigured. Deterministic, fixable, and it will
//    not heal itself — suppressing it hides the one thing a human must act on.
//  - `llm_error`: our own model plumbing failed. That is evidence about the agent, never evidence
//    that the test is flaky.
//
// SERIALIZATION and EGRESS belong to the caller. This module returns events as data; the fold
// appends them through `appendQuarantineEvents`, inside the writer-lease scope, after the
// projection transaction has committed.
//
// 2026-09-02 (Phase 412): the curation spec these notes once cited left with the Issue-slot cleanup;
// the A3 routing lives in `eval-and-core-types.md` §A9 and the trigger in `memory.md` §9.5.

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

// The identity key and its input type live in the subsystem's zero-import leaf (390-31), not here:
// the ladder is only one of three keying sites, and hosting the key made every other site pay an
// import edge into this module. `compareQuarantineIdentity` below still composes it.
import { quarantineIdentityKey } from './identity.js'
import type { QuarantineIdentity } from './identity.js'

// §7.3's locked window is spelled ONCE, beside the table it slides over. Re-exported here because
// the ladder's own contract is incomplete without it, and a second declaration is how a threshold
// and the window it is counted against drift apart.
export { QUARANTINE_WINDOW_ORDINALS } from '../projection/fingerprint-window-read.js'

/**
 * Visibility floor (D-06): distinct occurrence ordinals at which a fingerprint becomes suspected
 * flaky. Pinned, never config — retune from operational evidence in this source, where the change
 * is reviewable.
 */
export const QUARANTINE_FLAG_FLOOR = 2

/**
 * `memory.md` §9.5's locked trigger, verbatim: the same fingerprint at three distinct ordinals
 * inside the window escalates. Pinned constant with no config key (386 D-15) — retune it here.
 */
export const QUARANTINE_ESCALATE_THRESHOLD = 3

/**
 * THE PER-RUN BUDGET for mass auto-quarantine on the FLOOR path (390-19 / G-390-5): at most this
 * many `entered` events may be authored on the floor arm in ONE `evaluateQuarantineDetection` call.
 * One call is one run's fold, so this is PER RUN — and PER RUN is the whole of it, which is why
 * this reads "budget" and not "containment" (390-28 / WR-02; see the measurement below).
 *
 * WHY A COUNT AND NOT A CLASS. 390-16's motivating observation was itself a count — one probe
 * failure auto-quarantined 6 of 6 tests in a suite — and it was read as a statement about the class
 * `environment`. That reading is unsound under `classifyRootCause`'s branch order: its
 * `outcome === 'timeout'` arm RETURNS before the `baselineProbe` arms that mint `environment`, so a
 * run-scoped hang arrives classed `timeout`. Every class the floor can mint on a FAILING member is
 * reachable from a run-scoped cause, so no class-based gate can contain fan-out. This constant
 * states the property directly instead of proxying it through class semantics.
 *
 * WHAT THIS CONSTANT ACTUALLY BUYS: A RATE LIMIT, NOT CONTAINMENT (390-28 / WR-02, correcting the
 * 390-19 text). Two claims stood here and both were false, in opposite directions:
 *
 *  1. IT WOULD NOT HAVE CAUGHT THE MOTIVATING EVENT — that event never reaches this counter. The
 *     measured 6-of-6 members classed `environment`, and `QUARANTINE_FLOOR_ELIGIBILITY.environment`
 *     is `authored-required`, so `autoQuarantines` answers `'refused'` for a floor-produced
 *     `environment` crossing one conjunct EARLIER; the cap is consulted only when that call answers
 *     `'floor'`. Zero entered lines for those six is the CLASS gate's doing, pinned by
 *     detection-fold.test.ts's "writes ZERO entered lines for six floor-produced environment
 *     failures". The `timeout` RE-DERIVATION of the same event — a run-scoped hang arriving in a
 *     floor-eligible class, per WHY A COUNT above — is INFERRED and has never been observed in the
 *     field; it is the reason the cap exists, not evidence that the cap caught anything.
 *  2. IT DOES NOT BOUND EVENTUAL ENTRIES. Measured 2026-08-06 at CAP=2 over a SUITE=6 fan-out: six
 *     floor-admissible crossings enter 2 / 2 / 2 across three consecutive evaluations and ALL SIX
 *     are quarantined by run 3. Each refused member is admitted on the next applied run with no
 *     human decision and no new evidence — which is exactly what OVERFLOW IS LOUD says below, so
 *     the retracted containment clause contradicted its own docstring a paragraph later.
 *     The first two evaluations of that shape now live in the corpus rather than only in a probe:
 *     detection-fold.test.ts's "the floor cap rate-limits a multi-member fan-out (390-28)" produces
 *     CAP + 1 floor admissions in ONE real fold, admits exactly CAP by identity order, and admits
 *     the refused member on the very next run.
 *
 * So the purchase is TIME AND VISIBILITY, per run: every crossing this counter refuses is one build
 * in which a human sees the identity in `escalatedNotQuarantined` with the build still red, before
 * anything silences it. That is worth having and it is all of it.
 *
 * WHY 2 SPECIFICALLY, on the half that survives. Strictly above 1, so the mechanism is not a de
 * facto single-shot and two genuinely independent flaky tests can still both land in one run. A run
 * asking to silence three or more tests on the floor's word alone is the shape of FAN-OUT, not of
 * independent flakiness — simultaneity is the signal a shared cause leaves. The number is a
 * per-run BUDGET on that shape, and 2 is where the budget was set; it is not derived from the
 * 6-of-6 observation, which the class gate already refuses.
 *
 * IT SHARES `QUARANTINE_FLAG_FLOOR`'s VALUE BY COINCIDENCE AND IS NOT DERIVED FROM IT. Said
 * explicitly so a later retune of the flag floor cannot silently move this number too. A pinned
 * constant with no config key (386 D-15); retune it here, on its own evidence.
 *
 * OVERFLOW IS LOUD, NEVER DROPPED. Past the cap an identity routes to `escalatedNotQuarantined`
 * with the build still failing — D-05's already-ratified posture for a class-gated refusal, applied
 * to a count-gated one. It crosses again on the next applied run and may be admitted THEN; one that
 * stops failing was never a quarantine candidate. Nothing is lost: the cap slows the floor path
 * down, it does not close it.
 *
 * THE AUTHORED ARM IS EXEMPT, DELIBERATELY. An authored verdict is per-test evidence by
 * construction — a model read THIS test's evidence and named its cause — so it does not carry the
 * hazard this cap defends against, which is a RUN-level signal being read as per-test. Capping it
 * would also silently regress the arm 390-16 shipped, on no measurement. THE HONEST RESIDUAL: an
 * authored run CAN still class many tests identically, so the authored path's fan-out is unchanged
 * by this round — stated, not closed (T-390-19-07, accepted).
 */
export const QUARANTINE_FLOOR_AUTO_QUARANTINE_CAP = 2

/**
 * D-10's exit: M consecutive PASSING distinct build ordinals release a quarantined test. Five is
 * symmetric with the detection window by design (~17% escape odds for a 30%-failure flake) and sits
 * inside LAST_OUTCOMES_LIMIT, so no window widening is needed. Retune from operational evidence.
 */
export const QUARANTINE_AUTO_EXIT_PASSES = 5

/**
 * D-11's default lifetime in days. On lapse suppression STOPS and the entry stays listed as
 * `expired`.
 *
 * This is a REVIEW CADENCE, not a cap, and the difference is the fact somebody retuning the number
 * most needs: a still-crossing fingerprint re-enters with a fresh `expiryFrom(now)` on the very
 * next fold, indefinitely and with no attenuation. Measured over four full cycles (2026-08-06): 4
 * `entered` lines, 4 distinct deadlines, 0 released, cycle 4 indistinguishable from cycle 1. So
 * raising this number lengthens the gap between red builds; it does not change how many there
 * eventually are. A human deadline in a human-reviewed file; retune from operational evidence,
 * never from config.
 */
export const QUARANTINE_DEFAULT_EXPIRY_DAYS = 30

/** What escalation does with a verdict class. */
export type QuarantineDisposition = 'auto-quarantine' | 'escalate-only'

/**
 * The class gate, as a TOTAL function over the closed verdict vocabulary (D-05).
 *
 * `satisfies Record<VerdictClass, QuarantineDisposition>` is the load-bearing part: adding a ninth
 * member to VERDICT_CLASSES makes this object a compile error until its quarantine disposition is
 * decided. A `Set` of three names would have compiled forever while silently treating every future
 * class as escalate-only by accident rather than by decision.
 */
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

/**
 * Exactly `eval-and-core-types.md` §A9's A3 routing, DERIVED from the disposition table rather
 * than spelled a second time (388 C13) — the set and the table can never disagree about a class.
 */
export const AUTO_QUARANTINE_CLASSES: readonly VerdictClass[] = VERDICT_CLASSES.filter(
  (name) => QUARANTINE_CLASS_DISPOSITIONS[name] === 'auto-quarantine',
)

/**
 * Whether the deterministic floor may decide this KIND of failure AT ALL. Never sufficient on
 * its own: since 390-19 the floor arm also requires the crossing's own `sameBuildPassAndFail`,
 * so no class auto-quarantines on the floor's word alone. The pre-390-19 gloss on this line said
 * otherwise and was the same false-reachability shape 390-25 removed from the corpus header.
 */
export type QuarantineFloorEligibility = 'floor-eligible' | 'authored-required'

/**
 * The SECOND total table over the same closed vocabulary (390-16, G-390-3).
 *
 * The disposition table above answers "may this class ever auto-quarantine". It cannot answer the
 * other question, because the answer is not a property of the class name: is the EVIDENCE behind
 * the class a statement about THIS TEST, or about the run it happened to be in? This table answers
 * that, and it is a table rather than `if (cls === 'environment' || cls === 'timeout')` for exactly
 * the reason D-05 gave for the first one — a rule stated over a subset of its own input domain
 * compiles forever while treating every future class as an accident. A ninth member of
 * VERDICT_CLASSES is a compile error here until someone decides its floor eligibility.
 *
 * This table is ONE OF TWO CONJUNCTS on the floor arm since 390-19. It licenses a CLASS; the
 * crossing's `sameBuildPassAndFail` supplies the per-test EVIDENCE. Neither alone may silence a
 * failing test on the deterministic floor's word.
 *
 * Per class, with the reasoning that decides it:
 *
 *  - `timeout` → FLOOR-ELIGIBLE (re-decided by 390-19 / G-390-5, and the row that carries the LIVE
 *    floor path). This row used to read authored-required because "exceeded the budget" is
 *    per-test but semantically THIN — as consistent with an infinite spinner as with flakiness.
 *    Thinness is exactly what a same-build pass∧fail cures: a test that passed and failed at the
 *    same build ordinal is flaky by direct observation, whatever the budget did. So `timeout` may
 *    now be decided on the floor's word PLUS the signature, and NEVER on the floor's word alone.
 *  - `environment` → AUTHORED-REQUIRED, on its own merits, unchanged. Two of its three arms are
 *    RUN-SCOPED probe reads (`baselineProbe.error !== undefined`, `baselineProbe.status >= 500`)
 *    that fire before any per-test signal. One down staging dependency classifies every failing
 *    member of a suite identically; the measured blast radius was 6 of 6 tests under one shared
 *    30-day deadline. A flapping dependency produces same-build pass∧fail across MANY tests at
 *    once, so the signature does not make a run-scoped observation per-test — read the branch-order
 *    paragraph below before treating this row as the containment, because it is not.
 *  - `flake` → FLOOR-ELIGIBLE on the class's own merits, AND THIS ROW DECIDES NOTHING. Say it out
 *    loud, because G-390-5 exists precisely because a row nobody could reach was described as the
 *    mechanism keeping FLAK-01 alive. `classifyRootCause` mints `flake` only inside its
 *    `outcome === 'passed' || outcome === 'healed'` arm — the test LITERALLY passed on retry, so
 *    the class IS the signature — but a member that passed carries no `failure` row
 *    (`projection/run-outcomes.ts`'s `...(passed ? {} : { failure })` spread) and a
 *    `QuarantineDetectionFailure` is built only from `test.failure`. So no crossing can carry class
 *    `flake` AND producer `deterministic-classifier`: every `flake` crossing the pipeline can build
 *    is authored, and is admitted by the FIRST disjunct. `timeout` is the row that is
 *    reachable-and-deciding on the floor path; this one is correct and inert.
 *  - THE FIVE ESCALATE-ONLY CLASSES → AUTHORED-REQUIRED. They never reach the auto-quarantine
 *    branch today, so this value is not observable — which is precisely why it is the strict one.
 *    It makes authored-required the DEFAULT for any future widening of the disposition table, so a
 *    later one-line class flip cannot silently also license the floor (T-390-16-04).
 *
 * THE BRANCH-ORDER FACT THAT KILLS THE CLASS-BASED CONTAINMENT, measured at HEAD against
 * `classifyRootCause` (`runner/src/run/root-cause.ts`). Its arms run in this order: the presence
 * rule, then the `passed || healed` arm that mints `flake`, then the `outcome === 'timeout'` arm —
 * WHICH RETURNS — and only THEN the `baselineProbe` reads that mint `environment`. So a hung or
 * flapping staging dependency does NOT arrive classed `environment` for the members that blew their
 * deadline: it arrives classed `timeout`, the class this table now licenses. The run-scoped
 * objection stated on the `environment` row above applies VERBATIM to those `timeout` members.
 *
 * DRAW THE CONCLUSION HERE RATHER THAN LEAVING IT TO BE INFERRED: every class the floor can mint on
 * a FAILING member (`timeout`, `environment`, `unknown`) is reachable from a RUN-SCOPED cause, so
 * THIS TABLE CANNOT BE THE CONTAINMENT FOR MASS AUTO-QUARANTINE AND MUST NOT BE READ AS ONE.
 * Keeping `environment` strict contains `environment`; it does not contain the hazard.
 * QUARANTINE_FLOOR_AUTO_QUARANTINE_CAP does — a per-run COUNT, which is the form 390-16's
 * motivating observation (one probe failure, 6 of 6 tests) actually took. A reader who inherits the
 * older framing — that `environment` is THE run-scoped class and `timeout` is the per-test one —
 * will re-derive exactly the defect this round closes: a true-sounding containment sentence about a
 * path the code does not take.
 *
 * WHY NOT flip the disposition table instead. That is wrong in both directions: it would disable
 * auto-quarantine for genuinely ANALYZED environment/timeout failures, and it would leave
 * floor-minted `flake` firing. The consistent rule — the one 390-05 already ratified once when it
 * made `unknown` escalate-only — is that a quarantine decision requires per-test EVIDENCE, and
 * `producer` plus `sameBuildPassAndFail` are what make that rule expressible.
 */
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

/**
 * WHICH ARM of the gate admitted a crossing, or that none did (390-19). A boolean was exactly the
 * information the per-run floor cap needs and cannot get: the cap counts FLOOR admissions and
 * exempts AUTHORED ones, so the ladder has to be able to tell them apart.
 */
type QuarantineAdmission = 'authored' | 'floor' | 'refused'

/**
 * Whether a crossing may author an `entered` line, and — since 390-19 — WHICH ARM admitted it.
 *
 * The disposition must be auto-quarantine, and then EITHER this crossing's verdict was AUTHORED,
 * OR the class is floor-eligible AND the crossing carries the per-test flake signature. Everything
 * else routes to `escalatedNotQuarantined` — loud, rendered, build still failing.
 *
 * TWO CONJUNCTS ON THE FLOOR ARM, DELIBERATELY, and each refuses something the other admits:
 *
 *  - The CLASS conjunct alone admits a floor-produced `timeout` from a run-scoped hang with no
 *    per-test evidence behind it at all. That is 390-16's shape, and it is what the signature
 *    refuses.
 *  - The SIGNATURE conjunct alone admits a floor-produced `environment` — a class whose evidence is
 *    a health probe, where a flapping dependency stamps the same-build pass∧fail across many tests
 *    at once. That is what the class conjunct refuses.
 */
function autoQuarantines(failure: QuarantineDetectionFailure): QuarantineAdmission {
  if (QUARANTINE_CLASS_DISPOSITIONS[failure.verdictClass] !== 'auto-quarantine') return 'refused'
  if (failure.producer === 'analyze-run') return 'authored'
  return QUARANTINE_FLOOR_ELIGIBILITY[failure.verdictClass] === 'floor-eligible'
    && failure.sameBuildPassAndFail
    ? 'floor'
    : 'refused'
}

/**
 * One failed fingerprint this run contributed, with the recurrence the projection answered for it.
 * Test identity travels beside the fingerprint because a crossing has to name the test it
 * quarantines; the recurrence itself is keyed `(product, fingerprint)` (D-07).
 */
export interface QuarantineDetectionFailure {
  product: string
  filePath: string
  testName: string
  fingerprint: string
  verdictClass: VerdictClass
  /**
   * WHICH pipeline authored `verdictClass` on the CROSSING run (390-16). The floor-eligibility
   * gate reads this beside the class, because for some classes the class alone does not say
   * whether the evidence is about this test or about the whole run.
   *
   * WHY THE CROSSING RUN'S PRODUCER, and not all three occurrence ordinals'. Gating on every
   * ordinal in the window would need a new `producer` column on `run_fingerprint_windows` plus an
   * index rebuild — cheap in itself, since L12 makes the projection a gitignored rebuildable
   * derivation — but it is a strictly larger change that buys nothing: the crossing run is the one
   * AUTHORING the `entered` line, so its evidence is the evidence the entry rests on. Recorded
   * here so the next reader does not have to re-derive the choice (T-390-16-05, accepted).
   */
  producer: Verdict['producer']
  /**
   * THE PER-TEST FLAKE SIGNATURE for this crossing (390-19 / G-390-5): did this test both pass and
   * not pass at some ONE build ordinal? Computed by `hasSameBuildPassAndFail` over the per-test
   * outcome window the projection already keeps (`run_test_outcomes`.`last_outcomes_json`), so it
   * is read off bytes this phase computes rather than invented for the gate.
   *
   * REQUIRED, not optional, on purpose: `tsc --noEmit` then enumerates every construction site,
   * which is the completeness oracle 390-16 did not have and the reason its widening shipped with
   * an unreachable arm.
   *
   * ITS THREE HONEST BOUNDS, so nobody reads a set field as a stronger claim than it is:
   *
   *  1. The window is CAPPED at LAST_OUTCOMES_LIMIT entries, so this is "a same-build pass∧fail
   *     within the recorded window", never "ever".
   *  2. IT IS CONTEMPORANEOUS, and that bound is ENFORCED, not advisory (390-24, WR-05). The fold
   *     hands this predicate only the outcomes inside `[windowFloor(buildOrdinal), buildOrdinal]`
   *     — the crossing's OWN recurrence window, same floor `fingerprintRecurrence` counts over —
   *     so a same-build pass∧fail OLDER than that window answers false by construction. A
   *     since-fixed flake episode therefore cannot license the floor arm for a new hard
   *     regression. The scope lives at the construction site (`run-outcomes.ts`), named below.
   *  3. WHAT IT TAKES TO PRODUCE ONE IN THE REAL WORLD — this is not a common event. An in-run
   *     RETRY does NOT produce it: the member-runner collapses retries into a single member
   *     outcome and `countedOutcome` maps `healed` to a PASS, so one applied run leaves exactly
   *     ONE entry per member. Two entries at one ordinal therefore require TWO SEPARATE APPLIED
   *     RUNS carrying the same `handoff.buildOrdinal` — in practice a CI job re-run without an
   *     ordinal bump. Every claim in this phase that the floor path is "live without an analysis
   *     budget" is true only under that condition, and this phase has already overstated
   *     reachability three times.
   */
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
  /**
   * The crossing run's producer, carried onto the sighting so an operator can ACT on it — and
   * RENDERED on the curation tail's withheld line since 390-22 / WR-03. Until then this docstring
   * claimed the field existed so an operator could tell two causes apart on that line, and the
   * field never reached the line: the claim was true of the shape and false of the operator. It is
   * reduced here to what the render delivers.
   *
   * `escalatedNotQuarantined` has THREE distinct causes, and the producer separates the first two:
   * a class that is never auto-quarantinable (run `analyze-run` and it still will not be), versus a
   * class that would have been had a verdict been authored (run `analyze-run` and it will be).
   * Those read identically on the curation tail's line unless the producer travels with the
   * sighting.
   *
   * THE THIRD CAUSE, ADDED BY 390-19, AND THE FACT THAT THIS FIELD DOES NOT DISTINGUISH IT: the
   * crossing was admissible on the floor arm but QUARANTINE_FLOOR_AUTO_QUARANTINE_CAP was already
   * spent on this run. The information gap is bounded — an operator sees the withheld line either
   * way, the build fails either way, and the identity crosses again on the next applied run — so no
   * field is added to carry it, which would widen this shape and the cli render inside the very
   * round that is closing a containment defect. Recorded as a STATED RESIDUAL instead, because a
   * docstring that enumerates causes and misses one is the defect class this whole round closes.
   */
  producer: Verdict['producer']
  occurrenceOrdinals: number
  windowOrdinals: number
}

export interface QuarantineDetectionResult {
  /** Lifecycle events to append, entered-then-released, each group identity-sorted. */
  events: QuarantineLedgerEvent[]
  /** At the flag floor: suspected flaky, no state change, no ledger write (D-06). */
  flagged: QuarantineDetectionSighting[]
  /** Escalated but class-gated away from auto-quarantine — the build keeps failing (D-05). */
  escalatedNotQuarantined: QuarantineDetectionSighting[]
}

const MS_PER_DAY = 86_400_000

/**
 * The subsystem's ONE ordering rule: a TOTAL order over the identity key, by CODE UNIT.
 *
 * `<` on two strings compares UTF-16 code units. That is a total order over distinct strings — it
 * answers 0 only for equal keys — and it is a property of the STRINGS, not of the machine. Both
 * halves matter, and `String.prototype.localeCompare` (which this replaced) has neither:
 *
 *  - it resolves against the host's default locale and ICU build, so two checkouts of one commit
 *    could order the same ledger differently;
 *  - it answers 0 for canonically-equivalent-but-distinct names (an NFC/NFD pair), and
 *    `Array.prototype.sort` is stable, so a 0 hands the ordering decision back to the caller's
 *    iteration order — which is exactly the dependency `evaluateQuarantineDetection` denies.
 *
 * Every ordering site in the subsystem routes through here: both sorts in the detection ladder and
 * the identity tiebreak in `operations.ts`'s `triageOrder`, which already compared bytes and is
 * where this spelling was lifted from.
 */
export function compareQuarantineIdentity(
  left: QuarantineIdentity,
  right: QuarantineIdentity,
): number {
  return compareBytes(quarantineIdentityKey(left), quarantineIdentityKey(right))
}

/**
 * Code-unit comparison. MODULE-PRIVATE, and the visibility is the honest claim (390-28 / IN-01).
 *
 * It was exported "so no ordering site in the subsystem has to re-spell it" and had no consumer at
 * all — not `operations.ts`, not `detection.test.ts`, not the package barrel, which never published
 * it. An export that names consumers it does not have invites the next reader to preserve a
 * compatibility surface nothing depends on. Its TWO REAL CALL SITES are both in this file:
 * {@link compareQuarantineIdentity}, which compares the identity key with it, and the fingerprint
 * tiebreak in {@link evaluateQuarantineDetection}'s failure sort. Ordering sites OUTSIDE this
 * module reach the same primitive through `compareQuarantineIdentity`, which is exported.
 *
 * Both call sites want it for one reason: a comparison chain is only as deterministic as its least
 * deterministic leg, so leaving one `localeCompare` in the chain would reproduce WR-06 on a
 * narrower input class.
 */
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

/**
 * D-07's counting law — "two runs in one build are ONE ordinal" — spelled ONCE, for every reader of
 * it (390-19).
 *
 * Both directions of that law now have a consumer: the EXIT path asks whether an ordinal passed,
 * and the ENTRY path asks whether an ordinal disagreed with itself. Answering per ordinal whether
 * ANY entry passed and whether ANY entry did not is strictly RICHER than the boolean AND-fold the
 * exit path used to compute inline, and it has to be: under the AND-fold an ordinal carrying a pass
 * and a fail is indistinguishable from an ordinal carrying only fails — which is exactly the
 * distinction the flake signature is about.
 *
 * Shared IN CODE rather than pinned by a test on purpose. Two implementations that agree only
 * because a fixture compares them are free to drift the moment somebody edits one, and the entry
 * path and the exit path disagreeing about what a build ordinal IS would be a silent defect in
 * both directions at once (T-390-19-04).
 *
 * Groups are non-empty by construction — a group exists only because an entry created it — so
 * `anyPassed || anyFailed` holds for every returned element.
 */
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

/**
 * Collapse a per-test outcome window onto DISTINCT ordinals. An ordinal counts as passing only when
 * EVERY recorded run at that ordinal passed — two runs in one build are one ordinal (D-07's counting
 * law), and the safe direction for a mixed build is "not a pass", so a same-build pass∧fail (the
 * §8.2 flake signature itself) can never buy an exit.
 *
 * Expressed over `groupByBuildOrdinal` since 390-19: "no entry at this ordinal failed" is the same
 * answer the old AND-fold gave for every non-empty group, and every group is non-empty by
 * construction. The stated law and this function's signature are unchanged.
 */
function distinctOrdinalOutcomes(
  window: QuarantineDetectionTestWindow,
): { buildOrdinal: number; passed: boolean }[] {
  return groupByBuildOrdinal(window.ordinals)
    .map(({ buildOrdinal, anyFailed }) => ({ buildOrdinal, passed: !anyFailed }))
}

/**
 * THE PER-TEST FLAKE SIGNATURE (390-19 / G-390-5): at some ONE build ordinal this test both passed
 * and did not pass.
 *
 * This is the same shape `distinctOrdinalOutcomes` names above as "the §8.2 flake signature
 * itself", read here in the opposite direction — there it is the reason an ordinal cannot buy an
 * EXIT, here it is the per-test evidence the floor arm of the auto-quarantine gate requires before
 * it may silence anything. Both read `groupByBuildOrdinal`, so the counting law has ONE spelling in
 * code and not two that a test happens to compare.
 *
 * WHY THIS IS THE RIGHT PER-TEST SIGNAL, in the module's own vocabulary. The floor-eligibility
 * table below asks one question: is the EVIDENCE behind a class a statement about THIS TEST, or
 * about the run it happened to be in? A same-build pass∧fail is a statement about this test and
 * nothing else — at one build ordinal the same test both passed and failed, which no run-level
 * condition explains away.
 *
 * Deliberately NOT "some pass and some fail anywhere in the window": that is a test that broke and
 * was fixed, which is the ordinary shape of software rather than flakiness.
 *
 * TWO SITES, ONE RULE — WHO OWNS THE SCOPE (390-24). This function stays TOTAL over whatever
 * window it is handed and deliberately holds no opinion about how far back that window reaches.
 * The FOLD owns the scope: `evaluateQuarantineForFold` in `projection/run-outcomes.ts` filters the
 * per-test outcomes to `[windowFloor(buildOrdinal), buildOrdinal]` before calling here, so the
 * evidence licensing an entry is always about the SAME episode the recurrence counted. Narrowing
 * or widening one site without the other is the WR-05 defect returning: this predicate would still
 * be green over windows the fold no longer hands it.
 */
export function hasSameBuildPassAndFail(
  ordinals: readonly QuarantineOrdinalOutcome[],
): boolean {
  return groupByBuildOrdinal(ordinals).some((entry) => entry.anyPassed && entry.anyFailed)
}

/** D-10's exit predicate: the M most recent DISTINCT ordinals exist and every one of them passed. */
function releasesOnPasses(window: QuarantineDetectionTestWindow): boolean {
  const ordinals = distinctOrdinalOutcomes(window)
  if (ordinals.length < QUARANTINE_AUTO_EXIT_PASSES) return false
  return ordinals
    .slice(-QUARANTINE_AUTO_EXIT_PASSES)
    .every((entry) => entry.passed)
}

/**
 * WHOSE NAME an auto-authored `entered` event carries, stated over the prior entry's state
 * (390-18 / G-390-4). The rule is total across the three members of `QuarantineEntryStateName`:
 *
 *  - `'expired'` → CARRY the prior owner. A lapsed window is the SAME window continuing:
 *    suppression stopped, nobody closed it, and the person who claimed it still holds it.
 *    Re-stamping the unassigned literal here silently UN-CLAIMS a window somebody had taken.
 *  - `'released'` → the UNASSIGNED literal. A release is a human deliberately closing the window;
 *    a later crossing opens a genuinely new one, and D-12's honest-absence rule (no git-identity
 *    stamping, no CODEOWNERS guessing) says the truthful answer for it is that nobody has claimed
 *    it yet. Carrying a name here would attribute a new window to somebody who signed off on the
 *    old one.
 *  - `'quarantined'` → UNREACHABLE on this path, not silently absent. The ladder skips an
 *    already-suppressed identity (`activeKeys`, above) before it ever reaches the authoring
 *    branch, so there is no owner decision to make for a suppressing entry. Pinned as unreachable
 *    in detection.test.ts rather than left to be re-derived.
 *
 * No prior entry at all → the unassigned literal, unchanged.
 *
 * TWO AUTHORING PATHS, ONE RULE ABOUT SOMEBODY'S CLAIM. `createQuarantineOperations`'s RENEW arm
 * (operations.ts) makes the same decision from the other direction: it OMITS `owner` from the
 * `renewed` event when the caller named nobody, with a comment saying that writing the unassigned
 * literal there would silently un-claim a window somebody had taken. That is the identical rule
 * over an open window; this is it over a re-entry. Naming the sibling here is cheaper than a test
 * asserting the two agree — but it only works if a reader who changes one comes looking, so the
 * cross-reference is deliberately in BOTH.
 */
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

/**
 * The ladder, evaluated over one run's failures and the current ledger state.
 *
 * ORDERING IS DETERMINISTIC ON ANY HOST — entered events (identity-sorted) then released-auto
 * events (identity-sorted) — so the committed ledger's bytes are a function of ledger CONTENT and
 * not of projection iteration order. What makes that true rather than merely stated is
 * {@link compareQuarantineIdentity}: a TOTAL order over {@link quarantineIdentityKey} by code
 * unit. Total is the load-bearing word. A comparator that answers 0 for two DISTINCT identities
 * hands the decision back to the caller's iteration order, because `Array.prototype.sort` is
 * stable — so a zero here would falsify this paragraph directly. Code units also make the answer a
 * property of the strings rather than of the machine's locale and ICU build.
 *
 * Both sorts below and `operations.ts`'s `triageOrder` share that one comparator; the fingerprint
 * tiebreak uses the same `compareBytes` primitive. There is one ordering rule in this subsystem and
 * it is spelled once (390-22 / WR-06).
 *
 * Suppression is keyed on ledger STATE, not on the existence of an entry: only `'quarantined'`
 * suppresses a fresh `entered`. An `'expired'` entry has already stopped suppressing (D-11) and a
 * `'released'` one closed its window, so a fresh crossing re-enters in both cases — D-10's stated
 * "re-entry needs no special rule". The repeated `entered` lines are the ledger's own record that
 * this test has been here before, which is exactly the history D-03 chose an event log to keep.
 */
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
    // ONE ordering rule (390-22 / WR-06). Both legs compare CODE UNITS — the identity key through
    // the shared comparator, the fingerprint tiebreak through the same primitive — because a
    // comparison chain is only as deterministic as its least deterministic leg.
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
    // Release closes an entry that is still LISTED — `quarantined` or `expired`. Only a `released`
    // window is out of scope, and the old filter's justification was right about exactly that half:
    // re-releasing a closed window WOULD author an event that changes nothing while claiming the
    // exit path worked. It was wrong about the other half. A LAPSED entry is still listed, still
    // renewable, still in the triage queue and still the reason a human sees this test in
    // `quarantine.list` — a release genuinely closes it, so refusing to author one is what left a
    // FIXED test listed forever (390-17 / G-390-4). One condition was covering two states whose
    // answers differ.
    //
    // TWO SITES, ONE RULE. `evaluateQuarantineForFold` (projection/run-outcomes.ts) builds the
    // `testWindows` this loop reads, and its own exit-candidate filter must admit exactly the same
    // states. Narrow either one alone and the pair is a no-op: this loop would answer correctly
    // over a window the fold never built.
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
