import type { Action } from '@vostride/agent-qa-core'

export type ValidationResult =
  | { valid: true }
  | { valid: false; error: string; suggestion?: string }

export class ActionValidationError extends Error {
  readonly suggestion?: string

  constructor(message: string, suggestion?: string) {
    super(message)
    this.name = 'ActionValidationError'
    this.suggestion = suggestion
  }
}

const FILL_ROLES = new Set(['textbox', 'searchbox', 'spinbutton', 'combobox'])
const SELECT_ROLES = new Set(['listbox', 'combobox'])

// Actions that don't target elements — always valid
const NO_REF_ACTIONS = new Set(['scroll', 'navigate', 'waitFor', 'delay', 'waitForUrl', 'assert', 'pinch', 'multiTap', 'keyDown', 'keyUp', 'refresh', 'navigateHistory', 'readConsoleLogs', 'readNetworkLogs', 'readCookies', 'setCookies', 'readLocalStorage', 'setLocalStorage', 'executeScript'])

// Actions valid for any role
const ANY_ROLE_ACTIONS = new Set(['click', 'hover', 'keypress', 'paste', 'doubleClick', 'rightClick'])

export function validateAction(action: Action, elementRole: string | undefined): ValidationResult {
  // Actions that don't require an element ref are always valid
  if (NO_REF_ACTIONS.has(action.type)) {
    return { valid: true }
  }

  // Actions valid for any role
  if (ANY_ROLE_ACTIONS.has(action.type)) {
    return { valid: true }
  }

  // Unknown or missing role — allow with permissive pass (LLM might know better)
  if (!elementRole) {
    return { valid: true }
  }

  const role = elementRole.toLowerCase()

  if (action.type === 'fill') {
    if (FILL_ROLES.has(role)) {
      return { valid: true }
    }
    if (SELECT_ROLES.has(role)) {
      return {
        valid: false,
        error: `Cannot fill() on a '${role}' element — fill is for text inputs. Try 'select' to choose an option.`,
        suggestion: 'select',
      }
    }
    return {
      valid: false,
      error: `Element ${(action as any).ref} is not fillable (role: ${role}). Use a textbox or input element instead.`,
      suggestion: 'click',
    }
  }

  if (action.type === 'clearText') {
    if (FILL_ROLES.has(role)) {
      return { valid: true }
    }
    return {
      valid: false,
      error: `Element ${(action as any).ref} is not fillable (role: ${role}). clearText only works on text inputs. Use a textbox or input element instead.`,
      suggestion: 'click',
    }
  }

  if (action.type === 'select') {
    if (SELECT_ROLES.has(role)) {
      return { valid: true }
    }
    if (FILL_ROLES.has(role)) {
      return {
        valid: false,
        error: `Cannot select() on a '${role}' element — select is for lists. Try 'fill' to type a value instead.`,
        suggestion: 'fill',
      }
    }
    return {
      valid: false,
      error: `Cannot select() on a '${role}' element — select is for list/combo elements.`,
      suggestion: 'click',
    }
  }

  // Unknown action type — allow (forward-compatible)
  return { valid: true }
}
