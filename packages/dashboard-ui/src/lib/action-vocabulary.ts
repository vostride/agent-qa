import {
  actionFamilyOf, readIdempotentNoopMeta, type Action, type ActionFamily, type RunDetailSubAction,
} from '@vostride/agent-qa-schema'
import {
  Braces, CircleDashed, Compass, Hand, Hourglass, MousePointer2, CircleCheck,
  Smartphone, Terminal, TextCursorInput, Wrench, type LucideIcon,
} from 'lucide-react'

import { t } from '@/i18n'
import { textTable } from '@/i18n/text-table'

export const ACTION_VERBS = {
  click: true, doubleClick: true, rightClick: true, hover: true, focus: true, tap: true,
  doubleTap: true, multiTap: true, longpress: true, tapCoordinate: true, fill: true, paste: true,
  copy: true, clearText: true, keypress: true, keyevent: true, select: true, nativeSelect: true,
  pickerSelect: true, fileUpload: true, scroll: true, swipe: true, drag: true, pinch: true,
  swipeFromEdge: true, navigate: true, tab: true, openUniversalLink: true, assertAI: true,
  assertValue: true, extractAI: true, inspect: true, reportValue: true, setVariable: true,
  uniqueValue: true, waitFor: true, waitForUrl: true, delay: true, pressBack: true,
  pressHome: true, pressRecent: true, pressButton: true, hideKeyboard: true, setOrientation: true,
  openApp: true, stopApp: true, openNotifications: true, openQuickSettings: true, intent: true,
  setCookies: true, setLocalStorage: true, storageState: true, route: true, unroute: true,
  networkState: true, handleDialog: true, executeScript: true,
} satisfies Record<Action['type'], true>

export const ACTION_FAMILY_ICONS = {
  pointer: MousePointer2, input: TextCursorInput, gesture: Hand, navigate: Compass,
  verify: CircleCheck, extract: Braces, wait: Hourglass, device: Smartphone,
  environment: Wrench, script: Terminal,
} satisfies Record<ActionFamily, LucideIcon>

export const UNKNOWN_ACTION_ICON = CircleDashed
export type ActionOutcome = 'succeeded' | 'failed' | 'no-input'
export const ACTION_OUTCOMES = ['succeeded', 'failed', 'no-input'] as const satisfies readonly ActionOutcome[]
export const RESULT_WORDS = textTable({
  passed: () => t('action.result.passed'),
  failed: () => t('action.result.failed'),
  healed: () => t('action.result.healed'),
  'no-input': () => t('action.result.noInput'),
})
const NAVIGATIONS = ['back', 'forward', 'reload', 'url'] as const
const INSPECT_TARGETS = ['console', 'network', 'cookies', 'localStorage'] as const

export type ActionSentencePart = { kind: 'text'; text: string } | { kind: 'masked'; text: string }
export interface ActionSentenceModel {
  family: ActionFamily | undefined
  outcome: ActionOutcome
  parts: readonly ActionSentencePart[]
}

function plannedTarget(action: Action): string | undefined {
  if (!('target' in action)) return undefined
  const target = action.target
  if (typeof target === 'string') return target || undefined
  if (target && typeof target === 'object' && 'name' in target && typeof target.name === 'string') {
    return target.name || undefined
  }
  return undefined
}

/** Captured icon-font glyphs have no meaning without the originating font. Display only. */
export function displayTargetName(name: string): string {
  return name.replace(/[\uE000-\uF8FF\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]/gu, '').trim()
}

type Parts = readonly ActionSentencePart[]
type Slots = Readonly<Record<string, Parts | undefined>>
interface Clause {
  verb: string
  slots: Slots
}

const masked = (text: string): Parts => [{ kind: 'masked', text }]

// The template is split before any slot is filled, so recorded text is never read for slots.
function fillTemplate(key: string, slots: Slots, context?: string): Parts {
  const template = String(t(key as never, { skipInterpolation: true, context } as never))
  return template.split(/\{\{\s*(\w+)\s*\}\}/).flatMap((piece, index): Parts => {
    if (index % 2 === 1) return slots[piece] ?? []
    return piece ? [{ kind: 'text', text: piece }] : []
  })
}

// Every slot filled reads the base template; otherwise the variant named after the filled slots.
function variantOf(slots: Slots): string | undefined {
  const names = Object.keys(slots)
  const filled = names.filter((name) => slots[name])
  if (filled.length === names.length) return undefined
  return filled.length ? filled.join('_') : 'bare'
}

const named = (name: string) => fillTemplate('action.target.name', { name: masked(name) })

function targetOf(sub: RunDetailSubAction): Parts | undefined {
  const descriptor = sub.grounding?.descriptor
  const name = displayTargetName(descriptor?.name || plannedTarget(sub.plannedAction) || '')
  if (name) return named(name)
  const role = descriptor?.role
  if (!role) return undefined
  const article = /^[aeiou]/i.test(role) ? 'an' : undefined
  return fillTemplate('action.target.role', { role: masked(role) }, article)
}

function clauseOf(sub: RunDetailSubAction, known: boolean): Clause {
  const action = sub.plannedAction
  if (!known) return { verb: 'unknown', slots: { target: targetOf(sub) } }
  switch (action.type) {
    case 'navigate':
      if (!(NAVIGATIONS as readonly string[]).includes(action.to)) {
        return { verb: 'navigate', slots: {} }
      }
      if (action.to !== 'url') return { verb: `navigate.${action.to}`, slots: {} }
      return { verb: 'navigate.url', slots: { target: named(action.url) } }
    case 'inspect':
      return (INSPECT_TARGETS as readonly string[]).includes(action.what)
        ? { verb: `inspect.${action.what}`, slots: {} }
        : { verb: 'inspect', slots: {} }
    case 'keypress': {
      const keys = (action.keys ?? []).flatMap((key, index): Parts => [
        ...(index === 0 ? [] : [{ kind: 'text' as const, text: ' + ' }]),
        ...masked(key),
      ])
      return { verb: 'keypress', slots: { keys: keys.length ? keys : undefined } }
    }
    case 'setVariable':
      return {
        verb: 'setVariable',
        slots: {
          target: action.name ? named(action.name) : undefined,
          value: action.value === undefined ? undefined : masked(action.value),
        },
      }
    case 'fill':
    case 'select':
    case 'paste': {
      const value = action.type === 'fill' ? action.text : action.value
      return {
        verb: action.type,
        slots: { target: targetOf(sub), value: value === undefined ? undefined : masked(value) },
      }
    }
    default:
      return { verb: action.type, slots: { target: targetOf(sub) } }
  }
}

export function buildActionSentence(sub: RunDetailSubAction): ActionSentenceModel {
  const action = sub.plannedAction
  const known = Object.hasOwn(ACTION_VERBS, action.type)
  const family = known ? actionFamilyOf(action.type) : undefined
  const noInput = readIdempotentNoopMeta(sub.result)
  const outcome: ActionOutcome = noInput ? 'no-input' : sub.result.success ? 'succeeded' : 'failed'
  const form = outcome === 'succeeded' ? 'done' : outcome === 'failed' ? 'tried' : 'skipped'
  const { verb, slots } = clauseOf(sub, known)
  let parts = fillTemplate(`action.${verb}.${form}`, slots, variantOf(slots))
  if (outcome === 'failed') parts = fillTemplate('action.outcome.failed', { sentence: parts })
  if (noInput) {
    parts = fillTemplate('action.outcome.noInput', {
      sentence: parts,
      state: masked(noInput.currentState),
    })
  }
  return { family, outcome, parts }
}

export function actionSentenceText(model: ActionSentenceModel): string {
  return model.parts.map(part => part.text).join('')
}
