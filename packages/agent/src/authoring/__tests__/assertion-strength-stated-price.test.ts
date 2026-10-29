// C446-STATED-PRICE (446-11, D-25): an unquoted money amount in an assertion is a concrete expected value

import { describe, expect, it } from 'vitest'

import { assertionStrengthGate, classifyDraftSteps } from '../assertion-strength.js'

const LEG_DRAFT = [
  'Open the storefront and find the Everyday Ceramic Mug',
  'Add one Everyday Ceramic Mug to the bag',
  'Open the shopping bag',
  'Verify the bag contains one Everyday Ceramic Mug',
  'Verify the bag total is $29.00',
]

const SCAFFOLD_CART_TOTAL_EXAMPLE = [
  'Navigate to https://playground.vostride.dev/shop/?bug=cart-total',
  "Add Everyday Ceramic Mug to the bag, open the shopping bag, and increase that product's quantity to two.",
  'Verify the bag contains exactly two Everyday Ceramic Mugs and the order total is $53.00.',
]

describe('an unquoted stated price in an assertion', () => {
  it('the leg draft with an unquoted bag total price passes the falsifiable-assertion gate', () => {
    const gate = assertionStrengthGate({ steps: LEG_DRAFT })

    expect(gate.table[4]?.falsifiable, 'the price step is falsifiable').toBe(true)
    expect(gate.table[3]?.falsifiable, 'the step with no stated value stays unfalsifiable').toBe(false)
    expect(gate.falsifiableAssertionCount).toBe(1)
    expect(gate.pass).toBe(true)
    for (const amount of ['£24.00', '€29,00', '¥2900', '₹1,299.50']) {
      const row = classifyDraftSteps([`Verify the bag total is ${amount}`])[0]
      expect(row?.falsifiable, `the bag total stated as ${amount}`).toBe(true)
    }
  })

  it('the scaffold cart total example with an unquoted order total passes the falsifiable-assertion gate', () => {
    const gate = assertionStrengthGate({ steps: SCAFFOLD_CART_TOTAL_EXAMPLE })

    expect(gate.table.map((row) => row.role)).toEqual(['action', 'action', 'assertion'])
    expect(gate.table[2]?.falsifiable, 'the order total step is falsifiable').toBe(true)
    expect(gate.pass).toBe(true)
  })

  it('a price that a prior action typed is still refused as a restatement', () => {
    const gate = assertionStrengthGate({
      steps: ['Type "$29.00" into the Amount field', 'Verify the bag total is $29.00'],
    })

    expect(gate.table[1]?.tautologyHit, 'the restated price is flagged').toBe(true)
    expect(gate.table[1]?.falsifiable).toBe(false)
    expect(gate.pass).toBe(false)
    expect(gate.reason).toContain('restates a prior action')
  })

  it('vague totals, bare numbers and a price beside an action are still refused', () => {
    const refused = [
      'Verify the bag total is correct',
      'Verify the bag total is right',
      'Verify the bag total looks reasonable',
      'Verify the bag total is shown in dollars',
      'Verify the bag shows 1 item',
      'Verify the bag total is 29.00',
      'Verify the bag total is 29 dollars',
      'Verify the bag total is $',
      'Verify the coupon code is SAVE$10',
      'Verify the page loaded',
    ]
    for (const step of refused) {
      expect(assertionStrengthGate({ steps: [step] }).pass, step).toBe(false)
    }

    const mixed = assertionStrengthGate({ steps: ['Verify the bag total is $29.00 and click Checkout'] })
    expect(mixed.pass).toBe(false)
    expect(mixed.reason).toContain('acts and verifies in one step')
  })

  it('an unquoted price a prior action stated is refused as a restatement', () => {
    const drafts = [
      ['Type $29.00 into the Amount field', 'Verify the bag total is $29.00'],
      ['Enter €5 as the tip', 'Check the tip shows €5'],
      ['Type $29.00 into the Amount field', 'Verify the bag total is "$29.00"'],
    ]
    for (const steps of drafts) {
      const gate = assertionStrengthGate({ steps })

      expect(gate.table[1]?.tautologyHit, `${steps[1]} restates ${steps[0]}`).toBe(true)
      expect(gate.table[1]?.falsifiable, steps[1]).toBe(false)
      expect(gate.pass, steps.join(' / ')).toBe(false)
      expect(gate.reason).toContain('restates a prior action')
    }
  })

  it('a different price in a prior action, or the same price in a later action, leaves the stated total falsifiable', () => {
    const drafts = [
      ['Type $10.00 into the Amount field', 'Verify the bag total is $29.00'],
      ['Type $29.00 into the Amount field', 'Verify the bag total is $29'],
      ['Verify the bag total is $29.00', 'Type $29.00 into the Amount field'],
    ]
    for (const steps of drafts) {
      const row = classifyDraftSteps(steps).find((candidate) => candidate.role === 'assertion')

      expect(row?.falsifiable, steps.join(' / ')).toBe(true)
      expect(row?.tautologyHit, steps.join(' / ')).toBeUndefined()
    }
  })
})
