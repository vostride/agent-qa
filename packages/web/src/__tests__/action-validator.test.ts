import { describe, it, expect } from 'vitest'
import { validateAction, ActionValidationError } from '../action-validator.js'
import type { Action } from '@vostride/agent-qa-core'

describe('validateAction', () => {
  it('fill on textbox → valid', () => {
    const result = validateAction({ type: 'fill', ref: 'e1', value: 'hello' }, 'textbox')
    expect(result.valid).toBe(true)
  })

  it('fill on searchbox → valid', () => {
    const result = validateAction({ type: 'fill', ref: 'e1', value: 'query' }, 'searchbox')
    expect(result.valid).toBe(true)
  })

  it('fill on spinbutton → valid', () => {
    const result = validateAction({ type: 'fill', ref: 'e1', value: '42' }, 'spinbutton')
    expect(result.valid).toBe(true)
  })

  it('fill on combobox → valid (combobox accepts fill for typing)', () => {
    const result = validateAction({ type: 'fill', ref: 'e1', value: 'option' }, 'combobox')
    expect(result.valid).toBe(true)
  })

  it('fill on button → invalid with click suggestion', () => {
    const result = validateAction({ type: 'fill', ref: 'e1', value: 'text' }, 'button')
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.error).toContain("not fillable")
      expect(result.error).toContain("button")
      expect(result.suggestion).toBe('click')
    }
  })

  it('fill on listbox → invalid, suggests select', () => {
    const result = validateAction({ type: 'fill', ref: 'e1', value: 'text' }, 'listbox')
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.error).toContain("Cannot fill()")
      expect(result.error).toContain("'listbox'")
      expect(result.suggestion).toBe('select')
    }
  })

  it('select on listbox → valid', () => {
    const result = validateAction({ type: 'select', ref: 'e1', value: 'opt1' }, 'listbox')
    expect(result.valid).toBe(true)
  })

  it('select on combobox → valid', () => {
    const result = validateAction({ type: 'select', ref: 'e1', value: 'opt1' }, 'combobox')
    expect(result.valid).toBe(true)
  })

  it('select on textbox → invalid, suggests fill', () => {
    const result = validateAction({ type: 'select', ref: 'e1', value: 'opt1' }, 'textbox')
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.error).toContain("Cannot select()")
      expect(result.error).toContain("'textbox'")
      expect(result.suggestion).toBe('fill')
    }
  })

  it('click on any role → valid', () => {
    for (const role of ['button', 'link', 'textbox', 'listbox', 'heading', 'region']) {
      const result = validateAction({ type: 'click', ref: 'e1' }, role)
      expect(result.valid).toBe(true)
    }
  })

  it('hover on any role → valid', () => {
    const result = validateAction({ type: 'hover', ref: 'e1' }, 'button')
    expect(result.valid).toBe(true)
  })

  it('keypress on any role → valid', () => {
    const result = validateAction({ type: 'keypress', keys: ['Enter'] }, 'textbox')
    expect(result.valid).toBe(true)
  })

  it('navigate (no ref) → valid', () => {
    const result = validateAction({ type: 'navigate', url: 'https://example.com' }, undefined)
    expect(result.valid).toBe(true)
  })

  it('scroll (no ref) → valid', () => {
    const result = validateAction({ type: 'scroll', scrollType: 'vertical', value: -500 }, undefined)
    expect(result.valid).toBe(true)
  })

  it('waitFor → valid', () => {
    const result = validateAction({ type: 'waitFor', condition: '.loaded' }, undefined)
    expect(result.valid).toBe(true)
  })

  it('assert → valid', () => {
    const result = validateAction({ type: 'assert', condition: 'text visible' }, undefined)
    expect(result.valid).toBe(true)
  })

  it('action on unknown/missing role → valid (permissive)', () => {
    const result = validateAction({ type: 'fill', ref: 'e1', value: 'test' }, undefined)
    expect(result.valid).toBe(true)
  })

  it('action on unrecognized role string → valid for click', () => {
    const result = validateAction({ type: 'click', ref: 'e1' }, 'weird-custom-role')
    expect(result.valid).toBe(true)
  })

  it('paste on any role -> valid', () => {
    for (const role of ['button', 'textbox', 'searchbox', 'combobox', 'heading']) {
      const result = validateAction({ type: 'paste', ref: 'e1', value: 'hello' } as any, role)
      expect(result.valid).toBe(true)
    }
  })

  it('keyDown (no ref) -> valid', () => {
    const result = validateAction({ type: 'keyDown', key: 'Shift' } as any, undefined)
    expect(result.valid).toBe(true)
  })

  it('keyUp (no ref) -> valid', () => {
    const result = validateAction({ type: 'keyUp', key: 'Shift' } as any, undefined)
    expect(result.valid).toBe(true)
  })

  it('refresh (no ref) -> valid', () => {
    const result = validateAction({ type: 'refresh' } as any, undefined)
    expect(result.valid).toBe(true)
  })

  it('navigateHistory (no ref) -> valid', () => {
    const result = validateAction({ type: 'navigateHistory', direction: 'back' } as any, undefined)
    expect(result.valid).toBe(true)
  })

  it('readConsoleLogs (no ref) -> valid', () => {
    const result = validateAction({ type: 'readConsoleLogs' } as any, undefined)
    expect(result.valid).toBe(true)
  })

  it('readConsoleLogs with level filter -> valid', () => {
    const result = validateAction({ type: 'readConsoleLogs', level: 'error' } as any, undefined)
    expect(result.valid).toBe(true)
  })

  it('readNetworkLogs (no ref) -> valid', () => {
    const result = validateAction({ type: 'readNetworkLogs' } as any, undefined)
    expect(result.valid).toBe(true)
  })

  it('readNetworkLogs with urlPattern -> valid', () => {
    const result = validateAction({ type: 'readNetworkLogs', urlPattern: '/api/' } as any, undefined)
    expect(result.valid).toBe(true)
  })

  it('readCookies (no ref) -> valid', () => {
    const result = validateAction({ type: 'readCookies' } as any, undefined)
    expect(result.valid).toBe(true)
  })

  it('readCookies with name filter -> valid', () => {
    const result = validateAction({ type: 'readCookies', name: 'session' } as any, undefined)
    expect(result.valid).toBe(true)
  })

  it('setCookies (no ref) -> valid', () => {
    const result = validateAction({ type: 'setCookies', cookies: [{ name: 'a', value: 'b' }] } as any, undefined)
    expect(result.valid).toBe(true)
  })

  it('readLocalStorage (no ref) -> valid', () => {
    const result = validateAction({ type: 'readLocalStorage' } as any, undefined)
    expect(result.valid).toBe(true)
  })

  it('readLocalStorage with key -> valid', () => {
    const result = validateAction({ type: 'readLocalStorage', key: 'token' } as any, undefined)
    expect(result.valid).toBe(true)
  })

  it('setLocalStorage (no ref) -> valid', () => {
    const result = validateAction({ type: 'setLocalStorage', entries: [{ key: 'a', value: 'b' }] } as any, undefined)
    expect(result.valid).toBe(true)
  })

  it('executeScript (no ref) -> valid', () => {
    const result = validateAction({ type: 'executeScript', command: 'mobile: scroll' } as any, undefined)
    expect(result.valid).toBe(true)
  })

  it('executeScript with args (no ref) -> valid', () => {
    const result = validateAction({ type: 'executeScript', command: 'mobile: terminateApp', args: { bundleId: 'com.example' } } as any, undefined)
    expect(result.valid).toBe(true)
  })

  it('allows doubleClick on any role', () => {
    const result = validateAction({ type: 'doubleClick', ref: 'e1' } as Action, 'button')
    expect(result.valid).toBe(true)
  })

  it('allows rightClick on any role', () => {
    const result = validateAction({ type: 'rightClick', ref: 'e1' } as Action, 'button')
    expect(result.valid).toBe(true)
  })
})

describe('ActionValidationError', () => {
  it('has name and suggestion fields', () => {
    const err = new ActionValidationError('test error', 'click')
    expect(err.name).toBe('ActionValidationError')
    expect(err.message).toBe('test error')
    expect(err.suggestion).toBe('click')
  })

  it('works without suggestion', () => {
    const err = new ActionValidationError('test error')
    expect(err.suggestion).toBeUndefined()
  })
})
