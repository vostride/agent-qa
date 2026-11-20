// agent-qa run on a terminal, with the browser's start held so the run stays in progress: what is
// on the screen when the run is forced to exit.

import { WebPlatformAdapter } from '@vostride/agent-qa-web'
import { Command } from 'commander'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import {
  createInProcessFixture,
  freshUpdateCheckHome,
  removeInProcessFixtures,
} from '../../composition/__tests__/in-process-run-fixture.js'
import { pinProcessTmpdir, removeTempRoots } from '../../__tests__/temp-roots.js'
import type { PinnedTmpdir } from '../../__tests__/temp-roots.js'
import * as liveLineModule from '../../reporters/live-line.js'
import { createRunCommand, drawsLiveLine } from '../run.js'

const RUN_BUDGET_MS = 120_000
const EXIT_MARKER = 'fixture command exit'
const RUN_ID_LINE = /^Run ID: r_[a-z0-9-]+$/

let pinnedTmpdir: PinnedTmpdir | undefined
let stdoutIsTTY: PropertyDescriptor | undefined
let exitCodeBefore: typeof process.exitCode
const releases: Array<() => Promise<void>> = []

beforeAll(() => {
  pinnedTmpdir = pinProcessTmpdir()
})
afterEach(async () => {
  for (const release of releases.splice(0)) await release()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  if (stdoutIsTTY === undefined) Reflect.deleteProperty(process.stdout, 'isTTY')
  else Object.defineProperty(process.stdout, 'isTTY', stdoutIsTTY)
  // A first stop signal sets the exit code of the process the tests run in.
  process.exitCode = exitCodeBefore
})
afterAll(() => {
  removeInProcessFixtures()
  pinnedTmpdir?.restore()
  if (pinnedTmpdir !== undefined) removeTempRoots([pinnedTmpdir.root])
})

function plain(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '')
}

// Stdout as a terminal outside CI, and nothing the run writes reaching the real one.
function onATerminal(term: string): { readonly printed: string[] } {
  stdoutIsTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true })
  vi.stubEnv('CI', '')
  vi.stubEnv('TERM', term)
  vi.stubEnv('HOME', freshUpdateCheckHome())
  exitCodeBefore = process.exitCode
  const printed: string[] = []
  const keep = (...parts: unknown[]): void => {
    printed.push(...plain(parts.map(String).join(' ')).split('\n'))
  }
  vi.spyOn(console, 'log').mockImplementation(keep)
  vi.spyOn(console, 'warn').mockImplementation(keep)
  vi.spyOn(console, 'error').mockImplementation(keep)
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    keep(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
    return true
  })
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no network in this test'))
  return { printed }
}

interface ForcedExit {
  readonly code: unknown
  readonly runIdLines: readonly string[]
  readonly liveLineDrawn: boolean
}

interface HeldRun {
  liveLinesBuilt(): number
  liveLineDrawn(): boolean
  runIdLines(): string[]
  // What the screen held each time the command reached an exit; a real exit ends at the first.
  readonly exits: readonly ForcedExit[]
  signal(): void
}

// The command runs up to the start of its test's browser and waits there. The mocked exit throws,
// so a cell reads what the command had done when it reached its first exit.
async function runHeldAtBrowserStart(
  path: 'direct' | 'suite',
  term = 'xterm-256color',
): Promise<HeldRun> {
  const { printed } = onATerminal(term)
  let drawn = false
  const build = vi.spyOn(liveLineModule, 'createLiveLine').mockResolvedValue({
    start: () => {
      drawn = true
    },
    stop: () => {
      drawn = false
    },
  })
  const runIdLines = (): string[] => printed.filter((line) => RUN_ID_LINE.test(line))
  const exits: ForcedExit[] = []
  vi.spyOn(process, 'exit').mockImplementation((code) => {
    exits.push({ code, runIdLines: runIdLines(), liveLineDrawn: drawn })
    throw new Error(EXIT_MARKER)
  })
  let reached!: () => void
  const atBrowserStart = new Promise<void>((resolve) => {
    reached = resolve
  })
  let lift!: () => void
  const held = new Promise<void>((resolve) => {
    lift = resolve
  })
  vi.spyOn(WebPlatformAdapter.prototype, 'setup').mockImplementation(async () => {
    reached()
    await held
    throw new Error('the browser start was stopped')
  })

  const fixture = createInProcessFixture({ origin: 'http://127.0.0.1:1', environment: 'local' })
  const before = new Set<unknown>(process.listeners('SIGINT'))
  const program = new Command().option('--config <path>').addCommand(createRunCommand())
  const ended = program
    .parseAsync(
      [
        '--config',
        fixture.configPath,
        'run',
        path === 'direct' ? fixture.testPattern : fixture.suitePattern,
      ],
      { from: 'user' },
    )
    .then(
      () => undefined,
      () => undefined,
    )
  releases.push(async () => {
    vi.useRealTimers()
    lift()
    await ended
  })
  await Promise.race([atBrowserStart, ended])

  return {
    liveLinesBuilt: () => build.mock.calls.length,
    liveLineDrawn: () => drawn,
    runIdLines,
    exits,
    signal() {
      for (const handler of process.listeners('SIGINT')) {
        if (!before.has(handler)) handler('SIGINT')
      }
    },
  }
}

describe('whether a run draws the live line', () => {
  const terminal = { isTTY: true }
  const outsideCi = { TERM: 'xterm-256color' }

  it('draws it on a terminal outside CI when the console reporter prints the run', () => {
    expect(drawsLiveLine(terminal, outsideCi, true)).toBe(true)
    expect(drawsLiveLine(terminal, {}, true)).toBe(true)
    expect(drawsLiveLine(terminal, { ...outsideCi, CI: '', GITHUB_ACTIONS: '' }, true)).toBe(true)
  })

  it.each([
    ['stdout is a pipe or a file', { isTTY: false }, outsideCi, true],
    ['stdout does not say what it is', {}, outsideCi, true],
    ['CI is set', terminal, { ...outsideCi, CI: 'true' }, true],
    ['the run is under GitHub Actions', terminal, { ...outsideCi, GITHUB_ACTIONS: 'true' }, true],
    ['the terminal cannot move its cursor', terminal, { TERM: 'dumb' }, true],
    ['the console reporter is not selected', terminal, outsideCi, false],
  ])('draws none when %s', (_title, stream, env, consoleSelected) => {
    expect(drawsLiveLine(stream, env, consoleSelected)).toBe(false)
  })
})

describe.each(['direct', 'suite'] as const)('a %s run on a terminal', (path) => {
  it('builds one live line and draws it while a test is in progress', async () => {
    const run = await runHeldAtBrowserStart(path)

    expect(run.liveLinesBuilt()).toBe(1)
    expect(run.liveLineDrawn()).toBe(true)
  }, RUN_BUDGET_MS)

  it('builds no live line when the terminal cannot move its cursor', async () => {
    const run = await runHeldAtBrowserStart(path, 'dumb')

    expect(run.liveLinesBuilt()).toBe(0)
    expect(run.liveLineDrawn()).toBe(false)
  }, RUN_BUDGET_MS)
})

describe.each(['direct', 'suite'] as const)('a forced exit of a %s run on a terminal', (path) => {
  it('stops the live line and prints the run id once on a second stop signal', async () => {
    const run = await runHeldAtBrowserStart(path)
    expect(run.liveLineDrawn(), 'the run drew no live line before it was stopped').toBe(true)
    expect(run.runIdLines()).toEqual([])

    run.signal()
    expect(run.exits).toEqual([])
    expect(() => run.signal()).toThrow(EXIT_MARKER)

    expect(run.exits).toEqual([
      { code: 130, runIdLines: [expect.stringMatching(RUN_ID_LINE)], liveLineDrawn: false },
    ])
  }, RUN_BUDGET_MS)

  it('stops the live line and prints the run id once when the grace period ends', async () => {
    const run = await runHeldAtBrowserStart(path)
    expect(run.liveLineDrawn(), 'the run drew no live line before it was stopped').toBe(true)

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    run.signal()
    expect(run.exits).toEqual([])
    expect(() => vi.advanceTimersByTime(3_000)).toThrow(EXIT_MARKER)

    expect(run.exits).toEqual([
      { code: 130, runIdLines: [expect.stringMatching(RUN_ID_LINE)], liveLineDrawn: false },
    ])
  }, RUN_BUDGET_MS)

  it('never prints the run id a second time after a forced exit', async () => {
    const run = await runHeldAtBrowserStart(path)

    run.signal()
    expect(() => run.signal()).toThrow(EXIT_MARKER)
    await releases.pop()?.()

    expect(run.exits.length).toBeGreaterThan(1)
    expect(run.runIdLines()).toHaveLength(1)
  }, RUN_BUDGET_MS)
})
