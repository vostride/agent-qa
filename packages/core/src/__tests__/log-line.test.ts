import pc from 'picocolors'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  colorEnabled,
  colorsFor,
  formatLogLine,
  isCi,
  printLogLine,
  type LogLine,
} from '../logging/log-line.js'

const PLAIN = pc.createColors(false)
const COLOURED = pc.createColors(true)
const TIME = new Date(2026, 10, 20, 9, 4, 7)
const PAIR = /^::stop-commands::([0-9a-f]{32})\n([\s\S]*)::\1::\n$/u

const RED = '\u001b[31m'
const YELLOW = '\u001b[33m'
const DIM = '\u001b[2m'
const MAGENTA = '\u001b[35m'
const CYAN = '\u001b[36m'

function clock(at: Date): string {
  const two = (value: number) => String(value).padStart(2, '0')
  return `${two(at.getHours())}:${two(at.getMinutes())}:${two(at.getSeconds())}`
}

function plain(line: LogLine): string {
  return formatLogLine({ time: TIME, ...line }, PLAIN)
}

describe('formatLogLine', () => {
  it('prints the time, the tag in its column and the message, ending with the message', () => {
    const text = plain({ tag: 'server', message: 'Dashboard running at http://localhost:55980' })
    expect(text).toBe(
      `${clock(TIME)}  server     Dashboard running at http://localhost:55980`,
    )
    expect(text.endsWith('55980')).toBe(true)
  })

  it.each([
    ['knowledge', 'knowledge  '],
    ['run', 'run        '],
    ['appium', 'appium     '],
  ])('starts the message in the same column after the tag %j', (tag, column) => {
    const text = plain({ tag, message: 'm' })
    expect(text).toBe(`${clock(TIME)}  ${column}m`)
    expect(text.slice(21)).toBe('m')
  })

  it('continues a second line of the message under the message column', () => {
    expect(plain({ tag: 'run', message: 'first\nsecond' })).toBe(
      `${clock(TIME)}  run        first\n${' '.repeat(21)}second`,
    )
  })

  it('prints data after the message as key=value pairs with JSON values', () => {
    expect(plain({ tag: 'appium', message: 'lease', data: { run: 'r_1', leases: 2 } })).toBe(
      `${clock(TIME)}  appium     lease run="r_1" leases=2`,
    )
  })

  it('prints nothing after the message when there is no data', () => {
    expect(plain({ tag: 'appium', message: 'Stopped', data: {} })).toBe(
      `${clock(TIME)}  appium     Stopped`,
    )
  })

  describe('with colour on', () => {
    function coloured(line: LogLine): string {
      return formatLogLine({ time: TIME, ...line }, COLOURED)
    }

    it('colours an error line red and a warning line yellow, line by line', () => {
      const error = coloured({ tag: 'live', message: 'one\ntwo', level: 'error' })
      expect(error).toContain(`${RED}one`)
      expect(error).toContain(`${RED}two`)
      expect(coloured({ tag: 'live', message: 'careful', level: 'warn' })).toContain(
        `${YELLOW}careful`,
      )
    })

    it('dims the time', () => {
      expect(coloured({ tag: 'server', message: 'm' }).startsWith(`${DIM}${clock(TIME)}`)).toBe(
        true,
      )
    })

    it('colours the appium tag magenta and a tag it does not know cyan', () => {
      expect(coloured({ tag: 'appium', message: 'm' })).toContain(`${MAGENTA}appium`)
      expect(coloured({ tag: 'somewhere', message: 'm' })).toContain(`${CYAN}somewhere`)
    })

    it('leaves an information line ending with its port and no escape code after it', () => {
      const text = coloured({ tag: 'server', message: 'Dashboard running at http://localhost:1' })
      expect(text.endsWith('  Dashboard running at http://localhost:1')).toBe(true)
    })
  })
})

describe('isCi', () => {
  it.each([{ CI: 'true' }, { CI: '1' }, { GITHUB_ACTIONS: 'true' }])('reads %j as CI', (env) => {
    expect(isCi(env)).toBe(true)
  })

  it.each([{}, { CI: '' }, { CI: '0' }, { CI: 'false' }])('reads %j as not CI', (env) => {
    expect(isCi(env)).toBe(false)
  })
})

describe('colorEnabled', () => {
  it.each([
    [{ NO_COLOR: '1' }, true, false],
    [{ NO_COLOR: '0' }, true, false],
    [{ NO_COLOR: '1', FORCE_COLOR: '1' }, true, false],
    [{ NO_COLOR: '' }, true, true],
    [{ FORCE_COLOR: '0' }, true, false],
    [{ FORCE_COLOR: 'false' }, true, false],
    [{ FORCE_COLOR: '1' }, false, true],
    [{ FORCE_COLOR: '' }, false, true],
    [{}, true, true],
    [{ TERM: 'dumb' }, true, false],
    [{ CI: 'true' }, false, true],
    [{}, false, false],
  ])('reads %j with a terminal %j as %j', (env, isTTY, expected) => {
    expect(colorEnabled(env, isTTY)).toBe(expected)
  })
})

describe('colorsFor', () => {
  it('colours a terminal stream and not another stream of the same process', () => {
    expect(colorsFor({ isTTY: true }, {}).red('x')).toBe(`${RED}x\u001b[39m`)
    expect(colorsFor({ isTTY: false }, {}).red('x')).toBe('x')
  })
})

describe('printLogLine', () => {
  let log: ReturnType<typeof vi.spyOn>
  let warn: ReturnType<typeof vi.spyOn>
  let error: ReturnType<typeof vi.spyOn>
  let stdout: ReturnType<typeof vi.spyOn>
  let stderr: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it.each([
    ['info', () => log],
    ['debug', () => log],
    ['warn', () => warn],
    ['error', () => error],
  ] as const)('sends a %s line to its console method', (level, method) => {
    printLogLine({ tag: 'server', message: 'hello', level }, { env: {} })
    expect(method()).toHaveBeenCalledTimes(1)
    expect(String(method().mock.calls[0]?.[0])).toMatch(/^\d\d:\d\d:\d\d {2}server {5}hello$/u)
  })

  it('sends an information line to console.error when told to write to stderr', () => {
    printLogLine({ tag: 'server', message: 'hello' }, { env: {}, to: 'stderr' })
    expect(error).toHaveBeenCalledTimes(1)
    expect(log).not.toHaveBeenCalled()
  })

  describe('when one stream is a terminal and the other is not', () => {
    const streams = [process.stdout, process.stderr] as const
    let saved: (PropertyDescriptor | undefined)[] = []

    function setTerminals(terminals: { stdout: boolean; stderr: boolean }): void {
      for (const [stream, isTTY] of [
        [process.stdout, terminals.stdout],
        [process.stderr, terminals.stderr],
      ] as const) {
        Object.defineProperty(stream, 'isTTY', { value: isTTY, configurable: true, writable: true })
      }
    }

    beforeEach(() => {
      saved = streams.map((stream) => Object.getOwnPropertyDescriptor(stream, 'isTTY'))
    })

    afterEach(() => {
      streams.forEach((stream, index) => {
        const descriptor = saved[index]
        if (descriptor === undefined) Reflect.deleteProperty(stream, 'isTTY')
        else Object.defineProperty(stream, 'isTTY', descriptor)
      })
    })

    it('colours the lines it sends to stderr and not the ones it sends to stdout when only stderr is a terminal', () => {
      setTerminals({ stdout: false, stderr: true })

      printLogLine({ tag: 'server', message: 'started' }, { env: {} })
      printLogLine({ tag: 'server', message: 'careful', level: 'warn' }, { env: {} })
      printLogLine({ tag: 'server', message: 'broken', level: 'error' }, { env: {} })
      printLogLine({ tag: 'server', message: 'moved' }, { env: {}, to: 'stderr' })

      expect(String(log.mock.calls[0]?.[0])).toMatch(/^\d\d:\d\d:\d\d {2}server {5}started$/u)
      expect(String(warn.mock.calls[0]?.[0])).toContain(`${YELLOW}careful`)
      expect(String(error.mock.calls[0]?.[0])).toContain(`${RED}broken`)
      expect(String(error.mock.calls[1]?.[0]).startsWith(DIM)).toBe(true)
    })

    it('colours the lines it sends to stdout and not the ones it sends to stderr when only stdout is a terminal', () => {
      setTerminals({ stdout: true, stderr: false })

      printLogLine({ tag: 'server', message: 'started' }, { env: {} })
      printLogLine({ tag: 'server', message: 'careful', level: 'warn' }, { env: {} })
      printLogLine({ tag: 'server', message: 'broken', level: 'error' }, { env: {} })
      printLogLine({ tag: 'server', message: 'moved', level: 'error' }, { env: {}, to: 'stdout' })

      expect(String(log.mock.calls[0]?.[0]).startsWith(DIM)).toBe(true)
      expect(String(warn.mock.calls[0]?.[0])).toMatch(/^\d\d:\d\d:\d\d {2}server {5}careful$/u)
      expect(String(error.mock.calls[0]?.[0])).toMatch(/^\d\d:\d\d:\d\d {2}server {5}broken$/u)
      expect(String(log.mock.calls[1]?.[0])).toContain(`${RED}moved`)
    })
  })

  it('writes one stop-commands pair holding the line under GitHub Actions', () => {
    printLogLine({ tag: 'server', message: '::set-output name=x::y' }, {
      env: { GITHUB_ACTIONS: 'true' },
    })
    expect(log).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
    const blocks = [...stdout.mock.calls, ...stderr.mock.calls].map((call) => String(call[0]))
    expect(blocks).toHaveLength(1)
    // GitHub Actions is CI, so the line inside the pair is coloured.
    const pair = PAIR.exec((blocks[0] ?? '').replace(/\u001b\[[0-9;]*m/gu, ''))
    expect(pair?.[2]).toMatch(/^\d\d:\d\d:\d\d {2}server {5}::set-output name=x::y\n$/u)
  })
})
