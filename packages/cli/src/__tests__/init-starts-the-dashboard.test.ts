// An interactive init ends by starting the dashboard, as a child, on the page that finishes setup.
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { createServer, type AddressInfo } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { getAuthPath } from '@vostride/agent-qa-core'
import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { parse } from 'yaml'

import { runCli, type CliFailureDeps } from '../cli-error-handler.js'
import { createInitCommand } from '../commands/init.js'
import type { InitDocument } from '../commands/init-document.js'
import { dashboardPage, probeDashboardPort } from '../commands/init-dashboard.js'
import { installedAgentQaVersion } from '../commands/package-json-plan.js'
import type { RunResult } from '../commands/project-host.js'
import { composeAnalyticsHost } from '../composition/analytics-host.js'
import { CANCELLED_LINE } from '../composition/cli-refusal.js'
import { fakeInitUi, type FakeInitUi } from './fake-init-ui.js'
import {
  cleanupTempProjects,
  fakeRunner,
  tempProject,
  writeInstalledPackage,
  type FakeRunner,
} from './project-fixtures.js'
import { takeGuardedCalls } from './test-side-effect-guard.js'

const spawned = vi.hoisted(() => [] as string[])
const sockets = vi.hoisted(() => ({ servers: 0 }))

vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>()
  const record =
    <T extends (...args: never[]) => unknown>(fn: T) =>
    (...args: Parameters<T>): ReturnType<T> => {
      spawned.push(args.flat().filter((arg) => typeof arg === 'string').join(' '))
      return fn(...args) as ReturnType<T>
    }
  return {
    ...real,
    spawn: record(real.spawn),
    spawnSync: record(real.spawnSync),
    exec: record(real.exec),
    execFile: record(real.execFile),
  }
})

vi.mock('node:net', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:net')>()
  return {
    ...real,
    createServer: (...args: Parameters<typeof real.createServer>) => {
      sockets.servers += 1
      return real.createServer(...args)
    },
  }
})

const CLI_PACKAGE = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const RUNNING_BIN = resolve(
  CLI_PACKAGE,
  (JSON.parse(readFileSync(join(CLI_PACKAGE, 'package.json'), 'utf8')) as {
    bin: Record<string, string>
  }).bin['agent-qa']!,
)
const RUN_COMMAND = 'npx agent-qa run suites/examples.suite.yaml'
const BASE = ['--platform', 'web', '--no-browsers', '--agents', 'none', '--pm', 'npm']
const OK: RunResult = { code: 0, signal: null, output: '' }

const silentAnalytics: typeof composeAnalyticsHost = async () =>
  composeAnalyticsHost({
    surface: 'cli',
    env: {},
    transportOverride: { capture: () => {}, flush: () => {}, shutdown: () => {} },
    resolveIdentity: async () => ({ distinctId: 'u_init-dashboard', runtimeContext: 'user' }),
  })

let stderr: MockInstance<typeof process.stderr.write>
let stdout: MockInstance<typeof process.stdout.write>

interface Project {
  root: string
  home: string
}

function project(options: { agentQa?: boolean } = {}): Project {
  const { root, home } = tempProject('dashboard')
  if (options.agentQa !== false) {
    writeInstalledPackage(root, 'agent-qa', installedAgentQaVersion(), {
      packageJson: { bin: { 'agent-qa': 'cli.js' } },
      files: { 'cli.js': '' },
    })
  }
  return { root, home }
}

function projectBin(root: string): string {
  return realpathSync(join(root, 'node_modules', 'agent-qa', 'cli.js'))
}

function saveCredentials(home: string, store: Record<string, unknown>): void {
  const authPath = getAuthPath({ env: {}, homeDir: home })
  mkdirSync(dirname(authPath), { recursive: true })
  writeFileSync(authPath, JSON.stringify(store))
}

function configuredPort(root: string): number {
  const config = parse(readFileSync(join(root, 'agent-qa.config.yaml'), 'utf8')) as {
    services: { dashboard: { port: number } }
  }
  return config.services.dashboard.port
}

const FREE_PORT = 49_731
const freePort = { probe: async () => 'free' as const, findFree: async () => FREE_PORT }
const busyPort = { probe: async () => 'busy' as const, findFree: async () => FREE_PORT }

// Answers the manager's version probe and the dashboard, and passes every other call.
function runner(dashboard: RunResult = OK, onDashboard?: () => void): FakeRunner {
  return fakeRunner(({ args }) => {
    if (args[0] === '--version') return { code: 0, signal: null, output: '10.0.0\n' }
    if (args.includes('dashboard')) {
      onDashboard?.()
      return dashboard
    }
    return OK
  })
}

interface InitExit {
  exit: number | undefined
  stderr: string
  stdout: string
}

async function init(
  { root, home }: Project,
  ui: FakeInitUi,
  args: readonly string[],
  options: {
    run?: FakeRunner
    dashboardPort?: typeof freePort
    isTTY?: boolean
    env?: NodeJS.ProcessEnv
  } = {},
): Promise<InitExit> {
  stderr.mockClear()
  stdout.mockClear()
  const program = new Command('agent-qa').addCommand(
    createInitCommand({
      cwd: root,
      host: {
        homedir: home,
        env: options.env ?? {},
        ...(options.run === undefined ? {} : { run: options.run }),
      },
      isTTY: options.isTTY ?? true,
      ui,
      composeAnalytics: silentAnalytics,
      ...(options.dashboardPort === undefined ? {} : { dashboardPort: options.dashboardPort }),
    }),
  )
  const printed: string[] = []
  let exit: number | undefined
  const deps: CliFailureDeps = {
    print: (text) => printed.push(text),
    printFixed: (line) => printed.push(line),
    mask: (text) => text,
    setExitCode: () => {},
    flush: async () => {},
    exit: (code) => {
      exit = code
    },
    env: {},
  }
  await runCli(program, ['node', 'agent-qa', 'init', ...args], deps)
  const written = stderr.mock.calls.map((call) => String(call[0])).join('')
  const out = stdout.mock.calls.map((call) => String(call[0])).join('')
  return { exit, stderr: `${written}${printed.join('\n')}`, stdout: out }
}

function dashboardCalls(run: FakeRunner): string[][] {
  return run.calls
    .filter((call) => call.args.includes('dashboard'))
    .map((call) => [call.command, ...call.args])
}

function nextSteps(ui: FakeInitUi): string[] {
  const note = ui.entries.find((entry) => entry.kind === 'note' && entry.text === 'Next steps')
  return note?.kind === 'note' ? note.lines : []
}

beforeEach(() => {
  stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  spawned.length = 0
  sockets.servers = 0
  cleanupTempProjects()
})

describe('the page the dashboard opens on', () => {
  it('is the model page while the model is pending', () => {
    expect(dashboardPage({ model: 'pending' })).toBe('/config/models')
  })

  it('is none, the runs page, once the model is ready', () => {
    expect(dashboardPage({ model: 'ready' })).toBeUndefined()
  })

  it('adds a saved compatible key by its name and a new endpoint by its kind', () => {
    const saved = { add: 'openai-compatible-key', name: 'work' }
    expect(dashboardPage({ model: 'pending', dashboard: saved })).toBe(
      '/config/models?add=openai-compatible-key&name=work',
    )
    const endpoint = { add: 'anthropic-compatible-key' }
    expect(dashboardPage({ model: 'pending', dashboard: endpoint })).toBe(
      '/config/models?add=anthropic-compatible-key',
    )
  })

  it('leaves out a name that is not a slug, so the page stays one plain argument', () => {
    expect(
      dashboardPage({
        model: 'pending',
        dashboard: { add: 'openai-compatible-key', name: 'Work Key"; rm -rf ~' },
      }),
    ).toBe('/config/models?add=openai-compatible-key')
  })
})

describe('an interactive init starts the dashboard', () => {
  it('runs the project agent-qa on the model page after the next steps while the model is pending', async () => {
    const target = project()
    const ui = fakeInitUi()
    let drawnBefore = -1
    const run = runner(OK, () => {
      drawnBefore = ui.entries.length
    })

    const result = await init(target, ui, [...BASE, '--llm', 'gemini'], {
      run,
      dashboardPort: freePort,
    })

    expect(result.exit).toBeUndefined()
    expect(dashboardCalls(run)).toEqual([
      [process.execPath, projectBin(target.root), 'dashboard', '--open', '/config/models'],
    ])
    expect(run.calls.find((call) => call.args.includes('dashboard'))?.stdio).toBe('inherit')
    const note = ui.entries.findIndex((entry) => entry.kind === 'note')
    expect(note).toBeGreaterThanOrEqual(0)
    expect(drawnBefore).toBeGreaterThan(note)
    expect(ui.entries).toContainEqual({
      kind: 'done',
      text: `Dashboard on http://127.0.0.1:${configuredPort(target.root)} (Ctrl-C stops it)`,
    })
    expect(nextSteps(ui).slice(-2)).toEqual(['Run the examples in the dashboard, or:', RUN_COMMAND])
    expect(nextSteps(ui)).not.toContain('npx agent-qa dashboard')
  })

  it('opens on the runs page when the model is ready', async () => {
    const target = project()
    saveCredentials(target.home, {
      gemini: { type: 'api', provider: 'gemini', key: 'DUMMY-KEY-D' },
    })
    const run = runner()

    await init(target, fakeInitUi(), [...BASE, '--llm', 'gemini'], {
      run,
      dashboardPort: freePort,
    })

    expect(dashboardCalls(run)).toEqual([
      [process.execPath, projectBin(target.root), 'dashboard', '--open'],
    ])
  })

  it('opens on the model page adding a saved compatible key by its name', async () => {
    const target = project()
    saveCredentials(target.home, {
      work: { type: 'api', provider: 'openai-compatible', key: 'DUMMY-KEY-W' },
    })
    const run = runner()

    await init(target, fakeInitUi(), [...BASE, '--llm', 'work'], { run, dashboardPort: freePort })

    expect(dashboardCalls(run)).toEqual([
      [
        process.execPath,
        projectBin(target.root),
        'dashboard',
        '--open',
        '/config/models?add=openai-compatible-key&name=work',
      ],
    ])
  })

  it('opens on the model page adding a new Anthropic-compatible endpoint', async () => {
    const target = project()
    const run = runner()

    await init(target, fakeInitUi(), [...BASE, '--llm', 'anthropic-compatible'], {
      run,
      dashboardPort: freePort,
    })

    expect(dashboardCalls(run)).toEqual([
      [
        process.execPath,
        projectBin(target.root),
        'dashboard',
        '--open',
        '/config/models?add=anthropic-compatible-key',
      ],
    ])
  })

  it('runs this agent-qa as a child when the project has none installed', async () => {
    const target = project({ agentQa: false })
    const run = runner()

    await init(target, fakeInitUi(), [...BASE, '--llm', 'gemini'], { run, dashboardPort: freePort })

    expect(dashboardCalls(run)).toEqual([
      [process.execPath, RUNNING_BIN, 'dashboard', '--open', '/config/models'],
    ])
    expect(spawned.filter((call) => call.includes('dashboard'))).toEqual([])
  })

  it('adds no SIGINT listener while the dashboard runs, and the step runner holds none', async () => {
    const before = process.listenerCount('SIGINT')
    let during = -1
    const run = runner(OK, () => {
      during = process.listenerCount('SIGINT')
    })

    await init(project(), fakeInitUi(), [...BASE, '--llm', 'gemini'], {
      run,
      dashboardPort: freePort,
    })

    expect(dashboardCalls(run)).toHaveLength(1)
    expect(during).toBe(before)
  })
})

describe('stopping the dashboard ends init with setup code', () => {
  const stops: [string, RunResult][] = [
    ['a clean exit after Ctrl-C', { code: 0, signal: null, output: '', cancelled: true }],
    ['an exit 130 on a second Ctrl-C', { code: 130, signal: null, output: '', cancelled: true }],
    ['death by SIGINT', { code: null, signal: 'SIGINT', output: '' }],
  ]

  for (const [label, stop] of stops) {
    it(`exits 0 without Cancelled. after ${label} when every step went through`, async () => {
      const run = runner(stop)

      const result = await init(project(), fakeInitUi(), [...BASE, '--llm', 'gemini'], {
        run,
        dashboardPort: freePort,
      })

      expect(dashboardCalls(run)).toHaveLength(1)
      expect(result.exit).toBeUndefined()
      expect(result.stderr).not.toContain(CANCELLED_LINE)
    })

    it(`exits 3 without Cancelled. after ${label} when the Chromium step failed`, async () => {
      const run = fakeRunner(({ args }) => {
        if (args[0] === '--version') return { code: 0, signal: null, output: '10.0.0\n' }
        if (args.includes('install-browsers')) return { code: 1, signal: null, output: 'offline\n' }
        return args.includes('dashboard') ? stop : OK
      })
      const ui = fakeInitUi()

      const result = await init(
        project(),
        ui,
        ['--platform', 'web', '--agents', 'none', '--pm', 'npm', '--llm', 'gemini'],
        { run, dashboardPort: freePort },
      )

      expect(dashboardCalls(run)).toHaveLength(1)
      expect(ui.entries.some((entry) => entry.kind === 'failed')).toBe(true)
      expect(result.exit).toBe(3)
      expect(result.stderr).not.toContain(CANCELLED_LINE)
    })
  }
})

describe('when init does not start the dashboard', () => {
  it('a busy port skips the step and names a free port in the next steps, with exit 0', async () => {
    const target = project()
    const ui = fakeInitUi()
    const run = runner()

    const result = await init(target, ui, [...BASE, '--llm', 'gemini'], {
      run,
      dashboardPort: busyPort,
    })

    const port = configuredPort(target.root)
    expect(nextSteps(ui).join(' ')).toContain(`npx agent-qa dashboard --port ${FREE_PORT}`)
    expect(dashboardCalls(run)).toEqual([])
    expect(ui.entries).toContainEqual({
      kind: 'skipped',
      text: `Dashboard: skipped (port ${port} is in use)`,
    })
    expect(nextSteps(ui).at(-1)).toMatch(/^npx agent-qa dashboard --port \d+$/u)
    expect(result.exit).toBeUndefined()
  })

  it('a busy port leaves a failed setup at exit 3', async () => {
    const run = fakeRunner(({ args }) => {
      if (args[0] === '--version') return { code: 0, signal: null, output: '10.0.0\n' }
      return args.includes('install-browsers') ? { code: 1, signal: null, output: 'offline\n' } : OK
    })

    const result = await init(
      project(),
      fakeInitUi(),
      ['--platform', 'web', '--agents', 'none', '--pm', 'npm', '--llm', 'gemini'],
      { run, dashboardPort: busyPort },
    )

    expect(dashboardCalls(run)).toEqual([])
    expect(result.exit).toBe(3)
  })

  it('--no-dashboard skips the step and lists the dashboard command last', async () => {
    const ui = fakeInitUi()
    const run = runner()

    const result = await init(project(), ui, [...BASE, '--llm', 'gemini', '--no-dashboard'], {
      run,
      dashboardPort: freePort,
    })

    expect(dashboardCalls(run)).toEqual([])
    expect(ui.entries).toContainEqual({
      kind: 'skipped',
      text: 'Dashboard: skipped (--no-dashboard)',
    })
    expect(nextSteps(ui).at(-1)).toBe('npx agent-qa dashboard')
    expect(result.exit).toBeUndefined()
  })

  const unattended: [string, readonly string[], { isTTY?: boolean; env?: NodeJS.ProcessEnv }][] = [
    ['--yes in a terminal', ['--yes'], {}],
    ['CI', [], { env: { CI: 'true' } }],
    ['no terminal', [], { isTTY: false }],
  ]

  for (const [label, args, options] of unattended) {
    it(`${label} skips the step as not interactive and lists the dashboard command`, async () => {
      const ui = fakeInitUi()
      const run = runner()

      await init(project(), ui, [...BASE, '--llm', 'gemini', ...args], {
        run,
        dashboardPort: freePort,
        ...options,
      })

      expect(dashboardCalls(run)).toEqual([])
      expect(ui.entries).toContainEqual({
        kind: 'skipped',
        text: 'Dashboard: skipped (not interactive)',
      })
      expect(nextSteps(ui).at(-1)).toBe('npx agent-qa dashboard')
    })
  }

  it('--json records the dashboard step as skipped, not interactive', async () => {
    const run = runner()

    const result = await init(project(), fakeInitUi(), [...BASE, '--llm', 'gemini', '--json'], {
      run,
      dashboardPort: freePort,
    })

    const doc = JSON.parse(result.stdout) as InitDocument
    expect(dashboardCalls(run)).toEqual([])
    expect(doc.steps.at(-1)).toEqual({
      name: 'dashboard',
      outcome: 'skipped',
      reason: 'not interactive',
    })
    expect(doc.nextSteps.at(-1)?.command).toBe('npx agent-qa dashboard')
  })
})

describe('the port probe', () => {
  it('reads a port a server holds on loopback as busy, and free once it closes', async () => {
    const held = createServer()
    await new Promise<void>((listening) => held.listen(0, '127.0.0.1', listening))
    const { port } = held.address() as AddressInfo

    expect(await probeDashboardPort(port)).toBe('busy')
    await new Promise<void>((closed) => held.close(() => closed()))
    expect(await probeDashboardPort(port)).toBe('free')
  })
})

describe('the setup guard in front of the dashboard', () => {
  const GUARDED = ['--platform', 'web', '--no-browsers', '--agents', 'none', '--pm', 'none']

  it('refuses the real probe of the configured port before any socket or child', async () => {
    const target = project()

    const result = await init(target, fakeInitUi(), [...GUARDED, '--llm', 'gemini'])

    expect(takeGuardedCalls()).toEqual([`probe ${configuredPort(target.root)}`])
    expect(sockets.servers).toBe(0)
    expect(spawned.filter((call) => call.includes('dashboard'))).toEqual([])
    expect(result.exit).toBe(1)
    expect(result.stderr).toContain('A test reached a real probe of port')
  })

  it('refuses a dashboard started through the default runner before any child', async () => {
    const result = await init(project(), fakeInitUi(), [...GUARDED, '--llm', 'gemini'], {
      dashboardPort: freePort,
    })

    const calls = takeGuardedCalls()
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain(' dashboard --open /config/models')
    expect(spawned.filter((call) => call.includes('dashboard'))).toEqual([])
    expect(result.exit).toBe(1)
    expect(result.stderr).toContain('A test reached a real dashboard.')
  })
})
