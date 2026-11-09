import type { Readable, Writable } from 'node:stream'
import { stripVTControlCharacters, styleText } from 'node:util'

import { SelectPrompt, getColumns, getRows, settings, wrapTextWithPrefix } from '@clack/core'
import {
  S_BAR,
  S_RADIO_ACTIVE,
  S_RADIO_INACTIVE,
  SELECT_INSTRUCTIONS,
  formatInstructionFooter,
  symbol,
  symbolBar,
} from '@clack/prompts'

import type { InitSection } from './init-ui.js'

type Row<T> =
  | { kind: 'heading'; value: symbol; disabled: true; heading: string }
  | { kind: 'option'; value: T; label: string; status: string }

// Each heading's value is a fresh symbol, so no option can equal it; being disabled, the prompt's
// cursor skips it in both directions and never starts on it.
function rowsOf<T>(sections: readonly InitSection<T>[]): Row<T>[] {
  return sections.flatMap(({ heading, options }): Row<T>[] => [
    { kind: 'heading', value: Symbol(heading), disabled: true, heading },
    ...options.map(({ value, label, status }) => ({
      kind: 'option' as const,
      value,
      label,
      status,
    })),
  ])
}

type Piece = { text: string; style: (text: string) => string }

const plain = (text: string): string => text
const styled =
  (format: Parameters<typeof styleText>[0]) =>
  (text: string): string =>
    styleText(format, text)

// Cut before styling, so the escape codes never count towards the width.
function fit(pieces: readonly Piece[], width: number): string {
  const total = pieces.reduce((sum, piece) => sum + piece.text.length, 0)
  if (total <= width) return pieces.map((piece) => piece.style(piece.text)).join('')
  let room = Math.max(0, width - 1)
  let drawn = ''
  for (const piece of pieces) {
    const kept = piece.text.slice(0, room)
    room -= kept.length
    if (kept.length > 0) drawn += piece.style(kept)
    if (room === 0) break
  }
  return `${drawn}…`
}

function cut(text: string, width: number): string {
  return text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`
}

// The columns a row takes besides its label and status: the radio, a space and two spaces.
const ROW_SPACING = Math.max(S_RADIO_ACTIVE.length, S_RADIO_INACTIVE.length) + 3

function heightOf(text: string, columns: number): number {
  return text
    .split('\n')
    .reduce(
      (sum, line) =>
        sum + Math.max(1, Math.ceil(stripVTControlCharacters(line).length / Math.max(1, columns))),
      0,
    )
}

interface Window {
  // The heading drawn on the first line for the section the window opens in, when the window
  // opens on an option rather than on a heading.
  sticky?: number
  first: number
  last: number
  hiddenBelow: boolean
}

function headingAbove<T>(rows: readonly Row<T>[], index: number): number | undefined {
  for (let at = index; at >= 0; at -= 1) if (rows[at]?.kind === 'heading') return at
  return undefined
}

function windowFrom<T>(rows: readonly Row<T>[], first: number, lines: number): Window {
  const sticky = rows[first]?.kind === 'heading' ? undefined : headingAbove(rows, first)
  const room = lines - (sticky === undefined ? 0 : 1)
  if (rows.length - first <= room) {
    return { sticky, first, last: rows.length - 1, hiddenBelow: false }
  }
  return { sticky, first, last: first + room - 2, hiddenBelow: true }
}

// The highest window that shows the cursor with a row under it before the ... line, as Clack's
// own select scrolls; worked out from the cursor alone, so moving up scrolls the same way.
function windowAround<T>(rows: readonly Row<T>[], cursor: number, lines: number): Window {
  if (rows.length <= lines) return { first: 0, last: rows.length - 1, hiddenBelow: false }
  for (let first = 0; first < cursor; first += 1) {
    const window = windowFrom(rows, first, lines)
    if (window.hiddenBelow ? cursor < window.last : cursor <= window.last) return window
  }
  return windowFrom(rows, cursor, lines)
}

// Clack's select, with headings between the options and each option's status beside its label.
export function sectionSelect<T>(options: {
  input: Readable
  output: Writable
  signal: AbortSignal
  message: string
  sections: readonly InitSection<T>[]
  initialValue: T
}): Promise<T | symbol> {
  const { input, output, signal, message, sections, initialValue } = options
  const rows = rowsOf(sections)
  const width = Math.max(0, ...rows.map((row) => (row.kind === 'option' ? row.label.length : 0)))
  const statusWidth = Math.max(
    0,
    ...rows.map((row) => (row.kind === 'option' ? row.status.length : 0)),
  )
  const labelOf = (row: Row<T> | undefined): string => (row?.kind === 'option' ? row.label : '')
  // An over-long label is cut so the widest status still fits, but keeps at least half the row.
  const labelWidthIn = (room: number): number =>
    Math.min(width, Math.max(1, Math.floor(room / 2), room - statusWidth - ROW_SPACING))

  const drawRow = (row: Row<T>, active: boolean, room: number): string => {
    if (row.kind === 'heading') return fit([{ text: row.heading, style: styled('bold') }], room)
    const labelWidth = labelWidthIn(room)
    const label = cut(row.label, labelWidth).padEnd(labelWidth)
    const status = { text: row.status, style: styled('dim') }
    return active
      ? fit(
          [
            { text: S_RADIO_ACTIVE, style: styled('green') },
            { text: ` ${label}  `, style: plain },
            status,
          ],
          room,
        )
      : fit(
          [
            { text: S_RADIO_INACTIVE, style: styled('dim') },
            { text: ' ', style: plain },
            { text: label, style: styled('dim') },
            { text: '  ', style: plain },
            status,
          ],
          room,
        )
  }

  const prompt = new SelectPrompt<Row<T>>({
    input,
    output,
    signal,
    options: rows,
    initialValue,
    render() {
      const guide = settings.withGuide
      const title = `${guide ? `${styleText('gray', S_BAR)}\n` : ''}${wrapTextWithPrefix(
        output,
        message,
        `${symbolBar(this.state)}  `,
        `${symbol(this.state)}  `,
      )}\n`
      const answered = guide ? `${styleText('gray', S_BAR)}  ` : ''
      const chosen = labelOf(this.options[this.cursor])
      switch (this.state) {
        case 'submit':
          return `${title}${wrapTextWithPrefix(output, styleText('dim', chosen), answered)}`
        case 'cancel':
          return `${title}${wrapTextWithPrefix(
            output,
            styleText(['strikethrough', 'dim'], chosen),
            answered,
          )}${guide ? `\n${styleText('gray', S_BAR)}` : ''}`
        default: {
          const gutter = guide ? `${styleText('cyan', S_BAR)}  ` : ''
          const footer = formatInstructionFooter(SELECT_INSTRUCTIONS, guide).join('\n')
          const columns = getColumns(output)
          const room = Math.max(1, columns - stripVTControlCharacters(gutter).length)
          // The line under the frame, where the cursor rests, is one of the terminal's rows too.
          const others = heightOf(title, columns) - 1 + heightOf(footer, columns) + 1
          const window = windowAround(
            this.options,
            this.cursor,
            Math.max(4, getRows(output) - others),
          )
          const drawn = [
            ...(window.sticky === undefined
              ? []
              : [drawRow(this.options[window.sticky]!, false, room)]),
            ...this.options
              .slice(window.first, window.last + 1)
              .map((row, index) => drawRow(row, window.first + index === this.cursor, room)),
            ...(window.hiddenBelow ? [styleText('dim', '...')] : []),
          ]
          return `${title}${gutter}${drawn.join(`\n${gutter}`)}\n${footer}\n`
        }
      }
    },
  })
  return prompt.prompt() as Promise<T | symbol>
}
