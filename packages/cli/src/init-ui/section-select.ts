import type { Readable, Writable } from 'node:stream'
import { styleText } from 'node:util'

import { SelectPrompt, settings, wrapTextWithPrefix } from '@clack/core'
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
  const labelOf = (row: Row<T> | undefined): string => (row?.kind === 'option' ? row.label : '')

  const drawRow = (row: Row<T>, active: boolean): string => {
    if (row.kind === 'heading') return styleText('bold', row.heading)
    const status = styleText('dim', row.status)
    const label = row.label.padEnd(width)
    return active
      ? `${styleText('green', S_RADIO_ACTIVE)} ${label}  ${status}`
      : `${styleText('dim', S_RADIO_INACTIVE)} ${styleText('dim', label)}  ${status}`
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
          const drawn = this.options.map((row, index) => drawRow(row, index === this.cursor))
          const footer = formatInstructionFooter(SELECT_INSTRUCTIONS, guide).join('\n')
          return `${title}${gutter}${drawn.join(`\n${gutter}`)}\n${footer}\n`
        }
      }
    },
  })
  return prompt.prompt() as Promise<T | symbol>
}
