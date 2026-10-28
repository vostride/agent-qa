import type { Action } from '../action/index'
import type { ServedRetrievalTraceV1 } from '../brief/retrieval-trace'
import type { RecordedRetrievalRung } from '../brief/retrieval-rung'
import type { ServedBrief } from '../brief/served-brief'
import type { RecordId } from '../ids/record-id'
import type { WorkingMemoryEntry } from '../memory/working-memory-entry'
import type { RecordedActionResult } from '../result/index'
import type { ConditionVerdictsEvidence } from './condition-evidence'
import type { LimitStopEvidence, StepLimitUsage } from './limit-evidence'
import type { DeclaredModelProfile, ModelIdentity } from './model-call-profile'
import type { OperationCaptureAvailability } from './operation-evidence'
import type { CycleEvidence, StagnationEvidence } from './progress-evidence'
import type { SubActionEvidence } from './sub-action-evidence'
import type { PlanningFailureEvidence } from './tool-exchange'
import type {
  AiJudgmentEvidence,
  AssertValueEvidence,
  ReportedValueEvidence,
  TerminationEvidence,
  VerdictSource,
} from './verb-evidence'

export interface VerifierVerdict {
  pass: boolean
  reasoning: string
}

/**
 * D-12 typed step plan source. `procedure-replay` = the step's actions came from a committed
 * procedure's guarded replay, carrying the guard fold (and the first miss when the fold broke
 * off). `procedure-hint` = a matched procedure was SERVED as a hint into planning without
 * replay — recorded here so M3 gate audits can measure served-hint exposure (RESEARCH Open
 * Q3: beside `planSource` on StepEvidence, never a ServedBrief widening).
 */
export type StepPlanSource =
  | {
      kind: 'procedure-replay'
      procedureId: RecordId
      guard: {
        /**
         * PER-STEP fold (F-381-51-1 · 381 D-09/D-12): `checksPassed`/`total` range over the
         * stored actions attempted within THIS test step. Under the one-body-step-per-test-step
         * law `total` is 1 for every flow-covered step, so `checksPassed === total` (with no
         * `miss`) keeps meaning "this step's replayed actions all passed guards, executed, and
         * were accepted" for every consumer — the harness completeness gate and per-step canary
         * attribution alike. Cross-flow position lives in the sibling `flow` member, never here.
         */
        checksPassed: number
        total: number
        miss?: {
          procedureStepIndex: number
          reason:
            | 'descriptor-ambiguous'
            | 'descriptor-missing'
            | 'page-anchor-mismatch'
            | 'gate-refused'
            // A bind-time availability gap (D-08), distinct from an invalid action shape.
            | 'parameter-unbound'
            | 'non-replayable-action'
        }
        /**
         * The adapter failed after this stored action passed the full replay guard. This is
         * execution evidence, not a staleness signal, and it blocks positive procedure
         * attribution even if a later live-planned recovery makes the step verdict pass.
         */
        executionFailure?: {
          procedureStepIndex: number
        }
        /**
         * The stored action executed after passing its replay guards, but the verifier rejected
         * its result. This blocks positive procedure attribution even when live-planned recovery
         * later makes the step verdict pass; attributable rejection is negative evidence.
         */
        verifierRejection?: {
          procedureStepIndex: number
        }
      }
      /**
       * The flow cursor this test step consumed (F-381-51-1 · D-09, the one honest D-12
       * extension the cross-step body-step↔test-step mapping requires): `cursor` = the
       * committed body-step index this test step attempted, `length` = the committed body's
       * step count. Additive optional — pre-existing handoffs and every consumer of the
       * guard fold stay valid unchanged.
       */
      flow?: {
        cursor: number
        length: number
      }
    }
  | {
      kind: 'procedure-hint'
      procedureId: RecordId
      /**
       * Present ONLY when this hint is a replay recommendation that the loop's fail-closed
       * body read demoted (D-12 evidence discipline): the matcher earned a replay, but the
       * committed body could not be read (`body-unreadable`), could not be decoded
       * (`body-unparseable`), or decoded to zero steps (`body-empty`).
       *
       * An ordinary hint recommendation carries NO demotion member at all, so a starved
       * replay is structurally distinguishable from ordinary served-hint exposure. Without
       * it the two are byte-identical, which is exactly how G-381-4 hid three earned replay
       * recommendations behind ordinary-looking hints across a whole live run. Eval and M3
       * gate audits count demotions from this member; do not widen it into a free-form
       * string.
       */
      demotion?: 'body-unreadable' | 'body-unparseable' | 'body-empty'
    }

/**
 * Why a cache key hit did not replay (438 D-10, D-11): its stored target matched no current
 * element strictly, matched several, or the stored value cannot replay at all.
 */
export type CacheMissReason = 'strict-absent' | 'strict-not-unique' | 'non-replayable'

export interface Decision {
  plan: string
  plannedAction: Action
  result: RecordedActionResult
}

/**
 * One `{{env:NAME}}` binding that interpolated into a step's text, recorded as the
 * NAME the test author bound alongside the value that replaced it (PROC-01, 381 D-03/D-08).
 *
 * Interpolation happens BEFORE planning, so without this pair the binding name is
 * destroyed at the capture seam and only the resolved literal survives into the
 * trajectory — the G-381-3 root cause.
 */
export interface InterpolatedVariable {
  name: string
  value: string
}

export interface StepEvidence {
  stepIndex: number
  stepText: string
  /** `disabled` means no cache was bound for the step's test. */
  cacheStatus: 'hit' | 'miss' | 'bypass' | 'disabled'
  /**
   * The first cache key hit in this step whose stored target was not the only strict match, or
   * could not replay. Present only when `cacheStatus` is 'miss'.
   */
  cacheMiss?: { reason: CacheMissReason }
  servedBrief: ServedBrief
  /**
   * The run-scoped verbatim working-memory entries served to this step's planning turns
   * (WM-01, §12.15), masked. Planner INPUT recorded BESIDE the brief — never a
   * `ServedBrief` channel (§A11 stays exactly the three memidex channels). Ratified
   * 2026-07-03; the structured-entry shape lands with Phase 358.
  */
  workingMemory?: WorkingMemoryEntry[]
  /**
   * The serve-time retrieval trace for THIS step's brief (KREV-02 · 387 D-13/D-14):
   * per served line its record, matching leg, rank and score, plus the bounded ledger of
   * candidates the token budget cut.
   *
   * BESIDE `servedBrief`, never a widening of it — the same Q3 precedent `workingMemory`
   * above carries (§A11 stays exactly the three memidex channels). The reason is concrete
   * rather than stylistic: `ServedBrief` feeds `computeBriefDigest`, so a trace channel
   * inside it would change the digest of every brief ever served and invalidate the
   * cassettes and acceptance evidence keyed on those bytes.
   *
   * Reader computes, runner persists (D-13): the serving path is the only place that knows
   * these facts, and this is the only place they survive. Optional because runs that
   * predate 387 have no trace and never will — the why-verb answers those with a typed
   * no-trace result rather than by re-running retrieval against today's index (D-15).
  */
  retrievalTrace?: ServedRetrievalTraceV1
  /**
   * The HOST's retrieval rung at the moment this step's brief was served (TRST-01 · 407 D-13,
   * 2026-08-29).
   *
   * BESIDE `servedBrief`, on exactly the same 387 Q3 footing `retrievalTrace` above carries —
   * never a `ServedBrief` widening. The reason is the same concrete one: `computeBriefDigest`
   * keys cassettes and acceptance evidence on the brief's bytes, so a rung channel inside it
   * would change the digest of every brief ever served. §A11 stays exactly three channels.
   *
   * RUN-CONSTANT. The rung describes the machine's ladder for this run, not a per-line ranking
   * claim: a surface renders "retrieval was on rung X for this run", never "this brief was
   * dense-ranked". It is folded ONCE (`knowledge-local/src/retrieval-rung.ts`) from the two
   * axes only that package can see, and recorded here so the banner stays honest about a past
   * run after the host is fixed.
   *
   * ABSENT on pre-407 runs, and absent on a run served with no knowledge reader bound at all
   * (D-16 — that run's truncation marker is the durable fact, and there is no ladder to name).
  */
  retrievalRung?: RecordedRetrievalRung
  /**
   * The run's configured decision context, embedded per step including cache-hit steps
   * (D-06). New runs populate it by construction; it remains optional only for structural
   * absence in port-less harnesses under the D-04 version rule.
   */
  modelProfile?: DeclaredModelProfile
  /**
   * The deterministic 64-hex digest of the run platform's bound tool surface (INST-04,
   * D-16). It is its own receipt component because tool surface and model identity are
   * independent attribution inputs.
   */
  toolSchemaDigest?: string
  subActions: SubActionEvidence[]
  verifierVerdict: VerifierVerdict
  /**
   * The verifier's declared identity recorded beside its verdict (D-07), without widening
   * the broadly constructed `VerifierVerdict` value.
   */
  verifierIdentity?: ModelIdentity
  /**
   * The per-condition verdicts the runner computed the pass from (439 D-07), beside
   * `verifierVerdict` and never inside it.
   */
  conditionVerdicts?: ConditionVerdictsEvidence
  /**
   * The failed planning-turn block (D-03). Present only when planning failed structurally,
   * preserving that turn's exchanges instead of silently losing them.
   */
  planningFailure?: PlanningFailureEvidence
  /**
   * The stagnation tree state at a terminal `stepFailed` (CYCLE-02, D-07). Present only
   * when the step failed after the bounded per-element ladder exhausted.
   */
  stagnation?: StagnationEvidence
  /**
   * The cycle-flag terminal block (CYCLE-03, D-07/D-08). Present only when a true cycle
   * was flagged (state revisitation AND no task progress across the window).
   */
  cycle?: CycleEvidence
  selfHeal?: {
    failedDecision: Decision
    recoveringDecision: Decision
  }
  /**
   * The `common_reportValue` answer block (D-03). Present when the step reported a value;
   * masked-before-record. Additive optional — every existing consumer keeps compiling (358-02
   * `workingMemory` idiom).
   */
  reportedValue?: ReportedValueEvidence
  /**
   * The typed infeasible termination block (D-04). Present only when a turn declared the step
   * infeasible via `failureKind`/`failureReason` — distinct from a plain `stepFailed`.
   */
  termination?: TerminationEvidence
  /** The typed limit stop (436 D-12); present only when a per-step limit refused a dispatch. */
  limitStop?: LimitStopEvidence
  /** The configured per-step limits and what this step used against them (436 D-11). */
  limitUsage?: StepLimitUsage
  /** Whether this step's platform could capture downloads and clipboard writes at all (436 D-23). */
  operationCapture?: OperationCaptureAvailability
  /**
   * Present when the step ran assertAI or extractAI through the verifier's model lane: the
   * verdict and rationale, or why the model could not judge or extract.
   */
  aiJudgment?: AiJudgmentEvidence
  /**
   * The structured `common_assertValue` outcome block (D-10/D-11). Present when the step ran a
   * deterministic assertValue comparison; masked-before-record.
   */
  assertOutcome?: AssertValueEvidence
  /**
   * Which path produced this step's verification verdict (D-11): the deterministic assertValue
   * comparator, the assertAI judge, or the verifier's own model call.
   */
  verdictSource?: VerdictSource
  /**
   * The typed step plan source (D-12). Additive optional BESIDE the existing `cacheStatus`
   * provenance — structurally distinct from the cached flag so eval/cassette consumers reading
   * cached semantics are never polluted (§A11 stays exactly the three memidex channels).
   * Present only when a procedure drove or hinted this step's planning; absent means the
   * historical single source (a planning turn, with the action cache as an exact-key shortcut).
   */
  planSource?: StepPlanSource
  /**
   * The `{{env:NAME}}` bindings that interpolated into `stepText` (PROC-01 · 381 D-03/D-08).
   * Additive optional (the 358-02 `workingMemory` idiom): absent when the step's text
   * interpolated nothing, so pre-existing handoffs stay valid unchanged.
   *
   * CONSUMER: the procedure-extraction emit fold (`cli/src/curation/emit-candidates.ts`).
   * DEREFERENCE DEPTH: it applies exact string equality against `value` to classify a
   * trajectory value slot, and copies `name` VERBATIM as the forced parameter name — so
   * the load guard validates exactly `{name: string, value: string}` and no deeper.
   *
   * EXPOSURE RATIONALE (truthful baseline — no phantom control): these values are env
   * material that ALREADY persists unmasked in this same handoff, twice over — in
   * `stepText` (passed to finalize unmasked at `runner/src/loop/index.ts:411`) and in
   * `plannedAction` at every `recordSubAction` site. This third derived copy therefore
   * adds no exposure. Secret material cannot enter the channel by construction:
   * `interpolateVariables` never resolves `{{secret:...}}`.
   *
   * DELIBERATELY NOT MASKED. Masking would buy zero confidentiality (see above), and when
   * this was written it actively broke the consumer: the run masker (deleted 441-33, D-12)
   * transformed emails UNCONDITIONALLY and registration-free, and the run's env-name seed
   * (deleted 441-19, D-12) registered ordinary env vars by NAME
   * (`_KEY`/`_TOKEN`/`_SECRET`/`_PASSWORD`/… suffixes, `ANTHROPIC_`/`OPENAI_`/`GH_`/…
   * prefixes). An email-valued username binding — the canonical login case — or any
   * `{{env:X_TOKEN}}` would be transformed HERE while `plannedAction` stayed raw, the
   * exact-match classification would miss, no source name would be emitted, and replay
   * would stay permanently `hint`. That is G-381-3 itself.
   */
  interpolatedVariables?: InterpolatedVariable[]
}
