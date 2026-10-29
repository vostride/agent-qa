import { describe, it, expect } from 'vitest'
import { asRef } from '@vostride/agent-qa-schema'
import { validateAction, ActionValidationError } from '../action-validator.js'

describe('validateAction', () => {
  it('fill on textbox → valid', () => {
    const result = validateAction({ type: 'fill', ref: asRef('e1'), text: 'hello', clearMode: 'replace', submit: false }, 'textbox')
    expect(result.valid).toBe(true)
  })

  it('fill on searchbox → valid', () => {
    const result = validateAction({ type: 'fill', ref: asRef('e1'), text: 'query', clearMode: 'replace', submit: false }, 'searchbox')
    expect(result.valid).toBe(true)
  })

  it('fill on spinbutton → valid', () => {
    const result = validateAction({ type: 'fill', ref: asRef('e1'), text: '42', clearMode: 'replace', submit: false }, 'spinbutton')
    expect(result.valid).toBe(true)
  })

  it('fill on combobox → valid (combobox accepts fill for typing)', () => {
    const result = validateAction({ type: 'fill', ref: asRef('e1'), text: 'option', clearMode: 'replace', submit: false }, 'combobox')
    expect(result.valid).toBe(true)
  })

  it('fill on button → invalid with click suggestion', () => {
    const result = validateAction({ type: 'fill', ref: asRef('e1'), text: 'text', clearMode: 'replace', submit: false }, 'button')
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.error).toContain("not fillable")
      expect(result.error).toContain("button")
      expect(result.suggestion).toBe('click')
    }
  })

  it('fill on listbox → invalid, suggests select', () => {
    const result = validateAction({ type: 'fill', ref: asRef('e1'), text: 'text', clearMode: 'replace', submit: false }, 'listbox')
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.error).toContain("Cannot fill()")
      expect(result.error).toContain("'listbox'")
      expect(result.suggestion).toBe('select')
    }
  })

  it('select on listbox → valid', () => {
    const result = validateAction({ type: 'select', ref: asRef('e1'), value: 'opt1' }, 'listbox')
    expect(result.valid).toBe(true)
  })

  it('select on combobox → valid', () => {
    const result = validateAction({ type: 'select', ref: asRef('e1'), value: 'opt1' }, 'combobox')
    expect(result.valid).toBe(true)
  })

  it('select on textbox → invalid, suggests fill', () => {
    const result = validateAction({ type: 'select', ref: asRef('e1'), value: 'opt1' }, 'textbox')
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.error).toContain("Cannot select()")
      expect(result.error).toContain("'textbox'")
      expect(result.suggestion).toBe('fill')
    }
  })

  it('click on any role → valid', () => {
    for (const role of ['button', 'link', 'textbox', 'listbox', 'heading', 'region']) {
      const result = validateAction({ type: 'click', ref: asRef('e1') }, role)
      expect(result.valid).toBe(true)
    }
  })

  it('hover on any role → valid', () => {
    const result = validateAction({ type: 'hover', ref: asRef('e1') }, 'button')
    expect(result.valid).toBe(true)
  })

  it('keypress on any role → valid', () => {
    const result = validateAction({ type: 'keypress', keys: ['Enter'], mode: 'press' }, 'textbox')
    expect(result.valid).toBe(true)
  })

  it('focus on any role → valid', () => {
    const result = validateAction({ type: 'focus', ref: asRef('e1') }, 'button')
    expect(result.valid).toBe(true)
  })

  it('navigate (no ref) → valid', () => {
    const result = validateAction({ type: 'navigate', to: 'url', url: 'https://example.com' }, undefined)
    expect(result.valid).toBe(true)
  })

  it('scroll (no ref) → valid', () => {
    const result = validateAction({ type: 'scroll', mode: 'direction', direction: 'up', amount: 'page', retryOpposite: false }, undefined)
    expect(result.valid).toBe(true)
  })

  it('waitFor → valid', () => {
    const result = validateAction({ type: 'waitFor', on: 'selector', selector: '.loaded', timeoutMs: 1000 }, undefined)
    expect(result.valid).toBe(true)
  })

  it('assertValue → valid', () => {
    const result = validateAction({ type: 'assertValue', source: 'url', op: 'contains', expected: '/done' }, undefined)
    expect(result.valid).toBe(true)
  })

  it('action on unknown/missing role → valid (permissive)', () => {
    const result = validateAction({ type: 'fill', ref: asRef('e1'), text: 'test', clearMode: 'replace', submit: false }, undefined)
    expect(result.valid).toBe(true)
  })

  it('action on unrecognized role string → valid for click', () => {
    const result = validateAction({ type: 'click', ref: asRef('e1') }, 'weird-custom-role')
    expect(result.valid).toBe(true)
  })

  it('paste on any role -> valid', () => {
    for (const role of ['button', 'textbox', 'searchbox', 'combobox', 'heading']) {
      const result = validateAction({ type: 'paste', ref: asRef('e1'), value: 'hello' }, role)
      expect(result.valid).toBe(true)
    }
  })

  // Folded keyDown/keyUp → keypress modes (no ref → valid on any/missing role).
  it('keypress mode:down (no ref) -> valid', () => {
    const result = validateAction({ type: 'keypress', keys: ['Shift'], mode: 'down' }, undefined)
    expect(result.valid).toBe(true)
  })

  it('keypress mode:up (no ref) -> valid', () => {
    const result = validateAction({ type: 'keypress', keys: ['Shift'], mode: 'up' }, undefined)
    expect(result.valid).toBe(true)
  })

  // Folded refresh/navigateHistory → navigate to-discriminants (no ref → valid).
  it('navigate to:reload (no ref) -> valid', () => {
    const result = validateAction({ type: 'navigate', to: 'reload' }, undefined)
    expect(result.valid).toBe(true)
  })

  it('navigate to:back (no ref) -> valid', () => {
    const result = validateAction({ type: 'navigate', to: 'back' }, undefined)
    expect(result.valid).toBe(true)
  })

  // Folded read* → inspect what-discriminants (no ref → valid).
  it('inspect console (no ref) -> valid', () => {
    const result = validateAction({ type: 'inspect', what: 'console' }, undefined)
    expect(result.valid).toBe(true)
  })

  it('inspect console with level filter -> valid', () => {
    const result = validateAction({ type: 'inspect', what: 'console', level: 'error' }, undefined)
    expect(result.valid).toBe(true)
  })

  it('inspect network (no ref) -> valid', () => {
    const result = validateAction({ type: 'inspect', what: 'network' }, undefined)
    expect(result.valid).toBe(true)
  })

  it('inspect network with urlPattern -> valid', () => {
    const result = validateAction({ type: 'inspect', what: 'network', urlPattern: '/api/' }, undefined)
    expect(result.valid).toBe(true)
  })

  it('inspect cookies (no ref) -> valid', () => {
    const result = validateAction({ type: 'inspect', what: 'cookies' }, undefined)
    expect(result.valid).toBe(true)
  })

  it('inspect cookies with name filter -> valid', () => {
    const result = validateAction({ type: 'inspect', what: 'cookies', name: 'session' }, undefined)
    expect(result.valid).toBe(true)
  })

  it('setCookies (no ref) -> valid', () => {
    const result = validateAction({ type: 'setCookies', cookies: [{ name: 'a', value: 'b' }] }, undefined)
    expect(result.valid).toBe(true)
  })

  it('inspect localStorage (no ref) -> valid', () => {
    const result = validateAction({ type: 'inspect', what: 'localStorage' }, undefined)
    expect(result.valid).toBe(true)
  })

  it('inspect localStorage with key -> valid', () => {
    const result = validateAction({ type: 'inspect', what: 'localStorage', key: 'token' }, undefined)
    expect(result.valid).toBe(true)
  })

  it('setLocalStorage (no ref) -> valid', () => {
    const result = validateAction({ type: 'setLocalStorage', entries: [{ key: 'a', value: 'b' }] }, undefined)
    expect(result.valid).toBe(true)
  })

  it('route (no ref) -> valid', () => {
    const result = validateAction({ type: 'route', urlPattern: '**/api/**', body: '{}' }, undefined)
    expect(result.valid).toBe(true)
  })

  it('networkState offline (no ref) -> valid', () => {
    const result = validateAction({ type: 'networkState', mode: 'offline' }, undefined)
    expect(result.valid).toBe(true)
  })

  it('storageState save (no ref) -> valid', () => {
    const result = validateAction({ type: 'storageState', op: 'save', name: 'authed' }, undefined)
    expect(result.valid).toBe(true)
  })

  it('handleDialog (no ref) -> valid', () => {
    const result = validateAction({ type: 'handleDialog', accept: true }, undefined)
    expect(result.valid).toBe(true)
  })

  it('executeScript (no ref) -> valid', () => {
    const result = validateAction({ type: 'executeScript', command: 'mobile: scroll' }, undefined)
    expect(result.valid).toBe(true)
  })

  it('executeScript with args (no ref) -> valid', () => {
    const result = validateAction({ type: 'executeScript', command: 'mobile: terminateApp', args: { bundleId: 'com.example' } }, undefined)
    expect(result.valid).toBe(true)
  })

  it('allows doubleClick on any role', () => {
    const result = validateAction({ type: 'doubleClick', ref: asRef('e1') }, 'button')
    expect(result.valid).toBe(true)
  })

  it('allows rightClick on any role', () => {
    const result = validateAction({ type: 'rightClick', ref: asRef('e1') }, 'button')
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
