import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Command } from 'commander'

const { mockResolveConfig, mockStartServer } = vi.hoisted(() => ({
  mockResolveConfig: vi.fn(),
  mockStartServer: vi.fn(),
}))

vi.mock('../config.js', () => ({
  resolveConfig: mockResolveConfig,
}))

vi.mock('@vostride/agent-qa-dashboard', async () => {
  const actual = await vi.importActual<typeof import('@vostride/agent-qa-dashboard')>(
    '@vostride/agent-qa-dashboard',
  )
  return { ...actual, startServer: mockStartServer }
})

import {
  createDashboardCommand,
  dashboardOpenUrl,
  openDashboardUrl,
  type DashboardOpener,
} from '../commands/dashboard.js'
import { CliRefusal } from '../composition/cli-refusal.js'
import { runCli, type CliFailureDeps } from '../cli-error-handler.js'

const PAGE = '/config/models?add=openai-compatible-key&name=work'
const PAGE_URL = `http://localhost:3470${PAGE}`

function fakeOpener(platform: NodeJS.Platform) {
  const child = { on: vi.fn(), unref: vi.fn() }
  const spawn = vi.fn((_command: string, _args: readonly string[], _options: object) => child)
  const opener: DashboardOpener = { platform, spawn }
  return { opener, spawn, child }
}

function refusalOf(run: () => unknown): CliRefusal {
  try {
    run()
  } catch (error) {
    if (error instanceof CliRefusal) return error
    throw error
  }
  throw new Error('expected a refusal')
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('dashboardOpenUrl', () => {
  it('appends a page path to the local dashboard address', () => {
    expect(dashboardOpenUrl(3470, PAGE)).toBe(PAGE_URL)
  })

  it('opens the root for a bare --open', () => {
    expect(dashboardOpenUrl(3470, true)).toBe('http://localhost:3470')
  })

  it.each([
    'config/models',
    '/x"; rm -rf ~',
    '/a b<c>',
    '/x%PATH%',
    '/a^b',
    '/a|b',
    '/a>b',
    '/a!b',
    '/a\u0007b',
  ])('refuses %j with one line naming --open and exit 2', (path) => {
    const refusal = refusalOf(() => dashboardOpenUrl(3470, path))
    expect(refusal.exitCode).toBe(2)
    expect(refusal.lines).toHaveLength(1)
    expect(refusal.message).toContain('--open')
    expect(refusal.message).not.toContain('\n')
  })
})

describe('openDashboardUrl', () => {
  it('runs open with the URL and no shell on macOS', () => {
    const { opener, spawn, child } = fakeOpener('darwin')
    openDashboardUrl(PAGE_URL, opener)
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(spawn).toHaveBeenCalledWith('open', [PAGE_URL], { shell: false, stdio: 'ignore' })
    expect(child.unref).toHaveBeenCalledTimes(1)
  })

  it('runs xdg-open with the URL and no shell on Linux', () => {
    const { opener, spawn, child } = fakeOpener('linux')
    openDashboardUrl(PAGE_URL, opener)
    expect(spawn).toHaveBeenCalledWith('xdg-open', [PAGE_URL], { shell: false, stdio: 'ignore' })
    expect(child.unref).toHaveBeenCalledTimes(1)
  })

  it('hands cmd start "" with the whole URL in one quoted argument on Windows', () => {
    const { opener, spawn, child } = fakeOpener('win32')
    openDashboardUrl(PAGE_URL, opener)
    expect(spawn).toHaveBeenCalledWith(
      'cmd',
      ['/d', '/c', 'start', '""', `"${PAGE_URL}"`],
      { shell: false, stdio: 'ignore', windowsVerbatimArguments: true },
    )
    const [command, args] = spawn.mock.calls[0]!
    expect([command, ...args].join(' ')).toBe(`cmd /d /c start "" "${PAGE_URL}"`)
    expect(child.unref).toHaveBeenCalledTimes(1)
  })

  it.each(['http://localhost:3470/x%PATH%', 'http://localhost:3470/x"&calc'])(
    'refuses %j on Windows before anything is spawned',
    (url) => {
      const { opener, spawn } = fakeOpener('win32')
      expect(() => openDashboardUrl(url, opener)).toThrow(/cmd\.exe/u)
      expect(spawn).not.toHaveBeenCalled()
    },
  )

  it('swallows an error from a missing opener', () => {
    const { opener, child } = fakeOpener('linux')
    openDashboardUrl(PAGE_URL, opener)
    expect(child.on).toHaveBeenCalledWith('error', expect.any(Function))
    const onError = child.on.mock.calls[0]![1] as (error: Error) => void
    expect(() => onError(new Error('spawn xdg-open ENOENT'))).not.toThrow()
  })
})

describe('agent-qa dashboard --open', () => {
  it('refuses a page outside the URL-encoded form with exit 2 before the server starts', async () => {
    const { opener, spawn } = fakeOpener('darwin')
    const program = new Command()
    program.option('--config <path>')
    program.exitOverride()
    program.addCommand(createDashboardCommand(opener))

    const printed: string[] = []
    let exitCode: number | undefined
    const deps: CliFailureDeps = {
      print: (text) => printed.push(text),
      printFixed: (line) => printed.push(line),
      mask: (text) => text,
      setExitCode: () => {},
      capture: () => {},
      settle: async () => {},
      flush: async () => {},
      exit: (code) => {
        exitCode = code
      },
      env: {},
    }

    await runCli(program, ['node', 'agent-qa', 'dashboard', '--open', '/x"; rm -rf ~'], deps)

    expect(exitCode).toBe(2)
    expect(printed).toHaveLength(1)
    expect(printed[0]!.split('\n')).toHaveLength(1)
    expect(printed[0]).toContain('--open')
    expect(mockResolveConfig).not.toHaveBeenCalled()
    expect(mockStartServer).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
  })
})
