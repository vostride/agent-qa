// The verifier's answers are scripted JSON; no model runs.

import { describe, expect, it } from 'vitest'
import { asRef } from '@vostride/agent-qa-schema'
import type { ElementInfo } from '@vostride/agent-qa-schema'
import { buildVerifierStableTier } from '../prompts.js'
import { judgeConditions } from '../requested-conditions.js'
import type { CitationSources } from '../requested-conditions.js'
import type { VerificationResult } from '../types.js'
import { VerificationResultSchema } from '../verifier.js'

const identity = (value: string) => value

const PRODUCT_STEP = 'Find and open the product "Everyday Ceramic Mug"'
const PRODUCT_CLICK = '1. click on ref="e34" (button "Everyday Ceramic Mug") → success'
const PRODUCT_SCREEN = [
  'Current page: https://shop.example.test/shop/',
  '- dialog "Everyday Ceramic Mug" [ref=e74]',
  '  - heading "Everyday Ceramic Mug" [ref=e77]',
  '  - button "Add to bag" [ref=e80]',
].join('\n')

function element(ref: string, role: string, name: string): ElementInfo {
  return {
    ref: asRef(ref),
    role,
    name,
    nameNormalized: name.toLowerCase(),
    state: { enabled: true, focused: false, visible: true },
    labels: {},
    attributes: {},
  }
}

const PRODUCT_ELEMENTS = [
  element('e74', 'dialog', 'Everyday Ceramic Mug'),
  element('e77', 'heading', 'Everyday Ceramic Mug'),
  element('e80', 'button', 'Add to bag'),
]

function sources(parts: Partial<CitationSources>): CitationSources {
  return { 'start-screen': '', 'final-screen': '', action: '', read: '', carried: '', ...parts }
}

function verifierAnswer(answer: string): VerificationResult {
  return JSON.parse(answer) as VerificationResult
}

function productAnswer(
  verdict: string,
  dialogs: { name: string; account: string }[],
): string {
  return JSON.stringify({
    conditions: [
      {
        quote: PRODUCT_STEP,
        verdict,
        needs: 'none',
        controlRef: '',
        file: { name: '', match: 'none', text: '' },
        citations: [
          { source: 'action', quote: PRODUCT_CLICK },
          { source: 'final-screen', quote: '- dialog "Everyday Ceramic Mug" [ref=e74]' },
        ],
        reasoning: 'The requested product was selected and its product dialog is now open.',
      },
    ],
    dialogs: dialogs.map((dialog) => ({ ...dialog, reasoning: 'scripted' })),
    isAppError: false,
    reasoning: 'scripted',
  })
}

function judgeProduct(answer: string, extraElements: ElementInfo[] = [], extraScreen = '') {
  return judgeConditions({
    stepText: PRODUCT_STEP,
    output: verifierAnswer(answer),
    sources: sources({
      action: PRODUCT_CLICK,
      'final-screen': `${PRODUCT_SCREEN}${extraScreen}`,
    }),
    mask: identity,
    imageAttached: false,
    ending: 'completion',
    guards: {
      finalElements: [...PRODUCT_ELEMENTS, ...extraElements],
      platform: 'web',
      imageAttached: false,
    },
  })
}

describe('an open dialog the step requested', () => {
  it('the verifier may answer that an open dialog is the state the step asked to open or see', () => {
    const answer = productAnswer('met', [{ name: 'Everyday Ceramic Mug', account: 'requested' }])
    const parsed = VerificationResultSchema.safeParse(JSON.parse(answer))
    expect(parsed.success, 'the verifier schema accepts the requested account').toBe(true)

    const tier = buildVerifierStableTier()
    expect(tier).toContain('requested when it is the state the step asks to open or see')
    expect(tier).toContain('its account (bears-on-condition, requested or unrelated)')
  })

  it('the run 4 product step passes with the product dialog it opened accounted as requested', () => {
    const judged = judgeProduct(
      productAnswer('met', [{ name: 'Everyday Ceramic Mug', account: 'requested' }]),
    )
    expect(judged.evidence.openDialogs).toEqual([
      { name: 'Everyday Ceramic Mug', account: 'requested' },
    ])
    expect(judged.reason).toBe('')
    expect(judged.pass).toBe(true)
  })

  it('a confirmation dialog that bears on a condition still blocks', () => {
    const step = 'Delete the address "12 Elm Street"'
    const click = '1. click on ref="e9" (button "Delete") → success'
    const judged = judgeConditions({
      stepText: step,
      output: verifierAnswer(
        JSON.stringify({
          conditions: [
            {
              quote: step,
              verdict: 'met',
              needs: 'none',
              controlRef: '',
              file: { name: '', match: 'none', text: '' },
              citations: [{ source: 'action', quote: click }],
              reasoning: 'Delete was clicked.',
            },
          ],
          dialogs: [
            { name: 'Delete address?', account: 'bears-on-condition', reasoning: 'scripted' },
          ],
          isAppError: false,
          reasoning: 'scripted',
        }),
      ),
      sources: sources({ action: click, 'final-screen': '- alertdialog "Delete address?" [ref=e20]' }),
      mask: identity,
      imageAttached: false,
      ending: 'completion',
      guards: {
        finalElements: [element('e20', 'alertdialog', 'Delete address?')],
        platform: 'web',
        imageAttached: false,
      },
    })
    expect(judged.pass).toBe(false)
    expect(judged.evidence.openDialogs).toEqual([
      { name: 'Delete address?', account: 'bears-on-condition' },
    ])
    expect(judged.reason).toBe('Not met: open dialog "Delete address?" bears on a condition')

    const beside = judgeProduct(
      productAnswer('met', [
        { name: 'Everyday Ceramic Mug', account: 'requested' },
        { name: 'Unsaved changes', account: 'bears-on-condition' },
      ]),
      [element('e90', 'dialog', 'Unsaved changes')],
      '\n- dialog "Unsaved changes" [ref=e90]',
    )
    expect(beside.pass).toBe(false)
    expect(beside.evidence.openDialogs).toContainEqual({
      name: 'Unsaved changes',
      account: 'bears-on-condition',
    })
    expect(beside.reason).toContain('Not met: open dialog "Unsaved changes" bears on a condition')
  })

  it('an unrelated dialog still does not block', () => {
    const step = 'Click Save'
    const judged = judgeConditions({
      stepText: step,
      output: verifierAnswer(
        JSON.stringify({
          conditions: [
            {
              quote: step,
              verdict: 'met',
              needs: 'none',
              controlRef: '',
              file: { name: '', match: 'none', text: '' },
              citations: [{ source: 'final-screen', quote: 'heading "Saved"' }],
              reasoning: 'The page says Saved.',
            },
          ],
          dialogs: [{ name: 'Cookies', account: 'unrelated', reasoning: 'a cookie banner' }],
          isAppError: false,
          reasoning: 'scripted',
        }),
      ),
      sources: sources({ 'final-screen': '- heading "Saved" [ref=e1]\n- dialog "Cookies" [ref=e2]' }),
      mask: identity,
      imageAttached: false,
      ending: 'completion',
      guards: {
        finalElements: [element('e1', 'heading', 'Saved'), element('e2', 'dialog', 'Cookies')],
        platform: 'web',
        imageAttached: false,
      },
    })
    expect(judged.evidence.openDialogs).toEqual([{ name: 'Cookies', account: 'unrelated' }])
    expect(judged.reason).toBe('')
    expect(judged.pass).toBe(true)
  })

  it('a requested dialog never rescues an unmet condition, and an unaccounted product dialog still blocks', () => {
    const notMet = judgeProduct(
      productAnswer('not-met', [{ name: 'Everyday Ceramic Mug', account: 'requested' }]),
    )
    expect(notMet.pass).toBe(false)
    expect(notMet.reason).toContain('Not met: "Find and open the product "Everyday Ceramic Mug""')

    const unaccounted = judgeProduct(productAnswer('met', []))
    expect(unaccounted.pass).toBe(false)
    expect(unaccounted.evidence.openDialogs).toEqual([
      { name: 'Everyday Ceramic Mug', account: 'unaccounted' },
    ])
    expect(unaccounted.reason).toBe(
      'Unverified: open dialog "Everyday Ceramic Mug" was not accounted for',
    )
  })
})
