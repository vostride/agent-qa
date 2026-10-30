import { describe, expect, it } from 'vitest'

import { asRef } from '@vostride/agent-qa-schema'
import type { ElementInfo, ElementLabels } from '@vostride/agent-qa-schema'

import { judgeStatedTarget, renderTargetMismatch } from '../stated-target.js'
import { strictMatch } from '../strict-match.js'
import type { StatedTarget, TargetMismatchReason } from '../stated-target.js'

interface ElementOverrides {
  value?: string
  labels?: ElementLabels
}

function element(role: string, name: string, overrides: ElementOverrides = {}): ElementInfo {
  return {
    ref: asRef('e1'),
    role,
    name,
    nameNormalized: name.toLowerCase(),
    ...(overrides.value !== undefined ? { value: overrides.value } : {}),
    state: { enabled: true, focused: false, visible: true },
    labels: overrides.labels ?? {},
    attributes: {},
  }
}

function reasons(stated: StatedTarget, observed: ElementInfo): TargetMismatchReason[] {
  const judgement = judgeStatedTarget(stated, observed, [observed])
  return judgement.verdict === 'contradicts' ? judgement.reasons : []
}

describe('judgeStatedTarget', () => {
  it('button vs textbox is a role-kind contradiction', () => {
    expect(reasons({ role: 'button', name: 'Submit' }, element('textbox', ''))).toEqual([
      'role-kind',
    ])
  })

  it('button vs link agrees (both press)', () => {
    expect(reasons({ role: 'button', name: 'Help' }, element('link', 'Help'))).toEqual([])
  })

  it('a stated button agrees with an observed text or cell', () => {
    expect(reasons({ role: 'button', name: 'Pay' }, element('text', 'Pay'))).toEqual([])
    expect(reasons({ role: 'button', name: 'Pay' }, element('cell', 'Pay'))).toEqual([])
  })

  it('a stated target with no role never contradicts on role', () => {
    expect(reasons({ name: 'Email' }, element('textbox', 'Email'))).toEqual([])
    expect(reasons({ name: 'Email' }, element('button', 'Email'))).toEqual([])
  })

  it('"Log in" vs "Sign in" agrees', () => {
    expect(reasons({ role: 'button', name: 'Log in' }, element('button', 'Sign in'))).toEqual([])
  })

  it('"Delete" vs "Save" shares no word', () => {
    expect(reasons({ role: 'button', name: 'Delete' }, element('button', 'Save'))).toEqual([
      'name-no-shared-word',
    ])
  })

  it('an unnamed textbox stated "Email" agrees', () => {
    expect(reasons({ role: 'textbox', name: 'Email' }, element('textbox', ''))).toEqual([])
  })

  it('the value, aria-label, placeholder and title are observed words; the test id is not', () => {
    const stated = { role: 'textbox', name: 'Email' }
    const login = (overrides: ElementOverrides) =>
      reasons(stated, element('textbox', 'Login', overrides))
    expect(login({ value: 'email' })).toEqual([])
    expect(login({ labels: { ariaLabel: 'Email' } })).toEqual([])
    expect(login({ labels: { placeholder: 'Email' } })).toEqual([])
    expect(login({ labels: { title: 'Email' } })).toEqual([])
    expect(login({ labels: { testId: 'email' } })).toEqual(['name-no-shared-word'])
  })

  it('"Invoice 947" vs "Invoice 946" is a name-number contradiction', () => {
    expect(reasons({ role: 'link', name: 'Invoice 947' }, element('link', 'Invoice 946'))).toEqual([
      'name-number',
    ])
  })

  it('"Invoice 947" vs "Invoice 947" agrees', () => {
    const observed = element('link', 'Invoice 947')
    expect(reasons({ role: 'link', name: 'Invoice 947' }, observed)).toEqual([])
  })

  it('"Cart" vs "Cart (3)" agrees (only one side has a number)', () => {
    expect(reasons({ role: 'button', name: 'Cart' }, element('button', 'Cart (3)'))).toEqual([])
  })

  it('"Invoice 947" vs "Invoice 947 due `2026-10-31`" agrees (every stated number is observed)', () => {
    const observed = element('link', 'Invoice 947 due 2026-10-31')
    expect(reasons({ role: 'link', name: 'Invoice 947' }, observed)).toEqual([])
  })

  it('"Pay $1234.50" vs "Pay $1,234.50" agrees (a thousands separator is ignored)', () => {
    expect(
      reasons({ role: 'button', name: 'Pay $1234.50' }, element('button', 'Pay $1,234.50')),
    ).toEqual([])
    expect(
      reasons({ role: 'button', name: 'Pay $1234.50' }, element('button', 'Pay $1，234.50')),
    ).toEqual([])
  })

  it('"Pay $1,234.50" vs "Pay $1,235.50" is a name-number contradiction', () => {
    expect(
      reasons({ role: 'button', name: 'Pay $1,234.50' }, element('button', 'Pay $1,235.50')),
    ).toEqual(['name-number'])
  })

  it('"Rows 1,2" vs "Rows 12" is a name-number contradiction (only a thousands separator is ignored)', () => {
    expect(reasons({ role: 'button', name: 'Rows 1,2' }, element('button', 'Rows 12'))).toEqual([
      'name-number',
    ])
  })

  // A digit group is one number to the shared-word rule too.
  it('"1234" vs "1,234" agrees (a digit group is one number)', () => {
    expect(reasons({ role: 'button', name: '1234' }, element('button', '1,234'))).toEqual([])
  })

  it('"1,234" vs "1234" agrees', () => {
    expect(reasons({ role: 'button', name: '1,234' }, element('button', '1234'))).toEqual([])
  })

  it('"1234" vs "1 234" with a narrow no-break space agrees', () => {
    expect(reasons({ role: 'button', name: '1234' }, element('button', '1\u202F234'))).toEqual([])
  })

  it('"1234" vs "1 234" with a no-break space agrees', () => {
    expect(reasons({ role: 'button', name: '1234' }, element('button', '1\u00A0234'))).toEqual([])
  })

  it('"Weight 1.234" vs "Weight 1234" is a name-number contradiction (a dot is never a separator)', () => {
    expect(
      reasons({ role: 'button', name: 'Weight 1.234' }, element('button', 'Weight 1234')),
    ).toEqual(['name-number'])
  })

  it('a full-width "Ｓｕｂｍｉｔ" agrees with "Submit"', () => {
    const observed = element('button', 'Submit')
    expect(reasons({ role: 'button', name: 'Ｓｕｂｍｉｔ' }, observed)).toEqual([])
  })

  it('"SUBMIT" agrees with "Submit"', () => {
    expect(reasons({ role: 'button', name: 'SUBMIT' }, element('button', 'Submit'))).toEqual([])
  })

  it('an agreeing judgement reports whether a row was stated', () => {
    const observed = element('button', 'Edit label')
    const unrowed = judgeStatedTarget({ role: 'button', name: 'Edit label' }, observed, [observed])
    expect(unrowed).toEqual({ verdict: 'agrees', rowStated: false, rowKnown: false })
    const rowed = { role: 'button', name: 'Edit label', row: '7 Elm Street' }
    expect(judgeStatedTarget(rowed, observed, [observed])).toMatchObject({
      verdict: 'agrees',
      rowStated: true,
    })
  })

  it('renderTargetMismatch names both identities on one line', () => {
    const line = renderTargetMismatch({
      lane: 'ref',
      ref: 'e4',
      stated: { role: 'button', name: 'Submit' },
      observed: { role: 'textbox', name: 'First\nSecond' },
      reasons: ['role-kind'],
    })
    expect(line.startsWith('target-mismatch: ')).toBe(true)
    expect(line).toContain('"Submit"')
    expect(line).toContain('"First Second"')
    expect(line).toContain('button')
    expect(line).toContain('textbox')
    expect(line).not.toContain('\n')
  })

  it('renderTargetMismatch caps each name at 80 characters', () => {
    const line = renderTargetMismatch({
      lane: 'ref',
      ref: 'e4',
      stated: { role: 'button', name: 'x'.repeat(200) },
      observed: { role: 'button', name: 'Save' },
      reasons: ['name-no-shared-word'],
    })
    expect(line).toContain(`"${'x'.repeat(80)}…"`)
    expect(line).not.toContain('x'.repeat(81))
  })

  // A leaf's row carries every enclosing treeitem's own line.
  it('leaves with one name under different grandparents are told apart', () => {
    const treeitem = (ref: string, name: string, parentRef?: string): ElementInfo => ({
      ...element('treeitem', name),
      ref: asRef(ref),
      ...(parentRef !== undefined ? { hierarchy: { parentRef: asRef(parentRef) } } : {}),
    })
    const elements = [
      treeitem('e1', 'Invoices'),
      treeitem('e2', '2025', 'e1'),
      treeitem('e3', 'Q1', 'e2'),
      treeitem('e4', 'Receipts'),
      treeitem('e5', '2025', 'e4'),
      treeitem('e6', 'Q1', 'e5'),
    ]
    const [invoicesQ1, receiptsQ1] = [elements[2], elements[5]]

    expect(strictMatch({ role: 'treeitem', name: 'Q1', row: 'Receipts 2025' }, elements)).toEqual({
      kind: 'resolved',
      ref: receiptsQ1.ref,
    })
    expect(strictMatch({ role: 'treeitem', name: 'Q1', row: 'Invoices 2025' }, elements)).toEqual({
      kind: 'resolved',
      ref: invoicesQ1.ref,
    })
    const stated = { role: 'treeitem', name: 'Q1', row: 'Receipts' }
    expect(judgeStatedTarget(stated, invoicesQ1, elements)).toMatchObject({
      verdict: 'contradicts',
      reasons: ['row'],
    })
    expect(judgeStatedTarget(stated, receiptsQ1, elements)).toMatchObject({
      verdict: 'agrees',
      rowStated: true,
      rowKnown: true,
    })
  })

  // A comma run agrees under its grouped or its list reading.
  it('a stated order inside a comma list of orders agrees', () => {
    expect(reasons({ role: 'link', name: 'Order 947' }, element('link', 'Orders 947,948'))).toEqual(
      [],
    )
    const track = (rowName: string) => {
      const row: ElementInfo = { ...element('row', rowName), ref: asRef('r1') }
      const button: ElementInfo = {
        ...element('button', 'Track'),
        ref: asRef('b1'),
        hierarchy: { parentRef: asRef('r1') },
      }
      return judgeStatedTarget(
        { role: 'button', name: 'Track', row: 'Order 947' },
        button,
        [row, button],
      )
    }
    expect(track('Orders 947,948')).toMatchObject({
      verdict: 'agrees',
      rowStated: true,
      rowKnown: true,
    })
    expect(track('Orders 946,948')).toMatchObject({ verdict: 'contradicts', reasons: ['row'] })
  })

  it('a lakh-grouped number agrees with its plain spelling', () => {
    expect(
      reasons({ role: 'button', name: 'Pay 100000' }, element('button', 'Pay 1,00,000')),
    ).toEqual([])
    expect(
      reasons({ role: 'button', name: 'Pay 1,00,000' }, element('button', 'Pay 100000')),
    ).toEqual([])
    expect(
      reasons({ role: 'button', name: 'Pay 1,00,000' }, element('button', 'Pay 1,00,001')),
    ).toEqual(['name-number'])
  })
})
