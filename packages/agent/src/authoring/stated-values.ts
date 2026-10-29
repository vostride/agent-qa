// Stated values and the steps that lose them; linear and model-free, as the request is untrusted.

type QuoteKind = 'double' | 'curly' | 'single'
type Span = { readonly start: number; readonly end: number }
type Run = { next: number; delimiter: string; pending: Span[]; sentenceLike: boolean }
type Part = { readonly start: number; readonly end: number; readonly quoted?: string }
type RunStart = 'at-once' | 'pending'

const CURRENCY_SYMBOLS = '$€£¥₹'
const NUMBER_SEPARATORS = '.,:/-'
const SINGLE_QUOTE_OPENS_AFTER = ' ([\n'
const SINGLE_QUOTE_CLOSES_BEFORE = ' .,;:!?)]\n'
const LINE_BREAKS = '\n\r  '
const LIST_RUN_STARTS_AFTER = ':.!?'
const QUOTE_MASK = '"'

const MONTH =
  '(?:January|February|March|April|May|June|July|August|September|October|November|December' +
  '|Sept|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\\.?'
const DAY = '\\d{1,2}(?:st|nd|rd|th)?'
const MONTH_NAME_DATE =
  `(?<![\\p{L}\\p{N}])(?:${MONTH} ${DAY}(?:,? \\d{4})?|${DAY} ${MONTH}(?: \\d{4})?)` +
  '(?![\\p{L}\\p{N}])'
const STEP_LABEL =
  '(?<![\\p{L}\\p{N}])(?:Step|step|STEP) ([0-9]+)(?=([:)]|\\.(?=\\s|$)| [-–—]))'
const MONTH_BEFORE = new RegExp(`(?<![\\p{L}\\p{N}])${MONTH} $`, 'u')

const HOST_AND_PORT = /^[A-Za-z][A-Za-z0-9.-]*:\d+(?:\/\S*)?[.,;!?)\]]*$/
const IPV4_ADDRESS = /^\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?(?:\/\S*)?[.,;!?)\]]*$/
const BRACKETED_IPV6 = /^\[[0-9A-Fa-f.:]+\](?::\d+)?(?:\/\S*)?[.,;!?)\]]*$/
const DECADE_ELISION = /^\d0s(?![\p{L}\p{N}'’])/u
const LEADING_UPPERCASE = /^\p{Lu}/u
const LEADING_LETTER_OR_NUMBER = /^[\p{L}\p{N}]/u
const TRAILING_LETTER_OR_NUMBER = /[\p{L}\p{N}]$/u

function tidy(text: string): string {
  return text.normalize('NFC').replace(/\s+/g, ' ').trim()
}

function isDigit(char: string | undefined): boolean {
  return char !== undefined && char >= '0' && char <= '9'
}

function isSeparator(char: string | undefined): boolean {
  return char !== undefined && char.length === 1 && NUMBER_SEPARATORS.includes(char)
}

function letterOrNumberBefore(text: string, index: number): boolean {
  return TRAILING_LETTER_OR_NUMBER.test(text.slice(Math.max(0, index - 2), index))
}

function letterOrNumberAt(text: string, index: number): boolean {
  return LEADING_LETTER_OR_NUMBER.test(text.slice(index, index + 2))
}

// An inch mark (`15"`) and a decade elision such as `'90s` open no quote; `'4K'` is a value.
function openerAt(text: string, index: number): QuoteKind | undefined {
  const char = text[index]
  if (char === '"') return letterOrNumberBefore(text, index) ? undefined : 'double'
  if (char === '“') return 'curly'
  if (char !== "'" && char !== '‘') return undefined
  const before = text[index - 1]
  if (before !== undefined && !SINGLE_QUOTE_OPENS_AFTER.includes(before)) return undefined
  return DECADE_ELISION.test(text.slice(index + 1, index + 5)) ? undefined : 'single'
}

function closerOf(text: string, kind: QuoteKind, from: number): number {
  if (kind === 'double') return text.indexOf('"', from)
  if (kind === 'curly') return text.indexOf('”', from)
  for (let index = from; index < text.length; index += 1) {
    const char = text[index]
    if (char !== "'" && char !== '’') continue
    const after = text[index + 1]
    if (after === undefined || SINGLE_QUOTE_CLOSES_BEFORE.includes(after)) return index
  }
  return -1
}

// An IPv6 literal holds `::` or at least six colons, so a bracketed time or ratio is a value.
function holdsIpv6Groups(inside: string): boolean {
  return inside.includes('::') || inside.split(':').length > 6
}

// An IP or bracketed IPv6 host, with or without a port, states nothing.
function isAddress(chunk: string): boolean {
  const bare = chunk.startsWith('(') ? chunk.slice(1) : chunk
  return (
    bare.includes('://') ||
    bare.startsWith('www.') ||
    HOST_AND_PORT.test(bare) ||
    IPV4_ADDRESS.test(bare) ||
    (BRACKETED_IPV6.test(bare) && holdsIpv6Groups(bare.slice(1, bare.indexOf(']'))))
  )
}

function collapsedSpace(space: string): string {
  return [...space].some((char) => LINE_BREAKS.includes(char)) ? '\n' : ' '
}

function isSpace(char: string | undefined): boolean {
  return char === ' ' || char === '\n'
}

function blank(chars: string[], span: Span): void {
  for (let index = span.start; index < span.end; index += 1) chars[index] = ' '
}

function runStartAt(text: string, index: number): RunStart | undefined {
  if (index === 0 || (index === 1 && isSpace(text[0]))) return 'at-once'
  const before = text[index - 1]
  if (before === '\n') return 'at-once'
  if (before === ' ' && LIST_RUN_STARTS_AFTER.includes(text[index - 2] ?? ' ')) return 'pending'
  return undefined
}

function endsSentence(text: string, tokenEnd: number): boolean {
  return isSpace(text[tokenEnd]) && LEADING_UPPERCASE.test(text.slice(tokenEnd + 1, tokenEnd + 3))
}

// A step label counts like a list marker; the open run and the held candidate stay apart.
function blankStepLabels(text: string, chars: string[]): void {
  const open: Run = { next: 0, delimiter: '', pending: [], sentenceLike: false }
  const held: Run = { next: 0, delimiter: '', pending: [], sentenceLike: false }
  for (const match of text.matchAll(new RegExp(STEP_LABEL, 'gu'))) {
    const digits = match[1] ?? ''
    const mark = match[2] ?? ''
    const delimiter = mark.startsWith(' ') ? '-' : mark
    const end = match.index + match[0].length
    const span = { start: end - digits.length, end }
    const start = runStartAt(text, match.index)
    const headingEnds = endsSentence(text, end + mark.length)
    const continues = (run: Run) =>
      run.next >= 2 &&
      digits === String(run.next) &&
      (delimiter === run.delimiter || start !== undefined)
    if (digits === '1' && start === 'at-once') {
      open.next = 2
      open.delimiter = delimiter
      blank(chars, span)
      held.next = 0
      held.pending = []
    } else if (digits === '1' && start === 'pending') {
      held.next = 2
      held.delimiter = delimiter
      held.pending = [span]
      held.sentenceLike = headingEnds
    } else if (continues(open)) {
      blank(chars, span)
      open.next += 1
      open.delimiter = delimiter
    } else if (continues(held)) {
      held.next += 1
      if (held.pending.length === 1 && held.sentenceLike && headingEnds) {
        held.pending.push(span)
        continue
      }
      for (const waiting of held.pending) blank(chars, waiting)
      blank(chars, span)
      open.next = held.next
      open.delimiter = delimiter
      held.next = 0
      held.pending = []
    }
  }
}

// A list counts from 1 at a line, sentence or colon start; a month name's number is its day.
function blankListMarkers(text: string, chars: string[]): void {
  const open: Run = { next: 0, delimiter: '', pending: [], sentenceLike: false }
  const held: Run = { next: 0, delimiter: '', pending: [], sentenceLike: false }
  let index = 0
  while (index < text.length) {
    const tokenStarts = index === 0 || isSpace(text[index - 1])
    const opens = text[index] === '('
    const digitsStart = opens ? index + 1 : index
    let end = digitsStart
    while (tokenStarts && isDigit(text[end])) end += 1
    if (end === digitsStart) {
      index += 1
      continue
    }
    const closer = text[end]
    let delimiter: string | undefined
    if (opens) delimiter = closer === ')' ? '()' : undefined
    else if (closer === '.' || closer === ')') delimiter = closer
    const tokenEnd = end + 1
    if (delimiter === undefined || !isSpace(text[tokenEnd])) {
      index = end
      continue
    }
    const digits = text.slice(digitsStart, end)
    const span = { start: index, end: tokenEnd }
    const start = digits === '1' ? runStartAt(text, index) : undefined
    index = tokenEnd
    if (!opens && MONTH_BEFORE.test(text.slice(Math.max(0, span.start - 12), span.start))) {
      const heldNext =
        held.next >= 2 && delimiter === held.delimiter && digits === String(held.next)
      if (start === 'pending' || heldNext) {
        held.next = 0
        held.delimiter = ''
        held.pending = []
      }
      continue
    }
    if (start === 'at-once') {
      open.next = 2
      open.delimiter = delimiter
      blank(chars, span)
      held.next = 0
      held.delimiter = ''
      held.pending = []
    } else if (start === 'pending') {
      held.next = 2
      held.delimiter = delimiter
      held.pending = [span]
      held.sentenceLike = endsSentence(text, tokenEnd)
    } else if (delimiter === open.delimiter && digits === String(open.next)) {
      blank(chars, span)
      open.next += 1
    } else if (delimiter === held.delimiter && digits === String(held.next)) {
      held.next += 1
      if (held.pending.length === 1 && held.sentenceLike && endsSentence(text, tokenEnd)) {
        held.pending.push(span)
        continue
      }
      for (const waiting of held.pending) blank(chars, waiting)
      blank(chars, span)
      open.next = held.next
      open.delimiter = delimiter
      held.next = 0
      held.delimiter = ''
      held.pending = []
    }
  }
}

function unquotedValues(segment: string): string[] {
  const found: { readonly at: number; readonly value: string }[] = []
  let text = segment
    .replaceAll('\n', ' ')
    .split(' ')
    .map((chunk) => (isAddress(chunk) ? ' '.repeat(chunk.length) : chunk))
    .join(' ')

  const dates = [...text.matchAll(new RegExp(MONTH_NAME_DATE, 'gu'))]
  for (const match of dates) found.push({ at: match.index, value: match[0] })
  const pieces: string[] = []
  let cursor = 0
  for (const match of dates) {
    pieces.push(text.slice(cursor, match.index), ' '.repeat(match[0].length))
    cursor = match.index + match[0].length
  }
  pieces.push(text.slice(cursor))
  text = pieces.join('')

  let index = 0
  while (index < text.length) {
    if (!isDigit(text[index])) {
      index += 1
      continue
    }
    let start = index
    if (text[start - 1] === '-' && (start === 1 || ' ('.includes(text[start - 2] ?? '-'))) {
      start -= 1
    } else if (start > 0 && CURRENCY_SYMBOLS.includes(text[start - 1] ?? '-')) {
      start -= 1
    }
    let end = index
    while (isDigit(text[end])) end += 1
    while (isSeparator(text[end]) && isDigit(text[end + 1])) {
      end += 1
      while (isDigit(text[end])) end += 1
    }
    if (text[end] === '%') end += 1

    const startHolds =
      !letterOrNumberBefore(text, start) &&
      !(isSeparator(text[start - 1]) && isDigit(text[start - 2]))
    const endHolds =
      !letterOrNumberAt(text, end) && !(isSeparator(text[end]) && isDigit(text[end + 1]))
    if (startHolds && endHolds) found.push({ at: start, value: text.slice(start, end) })
    index = end
  }

  return found.sort((left, right) => left.at - right.at).map((entry) => entry.value)
}

export function extractStatedValues(request: string): readonly string[] {
  const text = request.normalize('NFC').replace(/\s+/g, collapsedSpace)
  const parts: Part[] = []
  // An opener with no closer has none at any later index either, so its kind stops searching.
  const unclosed = new Set<QuoteKind>()

  let segmentStart = 0
  let index = 0
  while (index < text.length) {
    const kind = openerAt(text, index)
    if (kind !== undefined && !unclosed.has(kind)) {
      const close = closerOf(text, kind, index + 1)
      if (close === -1) {
        unclosed.add(kind)
      } else if (kind === 'single' && close === index + 2 && text[index + 1] === 'n') {
        // `rock 'n' roll` is text, not a quoted `n`.
      } else {
        parts.push({ start: segmentStart, end: index })
        parts.push({ start: index, end: close + 1, quoted: tidy(text.slice(index + 1, close)) })
        index = close + 1
        segmentStart = index
        continue
      }
    }
    index += 1
  }
  parts.push({ start: segmentStart, end: text.length })

  // Runs are read with quoted values masked, so no marker is read inside a quote.
  const masked = parts
    .map(({ start, end, quoted }) =>
      quoted === undefined ? text.slice(start, end) : QUOTE_MASK.repeat(end - start),
    )
    .join('')
  const chars = masked.split('')
  blankStepLabels(masked, chars)
  blankListMarkers(chars.join(''), chars)
  const blanked = chars.join('')

  const values: string[] = []
  const seen = new Set<string>()
  const add = (value: string) => {
    if (value === '' || seen.has(value)) return
    seen.add(value)
    values.push(value)
  }
  for (const { start, end, quoted } of parts) {
    if (quoted !== undefined) add(quoted)
    else for (const value of unquotedValues(blanked.slice(start, end))) add(value)
  }
  return values
}

function startEdgeHolds(step: string, at: number, value: string): boolean {
  if (!LEADING_LETTER_OR_NUMBER.test(value)) return true
  if (letterOrNumberBefore(step, at)) return false
  return !(isDigit(value[0]) && isSeparator(step[at - 1]) && isDigit(step[at - 2]))
}

function endEdgeHolds(step: string, end: number, value: string): boolean {
  if (!TRAILING_LETTER_OR_NUMBER.test(value)) return true
  if (letterOrNumberAt(step, end)) return false
  return !(isDigit(value.at(-1)) && isSeparator(step[end]) && isDigit(step[end + 1]))
}

function carries(step: string, value: string): boolean {
  let from = 0
  while (from <= step.length) {
    const at = step.indexOf(value, from)
    if (at === -1) return false
    if (startEdgeHolds(step, at, value) && endEdgeHolds(step, at + value.length, value)) return true
    from = at + 1
  }
  return false
}

export function missingStatedValues(
  values: readonly string[],
  steps: readonly string[],
): readonly string[] {
  const tidiedSteps = steps.map(tidy)
  return values.filter((value) => {
    const wanted = tidy(value)
    return !tidiedSteps.some((step) => carries(step, wanted))
  })
}

export function statedValuesMissingReason(missing: readonly string[]): string {
  const listed = missing.map((value) => JSON.stringify(value)).join(', ')
  return `the request's stated values are missing: ${listed}`
}
