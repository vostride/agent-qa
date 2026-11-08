import { PassThrough, Writable } from 'node:stream'
import { setTimeout as sleep } from 'node:timers/promises'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { createClackUi } from '../init-ui/clack-ui.js'
import { brandPalette } from '../init-ui/palette.js'
import {
  classifyBackground,
  createLateReplyFilter,
  parseOsc11,
  probeTerminalBackground,
  processTerminalPort,
  type TerminalPort,
} from '../init-ui/terminal-background.js'

const QUERY = '\x1b]11;?\x1b\\\x1b[c'
const DARK_REPLY = '\x1b]11;rgb:1e1e/1e1e/1e1e\x07\x1b[?62;22c'
const LIGHT_REPLY = '\x1b]11;rgb:ffff/ffff/ffff\x1b\\\x1b[?1;2c'

interface FakeTerminal {
  port: TerminalPort
  events: string[]
  writes: string[]
  listenerCount(): number
  filterCount(): number
  // Sends input as the terminal would and returns what the listeners receive.
  type(chunk: string): string
}

function fakeTerminal(
  options: {
    reply?: string
    isTTY?: boolean
    env?: NodeJS.ProcessEnv
    failWrite?: boolean
    failOnData?: boolean
  } = {},
): FakeTerminal {
  const events: string[] = []
  const writes: string[] = []
  const listeners = new Set<(chunk: string) => void>()
  const filters = new Set<(chunk: string) => string>()
  const port: TerminalPort = {
    isTTY: options.isTTY ?? true,
    env: options.env ?? { TERM: 'xterm-256color' },
    setRawMode: (on) => {
      events.push(on ? 'raw on' : 'raw off')
    },
    write: (text) => {
      if (options.failWrite) throw new Error('the terminal closed')
      writes.push(text)
      const reply = options.reply
      if (reply !== undefined) {
        queueMicrotask(() => {
          for (const listener of [...listeners]) listener(reply)
        })
      }
    },
    onData: (listener) => {
      if (options.failOnData) throw new Error('stdin is gone')
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    intercept: (filter) => {
      filters.add(filter)
      return () => filters.delete(filter)
    },
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  }
  return {
    port,
    events,
    writes,
    listenerCount: () => listeners.size,
    filterCount: () => filters.size,
    type: (chunk) => {
      let kept = chunk
      for (const filter of [...filters]) kept = filter(kept)
      for (const listener of [...listeners]) listener(kept)
      return kept
    },
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('parseOsc11', () => {
  it('reads four hex digits per channel ending in BEL', () => {
    const rgb = parseOsc11('\x1b]11;rgb:1e1e/1e1e/1e1e\x07')
    expect(rgb?.r).toBeCloseTo(0.1176, 3)
    expect(rgb?.g).toBeCloseTo(0.1176, 3)
    expect(rgb?.b).toBeCloseTo(0.1176, 3)
  })

  it('scales one and two hex digits per channel to white', () => {
    expect(parseOsc11('\x1b]11;rgb:f/f/f\x07')).toEqual({ r: 1, g: 1, b: 1 })
    expect(parseOsc11('\x1b]11;rgb:ff/ff/ff\x1b\\')).toEqual({ r: 1, g: 1, b: 1 })
  })

  it('refuses a reply whose channels are not hex', () => {
    expect(parseOsc11('\x1b]11;rgb:zz/1/1\x07')).toBeUndefined()
  })
})

describe('probeTerminalBackground', () => {
  it('reads a dark reply as about 0.118 and classifies it dark', async () => {
    const terminal = fakeTerminal({ reply: DARK_REPLY })
    const rgb = await probeTerminalBackground(terminal.port)
    expect(rgb?.r).toBeCloseTo(0.118, 2)
    expect(classifyBackground(rgb, {})).toBe('dark')
  })

  it('reads a white reply ending in ST as light', async () => {
    const terminal = fakeTerminal({ reply: LIGHT_REPLY })
    const rgb = await probeTerminalBackground(terminal.port)
    expect(rgb).toEqual({ r: 1, g: 1, b: 1 })
    expect(classifyBackground(rgb, {})).toBe('light')
  })

  it('settles at once with nothing when only DA1 answers', async () => {
    vi.useFakeTimers()
    const terminal = fakeTerminal({ reply: '\x1b[?1;2c' })
    await expect(probeTerminalBackground(terminal.port)).resolves.toBeUndefined()
    expect(terminal.writes).toEqual([QUERY])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('settles with nothing at the one second timeout when nothing answers', async () => {
    vi.useFakeTimers()
    const terminal = fakeTerminal()
    let settled = false
    const probe = probeTerminalBackground(terminal.port).then((rgb) => {
      settled = true
      return rgb
    })
    await vi.advanceTimersByTimeAsync(999)
    expect(terminal.writes).toEqual([QUERY])
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await expect(probe).resolves.toBeUndefined()
    expect(settled).toBe(true)
  })

  it('gives nothing for a malformed reply', async () => {
    const terminal = fakeTerminal({ reply: '\x1b]11;rgb:zz/1/1\x07\x1b[?1c' })
    await expect(probeTerminalBackground(terminal.port)).resolves.toBeUndefined()
    expect(terminal.writes).toEqual([QUERY])
  })

  it('turns raw mode on then off, removes its listener and writes back nothing it received', async () => {
    const terminal = fakeTerminal({ reply: DARK_REPLY })
    await probeTerminalBackground(terminal.port)
    expect(terminal.events).toEqual(['raw on', 'raw off'])
    expect(terminal.listenerCount()).toBe(0)
    expect(terminal.writes).toEqual([QUERY])
  })

  it('leaves raw mode off and its listener removed when writing the query throws', async () => {
    const terminal = fakeTerminal({ failWrite: true })
    await expect(probeTerminalBackground(terminal.port)).resolves.toBeUndefined()
    expect(terminal.events).toEqual(['raw on', 'raw off'])
    expect(terminal.listenerCount()).toBe(0)
  })

  it('leaves raw mode off when attaching the data listener throws', async () => {
    const terminal = fakeTerminal({ failOnData: true, reply: DARK_REPLY })
    await expect(probeTerminalBackground(terminal.port)).resolves.toBeUndefined()
    expect(terminal.events).toEqual(['raw on', 'raw off'])
  })

  it('never writes the query without a terminal', async () => {
    const terminal = fakeTerminal({ isTTY: false, reply: DARK_REPLY })
    await expect(probeTerminalBackground(terminal.port)).resolves.toBeUndefined()
    expect(terminal.writes).toEqual([])
    expect(terminal.events).toEqual([])
  })

  it('never writes the query when TERM is dumb', async () => {
    const terminal = fakeTerminal({ env: { TERM: 'dumb' }, reply: DARK_REPLY })
    await expect(probeTerminalBackground(terminal.port)).resolves.toBeUndefined()
    expect(terminal.writes).toEqual([])
  })
})

describe('a reply that comes after the probe gave up', () => {
  const LATE_LIGHT_REPLY = '\x1b]11;rgb:aaaa/bbbb/cccc\x1b\\\x1b[?62;22c'

  it('is dropped from the input, keys around it pass, and the filter goes once DA1 has passed', async () => {
    vi.useFakeTimers()
    const terminal = fakeTerminal()
    const probe = probeTerminalBackground(terminal.port)
    await vi.advanceTimersByTimeAsync(1000)
    await expect(probe).resolves.toBeUndefined()
    expect(terminal.filterCount()).toBe(1)

    expect(terminal.type(`j${LATE_LIGHT_REPLY}\r`)).toBe('j\r')
    expect(terminal.filterCount()).toBe(0)
    expect(terminal.type('\x1b[?1;2c')).toBe('\x1b[?1;2c')
  })

  it('finishes a reply the timeout cut in two', async () => {
    vi.useFakeTimers()
    const terminal = fakeTerminal()
    const probe = probeTerminalBackground(terminal.port)
    await vi.advanceTimersByTimeAsync(10)
    terminal.type('\x1b]11;rgb:2a2a/')
    await vi.advanceTimersByTimeAsync(990)
    await probe

    expect(terminal.type('2a2a/2a2a\x07\x1b[?62;22c')).toBe('')
    expect(terminal.filterCount()).toBe(0)
  })

  it('leaves no filter when the terminal answers in time', async () => {
    const terminal = fakeTerminal({ reply: DARK_REPLY })
    await probeTerminalBackground(terminal.port)
    expect(terminal.filterCount()).toBe(0)
  })

  it('holds a reply split across chunks until it is whole, and passes the Escape key at once', () => {
    const filter = createLateReplyFilter()

    expect(filter.take('\x1b')).toBe('\x1b')
    expect(filter.take('\x1b]11;rgb:aa')).toBe('')
    expect(filter.take('aa/aaaa/aaaa\x07\x1b[?6')).toBe('')
    expect(filter.finished()).toBe(false)
    expect(filter.take('2;22c ')).toBe(' ')
    expect(filter.finished()).toBe(true)
    expect(filter.take('\x1b[B')).toBe('\x1b[B')
  })

  it('never changes the answer of the first prompt when it reaches a real Clack multiselect', async () => {
    const stdin = Object.assign(new PassThrough(), {
      isTTY: true,
      setRawMode: () => stdin,
    })
    let drawn = ''
    const stdout = Object.assign(
      new Writable({
        write(chunk: Buffer | string, _encoding, done) {
          drawn += chunk.toString()
          done()
        },
      }),
      { isTTY: true, columns: 100 },
    )
    const port = processTerminalPort(
      stdin as unknown as NodeJS.ReadStream,
      stdout as unknown as NodeJS.WriteStream,
      { TERM: 'xterm-256color' },
    )

    await expect(probeTerminalBackground(port, 20)).resolves.toBeUndefined()
    const ui = createClackUi({
      input: stdin,
      output: stdout,
      palette: brandPalette({ background: 'dark', level: 0 }),
      columns: 100,
    })
    const answer = ui.multiselect({
      message: 'What platform will you test?',
      options: [
        { value: 'web', label: 'Web' },
        { value: 'mobile', label: 'Mobile' },
      ],
      initialValues: ['web'],
      required: true,
    })
    for (let waited = 0; !drawn.includes('What platform'); waited += 10) {
      if (waited > 3000) throw new Error(`the prompt never drew:\n${drawn}`)
      await sleep(10)
    }
    await sleep(20)
    stdin.write(Buffer.from(LATE_LIGHT_REPLY, 'latin1'))
    await sleep(20)
    stdin.write('\r')

    // A required multiselect left empty refuses Enter, so a changed answer shows as no answer.
    await expect(Promise.race([answer, sleep(2000, 'no answer')])).resolves.toEqual(['web'])
  })
})

describe('classifyBackground', () => {
  it('reads a COLORFGBG background of 0 as dark', () => {
    expect(classifyBackground(undefined, { COLORFGBG: '15;0' })).toBe('dark')
  })

  it('reads a COLORFGBG background of 15 as light', () => {
    expect(classifyBackground(undefined, { COLORFGBG: '0;15' })).toBe('light')
  })

  it('reads the last field of a three-part COLORFGBG', () => {
    expect(classifyBackground(undefined, { COLORFGBG: '0;default;15' })).toBe('light')
  })

  it('gives nothing for an unset or unrecognised COLORFGBG', () => {
    expect(classifyBackground(undefined, {})).toBeUndefined()
    expect(classifyBackground(undefined, { COLORFGBG: '15;default' })).toBeUndefined()
    expect(classifyBackground(undefined, { COLORFGBG: '0;12' })).toBeUndefined()
    expect(classifyBackground(undefined, { COLORFGBG: 'light' })).toBeUndefined()
  })

  it('prefers a measured colour over COLORFGBG', () => {
    expect(classifyBackground({ r: 1, g: 1, b: 1 }, { COLORFGBG: '15;0' })).toBe('light')
  })
})
