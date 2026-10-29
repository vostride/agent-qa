import { ACTION_FAMILY_BY_TYPE, asRef, type Action, type RunDetailSubAction } from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'

const modules = import.meta.glob<typeof import('../action-vocabulary')>('../action-vocabulary.ts', { eager: true })
function vocabulary() {
  const module = modules['../action-vocabulary.ts']
  expect(module, 'the shared action sentence builder exists').toBeDefined()
  return module!
}

function sub(action: unknown = { type: 'click' }, success = true, descriptor?: { name?: string; role?: string }): RunDetailSubAction {
  return { testIndex: 0, stepIndex: 0, subActionIndex: 0, plan: 'Planner reasoning',
    plannedAction: action as Action, result: { success }, screenStateHash: 'screen',
    ...(descriptor ? { grounding: { descriptor, attempts: [] } } : {}) }
}

describe('action vocabulary', () => {
  it('SENTENCE-SUCCESS-PAST', () => {
    const { buildActionSentence, actionSentenceText } = vocabulary()
    const model = buildActionSentence(sub(undefined, true, { name: 'Learn more' }))
    expect(actionSentenceText(model)).toBe("Clicked 'Learn more'")
    expect(model).toMatchObject({ family: 'pointer', outcome: 'succeeded' })
    expect(model.parts).toContainEqual({ kind: 'masked', text: 'Learn more' })
  })
  it('SENTENCE-FAILURE-TRIED', () => {
    const { buildActionSentence, actionSentenceText, ACTION_VERBS } = vocabulary()
    expect(actionSentenceText(buildActionSentence(sub(undefined, false, { name: 'Learn more' })))).toBe("Tried to click 'Learn more' — failed")
    for (const [type, verb] of Object.entries(ACTION_VERBS)) {
      const model = buildActionSentence(sub({ type }, false))
      expect(model.outcome).toBe('failed')
      expect(actionSentenceText(model)).toMatch(/^Tried to .+ — failed$/)
      expect(model.parts).not.toContainEqual({ kind: 'text', text: verb.past })
    }
  })
  it('SENTENCE-GROUNDING-FIRST', () => {
    const { buildActionSentence, actionSentenceText } = vocabulary()
    const action = { type: 'click', target: { name: 'Address' } }
    expect(actionSentenceText(buildActionSentence(sub(action, true, { name: 'Email' })))).toBe("Clicked 'Email'")
    expect(actionSentenceText(buildActionSentence(sub(action, true)))).toBe("Clicked 'Address'")
  })
  it('SENTENCE-DEGRADES', () => {
    const { buildActionSentence, actionSentenceText } = vocabulary()
    expect(actionSentenceText(buildActionSentence(sub(undefined, true, { role: 'button' })))).toBe('Clicked a button')
    expect(actionSentenceText(buildActionSentence(sub(undefined, true, { role: 'option' })))).toBe('Clicked an option')
    expect(actionSentenceText(buildActionSentence(sub()))).toBe('Clicked')
  })
  it('SENTENCE-SECRET-TEXT', () => {
    const { buildActionSentence, actionSentenceText } = vocabulary()
    const secret = '[secret:PW]'
    for (const action of [{ type: 'fill', text: secret }, { type: 'select', value: secret },
      { type: 'paste', value: secret }, { type: 'setVariable', name: 'password', value: secret },
      { type: 'keypress', keys: [secret] }]) {
      const model = buildActionSentence(sub(action))
      expect(model.parts).toContainEqual({ kind: 'masked', text: secret })
      expect(model.parts.filter(part => part.kind === 'text').some(part => part.text.includes(secret))).toBe(false)
      expect(actionSentenceText(model)).toContain(secret)
    }
  })
  it('SENTENCE-NAVIGATE-BRANCHES', () => {
    const { buildActionSentence, actionSentenceText } = vocabulary()
    for (const [to, past, infinitive] of [['back', 'Went back', 'go back'], ['forward', 'Went forward', 'go forward'],
      ['reload', 'Reloaded the page', 'reload the page'], ['url', "Navigated to 'https://example.test'", "navigate to 'https://example.test'"]]) {
      const action = { type: 'navigate', to, url: 'https://example.test' }
      expect(actionSentenceText(buildActionSentence(sub(action)))).toBe(past)
      expect(actionSentenceText(buildActionSentence(sub(action, false)))).toBe(`Tried to ${infinitive} — failed`)
    }
  })
  it('SENTENCE-INSPECT-BRANCHES', () => {
    const { buildActionSentence, actionSentenceText } = vocabulary()
    for (const [what, label] of [['console', 'console'], ['network', 'network'], ['cookies', 'cookies'], ['localStorage', 'local storage']]) {
      expect(actionSentenceText(buildActionSentence(sub({ type: 'inspect', what })))).toBe(`Inspected ${label}`)
      expect(actionSentenceText(buildActionSentence(sub({ type: 'inspect', what }, false)))).toBe(`Tried to inspect ${label} — failed`)
    }
  })
  it('SENTENCE-UNKNOWN-TYPE', () => {
    const { buildActionSentence, actionSentenceText, UNKNOWN_ACTION_ICON } = vocabulary()
    expect(UNKNOWN_ACTION_ICON).toBeDefined()
    for (const type of ['futureAction', 'constructor', '__proto__']) {
      expect(buildActionSentence(sub({ type })).family).toBeUndefined()
      expect(actionSentenceText(buildActionSentence(sub({ type })))).toBe('Performed an action')
      expect(actionSentenceText(buildActionSentence(sub({ type }, false)))).toBe('Tried to perform an action — failed')
    }
  })
  it('every action type has a verb and every action family an icon', () => {
    const { ACTION_VERBS, ACTION_FAMILY_ICONS } = vocabulary()
    expect(Object.keys(ACTION_VERBS).sort()).toEqual(Object.keys(ACTION_FAMILY_BY_TYPE).sort())
    expect(Object.keys(ACTION_VERBS)).toHaveLength(57)
    expect(Object.keys(ACTION_FAMILY_ICONS).sort()).toEqual([...new Set(Object.values(ACTION_FAMILY_BY_TYPE))].sort())
  })
})

it('SENTENCE-TARGET-ICON-FONT removes decorative private-use glyphs only in display names', () => {
  const { buildActionSentence, actionSentenceText } = vocabulary()
  const name = '\uF291 Products 日本語 👩🏽‍💻 [secret:PW]'
  const recorded = sub(undefined, true, { name })
  const text = actionSentenceText(buildActionSentence(recorded))
  expect(text).toBe("Clicked 'Products 日本語 👩🏽‍💻 [secret:PW]'")
  expect(recorded.grounding?.descriptor.name).toBe(name)
})

// 2026-10-08 (437-03, D-05): a tap that sent no input is never shown as succeeded or failed.
describe('a skipped tap that sent no input', () => {
  function skippedTap(success: boolean, idempotentNoop: Record<string, unknown>): RunDetailSubAction {
    return { testIndex: 0, stepIndex: 0, subActionIndex: 0, plan: 'Planner reasoning',
      plannedAction: { type: 'tap', ref: asRef('wifi') }, grounding: { descriptor: { name: 'Wi-Fi' }, attempts: [] },
      result: { success, metadata: { idempotentNoop } }, screenStateHash: 'screen' }
  }

  it('the action sentence of a skipped tap says no input sent', () => {
    const { buildActionSentence, actionSentenceText, ACTION_OUTCOMES, RESULT_WORDS } = vocabulary()
    const model = buildActionSentence(skippedTap(false, { currentState: 'checked', inputSent: false }))
    expect(model.outcome).toBe('no-input')
    expect(actionSentenceText(model)).toBe("Did not tap 'Wi-Fi' — no input sent, already checked")
    expect(model.parts.at(-1)).toEqual({ kind: 'masked', text: 'checked' })
    expect(actionSentenceText(model)).not.toContain('Tapped')
    expect(actionSentenceText(model)).not.toContain(' — failed')
    expect(ACTION_OUTCOMES).toContain('no-input')
    expect(RESULT_WORDS['no-input']).toBe('no input sent')
  })

  it('an older skipped tap recorded with success true is labelled no input sent too', () => {
    const { buildActionSentence, actionSentenceText } = vocabulary()
    const model = buildActionSentence(skippedTap(true, { currentState: 'checked' }))
    expect(model.outcome).toBe('no-input')
    expect(actionSentenceText(model)).toBe("Did not tap 'Wi-Fi' — no input sent, already checked")
  })
})
