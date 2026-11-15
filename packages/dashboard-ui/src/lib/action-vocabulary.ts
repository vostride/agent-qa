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
  click: { past: 'Clicked', infinitive: 'click' },
  doubleClick: { past: 'Double-clicked', infinitive: 'double-click' },
  rightClick: { past: 'Right-clicked', infinitive: 'right-click' },
  hover: { past: 'Hovered over', infinitive: 'hover over' },
  focus: { past: 'Focused', infinitive: 'focus' },
  tap: { past: 'Tapped', infinitive: 'tap' },
  doubleTap: { past: 'Double-tapped', infinitive: 'double-tap' },
  multiTap: { past: 'Tapped repeatedly', infinitive: 'tap repeatedly' },
  longpress: { past: 'Long-pressed', infinitive: 'long-press' },
  tapCoordinate: { past: 'Tapped a position', infinitive: 'tap a position' },
  fill: { past: 'Filled', infinitive: 'fill' },
  paste: { past: 'Pasted', infinitive: 'paste' },
  copy: { past: 'Copied', infinitive: 'copy' },
  clearText: { past: 'Cleared', infinitive: 'clear' },
  keypress: { past: 'Pressed', infinitive: 'press' },
  keyevent: { past: 'Sent a key event', infinitive: 'send a key event' },
  select: { past: 'Selected', infinitive: 'select' },
  nativeSelect: { past: 'Selected', infinitive: 'select' },
  pickerSelect: { past: 'Selected', infinitive: 'select' },
  fileUpload: { past: 'Uploaded files', infinitive: 'upload files' },
  scroll: { past: 'Scrolled', infinitive: 'scroll' },
  swipe: { past: 'Swiped', infinitive: 'swipe' },
  drag: { past: 'Dragged', infinitive: 'drag' },
  pinch: { past: 'Pinched', infinitive: 'pinch' },
  swipeFromEdge: { past: 'Swiped from the edge', infinitive: 'swipe from the edge' },
  navigate: { past: 'Navigated', infinitive: 'navigate' },
  tab: { past: 'Changed tabs', infinitive: 'change tabs' },
  openUniversalLink: { past: 'Opened a link', infinitive: 'open a link' },
  assertAI: { past: 'Verified', infinitive: 'verify' },
  assertValue: { past: 'Verified a value', infinitive: 'verify a value' },
  extractAI: { past: 'Extracted information', infinitive: 'extract information' },
  inspect: { past: 'Inspected', infinitive: 'inspect' },
  reportValue: { past: 'Reported a value', infinitive: 'report a value' },
  setVariable: { past: 'Set', infinitive: 'set' },
  uniqueValue: { past: 'Generated a unique value', infinitive: 'generate a unique value' },
  waitFor: { past: 'Waited for', infinitive: 'wait for' },
  waitForUrl: { past: 'Waited for a URL', infinitive: 'wait for a URL' },
  delay: { past: 'Waited', infinitive: 'wait' },
  pressBack: { past: 'Pressed Back', infinitive: 'press Back' },
  pressHome: { past: 'Pressed Home', infinitive: 'press Home' },
  pressRecent: { past: 'Opened recent apps', infinitive: 'open recent apps' },
  pressButton: { past: 'Pressed a device button', infinitive: 'press a device button' },
  hideKeyboard: { past: 'Hid the keyboard', infinitive: 'hide the keyboard' },
  setOrientation: { past: 'Changed orientation', infinitive: 'change orientation' },
  openApp: { past: 'Opened an app', infinitive: 'open an app' },
  stopApp: { past: 'Stopped an app', infinitive: 'stop an app' },
  openNotifications: { past: 'Opened notifications', infinitive: 'open notifications' },
  openQuickSettings: { past: 'Opened quick settings', infinitive: 'open quick settings' },
  intent: { past: 'Sent an intent', infinitive: 'send an intent' },
  setCookies: { past: 'Set cookies', infinitive: 'set cookies' },
  setLocalStorage: { past: 'Set local storage', infinitive: 'set local storage' },
  storageState: { past: 'Updated storage state', infinitive: 'update storage state' },
  route: { past: 'Configured a network route', infinitive: 'configure a network route' },
  unroute: { past: 'Removed a network route', infinitive: 'remove a network route' },
  networkState: { past: 'Changed network conditions', infinitive: 'change network conditions' },
  handleDialog: { past: 'Handled a dialog', infinitive: 'handle a dialog' },
  executeScript: { past: 'Ran a script', infinitive: 'run a script' },
} satisfies Record<Action['type'], { past: string; infinitive: string }>

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
export const ACTION_FAILURE_SUFFIX = ' — failed'
const UNKNOWN_VERB = { past: 'Performed an action', infinitive: 'perform an action' }
const NAVIGATION_VERBS = {
  back: { past: 'Went back', infinitive: 'go back' },
  forward: { past: 'Went forward', infinitive: 'go forward' },
  reload: { past: 'Reloaded the page', infinitive: 'reload the page' },
  url: { past: 'Navigated to', infinitive: 'navigate to' },
} as const
const INSPECT_LABELS = {
  console: 'console', network: 'network', cookies: 'cookies', localStorage: 'local storage',
} as const

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

export function buildActionSentence(sub: RunDetailSubAction): ActionSentenceModel {
  const action = sub.plannedAction
  const known = Object.hasOwn(ACTION_VERBS, action.type)
  const family = known ? actionFamilyOf(action.type) : undefined
  const noInput = readIdempotentNoopMeta(sub.result)
  const outcome: ActionOutcome = noInput ? 'no-input' : sub.result.success ? 'succeeded' : 'failed'
  let verb = known ? ACTION_VERBS[action.type] : UNKNOWN_VERB
  if (action.type === 'navigate' && Object.hasOwn(NAVIGATION_VERBS, action.to)) {
    verb = NAVIGATION_VERBS[action.to]
  }
  const parts: ActionSentencePart[] = [{
    kind: 'text',
    text: outcome === 'succeeded' ? verb.past
      : outcome === 'no-input' ? `Did not ${verb.infinitive}` : `Tried to ${verb.infinitive}`,
  }]
  const text = (value: string) => { parts.push({ kind: 'text', text: value }) }
  const masked = (value: string) => { parts.push({ kind: 'masked', text: value }) }
  const quoted = (value: string) => {
    text(" '")
    masked(value)
    text("'")
  }

  if (action.type === 'navigate') {
    if (action.to === 'url') quoted(action.url)
  } else if (action.type === 'inspect') {
    if (Object.hasOwn(INSPECT_LABELS, action.what)) text(` ${INSPECT_LABELS[action.what]}`)
  } else if (action.type === 'keypress') {
    for (const [index, key] of (action.keys ?? []).entries()) {
      text(index === 0 ? ' ' : ' + ')
      masked(key)
    }
  } else if (action.type === 'setVariable') {
    if (action.name) quoted(action.name)
    if (action.value !== undefined) {
      text(' to ')
      masked(action.value)
    }
  } else {
    const name = displayTargetName(sub.grounding?.descriptor.name || plannedTarget(action) || '')
    const role = sub.grounding?.descriptor.role
    const value = action.type === 'fill' ? action.text
      : action.type === 'select' || action.type === 'paste' ? action.value : undefined
    if (action.type === 'select' || action.type === 'paste') {
      if (value !== undefined) {
        text(' ')
        masked(value)
      }
      if (name || role) text(action.type === 'select' ? ' in' : ' into')
    }
    if (name) quoted(name)
    else if (role) {
      text(/^[aeiou]/i.test(role) ? ' an ' : ' a ')
      masked(role)
    }
    if (action.type === 'fill' && value !== undefined) {
      text(' with ')
      masked(value)
    }
  }
  if (outcome === 'failed') text(ACTION_FAILURE_SUFFIX)
  if (noInput) {
    text(' — no input sent, already ')
    masked(noInput.currentState)
  }
  return { family, outcome, parts }
}

export function actionSentenceText(model: ActionSentenceModel): string {
  return model.parts.map(part => part.text).join('')
}
