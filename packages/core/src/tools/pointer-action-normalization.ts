import type { Action } from '../types/platform.js'

type PointerAction = Extract<Action, { type: 'doubleClick' | 'rightClick' }>

const EXPLICIT_TOP_LEFT_PATTERNS = [
  /top-left/i,
  /top left/i,
  /0\s*pixels?\s+right/i,
  /0\s*px\s+right/i,
  /x\s*:\s*0/i,
  /x\s*=\s*0/i,
  /zero[-\s]?offset/i,
]

export function normalizePointerActionForStep(action: Action, stepInstruction: string): Action {
  if (action.type !== 'doubleClick' && action.type !== 'rightClick') {
    return action
  }

  const normalized = normalizeNoOpClickDelay(action)
  const relativePosition = normalized.relativePosition

  if (!relativePosition) {
    return normalized
  }

  if (relativePosition.x !== 0 || relativePosition.y !== 0) {
    return normalized
  }

  if (isExplicitTopLeftInstruction(stepInstruction)) {
    return normalized
  }

  const withoutRelativePosition: PointerAction = { ...normalized }
  delete withoutRelativePosition.relativePosition
  return withoutRelativePosition
}

function normalizeNoOpClickDelay(action: PointerAction): PointerAction {
  if (action.clickDelay !== 0) {
    return action
  }

  const withoutClickDelay: PointerAction = { ...action }
  delete withoutClickDelay.clickDelay
  return withoutClickDelay
}

function isExplicitTopLeftInstruction(stepInstruction: string): boolean {
  return EXPLICIT_TOP_LEFT_PATTERNS.some(pattern => pattern.test(stepInstruction))
}
