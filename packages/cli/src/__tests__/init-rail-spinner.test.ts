import { stripVTControlCharacters } from 'node:util'

import { describe, expect, it } from 'vitest'

import { createClackUi } from '../init-ui/clack-ui.js'
import { brandPalette } from '../init-ui/palette.js'
import { clackStreams } from './clack-keys.js'

const CLEAR_LINE = '\x1b[1G\x1b[J'
const SPINNER_FRAME = /^[◒◐◓◑] {2}/u
const LONG_SKIP = "Sign-in: skipped (the project's agent-qa differs from this one)"

function rail(columns: number) {
  const streams = clackStreams({ columns })
  const ui = createClackUi({
    input: streams.input,
    output: streams.output,
    palette: brandPalette({ background: 'dark', level: 0 }),
    columns,
  })
  // What each redraw writes after it clears the row.
  const frames = (): string[] =>
    streams
      .text()
      .split(CLEAR_LINE)
      .map((segment) => stripVTControlCharacters(segment))
      .filter((segment) => SPINNER_FRAME.test(segment))
  return { streams, ui, frames }
}

describe('the step spinner on the rail', () => {
  it('keeps a title wider than the terminal to one row, so a redraw leaves no stray text', () => {
    const { ui, frames, streams } = rail(60)

    ui.step(LONG_SKIP).skipped(LONG_SKIP)

    expect(frames()).toEqual([`◒  ${LONG_SKIP.slice(0, 55)}…`])
    expect(frames().every((frame) => [...frame].length < 60)).toBe(true)
    expect(stripVTControlCharacters(streams.text())).toContain(`◇  ${LONG_SKIP}\n`)
  })

  it('draws a title that fits as it is', () => {
    const { ui, frames } = rail(100)

    ui.step('Installing packages').done('Packages installed')

    expect(frames()).toEqual(['◒  Installing packages'])
  })

  it('draws the whole title when the width is unknown', () => {
    const { ui, frames } = rail(0)

    ui.step(LONG_SKIP).skipped(LONG_SKIP)

    expect(frames()).toEqual([`◒  ${LONG_SKIP}`])
  })
})
