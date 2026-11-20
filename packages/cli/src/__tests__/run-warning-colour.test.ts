import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { curationTailLog, printRunWarning } from '../commands/run.js'

const ESC = '\x1B'
const YELLOW = '\x1B[33m'
const DIM = '\x1B[2m'
const LINE = '  Quarantine: one test is quarantined'
const streams = [process.stdout, process.stderr] as const

let savedTTY: (PropertyDescriptor | undefined)[] = []

function setTerminals(terminals: { stdout: boolean; stderr: boolean }): void {
  Object.defineProperty(process.stdout, 'isTTY', {
    value: terminals.stdout,
    configurable: true,
    writable: true,
  })
  Object.defineProperty(process.stderr, 'isTTY', {
    value: terminals.stderr,
    configurable: true,
    writable: true,
  })
}

function captureConsole(): {
  warn: ReturnType<typeof vi.spyOn>
  others: ReturnType<typeof vi.spyOn>[]
  stdout: string[]
} {
  const stdout: string[] = []
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const others = [
    vi.spyOn(console, 'log').mockImplementation(() => {}),
    vi.spyOn(console, 'error').mockImplementation(() => {}),
    vi.spyOn(console, 'info').mockImplementation(() => {}),
  ]
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    stdout.push(String(chunk))
    return true
  })
  return { warn, others, stdout }
}

beforeEach(() => {
  savedTTY = streams.map((stream) => Object.getOwnPropertyDescriptor(stream, 'isTTY'))
  vi.stubEnv('NO_COLOR', '')
  vi.stubEnv('CI', '')
  vi.stubEnv('GITHUB_ACTIONS', '')
  vi.stubEnv('FORCE_COLOR', undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  streams.forEach((stream, index) => {
    const saved = savedTTY[index]
    if (saved === undefined) Reflect.deleteProperty(stream, 'isTTY')
    else Object.defineProperty(stream, 'isTTY', saved)
  })
})

describe("a run's warning takes the colours of stderr, the stream it is written to", () => {
  it('is yellow when stderr is a terminal and stdout is not', () => {
    setTerminals({ stdout: false, stderr: true })
    const calls = captureConsole()

    printRunWarning(LINE)

    expect(calls.warn).toHaveBeenCalledTimes(1)
    const [printed] = calls.warn.mock.calls[0] as [string]
    expect(printed).toContain(YELLOW)
    expect(printed).toContain(LINE)
    for (const other of calls.others) expect(other).not.toHaveBeenCalled()
    expect(calls.stdout).toEqual([])
  })

  it('has no colour when stdout is a terminal and stderr is not', () => {
    setTerminals({ stdout: true, stderr: false })
    const calls = captureConsole()

    printRunWarning(LINE)

    expect(calls.warn).toHaveBeenCalledTimes(1)
    expect(calls.warn).toHaveBeenCalledWith(LINE)
  })

  it('has no colour with NO_COLOR set, even when stderr is a terminal', () => {
    vi.stubEnv('NO_COLOR', '1')
    setTerminals({ stdout: false, stderr: true })
    const calls = captureConsole()

    printRunWarning(LINE)

    expect(calls.warn).toHaveBeenCalledTimes(1)
    const [printed] = calls.warn.mock.calls[0] as [string]
    expect(printed).not.toContain(ESC)
    expect(printed).toBe(LINE)
  })

  it('prints one stop-commands pair holding the text under GitHub Actions, and no console line', () => {
    vi.stubEnv('GITHUB_ACTIONS', 'true')
    setTerminals({ stdout: false, stderr: false })
    const calls = captureConsole()

    printRunWarning(LINE)

    expect(calls.warn).not.toHaveBeenCalled()
    for (const other of calls.others) expect(other).not.toHaveBeenCalled()
    expect(calls.stdout).toHaveLength(1)
    const written = calls.stdout[0]!.replace(/\x1b\[[0-9;]*m/g, '')
    const token = /^::stop-commands::([0-9a-f]+)\n/u.exec(written)?.[1]
    expect(token, written).toBeDefined()
    expect(written).toBe(`::stop-commands::${token}\n${LINE}\n::${token}::\n`)
  })
})

describe("the curator's lines in a run take the colours of stderr, the stream they go to", () => {
  const WARNING = 'Warning: curation did not finish'
  const DETAIL = 'curation: drained inline (12ms)'

  let calls: ReturnType<typeof captureConsole> & { error: ReturnType<typeof vi.spyOn> }

  function capture(): void {
    const base = captureConsole()
    calls = { ...base, error: base.others[1]! }
  }

  function detailAtDebug(): string {
    const saved = curationTailLog.level
    curationTailLog.level = 'debug'
    try {
      curationTailLog.detail(DETAIL)
    } finally {
      curationTailLog.level = saved
    }
    expect(calls.error).toHaveBeenCalledTimes(1)
    return (calls.error.mock.calls[0] as [string])[0]
  }

  it('prints the warning in yellow when stderr is a terminal and stdout is not', () => {
    setTerminals({ stdout: false, stderr: true })
    capture()

    curationTailLog.warn('curation did not finish')

    expect(calls.warn).toHaveBeenCalledTimes(1)
    const [printed] = calls.warn.mock.calls[0] as [string]
    expect(printed).toContain(YELLOW)
    expect(printed).toContain(WARNING)
    expect(calls.stdout).toEqual([])
  })

  it('prints the warning with no colour when stdout is a terminal and stderr is not', () => {
    setTerminals({ stdout: true, stderr: false })
    capture()

    curationTailLog.warn('curation did not finish')

    expect(calls.warn).toHaveBeenCalledTimes(1)
    expect(calls.warn).toHaveBeenCalledWith(WARNING)
  })

  it('dims the time of a detail line at debug when stderr is a terminal and stdout is not', () => {
    setTerminals({ stdout: false, stderr: true })
    capture()

    const printed = detailAtDebug()

    expect(printed).toContain(DIM)
    expect(printed).toContain(DETAIL)
    expect(calls.stdout).toEqual([])
  })

  it('prints a detail line at debug with no colour when stdout is a terminal and stderr is not', () => {
    setTerminals({ stdout: true, stderr: false })
    capture()

    const printed = detailAtDebug()

    expect(printed).not.toContain(ESC)
    expect(printed).toMatch(/^\d{2}:\d{2}:\d{2} {2}knowledge {2}curation: drained inline \(12ms\)$/u)
  })
})
