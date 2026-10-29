// The renderer `agent-qa doctor` prints with, kept apart so the test imports it, not the command.

// The type import is ERASED at compile time, so it creates NO runtime edge back to `doctor.ts`:
// the only runtime edge is `doctor.ts -> doctor-row.ts`, and this is not an import cycle.
// `CheckStatus` stays in `doctor.ts` because it belongs to the CHECK contract — the same three
// types `doctor-knowledge-checks.ts` imports from there — not to the renderer.
import pc from 'picocolors'
import type { CheckStatus } from './doctor.js'

// The width budget lives in the renderer, because a trimmed message grows again in deeper cwds.

/** The width assumed when neither `process.stdout.columns` nor `COLUMNS` can answer. */
export const DEFAULT_TERMINAL_WIDTH = 80

// Below twenty columns the continuation budget goes negative and every word gets its own line.
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

// Takes the bare word so width arithmetic never sees an escape; colour is applied at emit time.
export function formatStatus(statusWord: StatusWord): string {
  return STATUS_COLOURS[statusWord](statusWord)
}

// Columns, then `COLUMNS`, then 80, floored at `MIN_USABLE_WIDTH`; formatters floor separately.
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

// A word wider than the budget gets its own uncut line, because truncated paths are unusable.
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

// The clamp only removes dots past the width; at the dot floor the head line may run over-wide.
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

// A producer newline would push the status off the name line, so whitespace runs collapse first.
function flatten(message: string): string {
  return message.replace(/\s+/gu, ' ').trim()
}

// The status word never leaves the name line; an over-wide message moves beneath it, wrapped.
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
  // A check with nothing to instruct prints no bare prefix line.
  if (wrapped.length === 0) return []
  return wrapped.map((line, index) => (
    index === 0 ? `${FIX_PREFIX}${line}` : `${FIX_HANGING_INDENT}${line}`
  ))
}
