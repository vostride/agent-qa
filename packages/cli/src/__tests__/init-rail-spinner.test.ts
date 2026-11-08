import { EventEmitter } from 'node:events'
import { stripVTControlCharacters } from 'node:util'

import { describe, expect, it } from 'vitest'

import { createClackUi, type RailProcess } from '../init-ui/clack-ui.js'
import { brandPalette } from '../init-ui/palette.js'
import { clackStreams } from './clack-keys.js'

const CLEAR_LINE = '\x1b[1G\x1b[J'
const SPINNER_FRAME = /^[◒◐◓◑] {2}/u
const LONG_SKIP = "Sign-in: skipped (the project's agent-qa differs from this one)"

const SHOW_CURSOR = '\x1b[?25h'
const HIDE_CURSOR = '\x1b[?25l'
const WATCHED = ['exit', 'SIGTERM', 'SIGHUP'] as const

// Stands in for the process: records each kill and never ends this one.
function fakeProcess(): RailProcess & {
  emit(event: string, ...args: unknown[]): boolean
  kills: unknown[][]
} {
  const events = new EventEmitter()
  const kills: unknown[][] = []
  return {
    pid: 4242,
    kills,
    on: (event, listener) => events.on(event, listener),
    off: (event, listener) => events.off(event, listener),
    listenerCount: (event) => events.listenerCount(event),
    emit: (event, ...args) => events.emit(event, ...args),
    kill: (pid, signal) => kills.push([pid, signal]),
  }
}

function rail(columns: number, host: RailProcess = fakeProcess()) {
  const streams = clackStreams({ columns })
  const ui = createClackUi({
    input: streams.input,
    output: streams.output,
    palette: brandPalette({ background: 'dark', level: 0 }),
    columns,
    host,
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

describe('the cursor while a step runs', () => {
  const cursorAfterLastHide = (text: string): string => text.slice(text.lastIndexOf(HIDE_CURSOR))

  it.each(['SIGTERM', 'SIGHUP'] as const)(
    '%s shows the cursor again, drops the listeners and ends the process as the signal would',
    (signal) => {
      const host = fakeProcess()
      const { ui, streams } = rail(100, host)
      ui.step('Installing packages')

      host.emit(signal, signal)

      expect(cursorAfterLastHide(streams.text())).toContain(SHOW_CURSOR)
      expect(host.kills).toEqual([[4242, signal]])
      for (const event of WATCHED) expect(host.listenerCount(event)).toBe(0)
    },
  )

  it('leaves the signal to a listener that was already there, after showing the cursor', () => {
    const host = fakeProcess()
    host.on('SIGTERM', () => {})
    const { ui, streams } = rail(100, host)
    ui.step('Installing packages')

    host.emit('SIGTERM', 'SIGTERM')

    expect(cursorAfterLastHide(streams.text())).toContain(SHOW_CURSOR)
    expect(host.kills).toEqual([])
  })

  it('an exit mid-step shows the cursor again', () => {
    const host = fakeProcess()
    const { ui, streams } = rail(100, host)
    ui.step('Installing packages')

    host.emit('exit', 0)

    expect(cursorAfterLastHide(streams.text())).toContain(SHOW_CURSOR)
  })

  it('removes every listener when the step ends, and adds none outside a step', () => {
    const host = fakeProcess()
    const { ui } = rail(100, host)

    const line = ui.step('Installing packages')
    for (const event of WATCHED) expect(host.listenerCount(event)).toBe(1)
    line.done('Packages installed')
    for (const event of WATCHED) expect(host.listenerCount(event)).toBe(0)

    ui.step('Validating').skipped('Validate skipped')
    ui.step('Starting').failed('it failed')
    ui.step('Stopped').done('stopped')
    ui.dispose()
    for (const event of WATCHED) expect(host.listenerCount(event)).toBe(0)
  })

  it('a step left running by the next step hands its listeners on, never stacking them', () => {
    const host = fakeProcess()
    const { ui } = rail(100, host)

    ui.step('First')
    ui.step('Second')

    for (const event of WATCHED) expect(host.listenerCount(event)).toBe(1)
    ui.dispose()
    for (const event of WATCHED) expect(host.listenerCount(event)).toBe(0)
  })
})
