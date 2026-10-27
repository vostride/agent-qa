/**
 * The Phase 360 termination-verb & AI-assertion evidence vocabulary (EXEC-05/EXEC-07;
 * D-03/D-04/D-06/D-07/D-09/D-11; spec `tools-and-actions.md` §9.1/§9.6/§12.2/§12.10).
 * The 353 D-14 law holds: the recording types ARE the schema DTOs — Plans 08/09/10
 * record these blocks at the machinery boundary, Phase 361 serializes them into the
 * `CompletedRunHandoff` without reinvention.
 *
 * Redaction-before-record law (T-360-01): every value-bearing field below carries app or
 * user data that MUST be masked at the recorder boundary BEFORE it reaches evidence — the
 * Plan 01 secret fixtures enforce it. The DTOs never see a raw secret.
 *
 * Pure type-only DTOs: no runtime code, no host APIs (schema ownership contract).
 */

/**
 * The `common_reportValue` answer block (D-01/D-03; spec §9.1/§12.10). A platform-less
 * verb minted at the dispatch chokepoint records its answer here so the verdict layer — and
 * in Phase 361 the handoff — carries the retrieved value first-class and machine-scoreable.
 * `reportValue` is non-terminal (D-02): recording the answer never completes the step.
 */
export interface ReportedValueEvidence {
  /** The reported answer, masked-before-record (T-360-01). */
  value: string
}

/**
 * The typed infeasible termination block (D-04; spec §12.10). Present only when a turn
 * declares the step infeasible via the additive `failureKind`/`failureReason` plan-field
 * envelope (the 358 `remember[]` precedent) — machine-distinguishable from a plain
 * `stepFailed`. Sorted keys are exactly `["kind","reason"]` (the Plan 01 pin).
 */
export interface TerminationEvidence {
  /** The terminal outcome class. Closed literal union, extensible in later milestones. */
  kind: 'infeasible'
  /** Why the step was declared infeasible — required when a termination block is present. */
  reason: string
}

/**
 * The `assertAI`/`extractAI` judge block (D-05/D-06/D-07/D-09; spec §9.6/§12.2). The verb
 * routes through the verifier's injected model lane exactly once; the verdict + rationale are
 * recorded here, along with the requested-but-deferred M3/M4 knobs (so demand is visible) and
 * the `extractAI` `scope:'global'` degradation marker (D-07 — degraded to a run-scoped write,
 * never an error).
 */
export interface AiJudgmentEvidence {
  /** Which AI verb produced this judgment. */
  verb: 'assertAI' | 'extractAI'
  /** The model verdict for an `assertAI` claim (present on assertions; absent on extractAI). */
  verdict?: boolean
  /** The model rationale backing the verdict/extraction, masked-before-record (T-360-01). */
  rationale?: string
  /**
   * Why the model could not judge or extract: the step's error, masked and bounded. Absent when
   * it could.
   */
  unresolved?: string
  /**
   * The requested-but-deferred knobs (D-09). Executed single-model in M1 — recorded, never
   * honored, so M3/M4 consensus/video/effort can see accumulated demand.
   */
  requested?: {
    consensus?: number
    video?: boolean
    effort?: 'low' | 'medium' | 'high'
  }
  /**
   * True ⇒ an `extractAI` `scope:'global'` request degraded to the same run-scoped write
   * (D-07); durable memory is M2's curator, no write port exists in M1. Never an error.
   */
  degradedScope?: boolean
}

/**
 * The closed set of `common_assertValue` comparison operators (D-10; spec §7.2). Deterministic
 * by construction — the runner comparator applies exactly one of these per assertion.
 */
export type AssertValueOp =
  | 'isNull'
  | 'isDefined'
  | 'equals'
  | 'notEquals'
  | 'gt'
  | 'lt'
  | 'contains'

/**
 * The structured `common_assertValue` outcome block (D-10/D-11; spec §7.2/§12.2). The adapter
 * reads the source, the pure runner comparator judges, and the outcome is recorded here — a
 * passing assertValue short-circuits the per-step verifier with a deterministic verdict (no
 * vision round-trip). Sorted keys match the Plan 01 pin `["actual","expected","op","passed","source"]`.
 * `expected`/`actual` are masked-before-record (T-360-01).
 */
export interface AssertValueEvidence {
  /** The value source the assertion read (e.g. url, storage, cookies, network, expr-result). */
  source: string
  /** The comparison operator applied. */
  op: AssertValueOp
  /** The expected value, masked-before-record. Absent for the no-expected ops (isNull/isDefined). */
  expected?: string
  /** The actual value read, masked-before-record. `null` is a legitimate read (isNull). */
  actual?: string | null
  /** True ⇒ the comparison held. */
  passed: boolean
}

/**
 * Which path produced a step's final verification verdict (D-11; spec §12.2). A step concluded by
 * an `assertValue` result gets a deterministic `'assert-value'` verdict (zero model call). Every
 * other final verdict, including steps concluded by assertAI or extractAI, comes from the step
 * verifier's own model call (`'verifier-model'`); the judge's verdict stays on `aiJudgment`.
 * `'assert-ai'` is no longer produced (quick 261004-lsa) and is kept so older records parse.
 */
export type VerdictSource = 'assert-value' | 'assert-ai' | 'verifier-model'
