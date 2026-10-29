// Guards only lower a met verdict; none turns a not-met, unverified or inconclusive one into met.

import type {
  CitationSource,
  ConditionGuard,
  ConditionRecord,
  ConditionVerdict,
  ElementInfo,
  OpenDialogAccount,
  Platform,
} from '@vostride/agent-qa-schema'
import { compareSavedFile } from '../compound/file-compare.js'
import type { Action } from '../platform.js'
import { readLine, type RecordedAction, type RecordedRead } from './step-record.js'
import type { ConditionJudgment, DialogAccount } from './types.js'

const REASON_MAX = 200
const NAME_MAX = 300
const LIMIT_LINES_MAX = 50
const WEB_DIALOG_ROLES: ReadonlySet<string> = new Set(['dialog', 'alertdialog'])
const ANDROID_DIALOG_TITLE = 'android:id/alertTitle'
const ANDROID_DIALOG_BUTTON = 'android:id/button1'

function collapse(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function bound(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

/** Lower a met condition: `judged` keeps the verdict the record held before. */
export function demote(
  record: ConditionRecord,
  verdict: ConditionVerdict,
  guard: ConditionGuard,
  reason: string,
): ConditionRecord {
  const judged = record.judged ?? record.verdict
  return {
    ...record,
    verdict,
    ...(judged !== verdict ? { judged } : {}),
    guard,
    reason: bound(collapse(reason), REASON_MAX),
  }
}

export interface OpenDialog {
  name: string
  /** The word an unnamed dialog may be accounted by. */
  role: string
}

/** Every dialog still open among the final screen's elements. */
export function openDialogsOn(elements: readonly ElementInfo[], platform: Platform): OpenDialog[] {
  if (platform === 'web') {
    return elements
      .filter((element) => WEB_DIALOG_ROLES.has(element.role))
      .map((element) => ({ name: element.name, role: element.role }))
  }
  if (platform === 'ios') {
    return elements
      .filter((element) => element.role === 'alert')
      .map((element) => ({ name: element.name, role: 'alert' }))
  }
  const titles = elements.filter(
    (element) => element.attributes['resource-id'] === ANDROID_DIALOG_TITLE,
  )
  if (titles.length > 0) return titles.map((element) => ({ name: element.name, role: 'dialog' }))
  const unnamed = elements.some(
    (element) => element.attributes['resource-id'] === ANDROID_DIALOG_BUTTON,
  )
  return unnamed ? [{ name: '', role: 'dialog' }] : []
}

/**
 * Each open dialog with the verifier's account of it, matched by whitespace-collapsed, masked,
 * case-insensitive name; an unnamed dialog matches an account named '' or its role word. A dialog
 * the verifier did not account for is 'unaccounted'.
 */
export function applyDialogGuard(
  dialogs: readonly OpenDialog[],
  accounts: readonly DialogAccount[],
  mask: (value: string) => string,
): OpenDialogAccount[] {
  const key = (value: string) => collapse(mask(value)).toLowerCase()
  return dialogs.map((dialog) => {
    const name = key(dialog.name)
    const match = accounts.find((account) => {
      const accounted = key(typeof account.name === 'string' ? account.name : '')
      return name === '' ? accounted === '' || accounted === dialog.role : accounted === name
    })
    const account =
      match?.account === 'bears-on-condition' ||
      match?.account === 'requested' ||
      match?.account === 'unrelated'
        ? match.account
        : 'unaccounted'
    return { name: bound(collapse(mask(dialog.name)), NAME_MAX), account }
  })
}

function numeric(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function refOf(controlRef: string): string {
  return collapse(controlRef).replace(/^\[?ref=/, '').replace(/\]$/, '')
}

/**
 * A met limit-max or limit-min condition holds only when the named control's reported value
 * equals the limit the screen reports for it: not-met when it does not, unverified when the
 * control or its limit is not reported.
 */
export function applyLimitGuard(
  record: ConditionRecord,
  judgment: ConditionJudgment,
  finalElements: readonly ElementInfo[],
  mask: (value: string) => string,
): ConditionRecord {
  if (record.verdict !== 'met') return record
  const need = judgment.needs
  if (need !== 'limit-max' && need !== 'limit-min') return record
  const ref = refOf(typeof judgment.controlRef === 'string' ? judgment.controlRef : '')
  if (ref === '') return demote(record, 'unverified', 'limit', 'no control was named for the limit')
  const control = finalElements.find((element) => element.ref === ref)
  if (control === undefined) {
    return demote(record, 'unverified', 'limit', `no control ${mask(ref)} on the final screen`)
  }
  const limitKey = need === 'limit-max' ? 'valuemax' : 'valuemin'
  const nowText = control.attributes.valuenow
  const limitText = control.attributes[limitKey]
  const now = numeric(nowText)
  const limit = numeric(limitText)
  const which = need === 'limit-max' ? 'maximum' : 'minimum'
  if (now === undefined || limit === undefined) {
    const missing = now === undefined ? 'value' : which
    return demote(record, 'unverified', 'limit', `the control reports no ${missing}`)
  }
  if (now === limit) return record
  const value = mask(nowText!.trim())
  const reported = mask(limitText!.trim())
  const reason = need === 'limit-max' ? `${value} of ${reported}` : `${value}, not its minimum ${reported}`
  return demote(record, 'not-met', 'limit', reason)
}

/**
 * The final screen's controls that report a minimum or maximum, one line each:
 * `<role> "<name>" [ref=…] value <now> (min <min>, max <max>)`.
 */
export function renderControlLimits(elements: readonly ElementInfo[]): string {
  const lines: string[] = []
  for (const element of elements) {
    const { valuenow, valuemin, valuemax } = element.attributes
    if (valuemin === undefined && valuemax === undefined) continue
    const limits = [
      ...(valuemin !== undefined ? [`min ${valuemin}`] : []),
      ...(valuemax !== undefined ? [`max ${valuemax}`] : []),
    ].join(', ')
    const name = element.name ? ` "${collapse(element.name)}"` : ''
    lines.push(
      `${element.role}${name} [ref=${element.ref}] value ${valuenow ?? 'not reported'} (${limits})`,
    )
  }
  if (lines.length <= LIMIT_LINES_MAX) return lines.join('\n')
  const omitted = lines.length - LIMIT_LINES_MAX
  return [...lines.slice(0, LIMIT_LINES_MAX), `… ${omitted} more controls omitted …`].join('\n')
}

/** A model citation as written, with where the runner found it. */
export interface CheckedCitation {
  source: CitationSource
  quote: string
  found: boolean | 'unchecked'
}

export interface GuardRecord {
  actions: readonly RecordedAction[]
  reads: readonly RecordedRead[]
}

const LOOSER_OPERATORS: Readonly<Record<string, readonly string[]>> = {
  equals: ['contains', 'isDefined'],
  contains: ['isDefined'],
  gt: ['isDefined'],
  lt: ['isDefined'],
  notEquals: ['isDefined'],
}

function readPassed(read: RecordedRead): boolean | undefined {
  if (read.kind === 'assertValue') return read.assert?.passed
  if (read.kind === 'assertAI') return read.judged
  return undefined
}

function exprOf(actions: readonly RecordedAction[], index: number): string | undefined {
  const action = actions.find((entry) => entry.index === index)?.action as
    | { expr?: unknown }
    | undefined
  return typeof action?.expr === 'string' ? action.expr : undefined
}

function listItems(value: string): string[] {
  return value
    .split(/[,\n]/)
    .map((item) => collapse(item))
    .filter((item) => item.length > 0)
}

function properSubstring(smaller: string, larger: string): boolean {
  return smaller.length > 0 && smaller !== larger && larger.includes(smaller)
}

function fewerItems(smaller: string, larger: string): boolean {
  const all = listItems(larger)
  const some = listItems(smaller)
  return all.length > 1 && some.length < all.length && some.every((item) => all.includes(item))
}

/** Whether `later`, which passed, asks for less than `earlier`, which failed. */
function asksForLess(
  earlier: RecordedRead,
  later: RecordedRead,
  actions: readonly RecordedAction[],
): boolean {
  if (earlier.kind === 'assertAI' && later.kind === 'assertAI') {
    return properSubstring(collapse(later.claim ?? ''), collapse(earlier.claim ?? ''))
  }
  if (earlier.kind !== 'assertValue' || later.kind !== 'assertValue') return false
  const before = earlier.assert
  const after = later.assert
  if (before === undefined || after === undefined || before.source !== after.source) return false
  if (exprOf(actions, earlier.index) !== exprOf(actions, later.index)) return false
  const wanted = before.expected !== undefined ? collapse(before.expected) : undefined
  const asked = after.expected !== undefined ? collapse(after.expected) : undefined
  const looser = LOOSER_OPERATORS[before.op]?.includes(after.op) ?? false
  if (looser && (asked === undefined || (wanted !== undefined && wanted.includes(asked)))) return true
  if (!looser && after.op !== before.op) return false
  if (wanted === undefined || asked === undefined) return false
  return properSubstring(asked, wanted) || fewerItems(asked, wanted)
}

export function lineHolds(line: string, quote: string, mask: (value: string) => string): boolean {
  const raw = collapse(quote)
  if (raw.length === 0) return false
  return collapse(line).includes(raw) || collapse(mask(line)).includes(collapse(mask(raw)))
}

// A met condition citing a passing read is not met when an earlier failed read asked for more.
export function applyNarrowedGuard(
  record: ConditionRecord,
  cited: readonly CheckedCitation[],
  stepRecord: GuardRecord | undefined,
  mask: (value: string) => string,
): ConditionRecord {
  if (record.verdict !== 'met' || stepRecord === undefined) return record
  const reads = stepRecord.reads
  const lines = reads.map(readLine)
  for (const citation of cited) {
    if (citation.found !== true || citation.source !== 'read') continue
    for (let k = 0; k < reads.length; k++) {
      if (readPassed(reads[k]) !== true || !lineHolds(lines[k], citation.quote, mask)) continue
      for (let j = 0; j < k; j++) {
        if (readPassed(reads[j]) !== false) continue
        if (!asksForLess(reads[j], reads[k], stepRecord.actions)) continue
        const why = `an earlier check asking for more failed: ${collapse(mask(lines[j]))}`
        return demote(record, 'not-met', 'narrowed', why)
      }
    }
  }
  return record
}

const OBSERVATION_ACTIONS: ReadonlySet<string> = new Set([
  'assertAI',
  'assertValue',
  'extractAI',
  'reportValue',
  'waitFor',
  'waitForUrl',
  'delay',
  'scroll',
  'inspect',
  'hover',
  'setVariable',
  'navigate',
  'openApp',
  'tab',
  'route',
])

/** Whether an action can change the app's state (every type outside the observation list). */
export function isStateChangingAction(action: Pick<Action, 'type'>): boolean {
  return !OBSERVATION_ACTIONS.has(action.type)
}

function isReopen(action: Action): boolean {
  if (action.type === 'openApp') return true
  if (action.type !== 'navigate') return false
  const to = (action as { to?: unknown }).to
  return to === 'reload' || to === 'url' || to === 'back'
}

export const NO_REREAD_REASON =
  'no re-read after a reload or reopen following the last change; a "Saved" message is the app\'s claim'

/** Whether the step reloaded or reopened after its last state-changing action. */
export function reopenedAfterLastChange(stepRecord: GuardRecord | undefined): boolean {
  const actions = stepRecord?.actions ?? []
  let lastChange = 0
  for (const entry of actions) {
    if (entry.outcome !== 'refused' && isStateChangingAction(entry.action)) {
      lastChange = Math.max(lastChange, entry.index)
    }
  }
  return actions.some(
    (entry) => entry.index > lastChange && entry.outcome === 'success' && isReopen(entry.action),
  )
}

// A met persistence condition holds only after a reload or reopen and with a final-screen citation.
export function applyPersistenceGuard(
  record: ConditionRecord,
  judgment: ConditionJudgment,
  cited: readonly CheckedCitation[],
  stepRecord: GuardRecord | undefined,
): ConditionRecord {
  if (record.verdict !== 'met' || judgment.needs !== 'persistence') return record
  if (!reopenedAfterLastChange(stepRecord)) {
    return demote(record, 'unverified', 'no-reload', NO_REREAD_REASON)
  }
  if (!cited.some((citation) => citation.found === true && citation.source === 'final-screen')) {
    return demote(
      record,
      'unverified',
      'no-reload',
      'the re-read after the reload is not cited from the final screen',
    )
  }
  return record
}

export const VISUAL_TEXT_ONLY_REASON =
  'only a picture can settle this condition and the verifier was given no image'

// A met condition only a picture can settle is inconclusive when no image is attached.
export function applyVisualGuard(
  record: ConditionRecord,
  judgment: ConditionJudgment,
  cited: readonly CheckedCitation[],
  stepRecord: GuardRecord | undefined,
  imageAttached: boolean,
  mask: (value: string) => string,
): ConditionRecord {
  if (imageAttached || record.verdict !== 'met') return record
  const reads = stepRecord?.reads ?? []
  const visualRead = cited.some(
    (citation) =>
      citation.found === true &&
      citation.source === 'read' &&
      reads.some(
        (read) =>
          read.kind === 'assertAI' &&
          read.mode === 'visual' &&
          lineHolds(readLine(read), citation.quote, mask),
      ),
  )
  if (judgment.needs !== 'visual' && !visualRead) return record
  return demote(record, 'inconclusive', 'visual-text-only', VISUAL_TEXT_ONLY_REASON)
}

/** A completed download a file condition may name: its recorded (masked) name and held bytes. */
export interface SavedFile {
  name: string
  /** Undefined when the adapter holds no bytes for it. */
  bytes: Uint8Array | undefined
}

export const NO_SAVED_FILE_REASON =
  'no completed download in this step or carried from an earlier step'

// Candidates are this step's downloads, then carried ones, newest first; `none` checks the name.
export function applyFileGuard(
  record: ConditionRecord,
  judgment: ConditionJudgment,
  files: readonly SavedFile[] | undefined,
  mask: (value: string) => string,
): ConditionRecord {
  if (record.verdict !== 'met' || judgment.needs !== 'file') return record
  const expected = judgment.file
  if (files === undefined || files.length === 0) {
    return demote(record, 'unverified', 'file', NO_SAVED_FILE_REASON)
  }
  if (expected === undefined || typeof expected.name !== 'string' || expected.name.trim() === '') {
    return demote(record, 'unverified', 'file', 'no file name was stated')
  }
  const wanted = mask(expected.name)
  const file = files.find(
    (candidate) => candidate.name === expected.name || candidate.name === wanted,
  )
  if (file === undefined) {
    const found = [...new Set(files.map((candidate) => mask(candidate.name)))].join(', ')
    return {
      ...demote(record, 'not-met', 'file', `no download named ${wanted}; found ${found}`),
      file: { name: 'differs', content: 'unverified' },
    }
  }
  const compared = compareSavedFile({ expected, name: file.name, bytes: file.bytes, mask })
  const { line, ...check } = compared
  if (expected.match === 'none' || check.content === 'match') return { ...record, file: check }
  if (check.content === 'differs') {
    return {
      ...demote(record, 'not-met', 'file', `file content differs at line ${String(line ?? 1)}`),
      file: check,
    }
  }
  const why = file.bytes === undefined
    ? 'the file\'s bytes are not held (over the hold cap or evicted)'
    : 'the file is not UTF-8 text'
  return { ...demote(record, 'unverified', 'file', why), file: check }
}
