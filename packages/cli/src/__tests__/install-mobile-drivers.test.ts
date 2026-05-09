import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Command } from 'commander'

import {
  createInstallMobileDriversCommand,
  formatInstallMobileDriversRetryCommand,
  parseInstalledAppiumDrivers,
  runMobileDriverInstall,
  validateMobileDriverInstallSelection,
  type AppiumExecFile,
} from '../commands/install-mobile-drivers.js'

const LOCAL_APPIUM = '/tmp/project/node_modules/.bin/appium'

function makeExecFile(installedOutput: unknown = { drivers: [] }): ReturnType<typeof vi.fn<AppiumExecFile>> {
  return vi.fn((cmd: string, args: string[]) => {
    if (cmd !== LOCAL_APPIUM) throw new Error(`Unexpected command: ${cmd}`)
    const joined = args.join(' ')
    if (joined === '--version') return Buffer.from('2.0.0')
    if (joined === 'driver list --installed --json') {
      return Buffer.from(typeof installedOutput === 'string' ? installedOutput : JSON.stringify(installedOutput))
    }
    return Buffer.from('')
  })
}

async function runCommand(
  args: string[],
  execFile: ReturnType<typeof vi.fn<AppiumExecFile>> = makeExecFile(),
  parentArgs: string[] = [],
): Promise<string> {
  const output: string[] = []
  vi.spyOn(console, 'log').mockImplementation((...items: unknown[]) => {
    output.push(items.map(String).join(' '))
  })
  vi.spyOn(console, 'error').mockImplementation((...items: unknown[]) => {
    output.push(items.map(String).join(' '))
  })

  const parent = new Command()
  parent.option('--config <path>', 'config file path', 'agent-qa.config.yaml')
  parent.addCommand(createInstallMobileDriversCommand({
    resolveAppium: vi.fn(() => ({ command: LOCAL_APPIUM, source: 'local' as const })),
    execFile,
  }))

  await parent.parseAsync(['node', 'test', ...parentArgs, 'install-mobile-drivers', ...args])
  return output.join('\n')
}

describe('install-mobile-drivers command', () => {
  beforeEach(() => {
    process.exitCode = 0
  })

  afterEach(() => {
    vi.restoreAllMocks()
    process.exitCode = 0
  })

  it('formats retry commands with selected targets and update flags', () => {
    expect(formatInstallMobileDriversRetryCommand({ all: true })).toBe('agent-qa install-mobile-drivers --all')
    expect(formatInstallMobileDriversRetryCommand({ android: true, ios: true, update: true })).toBe('agent-qa install-mobile-drivers --android --ios --update')
    expect(formatInstallMobileDriversRetryCommand({ ios: true, update: true, unsafe: true })).toBe('agent-qa install-mobile-drivers --ios --update --unsafe')
  })

  it('validates target and update flag combinations', () => {
    expect(validateMobileDriverInstallSelection({})).toContain('Select at least one')
    expect(validateMobileDriverInstallSelection({ all: true, android: true })).toContain('Cannot combine --all')
    expect(validateMobileDriverInstallSelection({ ios: true, unsafe: true })).toContain('Cannot use --unsafe')
    expect(validateMobileDriverInstallSelection({ android: true })).toBeNull()
  })

  it('parses installed Appium drivers from JSON and plaintext output', () => {
    expect(parseInstalledAppiumDrivers(JSON.stringify({ installed: [{ name: 'uiautomator2' }] })).has('uiautomator2')).toBe(true)
    expect(parseInstalledAppiumDrivers(JSON.stringify({ xcuitest: { version: '1.0.0' } })).has('xcuitest')).toBe(true)
    expect(parseInstalledAppiumDrivers('uiautomator2@4.0.0\n').has('uiautomator2')).toBe(true)
  })

  it('fails before invoking Appium when no target is selected', async () => {
    const execFile = makeExecFile()
    const output = await runCommand([], execFile)

    expect(process.exitCode).toBe(1)
    expect(execFile).not.toHaveBeenCalled()
    expect(output).toContain('Select at least one mobile platform flag')
  })

  it('fails before invoking Appium when --all is combined with a target', async () => {
    const execFile = makeExecFile()
    const output = await runCommand(['--all', '--android'], execFile)

    expect(process.exitCode).toBe(1)
    expect(execFile).not.toHaveBeenCalled()
    expect(output).toContain('Cannot combine --all')
  })

  it('installs the Android UiAutomator2 driver through the resolved local Appium binary', async () => {
    const execFile = makeExecFile({ drivers: [] })

    await runCommand(['--android'], execFile, ['--config', '/tmp/project/agent-qa.config.yaml'])

    expect(execFile).toHaveBeenCalledWith(LOCAL_APPIUM, ['--version'], { stdio: 'pipe' })
    expect(execFile).toHaveBeenCalledWith(LOCAL_APPIUM, ['driver', 'list', '--installed', '--json'], { stdio: 'pipe', encoding: 'utf-8' })
    expect(execFile).toHaveBeenCalledWith(LOCAL_APPIUM, ['driver', 'install', 'uiautomator2'], { stdio: 'inherit' })
    expect(process.exitCode).toBe(0)
  })

  it('installs both mobile drivers for --all', async () => {
    const execFile = makeExecFile({ drivers: [] })

    await runCommand(['--all'], execFile)

    expect(execFile).toHaveBeenCalledWith(LOCAL_APPIUM, ['driver', 'install', 'uiautomator2'], { stdio: 'inherit' })
    expect(execFile).toHaveBeenCalledWith(LOCAL_APPIUM, ['driver', 'install', 'xcuitest'], { stdio: 'inherit' })
  })

  it('reuses already-installed selected drivers by default', async () => {
    const execFile = makeExecFile({ installed: [{ name: 'uiautomator2' }] })
    const output = await runCommand(['--android'], execFile)

    expect(execFile).not.toHaveBeenCalledWith(LOCAL_APPIUM, ['driver', 'install', 'uiautomator2'], { stdio: 'inherit' })
    expect(output).toContain('UiAutomator2 driver already installed')
  })

  it('updates already-installed selected drivers only when --update is explicit', async () => {
    const execFile = makeExecFile({ installed: [{ name: 'xcuitest' }] })

    await runCommand(['--ios', '--update'], execFile)

    expect(execFile).toHaveBeenCalledWith(LOCAL_APPIUM, ['driver', 'update', 'xcuitest'], { stdio: 'inherit' })
    expect(execFile).not.toHaveBeenCalledWith(LOCAL_APPIUM, ['driver', 'install', 'xcuitest'], { stdio: 'inherit' })
  })

  it('passes --unsafe to Appium update only with explicit update mode', async () => {
    const execFile = makeExecFile({ installed: [{ name: 'uiautomator2' }] })

    await runCommand(['--android', '--update', '--unsafe'], execFile)

    expect(execFile).toHaveBeenCalledWith(LOCAL_APPIUM, ['driver', 'update', 'uiautomator2', '--unsafe'], { stdio: 'inherit' })
  })

  it('treats already-installed Appium install errors as success', () => {
    const execFile = vi.fn((cmd: string, args: string[]) => {
      if (cmd !== LOCAL_APPIUM) throw new Error(`Unexpected command: ${cmd}`)
      const joined = args.join(' ')
      if (joined === '--version') return Buffer.from('2.0.0')
      if (joined === 'driver list --installed --json') return Buffer.from(JSON.stringify({ drivers: [] }))
      if (joined === 'driver install uiautomator2') throw new Error('A driver named "uiautomator2" is already installed.')
      return Buffer.from('')
    }) as ReturnType<typeof vi.fn<AppiumExecFile>>

    const result = runMobileDriverInstall({ android: true, cwd: '/tmp/project' }, {
      resolveAppium: () => ({ command: LOCAL_APPIUM, source: 'local' }),
      execFile,
    })

    expect(result.ok).toBe(true)
    expect(result.events).toContainEqual(expect.objectContaining({ driver: 'uiautomator2', action: 'reuse', ok: true }))
  })

  it('prints local-first Appium guidance when Appium is missing', async () => {
    const missing = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT', status: 127 })
    const execFile = vi.fn((cmd: string, args: string[]) => {
      if (cmd !== LOCAL_APPIUM) throw new Error(`Unexpected command: ${cmd}`)
      if (args.join(' ') === '--version') throw missing
      return Buffer.from('')
    }) as ReturnType<typeof vi.fn<AppiumExecFile>>

    const output = await runCommand(['--android'], execFile)

    expect(process.exitCode).toBe(127)
    expect(output).toContain('Appium not found')
    expect(output).toContain('npm install -D appium')
    expect(output).toContain('npm install -g appium')
  })

  it('returns a nonzero status and retry command when a driver operation fails', async () => {
    const execFile = vi.fn((cmd: string, args: string[]) => {
      if (cmd !== LOCAL_APPIUM) throw new Error(`Unexpected command: ${cmd}`)
      const joined = args.join(' ')
      if (joined === '--version') return Buffer.from('2.0.0')
      if (joined === 'driver list --installed --json') return Buffer.from(JSON.stringify({ drivers: [] }))
      if (joined === 'driver install xcuitest') throw Object.assign(new Error('xcode missing'), { status: 17 })
      return Buffer.from('')
    }) as ReturnType<typeof vi.fn<AppiumExecFile>>

    const output = await runCommand(['--ios'], execFile)

    expect(process.exitCode).toBe(17)
    expect(output).toContain('XCUITest driver installation failed')
    expect(output).toContain('agent-qa install-mobile-drivers --ios')
  })
})
