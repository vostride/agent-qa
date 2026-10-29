/**
 * The row renderer `agent-qa doctor` prints with (407-30 · REVIEW IN-06).
 *
 * WHY IT IS NOT IN `doctor.ts`. A command module's public surface should be its command. When the
 * width budget landed in 407-24 the renderer was written where it was used, and its test needed to
 * measure it directly — so seven functions and constants plus four types became public on a module
 * whose only production export had been `createDoctorCommand`, and `IDENTITY_DECORATION` became
 * public with no production caller at all. That is a surface defined by a test rather than by a
 * contract. Here the same symbols are the module's REASON for existing: the test imports the
 * renderer, the command imports what it prints, and `doctor.ts` re-exports nothing.
 *
 * Everything below is carried across from `doctor.ts` verbatim — a relocation, not a rewrite.
 */

// The type import is ERASED at compile time, so it creates NO runtime edge back to `doctor.ts`:
// the only runtime edge is `doctor.ts -> doctor-row.ts`, and this is not an import cycle.
// `CheckStatus` stays in `doctor.ts` because it belongs to the CHECK contract — the same three
// types `doctor-knowledge-checks.ts` imports from there — not to the renderer.
import pc from 'picocolors'
import type { CheckStatus } from './doctor.js'

// ---------------------------------------------------------------------------
// The row renderer.
//
// A diagnostic command is read on the terminal somebody already has. Before this, the composed row
// had no width awareness at all: `padDots` budgeted 60 columns for name-plus-message while the
// composed row is `4 spaces + name + 2 + dots + 2 + message + 2 + status`, and the `Knowledge
// store` FAIL row — whose message embeds a cwd-relative index path — measured 113 columns. At 80
// the terminal soft-wrapped it mid-word and pushed `FAIL` onto the continuation line, detached
// from the check that earned it.
//
// The budget belongs HERE and not in the copy. A message trimmed to fit today grows again the
// first time somebody runs the command from a deeper directory.
// ---------------------------------------------------------------------------

/** The width assumed when neither `process.stdout.columns` nor `COLUMNS` can answer. */
export const DEFAULT_TERMINAL_WIDTH = 80

/**
 * The narrowest width this command will act on, whatever the environment claims.
 *
 * The arithmetic, not a taste: the shortest row this command can compose is FIFTEEN columns —
 * four indent, one name character, two separator, two dots at the `MIN_DOTS` floor, two separator,
 * four status word — and the deepest indent it writes is the ELEVEN-column `Fix: ` hanging indent.
 * Twenty therefore leaves nine content columns beneath the deepest indent and fourteen beneath a
 * continuation. Below it there is effectively no content column at all: `COLUMNS=4` was accepted
 * before this floor and made `width - CONTINUATION_INDENT.length` NEGATIVE, putting every word on
 * a line of its own. A floor is honest where a negative budget is not — it renders a narrow
 * terminal's output as if the terminal were twenty columns, which is readable, instead of
 * shredding it one word per line.
 */
export const MIN_USABLE_WIDTH = 20

const ROW_INDENT = '    '
/** Deeper than a row's own four spaces, so a continuation reads as subordinate to the row above. */
const CONTINUATION_INDENT = '      '
const FIX_PREFIX = '      Fix: '
/** Hanging indent: a wrapped instruction lines up under the first word after `Fix: `. */
const FIX_HANGING_INDENT = ' '.repeat(FIX_PREFIX.length)
/** `padDots`' floor, preserved: the gutter degrades rather than going negative. */
const MIN_DOTS = 2
/** `padDots`' original 60-column name-plus-message target, kept as the PREFERRED dot count. */
const DOT_TARGET_COLUMNS = 60

const STATUS_WORDS = {
  pass: 'PASS',
  warn: 'WARN',
  fail: 'FAIL',
  skip: 'SKIP',
} as const satisfies Record<CheckStatus, string>

export type StatusWord = (typeof STATUS_WORDS)[CheckStatus]

const STATUS_COLOURS: Record<StatusWord, (text: string) => string> = {
  PASS: pc.green,
  WARN: pc.yellow,
  FAIL: pc.red,
  SKIP: pc.dim,
}

/**
 * Colour a status WORD, not a status value.
 *
 * The width arithmetic must never see an escape sequence, so the formatters below deal in the
 * bare four-character word and colour is applied at emit time by handing this function to
 * `composeRow` as a decorator. Taking the word (rather than the `CheckStatus`) is what lets it BE
 * that decorator.
 *
 * That reason never required the parameter to be `string` (407-29 · REVIEW WR-06). `RowDecoration`
 * narrowed alongside it, so the DECORATOR CONTRACT carries the type instead of discarding it: the
 * shape is preserved and the guarantee comes back. With `STATUS_COLOURS` already total over
 * `StatusWord`, there is no cast and no `undefined` branch to fall through — an eighth status is a
 * compile error in TWO places rather than a silently uncoloured word in one.
 */
export function formatStatus(statusWord: StatusWord): string {
  return STATUS_COLOURS[statusWord](statusWord)
}

/**
 * Why the width is resolved in ONE place, and why it is resolved at all.
 *
 * `process.stdout.columns` is the truth when there is a terminal. There often is not: a piped or
 * captured run has no `columns` at all, and a run whose output is being read by a person through
 * `less` has whatever `COLUMNS` that person exported. Somebody who sets `COLUMNS` is telling this
 * command something it has no other way to learn, so it is consulted second. 80 is the last
 * resort because it is the width a terminal is assumed to have when nothing says otherwise — the
 * VT100 default every wrapping convention since has inherited.
 *
 * Whatever the ladder answers is FLOORED at `MIN_USABLE_WIDTH` (407-30 · REVIEW IN-03). That floor
 * bounds what the ENVIRONMENT is allowed to claim; `formatCheckRow` and `formatFixLines` floor
 * their own wrap budgets separately, because a caller can pass any width directly without coming
 * through here at all. Two floors, two different callers, two different jobs.
 */
export function resolveTerminalWidth(): number {
  const columns = process.stdout?.columns
  if (typeof columns === 'number' && Number.isFinite(columns) && columns > 0) {
    return Math.max(MIN_USABLE_WIDTH, Math.floor(columns))
  }
  const fromEnv = Number.parseInt(process.env.COLUMNS ?? '', 10)
  if (Number.isFinite(fromEnv) && fromEnv > 0) return Math.max(MIN_USABLE_WIDTH, fromEnv)
  return DEFAULT_TERMINAL_WIDTH
}

/** The four plain, ANSI-free spans a row is made of. Colour is a property of the SEGMENT. */
export interface RowSegments {
  readonly name: string
  readonly dots: string
  /** The message when it shares the head line; the EMPTY STRING when it moved beneath the row. */
  readonly message: string
  readonly status: StatusWord
}

export interface RowDecoration {
  readonly dots: (segment: string) => string
  readonly status: (segment: StatusWord) => string
}

/** Composes the plain line: the decorators the formatter itself uses to derive `plainLine`. */
export const IDENTITY_DECORATION: RowDecoration = {
  dots: segment => segment,
  status: segment => segment,
}

/**
 * THE ONE PLACE THE COMPOSITION IS WRITTEN DOWN.
 *
 * `formatCheckRow` runs it with identity decorators to derive `plainLine`; the emit loop runs it
 * with `{ dots: pc.dim, status: formatStatus }` to print. There is therefore no second copy of the
 * recipe to drift out of step with the first: the pinned line and the shipped line are the same
 * recipe run twice, and they differ by exactly the escape sequences and by nothing else.
 *
 * A design where the emit loop restated the template would be one string edit away from a pin that
 * silently stopped measuring the line the command actually prints.
 */
export function composeRow(segments: RowSegments, decorate: RowDecoration): string {
  const head = `${ROW_INDENT}${segments.name}  ${decorate.dots(segments.dots)}`
  const middle = segments.message === '' ? '' : `  ${segments.message}`
  return `${head}${middle}  ${decorate.status(segments.status)}`
}

export interface CheckRow extends RowSegments {
  /** The head line, ANSI-free — what every width assertion and the byte-identical pin measure. */
  plainLine: string
  /** Already-indented wrapped message lines; empty when the row fits on one line. */
  continuations: string[]
}

/**
 * Wrap on word boundaries, never inside a word.
 *
 * A word wider than the budget gets its own line UNCUT and is the only line that may exceed the
 * width. That is deliberate: the over-long tokens this command prints are index paths and shas,
 * and a path silently truncated to fit is a diagnostic a person copies and cannot use.
 *
 * The `/\s+/` split is a NO-OP on separators now: every caller hands it a pre-flattened
 * string, so it can no longer be the place where a narrow terminal quietly normalises spacing a
 * wide terminal printed verbatim. The two paths see the same bytes and differ only in where the
 * line breaks fall.
 */
function wrapWords(text: string, budget: number): string[] {
  const words = text.split(/\s+/).filter(word => word.length > 0)
  const lines: string[] = []
  let current = ''

  for (const word of words) {
    if (current === '') {
      current = word
    } else if (current.length + 1 + word.length <= budget) {
      current = `${current} ${word}`
    } else {
      lines.push(current)
      current = word
    }
  }
  if (current !== '') lines.push(current)

  return lines
}

/**
 * The dot gutter, clamped so the composed row cannot exceed the width.
 *
 * The clamp only ever REMOVES dots the 60-column target would have added past the resolved width;
 * it never adds any. That is what makes the byte-identical pin exactly true rather than
 * approximately true — a row that already fits keeps the precise gutter it has today. The
 * overhead is measured by composing with an empty dot run rather than by re-adding the separator
 * widths by hand, so the arithmetic cannot drift from `composeRow`'s template.
 *
 * THE ONE CASE WHERE THE HEAD LINE STILL EXCEEDS THE WIDTH, spelled as arithmetic (407-30 ·
 * REVIEW IN-03). The clamp's OUTER `Math.max` is a floor, so when `affordable < MIN_DOTS` the
 * floor wins and the composed head line comes to `name.length + 14` — four indent, two separator,
 * two dots, two separator, four status word — which is wider than the width by definition of
 * `affordable` having gone below the floor. Two dots is the least gutter that still reads as a
 * gutter, and a name is not the renderer's to truncate: a check whose name has been cut is a
 * check the reader cannot look up. So this line is emitted over-wide and the terminal wraps it.
 * Unlike the long-word exception it CONTAINS SPACES, which is why a census cannot dismiss every
 * over-wide line as one unbroken token.
 */
function segmentsFor(
  name: string,
  message: string,
  statusWord: StatusWord,
  width: number,
): CheckRow {
  const preferred = Math.max(MIN_DOTS, DOT_TARGET_COLUMNS - (name.length + message.length))
  const bare: RowSegments = { name, dots: '', message, status: statusWord }
  const affordable = width - composeRow(bare, IDENTITY_DECORATION).length
  const segments: RowSegments = {
    ...bare,
    dots: '.'.repeat(Math.max(MIN_DOTS, Math.min(preferred, affordable))),
  }

  return {
    ...segments,
    plainLine: composeRow(segments, IDENTITY_DECORATION),
    continuations: [],
  }
}

/**
 * A message is ONE LINE by the time the budget sees it.
 *
 * A producer newline is not a layout instruction — it is a byte that would silently push the
 * status word off the name line, past a length check that counted it as ONE COLUMN. Nothing this
 * renderer prints is a literal the repository controls: an arbitrary `err.message`, a plugin's
 * `auth.message`, a 60-character slice of a provider SDK error and a join of Zod issue messages
 * all arrive here as-is. So the normalisation happens at the door, once, before any arithmetic:
 * every whitespace run — newline, carriage return, tab, form feed — collapses to a single space,
 * and the result is trimmed. A whitespace-only message therefore becomes the empty string and
 * takes the no-message shape, which is the right rendering of nothing to say.
 */
function flatten(message: string): string {
  return message.replace(/\s+/gu, ' ').trim()
}

/**
 * A row in one of TWO shapes, chosen by ONE law: the status word never leaves the name line.
 *
 * The law is only true because the message is FLATTENED first: `String.length` and display
 * columns are the same number for a single line and different numbers for a string carrying a
 * break, and the shape is chosen by comparing that length to the width.
 *
 * A reader scanning a column of statuses is scanning the left-hand names beside them, so a `FAIL`
 * that soft-wrapped onto a continuation line reads as the verdict of the row below it. When the
 * one-line composition fits the width it is emitted exactly as it always was. When it does not,
 * the head line is name + gutter + status and the message follows beneath it, indented and
 * word-wrapped.
 *
 * The return is SEGMENTS rather than finished text because colour is a property of the segment —
 * `dots` is dim, `status` is status-coloured, the message is plain. A formatter that returned
 * composed text would force its caller to re-discover those spans by pattern-matching, which is
 * both fiddly and the likeliest way the byte-identical pin quietly stops measuring the shipped
 * line. Width is a PARAMETER, not a read of `process.stdout`, so a test can measure the renderer
 * at a width it chose — and because it is a parameter, the wrap budget is floored at 1 here the
 * same way `formatFixLines` floors its own. `resolveTerminalWidth` bounds what the environment may
 * claim; this bounds what any CALLER may ask for, and they are different jobs with different
 * callers.
 *
 * TWO lines may exceed the width, and only these two (407-30 · REVIEW IN-03):
 *   1. a word wider than the wrap budget, alone on its line UNCUT — an index path or a sha
 *      silently truncated to fit is a diagnostic a person copies and cannot use;
 *   2. the HEAD line when `segmentsFor`'s dot floor wins, at exactly `name.length + 14` columns
 *      with `name.length + 14 > width`. Unlike the first, this one CONTAINS SPACES, so a
 *      command-level census must CLASSIFY an over-wide line rather than assume it is one token.
 */
export function formatCheckRow(
  name: string,
  message: string,
  status: CheckStatus,
  width: number,
): CheckRow {
  const flat = flatten(message)
  const statusWord = STATUS_WORDS[status]
  const oneLine = segmentsFor(name, flat, statusWord, width)
  if (flat === '' || oneLine.plainLine.length <= width) return oneLine

  const head = segmentsFor(name, '', statusWord, width)
  return {
    ...head,
    continuations: wrapWords(flat, Math.max(1, width - CONTINUATION_INDENT.length))
      .map(line => `${CONTINUATION_INDENT}${line}`),
  }
}

/**
 * The `Fix:` line, wrapped with a hanging indent.
 *
 * The UAT measured this line at 156 columns — the widest the command emits. Its first element
 * still begins with the same six-space `Fix: ` prefix the command has always written, so a
 * substring assertion on a short instruction is unaffected; continuations hang under it so they
 * read as belonging to the row above rather than as rows of their own.
 *
 * Flattened at the door for the same reason the check row is: an instruction carrying a break
 * would otherwise smuggle one past the hanging indent, and a continuation that is not indented
 * reads as a row of its own.
 */
export function formatFixLines(instructions: string, width: number): string[] {
  const flat = flatten(instructions)
  const wrapped = wrapWords(flat, Math.max(1, width - FIX_PREFIX.length))
  // A check with nothing to instruct instructs NOTHING. The guard exists precisely for the case
  // the previous form rendered badly: it returned the bare prefix, a line whose only content is
  // trailing whitespace (407-29 · REVIEW IN-04).
  if (wrapped.length === 0) return []
  return wrapped.map((line, index) => (
    index === 0 ? `${FIX_PREFIX}${line}` : `${FIX_HANGING_INDENT}${line}`
  ))
}
