import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Command } from 'commander'

import {
  buildBrowserInstallArgs,
  createInstallBrowsersCommand,
  formatInstallBrowsersRetryCommand,
  runBrowserInstall,
} from '../commands/install-browsers.js'

const PLAYWRIGHT_CLI = '/tmp/agent-qa/node_modules/playwright-core/cli.js'

function spawnResult(status: number) {
  return {
    status,
    signal: null,
    output: [],
    pid: 123,
    stdout: null,
    stderr: null,
  } as any
}

async function runCommand(args: string[], spawn = vi.fn(() => spawnResult(0))): Promise<string> {
  const output: string[] = []
  vi.spyOn(console, 'log').mockImplementation((...items: unknown[]) => {
    output.push(items.map(String).join(' '))
  })
  vi.spyOn(console, 'error').mockImplementation((...items: unknown[]) => {
    output.push(items.map(String).join(' '))
  })

  const parent = new Command()
  parent.addCommand(createInstallBrowsersCommand({
    resolveCli: () => PLAYWRIGHT_CLI,
    spawn,
  }))

  await parent.parseAsync(['node', 'test', 'install-browsers', ...args])
  return output.join('\n')
}

describe('install-browsers command', () => {
  beforeEach(() => {
    process.exitCode = 0
  })

  afterEach(() => {
    vi.restoreAllMocks()
    process.exitCode = 0
  })

  it('builds Playwright args for all browsers without browser names', () => {
    expect(buildBrowserInstallArgs({ all: true })).toEqual([])
    expect(formatInstallBrowsersRetryCommand({ all: true })).toBe('agent-qa install-browsers --all')
  })

  it('builds Playwright args for selected browsers and pass-through flags', () => {
    expect(buildBrowserInstallArgs({
      chromium: true,
      firefox: true,
      webkit: true,
      withDeps: true,
      force: true,
    })).toEqual(['--with-deps', '--force', 'chromium', 'firefox', 'webkit'])

    expect(formatInstallBrowsersRetryCommand({
      firefox: true,
      webkit: true,
      force: true,
    })).toBe('agent-qa install-browsers --firefox --webkit --force')
  })

  it('fails before spawning when no browser selector is provided', async () => {
    const spawn = vi.fn(() => spawnResult(0))

    const output = await runCommand([], spawn)

    expect(process.exitCode).toBe(1)
    expect(spawn).not.toHaveBeenCalled()
    expect(output).toContain('Select at least one browser flag')
  })

  it('fails before spawning when --all is combined with a browser flag', async () => {
    const spawn = vi.fn(() => spawnResult(0))

    const output = await runCommand(['--all', '--chromium'], spawn)

    expect(process.exitCode).toBe(1)
    expect(spawn).not.toHaveBeenCalled()
    expect(output).toContain('Cannot combine --all')
  })

  it('spawns the pinned Playwright CLI for --all with no browser names', async () => {
    const spawn = vi.fn(() => spawnResult(0))

    await runCommand(['--all'], spawn)

    expect(spawn).toHaveBeenCalledWith(
      process.execPath,
      [PLAYWRIGHT_CLI, 'install'],
      { stdio: 'inherit' },
    )
    expect(process.exitCode).toBe(0)
  })

  it('spawns the pinned Playwright CLI with selected browsers and pass-through flags', async () => {
    const spawn = vi.fn(() => spawnResult(0))

    await runCommand(['--webkit', '--with-deps', '--force'], spawn)

    expect(spawn).toHaveBeenCalledWith(
      process.execPath,
      [PLAYWRIGHT_CLI, 'install', '--with-deps', '--force', 'webkit'],
      { stdio: 'inherit' },
    )
  })

  it('returns nonzero status and agent-qa retry guidance when install fails', async () => {
    const spawn = vi.fn(() => spawnResult(13))

    const output = await runCommand(['--webkit', '--force'], spawn)

    expect(process.exitCode).toBe(13)
    expect(output).toContain('agent-qa install-browsers --webkit --force')
    expect(output).not.toContain('npx playwright install')
  })

  it('uses process.execPath and a playwright-core CLI path with inherited stdio', () => {
    const spawn = vi.fn(() => spawnResult(0))

    const result = runBrowserInstall({ chromium: true }, {
      resolveCli: () => PLAYWRIGHT_CLI,
      spawn,
    })

    expect(result).toEqual({ ok: true, status: 0, stage: 'installer' })
    expect(spawn).toHaveBeenCalledWith(
      process.execPath,
      [expect.stringContaining('playwright-core/cli.js'), 'install', 'chromium'],
      { stdio: 'inherit' },
    )
  })
})
