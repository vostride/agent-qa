// One classification, `classifyDraftSteps`; the gate and the evaluator only project its rows.

import type { StepClassificationRow } from '@vostride/agent-qa-schema'

/**
 * The minimal structural mirror of a parsed draft's step list.
 *
 * Declared HERE rather than imported because the dependency points the other way — this
 * package never names `core`, where `parseTestFile` lives, and acquiring that import would
 * be an arch lint violation with no legal repair (the `TestOutcomeHistoryLike`
 * precedent in `jobs/kinds.ts`). The HOST parses and flattens: `parseTestFile` yields steps
 * as `string | { step: string }`, and the caller narrows to text before handing them down
 * (the parse-at-host precedent in `cli/src/curation/authoring-test-discovery.ts`).
 */
export interface ParsedDraftStepsLike {
  readonly steps: readonly string[]
}

// Matched on the step's leading token, exactly and case-insensitively.
export const ASSERTION_VERBS = [
  'assert',
  'check',
  'confirm',
  'ensure',
  'expect',
  'verify',
] as const

// Read only at the leading token of a clause after a separator, so `Submit button` is an element.
export const ACTION_VERBS = [
  'click',
  'drag',
  'enter',
  'fill',
  'hover',
  'navigate',
  'open',
  'press',
  'scroll',
  'select',
  'submit',
  'type',
  'upload',
  'visit',
] as const

// Matched exactly against the normalised remainder, never as a substring of the raw step.
export const VACUOUS_ASSERTION_PHRASES = [
  'it works',
  'no errors',
  'no errors occurred',
  'page appears',
  'page displayed',
  'page is displayed',
  'page loaded',
  'page loads',
  'page works',
] as const

// Concrete only beside a named element: `is visible` alone does not say what is visible.
export const EXPECTED_STATE_TERMS = [
  'checked',
  'disabled',
  'empty',
  'enabled',
  'hidden',
  'selected',
  'unchecked',
  'visible',
] as const

// Page-whole nouns are absent: listing `form` here would let `the form is empty` pass.
export const ELEMENT_NOUNS = [
  'alert',
  'banner',
  'button',
  'checkbox',
  'dialog',
  'dropdown',
  'field',
  'footer',
  'header',
  'heading',
  'icon',
  'image',
  'input',
  'label',
  'link',
  'list',
  'menu',
  'modal',
  'option',
  'panel',
  'popup',
  'radio',
  'row',
  'sidebar',
  'slider',
  'spinner',
  'tab',
  'table',
  'textbox',
  'toast',
  'toggle',
  'toolbar',
  'tooltip',
] as const

// Read only inside the leftward walk; disjoint from `ELEMENT_NOUNS` and `EXPECTED_STATE_TERMS`.
export const PAGE_WHOLE_NOUNS = [
  'app',
  'browser',
  'content',
  'form',
  'page',
  'screen',
  'site',
] as const

// The only tokens the walk may cross; conjunctions stay out so it never crosses a clause boundary.
export const FUNCTION_WORDS = [
  'are',
  'be',
  'been',
  'being',
  'is',
  'not',
  'still',
  'was',
  'were',
] as const

// Each pattern is anchored at both ends and applied to one token of a quoted value, never to prose.
export const CAPTURE_SIGNATURE_PATTERNS = [
  { name: 'iso-8601-timestamp', pattern: /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/ },
  { name: 'long-hex', pattern: /^[0-9a-f]{16,}$/i },
  { name: 'opaque-id', pattern: /^(?:sess|session|tok|token|sk|pk|id|ref|txn|ord)[_-][A-Za-z0-9]{8,}$/i },
  { name: 'uuid', pattern: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i },
] as const

// Kept apart from `chat/clause-split.ts`'s set, so changing one does not move the other's gate.
const MIXED_STEP_SEPARATORS = [' and ', ' then ', ';', ','] as const

/** Leading determiners stripped before the vacuity lexicon is consulted. */
const LEADING_ARTICLES = ['a', 'an', 'that', 'the'] as const

const TRAILING_PUNCTUATION_RE = /[.!?,;:\s]+$/
const QUOTED_LITERAL_RE = /"([^"]*)"/g

// A currency symbol marks a value the page displays, so bare numbers and vague totals stay refused.
const MONEY_AMOUNT_RE = /(?<![\p{L}\p{N}])[$€£¥₹]\d+(?:[.,]\d+)*(?![\p{L}\p{N}])/gu

// The contract shape cli's `corpus-static-gates.test.ts` pins.
export interface AssertionStrengthStep {
  readonly text: string
  readonly kind: 'assertion' | 'action'
  readonly falsifiable: boolean
  readonly captureSignatureHits: string[]
}

/** @see AssertionStrengthStep */
export interface AssertionStrengthResult {
  readonly falsifiable: boolean
  readonly steps: AssertionStrengthStep[]
}

// A consumer recounting the table would give a second answer, so the counts ride the result.
export interface AssertionStrengthGateResult {
  readonly pass: boolean
  readonly assertionStepCount: number
  readonly falsifiableAssertionCount: number
  readonly reason: string
  readonly table: StepClassificationRow[]
}

function normalizeToken(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z]/g, '')
}

function leadingToken(text: string): string {
  return normalizeToken(text.trim().split(/\s+/)[0] ?? '')
}

function isAssertionVerb(token: string): boolean {
  return (ASSERTION_VERBS as readonly string[]).includes(token)
}

function isActionVerb(token: string): boolean {
  return (ACTION_VERBS as readonly string[]).includes(token)
}

// Unfiltered, for the tautology check: an action that typed `""` did type it.
function quotedSpans(text: string): string[] {
  return [...text.matchAll(QUOTED_LITERAL_RE)].map((match) => match[1] ?? '')
}

// Trim, not falsiness: `" "` expects as little as `""`; the tautology check reads `quotedSpans`.
function quotedLiterals(text: string): string[] {
  return quotedSpans(text).filter((literal) => literal.trim() !== '')
}

/** The step with every double-quoted span removed, so prose scans cannot read a literal. */
function unquotedResidue(text: string): string {
  return text.replace(QUOTED_LITERAL_RE, ' ')
}

function moneyAmounts(text: string): string[] {
  return unquotedResidue(text).match(MONEY_AMOUNT_RE) ?? []
}

/** The step after its leading token, byte-for-byte — every caller normalizes for itself. */
function afterLeadingToken(text: string): string {
  const trimmed = text.trim()
  const boundary = trimmed.search(/\s/)

  return boundary === -1 ? '' : trimmed.slice(boundary + 1).trim()
}

/**
 * The assertion remainder the vacuity lexicon is matched against, EXACTLY.
 *
 * Leading verb, then leading articles one at a time, then trailing punctuation. Articles are
 * stripped iteratively because `that the page is displayed` carries two, and a single pass
 * would leave a remainder that no member can equal — which reads as "not vacuous" and is the
 * failure direction that costs a user a bad test.
 */
function vacuityRemainder(text: string): string {
  let remainder = afterLeadingToken(text).toLowerCase().replace(/\s+/g, ' ').trim()

  for (;;) {
    const head = remainder.split(' ')[0] ?? ''
    if (!(LEADING_ARTICLES as readonly string[]).includes(head)) break
    remainder = remainder.slice(head.length).trim()
  }
  return remainder.replace(TRAILING_PUNCTUATION_RE, '')
}

// Quoted spans are removed first, so a literal reading `Click here to continue` is no instruction.
function isMixedActAndVerify(text: string): boolean {
  const residue = unquotedResidue(text)

  for (const separator of MIXED_STEP_SEPARATORS) {
    const pieces = residue.split(separator)
    if (pieces.length < 2) continue
    if (pieces.slice(1).some((piece) => isActionVerb(leadingToken(piece)))) return true
  }
  return false
}

// Walks left from each state term past function words only; an element noun there resolves true.
function namesElementInExpectedState(text: string): boolean {
  const tokens = afterLeadingToken(unquotedResidue(text)).split(/\s+/).map(normalizeToken)

  for (let index = 0; index < tokens.length; index += 1) {
    if (!(EXPECTED_STATE_TERMS as readonly string[]).includes(tokens[index] ?? '')) continue

    for (let left = index - 1; left >= 0; left -= 1) {
      const token = tokens[left] ?? ''
      if ((ELEMENT_NOUNS as readonly string[]).includes(token)) return true
      if ((PAGE_WHOLE_NOUNS as readonly string[]).includes(token)) break
      if (!(FUNCTION_WORDS as readonly string[]).includes(token)) break
    }
  }
  return false
}

// Per token of each literal, so an id inside a sentence is caught; reported sorted and deduped.
function captureSignatureHits(literals: readonly string[]): string[] {
  const hits = new Set<string>()

  for (const literal of literals) {
    for (const token of literal.split(/\s+/)) {
      for (const entry of CAPTURE_SIGNATURE_PATTERNS) {
        if (entry.pattern.test(token)) hits.add(entry.name)
      }
    }
  }
  return [...hits].sort()
}

// Prior-action spans accumulate in order, so an assertion cannot restate content entered later.
export function classifyDraftSteps(steps: readonly string[]): StepClassificationRow[] {
  const priorActionLiterals = new Set<string>()
  const rows: StepClassificationRow[] = []

  for (const stepText of steps) {
    const spans = quotedSpans(stepText)
    const literals = quotedLiterals(stepText)

    if (!isAssertionVerb(leadingToken(stepText))) {
      for (const span of spans) priorActionLiterals.add(span)
      for (const amount of moneyAmounts(stepText)) priorActionLiterals.add(amount)
      rows.push({ stepText, role: 'action', falsifiable: false, captureSignatureHits: [] })
      continue
    }

    const vacuityHit = (VACUOUS_ASSERTION_PHRASES as readonly string[])
      .find((phrase) => phrase === vacuityRemainder(stepText))
    const hits = captureSignatureHits(literals)
    const amounts = moneyAmounts(stepText)
    const tautology = [...spans, ...amounts].some((value) => priorActionLiterals.has(value))
    const concrete =
      literals.length > 0 || amounts.length > 0 || namesElementInExpectedState(stepText)

    rows.push({
      stepText,
      role: 'assertion',
      falsifiable:
        concrete
        && vacuityHit === undefined
        && hits.length === 0
        && !tautology
        && !isMixedActAndVerify(stepText),
      captureSignatureHits: hits,
      ...(vacuityHit === undefined ? {} : { vacuityHit }),
      ...(tautology ? { tautologyHit: true } : {}),
    })
  }
  return rows
}

function gateReason(rows: readonly StepClassificationRow[]): string {
  const assertions = rows.filter((row) => row.role === 'assertion')

  if (assertions.length === 0) {
    return 'no step classifies as an assertion: the draft records what it did, never what should be true'
  }
  if (assertions.some((row) => row.falsifiable)) {
    return `${assertions.filter((row) => row.falsifiable).length} of ${assertions.length} assertion steps reference concrete expected content`
  }

  const causes = new Set<string>()
  for (const row of assertions) {
    if (row.vacuityHit !== undefined) causes.add(`vacuous phrase "${row.vacuityHit}"`)
    if (row.tautologyHit === true) causes.add('restates a prior action\'s own literal')
    for (const hit of row.captureSignatureHits) causes.add(`capture signature ${hit}`)
    // The receipt row has no mixed flag, so a mixed step's cause has to surface in the reason here.
    if (isMixedActAndVerify(row.stepText)) {
      causes.add('acts and verifies in one step, so it has no single verdict to report')
    }
  }
  // This fallback must be true of every step reaching it, and deny no element or literal written.
  if (causes.size === 0) {
    causes.add(
      'no quoted expected value, and no element noun this gate knows stands before an expected-state term with only function words between them',
    )
  }

  return `${assertions.length} assertion step(s), none falsifiable: ${[...causes].sort().join('; ')}`
}

// Both clauses must hold on one row, or a vacuous assertion plus a concrete action would pass.
export function assertionStrengthGate(draft: ParsedDraftStepsLike): AssertionStrengthGateResult {
  const table = classifyDraftSteps(draft.steps)
  const assertions = table.filter((row) => row.role === 'assertion')
  const falsifiable = assertions.filter((row) => row.falsifiable)

  return {
    pass: falsifiable.length > 0,
    assertionStepCount: assertions.length,
    falsifiableAssertionCount: falsifiable.length,
    reason: gateReason(table),
    table,
  }
}

// Maps the receipt's `stepText`/`role` to the corpus contract's `text`/`kind`; no second judgment.
export function evaluateAssertionStrength(steps: readonly string[]): AssertionStrengthResult {
  const table = classifyDraftSteps(steps)

  return {
    falsifiable: table.some((row) => row.role === 'assertion' && row.falsifiable),
    steps: table.map((row) => ({
      text: row.stepText,
      kind: row.role,
      falsifiable: row.falsifiable,
      captureSignatureHits: row.captureSignatureHits,
    })),
  }
}
