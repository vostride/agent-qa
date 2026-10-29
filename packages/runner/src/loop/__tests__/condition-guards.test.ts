import { describe, expect, it } from 'vitest'
import { asRef } from '@vostride/agent-qa-schema'
import type { ConditionRecord, ElementInfo } from '@vostride/agent-qa-schema'
import {
  applyDialogGuard,
  applyLimitGuard,
  applyNarrowedGuard,
  applyPersistenceGuard,
  isStateChangingAction,
  openDialogsOn,
} from '../condition-guards.js'
import type { CheckedCitation, GuardRecord } from '../condition-guards.js'
import type { Action } from '../../platform.js'
import type { RecordedAction, RecordedRead } from '../step-record.js'
import { judgeConditions } from '../requested-conditions.js'
import type { CitationSources } from '../requested-conditions.js'
import type { ConditionJudgment, VerificationResult } from '../types.js'

const identity = (value: string) => value

function element(
  ref: string,
  role: string,
  name: string,
  attributes: Record<string, string> = {},
): ElementInfo {
  return {
    ref: asRef(ref),
    role,
    name,
    nameNormalized: name.toLowerCase(),
    state: { enabled: true, focused: false, visible: true },
    labels: {},
    attributes,
  }
}

function judgment(overrides: Partial<ConditionJudgment> = {}): ConditionJudgment {
  return {
    quote: 'Set the brightness to its maximum',
    verdict: 'met',
    needs: 'limit-max',
    controlRef: 'e1',
    file: { name: '', match: 'none', text: '' },
    citations: [{ source: 'final-screen', quote: 'slider "Brightness"' }],
    reasoning: 'The slider is at its maximum',
    ...overrides,
  }
}

function met(): ConditionRecord {
  return {
    quote: 'Set the brightness to its maximum',
    verdict: 'met',
    needs: 'limit-max',
    reason: 'The slider is at its maximum',
    citations: [{ source: 'final-screen', quote: 'slider "Brightness"', found: true }],
  }
}

function sources(finalScreen: string): CitationSources {
  return { 'start-screen': '', 'final-screen': finalScreen, action: '', read: '', carried: '' }
}

function output(conditions: ConditionJudgment[]): VerificationResult {
  return { conditions, dialogs: [], isAppError: false, reasoning: 'overall' }
}

describe('condition guards for dialogs and control limits', () => {
  it('an Android alert title is one open dialog named by it', () => {
    const elements = [
      element('e1', 'text', 'Delete address?', { 'resource-id': 'android:id/alertTitle' }),
      element('e2', 'text', 'This cannot be undone', { 'resource-id': 'android:id/message' }),
      element('e3', 'button', 'Delete', { 'resource-id': 'android:id/button1' }),
    ]
    expect(openDialogsOn(elements, 'android')).toEqual([{ name: 'Delete address?', role: 'dialog' }])
    expect(
      openDialogsOn([element('e1', 'button', 'OK', { 'resource-id': 'android:id/button1' })], 'android'),
    ).toEqual([{ name: '', role: 'dialog' }])
  })

  it('an iOS alert is an open dialog and a web alert is not', () => {
    expect(openDialogsOn([element('e1', 'alert', 'Allow notifications?')], 'ios')).toEqual([
      { name: 'Allow notifications?', role: 'alert' },
    ])
    expect(openDialogsOn([element('e1', 'alert', 'Saved')], 'web')).toEqual([])
    expect(openDialogsOn([element('e1', 'alertdialog', 'Delete address?')], 'web')).toEqual([
      { name: 'Delete address?', role: 'alertdialog' },
    ])
  })

  it('a dialog is matched to its account by name, and an unaccounted dialog blocks the pass', () => {
    const dialogs = [
      { name: 'Unsaved  Changes', role: 'dialog' },
      { name: 'Cookies', role: 'dialog' },
      { name: '', role: 'dialog' },
    ]
    const accounts = applyDialogGuard(
      dialogs,
      [
        { name: 'unsaved changes', account: 'bears-on-condition', reasoning: 'r' },
        { name: 'dialog', account: 'unrelated', reasoning: 'r' },
      ],
      identity,
    )
    expect(accounts).toEqual([
      { name: 'Unsaved Changes', account: 'bears-on-condition' },
      { name: 'Cookies', account: 'unaccounted' },
      { name: '', account: 'unrelated' },
    ])

    const judged = judgeConditions({
      stepText: 'Click Save',
      output: {
        ...output([
          judgment({
            quote: 'Click Save',
            needs: 'none',
            controlRef: '',
            citations: [{ source: 'final-screen', quote: 'heading "Saved"' }],
          }),
        ]),
        dialogs: [{ name: 'Cookies', account: 'unrelated', reasoning: 'a cookie banner' }],
      },
      sources: sources('- heading "Saved" [ref=e1]'),
      mask: identity,
      imageAttached: false,
      ending: 'completion',
      guards: {
        finalElements: [element('e1', 'heading', 'Saved'), element('e2', 'dialog', 'Unsaved changes'), element('e3', 'dialog', 'Cookies')],
        platform: 'web',
        imageAttached: false,
      },
    })
    expect(judged.pass).toBe(false)
    expect(judged.evidence.openDialogs).toEqual([
      { name: 'Unsaved changes', account: 'unaccounted' },
      { name: 'Cookies', account: 'unrelated' },
    ])
    expect(judged.reason).toBe('Unverified: open dialog "Unsaved changes" was not accounted for')
  })

  it('a range input at its default maximum meets limit-max', () => {
    const range = element('e1', 'slider', 'Volume', { valuenow: '100', valuemin: '0', valuemax: '100' })
    expect(applyLimitGuard(met(), judgment(), [range], identity)).toEqual(met())
  })

  it('one unit short of the reported maximum is not met', () => {
    const slider = element('e1', 'slider', 'Brightness', {
      valuenow: '65534',
      valuemin: '0',
      valuemax: '65535',
    })
    expect(applyLimitGuard(met(), judgment(), [slider], identity)).toMatchObject({
      verdict: 'not-met',
      judged: 'met',
      guard: 'limit',
      reason: '65534 of 65535',
    })
    const atMin = element('e1', 'slider', 'Brightness', { valuenow: '3', valuemin: '0', valuemax: '9' })
    expect(applyLimitGuard(met(), judgment({ needs: 'limit-min' }), [atMin], identity)).toMatchObject({
      verdict: 'not-met',
      guard: 'limit',
      reason: '3, not its minimum 0',
    })
  })

  it('a control with no reported limit, or no such control, leaves the condition unverified', () => {
    const spin = element('e1', 'spinbutton', 'Volume', { valuenow: '50' })
    expect(applyLimitGuard(met(), judgment(), [spin], identity)).toMatchObject({
      verdict: 'unverified',
      judged: 'met',
      guard: 'limit',
    })
    expect(applyLimitGuard(met(), judgment({ controlRef: 'e9' }), [spin], identity)).toMatchObject({
      verdict: 'unverified',
      guard: 'limit',
    })
  })

  it('a guard never raises a not-met or unverified verdict', () => {
    const atMax = element('e1', 'slider', 'Brightness', {
      valuenow: '65535',
      valuemin: '0',
      valuemax: '65535',
    })
    for (const verdict of ['not-met', 'unverified', 'inconclusive'] as const) {
      const record: ConditionRecord = { ...met(), verdict }
      expect(applyLimitGuard(record, judgment({ verdict }), [atMax], identity)).toEqual(record)
      const judged = judgeConditions({
        stepText: 'Set the brightness to its maximum',
        output: output([judgment({ verdict })]),
        sources: sources('- slider "Brightness" [ref=e1]'),
        mask: identity,
        imageAttached: true,
        ending: 'completion',
        guards: { finalElements: [atMax], platform: 'web', imageAttached: true },
      })
      expect(judged.evidence.conditions[0].verdict).toBe(verdict)
      expect(judged.pass).toBe(false)
    }
  })
})

function assertRead(
  index: number,
  op: string,
  expected: string | undefined,
  passed: boolean,
  source = 'expr',
): RecordedRead {
  const shown = expected !== undefined ? ` "${expected}"` : ''
  return {
    index,
    kind: 'assertValue',
    text: `${source} ${op}${shown}: ${passed ? 'passed' : 'failed'}`,
    assert: { source, op, ...(expected !== undefined ? { expected } : {}), passed },
  }
}

function claimRead(index: number, claim: string, judged: boolean): RecordedRead {
  return {
    index,
    kind: 'assertAI',
    text: `"${claim}": judged ${String(judged)}: r`,
    claim,
    judged,
  }
}

function recorded(index: number, action: Action, outcome: RecordedAction['outcome'] = 'success'): RecordedAction {
  return { index, action, outcome }
}

function readRecord(reads: RecordedRead[]): GuardRecord {
  const expr = "document.getElementById('row').textContent"
  return {
    reads,
    actions: reads.map((read) => recorded(read.index, read.kind === 'assertAI'
      ? { type: 'assertAI', claim: read.claim ?? '', mode: 'text' }
      : { type: 'assertValue', expr, op: 'contains' } as Action)),
  }
}

function citeRead(quote: string): CheckedCitation[] {
  return [{ source: 'read', quote, found: true }]
}

function metOn(quote: string): ConditionRecord {
  return { quote: 'the order row', verdict: 'met', reason: 'r', citations: [{ source: 'read', quote, found: true }] }
}

describe('a passed re-read that narrows a failed assertion', () => {
  const cases: { title: string; reads: RecordedRead[]; cite: string; narrowed: boolean }[] = [
    {
      title: 'a substring of the failed expected value',
      reads: [assertRead(1, 'contains', 'ORD-1001,42.50', false), assertRead(2, 'contains', 'ORD-1001', true)],
      cite: 'contains "ORD-1001": passed',
      narrowed: true,
    },
    {
      title: 'equals loosened to contains',
      reads: [assertRead(1, 'equals', 'Total 42.50', false), assertRead(2, 'contains', 'Total 42.50', true)],
      cite: 'contains "Total 42.50": passed',
      narrowed: true,
    },
    {
      title: 'contains loosened to isDefined',
      reads: [assertRead(1, 'contains', 'ORD-1001', false), assertRead(2, 'isDefined', undefined, true)],
      cite: 'isDefined: passed',
      narrowed: true,
    },
    {
      title: 'fewer listed items',
      reads: [assertRead(1, 'equals', 'A, B, C', false), assertRead(2, 'equals', 'A, C', true)],
      cite: 'equals "A, C": passed',
      narrowed: true,
    },
    {
      title: 'a narrowed assertAI claim',
      reads: [
        claimRead(1, 'the cart shows 3 items and a total of 42.50', false),
        claimRead(2, 'the cart shows 3 items', true),
      ],
      cite: '"the cart shows 3 items": judged true',
      narrowed: true,
    },
    {
      title: 'a different source is not narrowing',
      reads: [
        assertRead(1, 'contains', 'ORD-1001,42.50', false, 'url'),
        assertRead(2, 'contains', 'ORD-1001', true, 'storage'),
      ],
      cite: 'storage contains "ORD-1001": passed',
      narrowed: false,
    },
    {
      title: 'a later stricter check is not narrowing',
      reads: [assertRead(1, 'contains', 'ORD-1001', false), assertRead(2, 'contains', 'ORD-1001,42.50', true)],
      cite: 'contains "ORD-1001,42.50": passed',
      narrowed: false,
    },
  ]

  for (const entry of cases) {
    it(entry.title, () => {
      const result = applyNarrowedGuard(metOn(entry.cite), citeRead(entry.cite), readRecord(entry.reads), identity)
      if (entry.narrowed) {
        expect(result).toMatchObject({ verdict: 'not-met', judged: 'met', guard: 'narrowed' })
        expect(result.reason).toContain('an earlier check asking for more failed: read 1:')
      } else {
        expect(result).toEqual(metOn(entry.cite))
      }
    })
  }
})

describe('persistence proven by a re-read after a reload or reopen', () => {
  it('state-changing actions and observations', () => {
    const changing: Action[] = [
      { type: 'click', ref: asRef('e1') },
      { type: 'fill', ref: asRef('e1'), text: 'x', clearMode: 'replace', submit: false },
      { type: 'select', ref: asRef('e1'), value: 'x' },
      { type: 'keypress', keys: ['Enter'], mode: 'press' },
      { type: 'drag', fromRef: asRef('e1'), toRef: asRef('e2') },
      { type: 'fileUpload', ref: asRef('e1'), files: ['a.txt'] },
      { type: 'clearText', ref: asRef('e1') },
    ]
    for (const action of changing) expect(isStateChangingAction(action), action.type).toBe(true)
    const observing = [
      'assertAI', 'assertValue', 'extractAI', 'reportValue', 'waitFor', 'waitForUrl', 'delay', 'scroll',
      'inspect', 'hover', 'setVariable', 'navigate', 'openApp', 'tab', 'route',
    ]
    for (const type of observing) expect(isStateChangingAction({ type } as Action), type).toBe(false)
  })

  const persisted: ConditionRecord = {
    quote: 'the setting is saved',
    verdict: 'met',
    needs: 'persistence',
    reason: 'r',
    citations: [{ source: 'final-screen', quote: 'heading "Deals emails: on"', found: true }],
  }
  const persistence = judgment({ quote: 'the setting is saved', needs: 'persistence', controlRef: '' })
  const finalCited: CheckedCitation[] = [{ source: 'final-screen', quote: 'heading "Deals emails: on"', found: true }]
  const click = (index: number) => recorded(index, { type: 'click', ref: asRef('e1') })
  const reload = (index: number) => recorded(index, { type: 'navigate', to: 'reload' })

  it('a reopen after the last change and a final-screen citation is met', () => {
    const record = { actions: [click(1), click(2), reload(3)], reads: [] }
    expect(applyPersistenceGuard(persisted, persistence, finalCited, record)).toEqual(persisted)
    const reopened = { actions: [click(1), recorded(2, { type: 'openApp', appName: 'Shop' })], reads: [] }
    expect(applyPersistenceGuard(persisted, persistence, finalCited, reopened)).toEqual(persisted)
  })

  it('a reload before the change, or none, is unverified', () => {
    for (const actions of [[reload(1), click(2), click(3)], [click(1)], []]) {
      expect(applyPersistenceGuard(persisted, persistence, finalCited, { actions, reads: [] })).toMatchObject({
        verdict: 'unverified',
        judged: 'met',
        guard: 'no-reload',
        reason: expect.stringContaining('no re-read after a reload or reopen'),
      })
    }
  })

  it('a re-read not cited from the final screen is unverified', () => {
    const record = { actions: [click(1), reload(2)], reads: [] }
    const fromAction: CheckedCitation[] = [{ source: 'action', quote: '→ success', found: true }]
    expect(applyPersistenceGuard(persisted, persistence, fromAction, record)).toMatchObject({
      verdict: 'unverified',
      guard: 'no-reload',
    })
  })
})
