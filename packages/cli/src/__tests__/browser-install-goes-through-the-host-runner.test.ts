// init installs Chromium only through the host's runner, so a fake or the setup guard sees it.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createInitCommand } from '../commands/init.js'
import { composeAnalyticsHost } from '../composition/analytics-host.js'
import {
  CLI_ENTRY,
  REBUILD_INSTRUCTION,
  buildFreshness,
  cleanupTempRoots,
  spawnCollecting,
  trackTempRoot,
} from './conformance/spawned-chat.js'
import { fakeInitUi, type FakeInitUi } from './fake-init-ui.js'
import {
  cleanupTempProjects,
  fakeRunner,
  tempProject,
  type FakeRunner,
} from './project-fixtures.js'
import { takeGuardedCalls } from './test-side-effect-guard.js'

const spawned = vi.hoisted(() => [] as string[])

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

const CLI_PACKAGE = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const RUNNING_BIN = resolve(
  CLI_PACKAGE,
  (JSON.parse(readFileSync(join(CLI_PACKAGE, 'package.json'), 'utf8')) as {
    bin: Record<string, string>
  }).bin['agent-qa']!,
)
const CHROMIUM_COMMAND = 'npx agent-qa install-browsers --chromium'
const GUARD_REFUSAL =
  'A test reached the real browser install. Pass --no-browsers or inject host.run.'

const silentAnalytics: typeof composeAnalyticsHost = async () =>
  composeAnalyticsHost({
    surface: 'cli',
    env: {},
    transportOverride: { capture: () => {}, flush: () => {}, shutdown: () => {} },
    resolveIdentity: async () => ({ distinctId: 'u_browser-install', runtimeContext: 'user' }),
  })

async function init(
  root: string,
  home: string,
  ui: FakeInitUi,
  run: FakeRunner | undefined,
): Promise<unknown> {
  const parent = new Command()
  const command = createInitCommand({
    cwd: root,
    host: { homedir: home, env: {}, ...(run === undefined ? {} : { run }) },
    isTTY: false,
    composeAnalytics: silentAnalytics,
    ui,
  })
  parent.exitOverride()
  command.exitOverride()
  parent.addCommand(command)
  return await parent
    .parseAsync(['node', 'test', 'init', '--platform', 'web', '--llm', 'gemini', '--pm', 'none'])
    .then(
      () => undefined,
      (caught: unknown) => caught,
    )
}

function namesAnInstall(call: string): boolean {
  return /install-browsers|playwright|\binstall\b.*\bchromium\b/iu.test(call)
}

beforeEach(() => {
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  spawned.length = 0
  cleanupTempProjects()
  cleanupTempRoots()
})

describe('the Chromium step in a test process', () => {
  it('runs the running agent-qa through the injected runner and starts no child of its own', async () => {
    const { root, home } = tempProject('browser-source')
    const ui = fakeInitUi()
    const run = fakeRunner()

    expect(await init(root, home, ui, run)).toBeUndefined()

    const install = run.calls.filter((call) => call.args.includes('install-browsers'))
    expect(install.map((call) => [call.command, ...call.args])).toEqual([
      [process.execPath, RUNNING_BIN, 'install-browsers', '--chromium'],
    ])
    expect(install[0]?.stdio).toBe('capture')
    expect(ui.entries).toContainEqual({ kind: 'done', text: 'Chromium installed' })
    expect(spawned.filter(namesAnInstall)).toEqual([])
  })

  it('without a runner, the setup guard refuses the install and the step fails with its message', async () => {
    const { root, home } = tempProject('browser-guard')
    const ui = fakeInitUi()

    const error = await init(root, home, ui, undefined)

    const calls = takeGuardedCalls()
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('install-browsers --chromium')
    expect(spawned.filter(namesAnInstall)).toEqual([])
    expect(error).toMatchObject({ exitCode: 3 })
    expect(ui.entries).toContainEqual({
      kind: 'failed',
      text: GUARD_REFUSAL,
      command: CHROMIUM_COMMAND,
    })
  })
})

describe('a spawned init that forgets --no-browsers', () => {
  it('fails its Chromium step on the refused download host, exits 3 and downloads nothing', async () => {
    const freshness = buildFreshness()
    expect(
      { missing: freshness.missing, stale: freshness.stale },
      `this cell drives the built CLI: ${REBUILD_INSTRUCTION}`,
    ).toEqual({ missing: [], stale: [] })
    const root = trackTempRoot(mkdtempSync(join(tmpdir(), 'agent-qa-browser-backstop-')))
    const home = trackTempRoot(mkdtempSync(join(tmpdir(), 'agent-qa-browser-backstop-home-')))
    mkdirSync(join(root, '.git'))

    const outcome = await spawnCollecting(
      root,
      [CLI_ENTRY, 'init', '--platform', 'web', '--llm', 'gemini', '--pm', 'none'],
      { HOME: home, USERPROFILE: home },
    )

    expect(outcome.code, `${outcome.stdout}\n${outcome.stderr}`).toBe(3)
    expect(outcome.stderr).toContain(`Run: ${CHROMIUM_COMMAND}`)
    // Playwright writes its .links marker before a download; a browser lands beside it.
    const homeFiles = readdirSync(home, { recursive: true, encoding: 'utf8' })
    expect(homeFiles.filter((path) => /ms-playwright[\\/](?!\.links)/u.test(path))).toEqual([])
  }, 60_000)
})
