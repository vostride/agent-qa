// The stated-target judge.
// CRITICAL: provider-neutral + storage-neutral. No node:* imports, no fs/sharp, no
// core/model/adapter package imports — imports only schema types.
//
// Every element action carries, beside its ref, the element the planner meant: its role, its
// name and, when a label repeats, its row words. Before dispatch the loop judges that stated
// target against the element the ref names. Only a CLEAR contradiction is refused:
//   - role-kind: both roles are in ROLE_KIND and their kinds differ (a textbox where a button
//     was stated). Roles outside the map never contradict on role — mobile often exposes a
//     pressable control as `text` or `group`.
//   - name-no-shared-word: the element has words (name, value, aria-label, placeholder, title)
//     and no stated name word is one of them. A nameless element never contradicts on name.
//   - name-number: both names carry numbers and a stated number is absent from the element's name
//     ("Invoice 947" stated, "Invoice 946" found) — the shared word "Invoice" alone would let it
//     pass. Extra numbers in the element's name never refuse (438 gap round, WR-03, within D-03).
//   - row: a row was stated, the element's row is known (row-text.ts) and the stated row words
//     are not in it. An empty stated row is not stated; an unknown row never contradicts.
// All of them read words and numbers through row-text.ts, never a second tokenizer, and compare
// the NFKC-normalized tokens it produces (438 gap round 2, WR-11, completing WR-03; 444.1 D-16;
// within D-03). Grouping separators: `,`, `_`, U+202F and U+00A0 before exactly three digits
// ("1,234" equals "1234", "$1,234.50" equals "$1234.50"), and a well-formed lakh group
// ("1,00,000" equals "100000"). Not grouping: U+2009 and U+2007 (NFKC makes them a plain space),
// `'`, U+066C, and `.`, a decimal point. A comma run reads as a grouped number (wordTokens) or a
// list (listWordTokens), and a rule agrees when both texts read the same way, either way, agree:
// "Order 947" agrees with "Orders 947,948", while "Invoice 947" against "Invoice 946" and
// "Rows 1,2" against "Rows 12" still refuse.
// A paraphrase that shares a word ("Log in" for "Sign in") agrees; exact equality is never
// required. A refusal names both identities and never picks a substitute element.
//
// M2 injection boundary: names are opaque comparison data only — never interpolated into a
// selector or an instruction, never evaluated.
//
// Pure functions: no recording, no side effects. Redaction is the caller's job.

import type { ElementInfo } from '@vostride/agent-qa-schema'
import { listWordTokens, rowContains, rowTextOf, wordTokens } from './row-text.js'

/** The element the planner meant beside its ref; `row` names a repeated label's row. */
export interface StatedTarget {
  role?: string
  name: string
  row?: string
}

/** The element lanes an action can carry a stated target on. */
export type StatedTargetLane = 'ref' | 'fromRef' | 'toRef'

/** The stated target per element lane, kept by the gate for the pre-dispatch check. */
export type StatedTargets = Partial<Record<StatedTargetLane, StatedTarget>>

export type RoleKind = 'press' | 'entry' | 'toggle' | 'choice' | 'range'

export const ROLE_KIND: Readonly<Record<string, RoleKind>> = {
  button: 'press',
  link: 'press',
  menuitem: 'press',
  tab: 'press',
  textbox: 'entry',
  searchbox: 'entry',
  spinbutton: 'entry',
  checkbox: 'toggle',
  switch: 'toggle',
  radio: 'toggle',
  menuitemcheckbox: 'toggle',
  menuitemradio: 'toggle',
  combobox: 'choice',
  listbox: 'choice',
  option: 'choice',
  slider: 'range',
}

export type TargetMismatchReason = 'role-kind' | 'name-no-shared-word' | 'name-number' | 'row'

export type StatedTargetJudgement =
  | { verdict: 'agrees'; rowStated: boolean; rowKnown: boolean; observedRow?: string }
  | {
      verdict: 'contradicts'
      reasons: TargetMismatchReason[]
      rowStated: boolean
      observedRow?: string
    }

const NUMBER_TOKEN = /^\p{N}+$/u

type Reading = (text: string | undefined) => string[]

const READINGS: readonly Reading[] = [wordTokens, listWordTokens]

function numbersDiffer(stated: string, observed: string): boolean {
  return READINGS.every((read) => {
    const statedNumbers = read(stated).filter((word) => NUMBER_TOKEN.test(word))
    const observedNumbers = read(observed).filter((word) => NUMBER_TOKEN.test(word))
    if (statedNumbers.length === 0 || observedNumbers.length === 0) return false
    return statedNumbers.some((number) => !observedNumbers.includes(number))
  })
}

function observedWords(element: ElementInfo, read: Reading): Set<string> {
  const { testId: _testId, ...labels } = element.labels
  const sources = [element.name, element.value, ...Object.values(labels)]
  const words = new Set<string>()
  for (const source of sources) {
    if (typeof source !== 'string') continue
    for (const word of read(source)) words.add(word)
  }
  return words
}

function sharesWord(statedName: string, element: ElementInfo): boolean {
  return READINGS.some((read) => {
    const observed = observedWords(element, read)
    return read(statedName).some((word) => observed.has(word))
  })
}

/**
 * Judge a stated target against the element its ref names. `elements` is the observation
 * the element belongs to; the element's row is read from it.
 */
export function judgeStatedTarget(
  stated: StatedTarget,
  element: ElementInfo,
  elements: readonly ElementInfo[],
): StatedTargetJudgement {
  const reasons: TargetMismatchReason[] = []

  const statedKind = stated.role !== undefined ? ROLE_KIND[stated.role] : undefined
  const observedKind = ROLE_KIND[element.role]
  if (statedKind !== undefined && observedKind !== undefined && statedKind !== observedKind) {
    reasons.push('role-kind')
  }

  if (observedWords(element, wordTokens).size > 0 && wordTokens(stated.name).length > 0) {
    if (!sharesWord(stated.name, element)) reasons.push('name-no-shared-word')
    if (numbersDiffer(stated.name, element.name)) reasons.push('name-number')
  }

  const statedRow =
    typeof stated.row === 'string' && stated.row.trim().length > 0 ? stated.row : undefined
  const rowStated = statedRow !== undefined
  const observedRow = rowTextOf(element, elements)
  const rowKnown = observedRow !== undefined
  if (statedRow !== undefined && observedRow !== undefined && !rowContains(observedRow, statedRow)) {
    reasons.push('row')
  }

  const row = observedRow !== undefined ? { observedRow } : {}
  return reasons.length > 0
    ? { verdict: 'contradicts', reasons, rowStated, ...row }
    : { verdict: 'agrees', rowStated, rowKnown, ...row }
}

/** One identity as the refusal message renders it. */
export interface TargetIdentity {
  role?: string
  name: string
  row?: string
}

export interface TargetMismatchInput {
  lane: StatedTargetLane
  ref: string
  stated: TargetIdentity
  observed: TargetIdentity
  reasons: readonly TargetMismatchReason[]
}

const MESSAGE_TEXT_CAP = 80

function quoted(text: string): string {
  const oneLine = text.replace(/\s*[\r\n]+\s*/g, ' ')
  const capped =
    oneLine.length > MESSAGE_TEXT_CAP ? `${oneLine.slice(0, MESSAGE_TEXT_CAP)}…` : oneLine
  return JSON.stringify(capped)
}

function renderIdentity(identity: TargetIdentity): string {
  const role = identity.role !== undefined && identity.role.length > 0 ? identity.role : 'element'
  const row =
    identity.row !== undefined && identity.row.length > 0 ? ` in row ${quoted(identity.row)}` : ''
  return `${role} ${quoted(identity.name)}${row}`
}

/**
 * The self-correcting refusal line the planner reads (§7.1 form). Names are quoted, collapsed to
 * one line and capped, so app text cannot break the message's shape.
 */
export function renderTargetMismatch(input: TargetMismatchInput): string {
  return (
    `target-mismatch: ${input.lane} ${input.ref} is ${renderIdentity(input.observed)}, `
    + `but the stated target is ${renderIdentity(input.stated)} (${input.reasons.join(', ')}). `
    + 'No input was sent. Re-observe the screen and use the ref of the element you mean, '
    + 'or state the element this ref really is.'
  )
}
