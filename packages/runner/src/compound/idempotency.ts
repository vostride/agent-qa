// Suppresses only on positive persisted state from the settled observation, never a live probe.

import { isToggleElement, type ScreenState } from '@vostride/agent-qa-schema'
import type { IdempotentNoopMeta } from './metadata.js'

export type DesiredState = 'checked' | 'unchecked' | 'selected' | 'unselected'

export interface DesiredStateAction {
  type: string
  ref?: string
  desiredState?: DesiredState
  value?: string
}

const PICKER_TYPES = new Set(['select', 'nativeSelect', 'pickerSelect'])

export function desiredStateSatisfied(
  action: DesiredStateAction,
  screenState: ScreenState,
): IdempotentNoopMeta | undefined {
  if (action.ref === undefined) return undefined
  const element = screenState.elements.find((el) => el.ref === action.ref)
  if (!element) return undefined

  if ((action.type === 'tap' || action.type === 'click') && action.desiredState) {
    if (!isToggleElement(element)) return undefined
    switch (action.desiredState) {
      case 'checked':
      case 'selected':
        return element.state.checked === true ? { currentState: 'checked' } : undefined
      case 'unchecked':
      case 'unselected':
        return element.state.checked === false ? { currentState: 'unchecked' } : undefined
    }
  }

  if (PICKER_TYPES.has(action.type) && action.value !== undefined) {
    if (element.value !== undefined && element.value === action.value) {
      return { currentState: element.value }
    }
  }

  return undefined
}
