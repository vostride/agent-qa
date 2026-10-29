// WHAT THE RUN-DETAIL PAGE HAS SELECTED.
//
// THE STEP KEY IS MEMBER-SCOPED. A durable step has no id of its own — it is
// addressed by the pair `(testIndex, stepIndex)`, the handle plus the ordinal — so the key this
// union carries is that pair, spelled once, by {@link runDetailStepKey}. Until 405-08 the
// disambiguator was the child run's id (`?run=<childRunId>`), which came from the parent/child
// walk that plan deleted; a bare `stepIndex` would collide across members of the same run and
// select two rows at once on any suite.
//
// THE KEY AND THE `?step=` PARAM ARE THE SAME STRING, deliberately. One spelling means the URL
// round-trip is an identity rather than a translation, and a deep link cannot drift from what the
// tree is highlighting.

export type Selection =
  | { type: 'step'; stepId: string }
  | { type: 'subaction'; stepId: string; subIndex: number }
  | { type: 'hook'; hookId: string }
  | { type: 'suite-hook'; phase: 'setup' | 'teardown'; hookId: string }
  | { type: 'test-hook'; testIndex: number; phase: 'setup' | 'teardown'; hookId: string }
  | { type: 'execution'; stepId: string; logId: string }
  | { type: 'test'; testIndex: number }

export type StepLinkedSelection = Extract<Selection, { stepId: string }>
export type SubactionSelection = Extract<Selection, { type: 'subaction' }>

/** The separator between the handle and the step ordinal in a run-detail step key. */
const STEP_KEY_SEPARATOR = ':'

/**
 * The key one durable step is selected and deep-linked by — `<testIndex>:<stepIndex>`.
 *
 * Both halves are non-negative integers the projection produced, so the key is total, stable
 * across reloads and orderable without parsing.
 */
export function runDetailStepKey(testIndex: number, stepIndex: number): string {
  return `${String(testIndex)}${STEP_KEY_SEPARATOR}${String(stepIndex)}`
}

/**
 * Read a step key back into its pair, or answer `null`.
 *
 * IT NEVER THROWS AND IT NEVER GUESSES. `?step=` is attacker-adjacent and
 * hand-editable; anything that is not two non-negative integers answers `null`, and the page falls
 * back to its first step. The failure mode of a wrong answer here is landing on the top of the
 * tree, never on a row belonging to someone else's member.
 */
export function parseRunDetailStepKey(
  raw: string | null | undefined,
): { testIndex: number; stepIndex: number } | null {
  if (raw === null || raw === undefined) return null
  const match = /^(\d+):(\d+)$/.exec(raw)
  if (match === null) return null
  const testIndex = Number(match[1])
  const stepIndex = Number(match[2])
  if (!Number.isSafeInteger(testIndex) || !Number.isSafeInteger(stepIndex)) return null
  return { testIndex, stepIndex }
}

export function hasStepId(selection: Selection | null | undefined): selection is StepLinkedSelection {
  return (
    selection?.type === 'step'
    || selection?.type === 'subaction'
    || selection?.type === 'execution'
  )
}

export function isSubactionSelection(
  selection: Selection | null | undefined,
): selection is SubactionSelection {
  return selection?.type === 'subaction'
}
