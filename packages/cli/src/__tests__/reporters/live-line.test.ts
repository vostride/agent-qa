import { EventEmitter } from 'node:events'
import { clearLine, cursorTo, moveCursor } from 'node:readline'

import xterm from '@xterm/headless'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createLiveLine, fitToRow } from '../../reporters/live-line.js'

const LONG = 'Check the total is $24.00 and the shipping is $5.00 before paying. '
  .repeat(4)
  .slice(0, 200)
const FRAME = /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] /u

const segments = (text: string): string[] =>
  Array.from(new Intl.Segmenter().segment(text), (part) => part.segment)

// A terminal the live line draws on: the stream's bytes go to the emulator, and the screen is read
// back from the emulator's buffer once it has parsed every byte written so far.
function emulator(columns: number, rows = 12) {
  const terminal = new xterm.Terminal({ cols: columns, rows, allowProposedApi: true })
  let written = ''
  const stream = Object.assign(new EventEmitter(), {
    isTTY: true,
    columns,
    rows,
    write(chunk: string | Uint8Array, encoding?: unknown, callback?: unknown): boolean {
      const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
      written += text
      terminal.write(text)
      const done = typeof encoding === 'function' ? encoding : callback
      if (typeof done === 'function') done()
      return true
    },
    cursorTo: (x: number, y?: number): boolean => cursorTo(tty, x, y),
    moveCursor: (dx: number, dy: number): boolean => moveCursor(tty, dx, dy),
    clearLine: (dir: -1 | 0 | 1): boolean => clearLine(tty, dir),
  })
  const tty = stream as unknown as NodeJS.WriteStream
  const flush = (): Promise<void> => new Promise((resolve) => terminal.write('', resolve))
  return {
    stream: tty,
    written: (): string => written,
    async screen(): Promise<string[]> {
      await flush()
      const buffer = terminal.buffer.active
      const found: string[] = []
      for (let y = 0; y < buffer.length; y++) {
        const row = buffer.getLine(y)?.translateToString(true) ?? ''
        if (row !== '') found.push(row)
      }
      return found
    },
    // As in a terminal: the window changes size first, and the program hears of it afterwards.
    async resize(next: number): Promise<void> {
      await flush()
      terminal.resize(next, rows)
      stream.columns = next
      stream.emit('resize')
    },
  }
}

describe('fitToRow', () => {
  it.each([
    ['keeps a text that fits as it is', 'Open the cart', 60, '  4s', 'Open the cart'],
    [
      'cuts a text longer than the row and ends it with an ellipsis',
      LONG,
      48,
      '  12s',
      `${LONG.slice(0, 40)}…`,
    ],
    [
      'turns a text written over several lines into one line with single spaces',
      '  Open the cart\n    and add the mug\n\tto the bag  ',
      60,
      '  4s',
      'Open the cart and add the mug to the bag',
    ],
    ['gives nothing when the row holds only the tail', 'Open the cart', 7, '  4s', ''],
    ['gives nothing when the window reports no width', 'Open the cart', 0, '  4s', ''],
  ])('%s', (_title, text, columns, tail, expected) => {
    expect(fitToRow(text, columns, tail)).toBe(expected)
  })

  it('keeps the spinner, the text and the tail inside the row', () => {
    const fitted = fitToRow(LONG, 48, '  12s')

    expect(segments(fitted)).toHaveLength(48 - 2 - 5)
    expect(LONG.startsWith(fitted.slice(0, -1))).toBe(true)
  })

  it('cuts between graphemes, never inside a flag, a family emoji or an accented letter', () => {
    const text = 'é🇳🇱👨‍👩‍👧 '.repeat(30)
    const whole = segments(text)

    for (let columns = 9; columns <= 60; columns++) {
      const fitted = fitToRow(text, columns, '  3s')
      const kept = segments(fitted.slice(0, -1))

      expect(fitted.endsWith('…')).toBe(true)
      expect(segments(fitted)).toHaveLength(columns - 2 - 4)
      expect(kept).toEqual(whole.slice(0, kept.length))
    }
  })
})

describe('the live line on a terminal', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('draws one row with a spinner, the cut text and the seconds so far', async () => {
    const term = emulator(48)
    const live = createLiveLine(term.stream, (glyph) => glyph)

    live.start(LONG)
    vi.advanceTimersByTime(12_100)
    const during = await term.screen()
    live.stop()

    expect(during).toHaveLength(1)
    expect(during[0]).toMatch(FRAME)
    expect(during[0]).toBe(`${during[0]?.slice(0, 2)}${LONG.slice(0, 40)}…  12s`)
  })

  it('passes each spinner glyph through the frame function', async () => {
    const term = emulator(60)
    const live = createLiveLine(term.stream, (glyph) => `[${glyph}]`)

    live.start('Open the cart')
    vi.advanceTimersByTime(300)
    const during = await term.screen()
    live.stop()

    expect(during).toHaveLength(1)
    expect(during[0]).toMatch(/^\[[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\] Open the cart {2}0s$/u)
  })

  it('leaves only the result line after a step longer than the window', async () => {
    const term = emulator(40)
    const live = createLiveLine(term.stream, (glyph) => glyph)

    live.start(LONG)
    vi.advanceTimersByTime(2_400)
    const during = await term.screen()
    live.stop()
    term.stream.write('✗ Check the total 27s\n')

    expect(during).toHaveLength(1)
    expect(segments(during[0] ?? '').length).toBeLessThanOrEqual(40)
    expect(await term.screen()).toEqual(['✗ Check the total 27s'])
  })

  it('leaves only the result line after the window narrows and widens during a step', async () => {
    const term = emulator(60)
    const live = createLiveLine(term.stream, (glyph) => glyph)

    live.start(LONG)
    vi.advanceTimersByTime(300)
    await term.resize(30)
    const narrowed = await term.screen()
    vi.advanceTimersByTime(300)
    await term.resize(60)
    const widened = await term.screen()
    vi.advanceTimersByTime(300)
    live.stop()
    term.stream.write('✓ Open the cart 4s\n')

    expect(narrowed).toHaveLength(1)
    expect(segments(narrowed[0] ?? '').length).toBeLessThanOrEqual(30)
    expect(widened).toHaveLength(1)
    expect(segments(widened[0] ?? '').length).toBeGreaterThan(30)
    expect(await term.screen()).toEqual(['✓ Open the cart 4s'])
  })

  it('prints a line that arrives during a step once, above the live line', async () => {
    const term = emulator(60)
    const live = createLiveLine(term.stream, (glyph) => glyph)
    const arriving = '12:00:01  appium     started on port 4723'

    live.start('Open the cart')
    vi.advanceTimersByTime(300)
    term.stream.write(`${arriving}\n`)
    vi.advanceTimersByTime(300)
    const during = await term.screen()
    live.stop()
    term.stream.write('✓ Open the cart 1s\n')

    expect(during).toEqual([arriving, expect.stringMatching(/Open the cart {2}0s$/u)])
    expect(await term.screen()).toEqual([arriving, '✓ Open the cart 1s'])
  })

  it('writes nothing when stopped before it was started', () => {
    const term = emulator(60)
    const live = createLiveLine(term.stream, (glyph) => glyph)

    expect(() => live.stop()).not.toThrow()
    expect(term.written()).toBe('')
  })

  it('shows only the second text when started twice, with the seconds counted again', async () => {
    const term = emulator(60)
    const live = createLiveLine(term.stream, (glyph) => glyph)

    live.start('Open the cart')
    vi.advanceTimersByTime(3_100)
    const first = await term.screen()
    live.start('Add the mug to the bag')
    vi.advanceTimersByTime(300)
    const second = await term.screen()
    live.stop()

    expect(first).toEqual([expect.stringMatching(/Open the cart {2}3s$/u)])
    expect(second).toEqual([expect.stringMatching(/Add the mug to the bag {2}0s$/u)])
    expect(await term.screen()).toEqual([])
  })

  it('leaves no timer and no resize listener behind once stopped', () => {
    const term = emulator(60)
    const live = createLiveLine(term.stream, (glyph) => glyph)

    live.start('Open the cart')
    expect(term.stream.listenerCount('resize')).toBe(1)
    live.stop()

    expect(vi.getTimerCount()).toBe(0)
    expect(term.stream.listenerCount('resize')).toBe(0)
  })
})
