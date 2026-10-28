import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  guardJsonText,
  guardRunText,
  isGitHubActions,
  printRunText,
  reserveStdoutForData,
} from '../logging/run-text-output.js'

const ACTIONS = { GITHUB_ACTIONS: 'true' }
const PAIR = /^::stop-commands::([0-9a-f]{32})\n([\s\S]*)::\1::\n$/u

describe('isGitHubActions', () => {
  it.each(['true', '1', 'yes'])('reads %j as on', (value) => {
    expect(isGitHubActions({ GITHUB_ACTIONS: value })).toBe(true)
  })

  it.each([undefined, '', 'false', 'FALSE', '0'])('reads %j as off', (value) => {
    expect(isGitHubActions({ GITHUB_ACTIONS: value })).toBe(false)
  })
})

describe('guardRunText', () => {
  it('wraps a block in one stop-commands pair with a fresh token', () => {
    const block = guardRunText('::set-output name=x::y\n##[error]x', ACTIONS)
    expect(block).toMatch(
      /^::stop-commands::([0-9a-f]{32})\n::set-output name=x::y\n##\[error\]x\n::\1::\n$/u,
    )
  })

  it('adds no second newline to a block that already ends in one', () => {
    const block = guardRunText('line\n', ACTIONS)
    expect(PAIR.exec(block)?.[2]).toBe('line\n')
  })

  it('uses a different token on every call', () => {
    const first = PAIR.exec(guardRunText('x', ACTIONS))?.[1]
    const second = PAIR.exec(guardRunText('x', ACTIONS))?.[1]
    expect(first).toBeDefined()
    expect(second).toBeDefined()
    expect(first).not.toBe(second)
  })

  it('returns the text unchanged off GitHub Actions', () => {
    expect(guardRunText('::set-output name=x::y', {})).toBe('::set-output name=x::y')
  })
})

describe('guardJsonText', () => {
  const value = { '#k': '##[error]x', p: 'a\\#b' }

  it('writes every # as an escape that parses back to the same value', () => {
    const guarded = guardJsonText(JSON.stringify(value), ACTIONS)
    expect(guarded).not.toContain('#')
    expect(JSON.parse(guarded)).toEqual(value)
  })

  it('returns the JSON unchanged off GitHub Actions', () => {
    const serialized = JSON.stringify(value)
    expect(guardJsonText(serialized, {})).toBe(serialized)
  })
})

describe('printRunText', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
    vi.unstubAllEnvs()
  })

  it('writes the wrapped block to stdout once under GitHub Actions', () => {
    vi.stubEnv('GITHUB_ACTIONS', 'true')
    const print = vi.fn()
    printRunText('::add-mask::x', print)
    expect(print).not.toHaveBeenCalled()
    expect(stderrSpy).not.toHaveBeenCalled()
    expect(stdoutSpy).toHaveBeenCalledTimes(1)
    const block = String(stdoutSpy.mock.calls[0]?.[0])
    expect(PAIR.exec(block)?.[2]).toBe('::add-mask::x\n')
  })

  it('writes the block to stderr once, skipping the caller print, when stdout is data', () => {
    const print = vi.fn()
    printRunText('::add-mask::x', print, { env: ACTIONS, stdoutIsData: true })
    expect(print).not.toHaveBeenCalled()
    expect(stdoutSpy).not.toHaveBeenCalled()
    expect(stderrSpy).toHaveBeenCalledTimes(1)
    expect(PAIR.exec(String(stderrSpy.mock.calls[0]?.[0]))?.[2]).toBe('::add-mask::x\n')
  })

  it('writes each block to stderr once while stdout is reserved, skipping the caller print', () => {
    const ignoresItsText = vi.fn()
    const splitsItsText = vi.fn((text: string) => text.split('\n'))
    const release = reserveStdoutForData()
    try {
      printRunText('::add-mask::x', () => ignoresItsText(), { env: ACTIONS })
      printRunText('a\nb', splitsItsText, { env: ACTIONS })
      printRunText('::add-mask::y', undefined, { env: ACTIONS })
    } finally {
      release()
    }
    expect(ignoresItsText).not.toHaveBeenCalled()
    expect(splitsItsText).not.toHaveBeenCalled()
    expect(stdoutSpy).not.toHaveBeenCalled()
    expect(stderrSpy).toHaveBeenCalledTimes(3)
    expect(PAIR.exec(String(stderrSpy.mock.calls[0]?.[0]))?.[2]).toBe('::add-mask::x\n')
    expect(PAIR.exec(String(stderrSpy.mock.calls[1]?.[0]))?.[2]).toBe('a\nb\n')
    expect(PAIR.exec(String(stderrSpy.mock.calls[2]?.[0]))?.[2]).toBe('::add-mask::y\n')
  })

  it('releasing a reservation twice releases it once', () => {
    const outer = reserveStdoutForData()
    const inner = reserveStdoutForData()
    inner()
    inner()
    printRunText('x', vi.fn(), { env: ACTIONS })
    expect(stderrSpy).toHaveBeenCalledTimes(1)
    expect(stdoutSpy).not.toHaveBeenCalled()

    outer()
    printRunText('x', vi.fn(), { env: ACTIONS })
    expect(stderrSpy).toHaveBeenCalledTimes(1)
    expect(stdoutSpy).toHaveBeenCalledTimes(1)
  })

  it('calls the caller print with the text unchanged off GitHub Actions', () => {
    const print = vi.fn()
    printRunText('::add-mask::x', print)
    expect(print).toHaveBeenCalledTimes(1)
    expect(print).toHaveBeenCalledWith('::add-mask::x')
    expect(stdoutSpy).not.toHaveBeenCalled()
    expect(stderrSpy).not.toHaveBeenCalled()
  })
})

describe('the stdout reservation across the built entry points', () => {
  it('a reservation through the subpath keeps the root entry\'s LogManager off stdout', () => {
    const script = `
      import { reserveStdoutForData } from '@vostride/agent-qa-core/run-text-output'
      import { LogManager } from '@vostride/agent-qa-core'
      const release = reserveStdoutForData()
      new LogManager({ displayLevel: 'info' }).log('info', 'runner', 'while held ::add-mask::x')
      release()
      new LogManager({ displayLevel: 'info' }).log('info', 'runner', 'after release')
    `
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: fileURLToPath(new URL('../..', import.meta.url)),
      env: { ...process.env, GITHUB_ACTIONS: 'true' },
      encoding: 'utf8',
    })
    expect(child.status, child.stderr).toBe(0)
    expect(child.stdout).toMatch(PAIR)
    expect(child.stdout).toContain('after release')
    expect(child.stdout).not.toContain('while held')
    expect(child.stderr).toMatch(PAIR)
    expect(child.stderr).toContain('while held ::add-mask::x')
    expect(child.stderr).not.toContain('after release')
  })
})
