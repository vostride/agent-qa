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
