// Every value-bearing field is masked at the recorder boundary; these DTOs never see a raw secret.

// `reportValue` is non-terminal: recording the answer never completes the step.
export interface ReportedValueEvidence {
  // The reported answer, masked before it is recorded.
  value: string
}

// Present only when a turn declared the step infeasible; distinct from a plain `stepFailed`.
export interface TerminationEvidence {
  /** The terminal outcome class. Closed literal union, extensible in later milestones. */
  kind: 'infeasible'
  /** Why the step was declared infeasible — required when a termination block is present. */
  reason: string
}

/**
 * The `assertAI` or `extractAI` judge block. assertAI records its verdict and masked rationale;
 * either verb records `unresolved` when the model could not judge or extract.
 */
export interface AiJudgmentEvidence {
  /** Which AI verb produced this judgment. */
  verb: 'assertAI' | 'extractAI'
  /** The model verdict for an `assertAI` claim (present on assertions; absent on extractAI). */
  verdict?: boolean
  // The model rationale behind the verdict, masked before it is recorded.
  rationale?: string
  /**
   * Why the model could not judge or extract: the step's error, masked and bounded. Absent when
   * it could.
   */
  unresolved?: string
}

export type AssertValueOp =
  | 'isNull'
  | 'isDefined'
  | 'equals'
  | 'notEquals'
  | 'gt'
  | 'lt'
  | 'contains'

// A passing `assertValue` gives a deterministic verdict without the verifier; values are masked.
export interface AssertValueEvidence {
  /** The value source the assertion read: url, storage or network, or expr when it evaluated an expression. */
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

// Nothing produces `assert-ai`; it stays so stored records still parse.
export type VerdictSource = 'assert-value' | 'assert-ai' | 'verifier-model'
