import { describe, expect, it } from 'vitest'
import { isToggleElement, TOGGLE_ROLES } from '../toggle'
import {
  isToggleElement as rootIsToggleElement,
  TOGGLE_ROLES as ROOT_TOGGLE_ROLES,
} from '../../index'

describe('isToggleElement', () => {
  it('role switch, checkbox and radio are toggles with no attributes', () => {
    for (const role of ['switch', 'checkbox', 'radio']) {
      expect(isToggleElement({ role })).toBe(true)
      expect(isToggleElement({ role, attributes: {} })).toBe(true)
    }
  })

  it('role button, text or cell with checkable "true" is a toggle', () => {
    for (const role of ['button', 'text', 'cell']) {
      expect(isToggleElement({ role, attributes: { checkable: 'true' } })).toBe(true)
    }
  })

  it('role button, tab, cell or text carrying only selected is not a toggle', () => {
    for (const role of ['button', 'tab', 'cell', 'text']) {
      expect(isToggleElement({ role, attributes: { selected: 'true' } })).toBe(false)
      expect(isToggleElement({ role, attributes: { selected: 'false' } })).toBe(false)
      expect(isToggleElement({ role })).toBe(false)
    }
  })

  it('checkable "false" on role button is not a toggle', () => {
    expect(
      isToggleElement({ role: 'button', attributes: { checkable: 'false', selected: 'true' } }),
    ).toBe(false)
  })

  it('role switch is a toggle whatever its attributes', () => {
    expect(isToggleElement({ role: 'switch', attributes: { checkable: 'false' } })).toBe(true)
    expect(
      isToggleElement({ role: 'switch', attributes: { selected: 'true', checked: 'false' } }),
    ).toBe(true)
  })

  it('TOGGLE_ROLES is exactly switch, checkbox and radio, and the root index re-exports both', () => {
    expect([...TOGGLE_ROLES].sort()).toEqual(['checkbox', 'radio', 'switch'])
    expect(ROOT_TOGGLE_ROLES).toBe(TOGGLE_ROLES)
    expect(rootIsToggleElement).toBe(isToggleElement)
  })
})
