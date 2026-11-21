import { Console } from 'node:console'
import { EventEmitter } from 'node:events'
import { clearLine, clearScreenDown, cursorTo, moveCursor } from 'node:readline'

import xterm from '@xterm/headless'
import pc from 'picocolors'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createConsoleReporter } from '../../reporters/console-reporter.js'
import { createLiveLine, fitToRow } from '../../reporters/live-line.js'
import { buildReporterFixture } from './fixtures.js'

const LONG = 'Check the total is $24.00 and the shipping is $5.00 before paying. '
  .repeat(4)
  .slice(0, 200)
const JAPANESE = 'カートを開いて、合計が二千四百円で送料が五百円であることを確認する。'.repeat(4)
const EMOJI = 'Add 🛒, pay 💳, see ✅ and 🎉, then ship it to 🇯🇵. '.repeat(4)
const FRAME = /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] /u
const COLOURS_OFF = pc.createColors(false)
const ENDS_THE_LIVE_LINE = new Set([
  'stepFinalized',
  'hookStarted',
  'hookFinished',
  'testFinished',
  'runFinished',
])

const segments = (text: string): string[] =>
  Array.from(new Intl.Segmenter().segment(text), (part) => part.segment)

// The emulator's own width table is Unicode 6, where an emoji takes one cell. This one draws an
// emoji two cells wide, and a flag's two letters one cell each, as the terminals in use do. The
// emulator reads a character's width from bits 1 and 2 of the number `charProperties` returns.
function drawEmojiTwoCellsWide(terminal: InstanceType<typeof xterm.Terminal>): void {
  const cells = (codepoint: number): 1 | 2 => {
    const character = String.fromCodePoint(codepoint)
    if (/\p{Regional_Indicator}/u.test(character)) return 1
    return /\p{Emoji_Presentation}/u.test(character) ? 2 : 1
  }
  terminal.unicode.register({
    version: 'emoji-two-cells',
    wcwidth: cells,
    charProperties: (codepoint) => cells(codepoint) << 1,
  })
  terminal.unicode.activeVersion = 'emoji-two-cells'
}

type OnNarrowing =
  | 'cuts the row the cursor is on'
  | 'wraps that row again and keeps the cursor on its character'

// A terminal the live line draws on: the stream's bytes go to the emulator, and the screen is read
// back from the emulator's buffer once it has parsed every byte written so far.
function emulator(
  columns: number,
  rows = 12,
  widths: 'unicode-6' | 'wide-emoji' = 'unicode-6',
  onNarrowing: OnNarrowing = 'cuts the row the cursor is on',
) {
  // A terminal device moves to the start of the row on a line feed, so the emulator does too.
  const terminal = new xterm.Terminal({
    cols: columns,
    rows,
    allowProposedApi: true,
    convertEol: true,
    reflowCursorLine: onNarrowing !== 'cuts the row the cursor is on',
  })
  if (widths === 'wide-emoji') drawEmojiTwoCellsWide(terminal)
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
    clearScreenDown: (): boolean => clearScreenDown(tty),
  })
  const tty = stream as unknown as NodeJS.WriteStream
  const flush = (): Promise<void> => new Promise((resolve) => terminal.write('', resolve))
  return {
    stream: tty,
    written: (): string => written,
    // Bytes that reach the screen from somewhere other than the stream, as a second stream does.
    feed: (text: string): void => terminal.write(text),
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
    // The cells of the first row that are drawn on, a wide character counted as the two it takes.
    async cellsOnFirstRow(): Promise<number> {
      await flush()
      const row = terminal.buffer.active.getLine(0)
      let drawn = 0
      for (let x = 0; x < terminal.cols; x++) {
        const cell = row?.getCell(x)
        if (cell !== undefined && cell.getChars() !== '') drawn = x + cell.getWidth()
      }
      return drawn
    },
    // As in a terminal: the window changes size first, and the program hears of it afterwards.
    async resize(next: number): Promise<void> {
      await flush()
      const buffer = terminal.buffer.active
      const firstRowOfTheLine = (row: number): number => {
        let first = row
        while (buffer.getLine(first)?.isWrapped === true) first--
        return first
      }
      const row = buffer.baseY + buffer.cursorY
      const along = (row - firstRowOfTheLine(row)) * terminal.cols + buffer.cursorX
      terminal.resize(next, rows)
      if (onNarrowing !== 'cuts the row the cursor is on') {
        // The emulator moves the cursor down with the rows a wrap adds. This terminal keeps it on
        // the character it was on, so it is put back there.
        const first = firstRowOfTheLine(buffer.baseY + buffer.cursorY)
        const at = first + Math.floor(along / next) - buffer.baseY
        terminal.write(`\x1B[${at + 1};${(along % next) + 1}H`)
      }
      stream.columns = next
      stream.emit('resize')
    },
  }
}

// The process's stderr as a terminal showing on the screen it is handed: its bytes go straight to
// that screen, past the live line's stream, and never to the real stderr.
function stderrOnTheScreen(feed: (text: string) => void): { restore(): void } {
  const savedTTY = Object.getOwnPropertyDescriptor(process.stderr, 'isTTY')
  const savedWrite = Object.getOwnPropertyDescriptor(process.stderr, 'write')
  const onScreen = (
    chunk: string | Uint8Array,
    encoding?: unknown,
    callback?: unknown,
  ): boolean => {
    feed(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
    const done = typeof encoding === 'function' ? encoding : callback
    if (typeof done === 'function') done()
    return true
  }
  Object.defineProperty(process.stderr, 'isTTY', {
    value: true,
    configurable: true,
    writable: true,
  })
  Object.defineProperty(process.stderr, 'write', {
    value: onScreen,
    configurable: true,
    writable: true,
  })
  return {
    restore() {
      if (savedTTY === undefined) Reflect.deleteProperty(process.stderr, 'isTTY')
      else Object.defineProperty(process.stderr, 'isTTY', savedTTY)
      if (savedWrite === undefined) Reflect.deleteProperty(process.stderr, 'write')
      else Object.defineProperty(process.stderr, 'write', savedWrite)
    },
  }
}

// A terminal stdin that records what is done to it, in place of the process's own.
function terminalStdin(): {
  setRawMode: ReturnType<typeof vi.fn>
  listeners(): number
  restore(): void
} {
  const saved = Object.getOwnPropertyDescriptor(process, 'stdin')
  const setRawMode = vi.fn()
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: true,
    isRaw: false,
    setRawMode,
    isPaused: () => false,
    resume: () => stdin,
    pause: () => stdin,
  })
  Object.defineProperty(process, 'stdin', { value: stdin, configurable: true })
  return {
    setRawMode,
    listeners: () => stdin.listenerCount('data'),
    restore() {
      if (saved === undefined) Reflect.deleteProperty(process, 'stdin')
      else Object.defineProperty(process, 'stdin', saved)
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
    [
      'cuts a Japanese text by the two cells each character takes',
      'カートを開いて合計を確認する',
      20,
      '  4s',
      'カートを開い…',
    ],
    [
      'keeps a Japanese text that fills the row exactly',
      'カートを開いて',
      20,
      '  4s',
      'カートを開いて',
    ],
    [
      'leaves a cell empty when a wide character would straddle the cut',
      'abcd漢字x',
      12,
      '  4s',
      'abcd…',
    ],
    ['counts an emoji as two cells', '🛒🛒🛒🛒🛒', 14, '  4s', '🛒🛒🛒…'],
    ['counts a Thai cluster of two letters as two cells', 'น้ำน้ำน้ำน้ำ', 12, '  4s', 'น้ำน้ำ…'],
    ['gives a combining mark that stands alone no cell', '\u0301abcd', 10, '  4s', '\u0301abcd'],
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
    // An accented letter and a space take one cell; a flag and a family emoji take two.
    const cellsOf = (parts: string[]): number =>
      parts.reduce((sum, part) => sum + (/\p{Emoji_Presentation}/u.test(part) ? 2 : 1), 0)

    for (let columns = 9; columns <= 60; columns++) {
      const fitted = fitToRow(text, columns, '  3s')
      const kept = segments(fitted.slice(0, -1))
      const room = columns - 2 - 4

      expect(fitted.endsWith('…')).toBe(true)
      expect(kept).toEqual(whole.slice(0, kept.length))
      expect(cellsOf(kept) + 1).toBeLessThanOrEqual(room)
      expect(cellsOf(whole.slice(0, kept.length + 1)) + 1).toBeGreaterThan(room)
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
    const live = await createLiveLine(term.stream, (glyph) => glyph)

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
    const live = await createLiveLine(term.stream, (glyph) => `[${glyph}]`)

    live.start('Open the cart')
    vi.advanceTimersByTime(300)
    const during = await term.screen()
    live.stop()

    expect(during).toHaveLength(1)
    expect(during[0]).toMatch(/^\[[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\] Open the cart {2}0s$/u)
  })

  it('leaves only the result line after a step longer than the window', async () => {
    const term = emulator(40)
    const live = await createLiveLine(term.stream, (glyph) => glyph)

    live.start(LONG)
    vi.advanceTimersByTime(2_400)
    const during = await term.screen()
    live.stop()
    term.stream.write('✗ Check the total 27s\n')

    expect(during).toHaveLength(1)
    expect(segments(during[0] ?? '').length).toBeLessThanOrEqual(40)
    expect(await term.screen()).toEqual(['✗ Check the total 27s'])
  })

  it.each([
    ['a Ctrl+C', '^C'],
    ['a typed letter', 'q'],
    ['a typed word', 'status'],
  ])(
    'leaves no live line behind when the terminal echoes %s during a step longer than the window',
    async (_title, echo) => {
      const term = emulator(48)
      const live = await createLiveLine(term.stream, (glyph) => glyph)

      live.start(LONG)
      vi.advanceTimersByTime(2_400)
      term.feed(echo)
      vi.advanceTimersByTime(300)
      live.stop()
      term.stream.write('⊘ Check the total (cancelled)\n')

      expect(await term.screen()).toEqual(['⊘ Check the total (cancelled)'])
    },
  )

  it('keeps a Japanese step on one row of an 80-column window', async () => {
    const term = emulator(80)
    const live = await createLiveLine(term.stream, (glyph) => glyph)

    live.start(JAPANESE)
    vi.advanceTimersByTime(2_400)
    const during = await term.screen()
    const cells = await term.cellsOnFirstRow()
    live.stop()
    term.stream.write('✓ カートを開く 3s\n')

    expect(during).toHaveLength(1)
    expect(during[0]).toBe(`${during[0]?.slice(0, 2)}${JAPANESE.slice(0, 36)}…  2s`)
    expect(during[0]).toMatch(FRAME)
    expect(cells).toBe(79)
    expect(await term.screen()).toEqual(['✓ カートを開く 3s'])
  })

  it('keeps an emoji step on one row of an 80-column window', async () => {
    const term = emulator(80, 12, 'wide-emoji')
    const live = await createLiveLine(term.stream, (glyph) => glyph)

    live.start(EMOJI)
    vi.advanceTimersByTime(2_400)
    const during = await term.screen()
    const cells = await term.cellsOnFirstRow()
    live.stop()
    term.stream.write('✓ Add 🛒 3s\n')

    expect(during).toHaveLength(1)
    expect(during[0]).toMatch(FRAME)
    expect(during[0]).toMatch(/…  2s$/u)
    expect(EMOJI.startsWith(during[0]?.slice(2, -5) ?? '-')).toBe(true)
    // The row is full but for the cell a cut before a wide character can leave empty.
    expect([79, 80]).toContain(cells)
    expect(await term.screen()).toEqual(['✓ Add 🛒 3s'])
  })

  it.each([
    ['cuts the row the cursor is on'],
    ['wraps that row again and keeps the cursor on its character'],
  ] as const)(
    'leaves only the result line after the window narrows and widens, in a terminal that %s',
    async (onNarrowing) => {
      const term = emulator(60, 12, 'unicode-6', onNarrowing)
      const live = await createLiveLine(term.stream, (glyph) => glyph)

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
    },
  )

  it('prints a line that arrives during a step once, above the live line', async () => {
    const term = emulator(60)
    const live = await createLiveLine(term.stream, (glyph) => glyph)
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

  it('prints lines written to stderr during a step once, above the live line, when both streams show on one screen', async () => {
    const term = emulator(60)
    const live = await createLiveLine(term.stream, (glyph) => glyph)
    const stderr = stderrOnTheScreen(term.feed)
    const first = '12:00:01  agent      Looking for the cart button'
    const second = '  Quarantine: one test is quarantined'
    try {
      const terminal = new Console({ stdout: process.stdout, stderr: process.stderr })

      live.start('Open the cart')
      vi.advanceTimersByTime(300)
      terminal.error(first)
      vi.advanceTimersByTime(300)
      const afterFirst = await term.screen()
      terminal.warn(second)
      vi.advanceTimersByTime(300)
      const afterSecond = await term.screen()
      live.stop()
      term.stream.write('✓ Open the cart 1s\n')

      const liveRow = expect.stringMatching(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Open the cart {2}0s$/u)
      expect(afterFirst).toEqual([first, liveRow])
      expect(afterSecond).toEqual([first, second, liveRow])
      expect(await term.screen()).toEqual([first, second, '✓ Open the cart 1s'])
    } finally {
      live.stop()
      stderr.restore()
    }
  })

  it('gives stderr its own write back once stopped', async () => {
    const term = emulator(60)
    const live = await createLiveLine(term.stream, (glyph) => glyph)
    const stderr = stderrOnTheScreen(term.feed)
    try {
      const own = process.stderr.write

      live.start('Open the cart')
      const during = process.stderr.write
      live.stop()

      expect(during).not.toBe(own)
      expect(process.stderr.write).toBe(own)
    } finally {
      live.stop()
      stderr.restore()
    }
  })

  it('leaves a terminal stdin as it was, so a Ctrl+C typed during a step reaches the run', async () => {
    const term = emulator(60)
    const live = await createLiveLine(term.stream, (glyph) => glyph)
    const stdin = terminalStdin()
    try {
      live.start('Open the cart')
      vi.advanceTimersByTime(300)
      const listening = stdin.listeners()
      live.stop()

      expect(stdin.setRawMode).not.toHaveBeenCalled()
      expect(listening).toBe(0)
    } finally {
      live.stop()
      stdin.restore()
    }
  })

  it('shows at most one live line, last on the screen, through a whole run, and none once it ends', async () => {
    const envelopes = buildReporterFixture().envelopes
    const plain: string[] = []
    const without = createConsoleReporter({
      colors: COLOURS_OFF,
      env: {},
      write: (chunk) => plain.push(chunk),
    })
    for (const envelope of envelopes) without.handler(envelope)
    const printed = plain.join('').split('\n').filter((row) => row !== '')
    const columns = Math.max(...printed.map((row) => segments(row).length)) + 1
    const term = emulator(columns, printed.length + 8)
    const live = await createLiveLine(term.stream, (glyph) => glyph)
    const reporter = createConsoleReporter({
      colors: COLOURS_OFF,
      env: {},
      liveLine: live,
      write: (chunk) => void term.stream.write(chunk),
    })
    let drawn = 0

    for (const envelope of envelopes) {
      reporter.handler(envelope)
      vi.advanceTimersByTime(1_300)
      const rows = await term.screen()
      const spinning = rows.flatMap((row, index) => (FRAME.test(row) ? [index] : []))
      const seen = `after ${envelope.type}: ${JSON.stringify(rows)}`
      expect(spinning.length, seen).toBeLessThanOrEqual(1)
      if (ENDS_THE_LIVE_LINE.has(envelope.type)) expect(spinning, seen).toEqual([])
      if (spinning.length === 1) {
        drawn++
        expect(spinning[0], seen).toBe(rows.length - 1)
      }
      const results = spinning.length === 1 ? rows.slice(0, -1) : rows
      expect(results).toEqual(printed.slice(0, results.length))
    }

    expect(drawn).toBeGreaterThan(0)
    expect(await term.screen()).toEqual(printed)
  })

  it('writes nothing when stopped before it was started', async () => {
    const term = emulator(60)
    const live = await createLiveLine(term.stream, (glyph) => glyph)

    expect(() => live.stop()).not.toThrow()
    expect(term.written()).toBe('')
  })

  it('shows only the second text when started twice, with the seconds counted again', async () => {
    const term = emulator(60)
    const live = await createLiveLine(term.stream, (glyph) => glyph)

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

  it('leaves no timer and no resize listener behind once stopped', async () => {
    const term = emulator(60)
    const live = await createLiveLine(term.stream, (glyph) => glyph)

    live.start('Open the cart')
    expect(term.stream.listenerCount('resize')).toBe(1)
    live.stop()

    expect(vi.getTimerCount()).toBe(0)
    expect(term.stream.listenerCount('resize')).toBe(0)
  })
})
