// The one strict matcher for heal, cache and procedure replay; it never picks.

import { describe, expect, it } from 'vitest'

import { asRef } from '@vostride/agent-qa-schema'
import type { ElementInfo } from '@vostride/agent-qa-schema'

import { strictMatch, tidyName } from '../index.js'
import type { StrictMatchResult } from '../index.js'

interface ElementOverrides {
  parentRef?: string
  childRefs?: string[]
  text?: string
}

function element(ref: string, role: string, name: string, overrides: ElementOverrides = {}): ElementInfo {
  const el: ElementInfo = {
    ref: asRef(ref),
    role,
    name,
    nameNormalized: tidyName(name).toLowerCase(),
    state: { enabled: true, focused: false, visible: true },
    labels: {},
    attributes: {},
  }
  if (overrides.parentRef !== undefined || overrides.childRefs !== undefined) {
    el.hierarchy = {
      ...(overrides.parentRef !== undefined ? { parentRef: asRef(overrides.parentRef) } : {}),
      ...(overrides.childRefs !== undefined ? { childRefs: overrides.childRefs.map(asRef) } : {}),
    }
  }
  if (overrides.text !== undefined) el.text = overrides.text
  return el
}

const ADDRESSES: ElementInfo[] = [
  element('e1', 'listitem', '', { childRefs: ['e2'], text: 'Work 7 Elm Street, Springfield' }),
  element('e2', 'button', 'Edit label', { parentRef: 'e1' }),
  element('e3', 'listitem', '', { childRefs: ['e4'], text: 'Home 1 Home Street, Springfield' }),
  element('e4', 'button', 'Edit label', { parentRef: 'e3' }),
  element('e5', 'listitem', '', { childRefs: ['e6'], text: 'Old 9 Oak Road, Springfield' }),
  element('e6', 'button', 'Edit label', { parentRef: 'e5' }),
]

describe('strictMatch', () => {
  it('zero candidates are absent', () => {
    expect(strictMatch({ role: 'button', name: 'Save' }, [])).toEqual<StrictMatchResult>({
      kind: 'absent',
    })
  })

  it('one candidate resolves', () => {
    const elements = [element('e1', 'textbox', 'Email'), element('e2', 'button', 'Save')]
    expect(strictMatch({ role: 'button', name: 'Save' }, elements)).toEqual<StrictMatchResult>({
      kind: 'resolved',
      ref: asRef('e2'),
    })
  })

  it('two identical candidates are not-unique with the count and no ref', () => {
    const elements = [element('e1', 'button', 'Save'), element('e2', 'button', 'Save')]
    const result = strictMatch({ role: 'button', name: 'Save' }, elements)
    expect(result).toEqual<StrictMatchResult>({ kind: 'not-unique', count: 2 })
    expect(result).not.toHaveProperty('ref')
  })

  it("'Invoice 947' never matches 'Invoice 946'", () => {
    const elements = [element('e1', 'link', 'Invoice 946')]
    expect(strictMatch({ role: 'link', name: 'Invoice 947' }, elements)).toEqual({ kind: 'absent' })
  })

  it("'Cart (3)' does not match 'Cart (4)'", () => {
    const elements = [element('e1', 'button', 'Cart (4)')]
    expect(strictMatch({ role: 'button', name: 'Cart (3)' }, elements)).toEqual({ kind: 'absent' })
  })

  it("'Edit  label' (two spaces) matches 'Edit label'", () => {
    const elements = [element('e1', 'button', ' Edit  label\n')]
    expect(strictMatch({ role: 'button', name: 'Edit label' }, elements)).toEqual({
      kind: 'resolved',
      ref: asRef('e1'),
    })
    expect(strictMatch({ role: 'button', name: 'Edit  label' }, [element('e2', 'button', 'Edit label')]))
      .toEqual({ kind: 'resolved', ref: asRef('e2') })
    expect(tidyName('  Edit \t label  ')).toBe('Edit label')
  })

  it("'edit label' does not match 'Edit label'", () => {
    const elements = [element('e1', 'button', 'Edit label')]
    expect(strictMatch({ role: 'button', name: 'edit label' }, elements)).toEqual({ kind: 'absent' })
  })

  it("a 'link' target never matches a 'button' of the same name", () => {
    const elements = [element('e1', 'button', 'Details')]
    expect(strictMatch({ role: 'link', name: 'Details' }, elements)).toEqual({ kind: 'absent' })
  })

  it('three Edit label buttons in three rows: the row decides, or nothing does', () => {
    expect(strictMatch({ role: 'button', name: 'Edit label', row: '7 Elm Street' }, ADDRESSES))
      .toEqual({ kind: 'resolved', ref: asRef('e2') })
    expect(strictMatch({ role: 'button', name: 'Edit label' }, ADDRESSES))
      .toEqual({ kind: 'not-unique', count: 3 })
    expect(strictMatch({ role: 'button', name: 'Edit label', row: '5 Pine Road' }, ADDRESSES))
      .toEqual({ kind: 'absent' })
  })

  it('an element with unknown row text never survives a row-bearing target', () => {
    const elements = [element('e1', 'button', 'Edit label')]
    expect(strictMatch({ role: 'button', name: 'Edit label', row: '7 Elm Street' }, elements))
      .toEqual({ kind: 'absent' })
  })

  it('a row with no words is no row', () => {
    const elements = [element('e1', 'button', 'Edit label')]
    expect(strictMatch({ role: 'button', name: 'Edit label', row: ' , ' }, elements))
      .toEqual({ kind: 'resolved', ref: asRef('e1') })
  })
})
