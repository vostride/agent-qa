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

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    vi.unstubAllEnvs()
  })

  it('writes the wrapped block to stdout once under GitHub Actions', () => {
    vi.stubEnv('GITHUB_ACTIONS', 'true')
    const print = vi.fn()
    printRunText('::add-mask::x', print)
    expect(print).not.toHaveBeenCalled()
    expect(stdoutSpy).toHaveBeenCalledTimes(1)
    const block = String(stdoutSpy.mock.calls[0]?.[0])
    expect(PAIR.exec(block)?.[2]).toBe('::add-mask::x\n')
  })

  it('keeps the wrapped block on the caller stream when stdout carries data', () => {
    const print = vi.fn()
    printRunText('::add-mask::x', print, { env: ACTIONS, stdoutIsData: true })
    expect(stdoutSpy).not.toHaveBeenCalled()
    expect(print).toHaveBeenCalledTimes(1)
    const printed = String(print.mock.calls[0]?.[0])
    expect(PAIR.exec(`${printed}\n`)?.[2]).toBe('::add-mask::x\n')
  })

  it('keeps the wrapped block on the caller stream while stdout is reserved for data', () => {
    const print = vi.fn()
    const release = reserveStdoutForData()
    try {
      printRunText('::add-mask::x', print, { env: ACTIONS })
    } finally {
      release()
    }
    expect(stdoutSpy).not.toHaveBeenCalled()
    expect(print).toHaveBeenCalledTimes(1)
    expect(PAIR.test(`${String(print.mock.calls[0]?.[0])}\n`)).toBe(true)
  })

  it('releasing a reservation twice releases it once', () => {
    const outer = reserveStdoutForData()
    const inner = reserveStdoutForData()
    inner()
    inner()
    const print = vi.fn()
    printRunText('x', print, { env: ACTIONS })
    expect(print).toHaveBeenCalledTimes(1)
    expect(stdoutSpy).not.toHaveBeenCalled()

    outer()
    printRunText('x', print, { env: ACTIONS })
    expect(print).toHaveBeenCalledTimes(1)
    expect(stdoutSpy).toHaveBeenCalledTimes(1)
  })

  it('calls the caller print with the text unchanged off GitHub Actions', () => {
    const print = vi.fn()
    printRunText('::add-mask::x', print)
    expect(print).toHaveBeenCalledTimes(1)
    expect(print).toHaveBeenCalledWith('::add-mask::x')
    expect(stdoutSpy).not.toHaveBeenCalled()
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
