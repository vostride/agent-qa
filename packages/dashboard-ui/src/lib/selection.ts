// The key is the `testIndex:stepIndex` pair and doubles as `?step=`, so links cannot drift.

export type Selection =
  | { type: 'step'; stepId: string }
  | { type: 'subaction'; stepId: string; subIndex: number }
  | { type: 'hook'; hookId: string }
  | { type: 'suite-hook'; phase: 'setup' | 'teardown'; hookId: string }
  | { type: 'test-hook'; testIndex: number; phase: 'setup' | 'teardown'; hookId: string }
  | { type: 'execution'; stepId: string; logId: string }
  | { type: 'test'; testIndex: number }

export type StepLinkedSelection = Extract<Selection, { stepId: string }>

/** The separator between the handle and the step ordinal in a run-detail step key. */
const STEP_KEY_SEPARATOR = ':'

// Both halves are non-negative integers, so the key is total, stable and orderable without parsing.
export function runDetailStepKey(testIndex: number, stepIndex: number): string {
  return `${String(testIndex)}${STEP_KEY_SEPARATOR}${String(stepIndex)}`
}

// `?step=` is hand-editable, so anything but two non-negative integers answers `null`.
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

interface SelectedRowAttribute {
  name: 'data-step-id' | 'data-sub-action-id' | 'data-execution-id' | 'data-hook-id'
  value: string
  key: string
}

// The data attribute that names the selected item's row in the step tree; `null` when it has none.
export function selectedRowAttribute(selection: Selection | null | undefined): SelectedRowAttribute | null {
  const row = (name: SelectedRowAttribute['name'], value: string) => ({ name, value, key: `${name}=${value}` })
  switch (selection?.type) {
    case 'step': return row('data-step-id', selection.stepId)
    case 'subaction': return row('data-sub-action-id', `${selection.stepId}-${String(selection.subIndex)}`)
    case 'execution': return row('data-execution-id', selection.logId)
    case 'hook': return row('data-hook-id', selection.hookId)
    default: return null
  }
}
