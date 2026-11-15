import { ACTION_FAMILY_BY_TYPE, asRef, type Action, type RunDetailSubAction } from '@vostride/agent-qa-schema'
import { afterEach, describe, expect, it } from 'vitest'

import i18n from '@/i18n'

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
    for (const type of Object.keys(ACTION_VERBS)) {
      const model = buildActionSentence(sub({ type }, false))
      const past = actionSentenceText(buildActionSentence(sub({ type })))
      expect(model.outcome).toBe('failed')
      expect(actionSentenceText(model)).toMatch(/^Tried to .+ — failed$/)
      expect(actionSentenceText(model)).not.toContain(past)
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

describe('an action sentence written from catalog templates', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en')
    i18n.removeResourceBundle('de', 'translation')
  })

  async function german(bundle: Record<string, string>) {
    i18n.addResourceBundle('de', 'translation', bundle)
    await i18n.changeLanguage('de')
  }

  function skipped(action: unknown, descriptor?: { name?: string }): RunDetailSubAction {
    const idempotentNoop = { currentState: 'on', inputSent: false }
    return {
      ...sub(action, false, descriptor),
      result: { success: false, metadata: { idempotentNoop } },
    }
  }

  type Descriptor = { name?: string; role?: string }

  function sentence(action: unknown, success = true, descriptor?: Descriptor) {
    const { buildActionSentence, actionSentenceText } = vocabulary()
    return actionSentenceText(buildActionSentence(sub(action, success, descriptor)))
  }

  it('gives every verb a past sentence, a failed attempt and a skipped one in English', () => {
    const { buildActionSentence, actionSentenceText, ACTION_VERBS } = vocabulary()
    const actions: unknown[] = [
      ...Object.keys(ACTION_VERBS).map((type) => ({ type })),
      ...['back', 'forward', 'reload', 'url'].map((to) => ({
        type: 'navigate',
        to,
        url: 'https://example.test',
      })),
      { type: 'futureAction' },
    ]
    for (const action of actions) {
      const done = sentence(action)
      expect(done).not.toMatch(/^(Tried to|Did not) /)
      expect(done).not.toContain(' — ')
      expect(sentence(action, false)).toMatch(/^Tried to .+ — failed$/)
      expect(actionSentenceText(buildActionSentence(skipped(action)))).toMatch(
        /^Did not .+ — no input sent, already on$/,
      )
    }
  })

  it('reads the English sentences with a name, a role, a value or nothing', () => {
    const email = { type: 'fill', text: 'ada@example.test' }
    expect(sentence(email, true, { name: 'Email' })).toBe("Filled 'Email' with ada@example.test")
    expect(sentence(email)).toBe('Filled with ada@example.test')
    expect(sentence({ type: 'fill' }, false, { role: 'textbox' })).toBe(
      'Tried to fill a textbox — failed',
    )
    expect(sentence({ type: 'select', value: 'Norway' }, true, { name: 'Country' })).toBe(
      "Selected Norway in 'Country'",
    )
    expect(sentence({ type: 'select' }, true, { name: 'Country' })).toBe("Selected in 'Country'")
    expect(sentence({ type: 'paste', value: 'hello' }, true, { name: 'Notes' })).toBe(
      "Pasted hello into 'Notes'",
    )
    expect(sentence({ type: 'paste', value: 'hello' }, false, { role: 'editor' })).toBe(
      'Tried to paste hello into an editor — failed',
    )
    expect(sentence({ type: 'keypress', keys: ['Control', 'A'] })).toBe('Pressed Control + A')
    expect(sentence({ type: 'setVariable', name: 'total', value: '42' })).toBe("Set 'total' to 42")
    expect(sentence({ type: 'setVariable', value: '42' }, false)).toBe(
      'Tried to set to 42 — failed',
    )
    expect(sentence({ type: 'hover' }, true, { name: 'Menu' })).toBe("Hovered over 'Menu'")
    expect(sentence({ type: 'futureAction' }, true, { name: 'Widget' })).toBe(
      "Performed an action 'Widget'",
    )
  })

  it('keeps names, roles, values, keys and states as masked parts', () => {
    const { buildActionSentence } = vocabulary()
    const parts = (action: unknown, descriptor?: Descriptor) =>
      buildActionSentence(sub(action, true, descriptor)).parts
    expect(parts({ type: 'click' }, { role: 'button' })).toContainEqual({
      kind: 'masked',
      text: 'button',
    })
    expect(parts({ type: 'navigate', to: 'url', url: 'https://example.test' })).toContainEqual({
      kind: 'masked',
      text: 'https://example.test',
    })
    const keys = parts({ type: 'keypress', keys: ['Control', 'A'] })
    expect(keys).toContainEqual({ kind: 'masked', text: 'Control' })
    expect(keys).toContainEqual({ kind: 'masked', text: 'A' })
    const tap = buildActionSentence(skipped({ type: 'tap' }, { name: 'Wi-Fi' }))
    expect(tap.parts.at(-1)).toEqual({ kind: 'masked', text: 'on' })
  })

  it('leaves no stray space, quote or joiner when there is no target and no value', () => {
    const bare = [
      [{ type: 'fill' }, 'Filled'],
      [{ type: 'select' }, 'Selected'],
      [{ type: 'paste' }, 'Pasted'],
      [{ type: 'setVariable' }, 'Set'],
      [{ type: 'keypress', keys: [] }, 'Pressed'],
      [{ type: 'click' }, 'Clicked'],
    ] as const
    for (const [action, expected] of bare) expect(sentence(action)).toBe(expected)
  })

  it('puts the value before the target when a language writes them in that order', async () => {
    const { buildActionSentence, actionSentenceText } = vocabulary()
    await german({ 'action.fill.done': '{{value}} in {{target}} eingetragen' })
    const fill = { type: 'fill', text: '[secret:PW]' }
    const model = buildActionSentence(sub(fill, true, { name: 'Email' }))
    expect(actionSentenceText(model)).toBe("[secret:PW] in 'Email' eingetragen")
    const at = (text: string) =>
      model.parts.findIndex((part) => part.kind === 'masked' && part.text === text)
    expect(at('[secret:PW]')).toBeGreaterThanOrEqual(0)
    expect(at('Email')).toBeGreaterThan(at('[secret:PW]'))
  })

  it('shows the English sentence for a verb the language leaves out', async () => {
    await german({ 'action.fill.done': '{{value}} in {{target}} eingetragen' })
    expect(sentence({ type: 'click' }, false, { name: 'Learn more' })).toBe(
      "Tried to click 'Learn more' — failed",
    )
  })

  it('gives each inspect target a sentence of its own', async () => {
    expect(sentence({ type: 'inspect', what: 'screenshot' })).toBe('Inspected')
    await german({ 'action.inspect.console.done': 'Konsole untersucht' })
    expect(sentence({ type: 'inspect', what: 'console' })).toBe('Konsole untersucht')
    expect(sentence({ type: 'inspect', what: 'network' })).toBe('Inspected network')
  })

  it('uses the base role template for every role in a language without an article variant', async () => {
    await german({
      'action.click.done': '{{target}} angeklickt',
      'action.target.role': 'Element {{role}}',
    })
    expect(sentence({ type: 'click' }, true, { role: 'option' })).toBe('Element option angeklickt')
    expect(sentence({ type: 'click' }, true, { role: 'button' })).toBe('Element button angeklickt')
  })
})
