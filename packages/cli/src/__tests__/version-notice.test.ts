import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { VersionCheckRequest } from '@vostride/agent-qa-core'
import { afterEach, describe, expect, it } from 'vitest'

import { createAgentQaProgram } from '../program.js'
import { VERSION } from '../index.js'
import {
  UPDATE_NOTICE_SHOWN_FILE,
  runUpdateNotice,
  updateNoticeApplies,
  type UpdateNoticeGate,
} from '../version-notice.js'
import {
  CLI_ENTRY,
  REBUILD_INSTRUCTION,
  buildFreshness,
  cleanupTempRoots,
  spawnCollecting,
  trackTempRoot,
} from './conformance/spawned-chat.js'

const HOUR_MS = 60 * 60 * 1000
const NOW = Date.parse('2026-05-24T10:00:00.000Z')
const CURRENT = '0.3.4'

const createdDirs: string[] = []

afterEach(() => {
  for (const dir of createdDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  cleanupTempRoots()
})

function tempHome(cache?: Record<string, string>): string {
  const home = mkdtempSync(join(tmpdir(), 'agent-qa-notice-home-'))
  createdDirs.push(home)
  if (cache) {
    mkdirSync(join(home, '.agent-qa'), { recursive: true })
    writeFileSync(cachePath(home), JSON.stringify(cache, null, 2), 'utf-8')
  }
  return home
}

function cachePath(home: string): string {
  return join(home, '.agent-qa', 'version-check.json')
}

function shownPath(home: string): string {
  return join(home, '.agent-qa', UPDATE_NOTICE_SHOWN_FILE)
}

function isoHoursAgo(hours: number): string {
  return new Date(NOW - hours * HOUR_MS).toISOString()
}

function freshCache(latestVersion = '9.9.9'): Record<string, string> {
  return { latestVersion, checkedAt: isoHoursAgo(1), lastAttemptedAt: isoHoursAgo(1) }
}

function staleCache(): Record<string, string> {
  return { latestVersion: '9.9.9', checkedAt: isoHoursAgo(25), lastAttemptedAt: isoHoursAgo(25) }
}

// Records each registry request and never answers it.
function recordingRequest(): { request: VersionCheckRequest; calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    request: (url) => {
      calls.push(url)
      return Object.assign(new EventEmitter(), { destroy: () => undefined })
    },
  }
}

const OPEN_GATE: UpdateNoticeGate = {
  env: {},
  stdoutIsTTY: true,
  stderrIsTTY: true,
  json: false,
  logLevel: undefined,
}

const CLOSED_GATES: Array<[string, Partial<UpdateNoticeGate>]> = [
  ['CI=true', { env: { CI: 'true' } }],
  ['GITHUB_ACTIONS=true', { env: { GITHUB_ACTIONS: 'true' } }],
  ['stdout not a terminal', { stdoutIsTTY: false }],
  ['stderr not a terminal', { stderrIsTTY: false }],
  ['--json', { json: true }],
  ['a silent log level', { logLevel: 'silent' }],
]

async function notice(
  home: string,
  options: { now?: number; gate?: Partial<UpdateNoticeGate>; request?: VersionCheckRequest } = {},
): Promise<{ text: string; calls: string[] }> {
  const written: string[] = []
  const recorder = recordingRequest()
  await runUpdateNotice({
    ...OPEN_GATE,
    ...options.gate,
    homeDir: home,
    now: options.now ?? NOW,
    currentVersion: CURRENT,
    write: (text) => {
      written.push(text)
    },
    request: options.request ?? recorder.request,
  })
  return { text: written.join(''), calls: recorder.calls }
}

describe('the update notice', () => {
  it('names both versions, npx agent-qa@latest init and the releases link', async () => {
    const home = tempHome(freshCache())

    const { text, calls } = await notice(home)

    expect(text).toBe(
      'agent-qa 9.9.9 is out; you have 0.3.4. Update this project: npx agent-qa@latest init\n' +
        'Releases: https://github.com/vostride/agent-qa/releases\n',
    )
    expect(JSON.parse(readFileSync(shownPath(home), 'utf-8'))).toEqual({ shownAt: NOW })
    expect(calls).toEqual([])
  })

  it('shows at most once a day', async () => {
    const home = tempHome(freshCache())

    expect((await notice(home)).text).toContain('9.9.9')
    expect((await notice(home, { now: NOW + HOUR_MS })).text).toBe('')
    expect((await notice(home, { now: NOW + 25 * HOUR_MS })).text).toContain('9.9.9')
  })

  it.each([
    ['no cache file', undefined],
    ['a cached version equal to the running one', freshCache(CURRENT)],
    ['a cached version older than the running one', freshCache('0.3.3')],
  ])('prints nothing for %s', async (_name, cache) => {
    const home = tempHome(cache)

    expect((await notice(home)).text).toBe('')
    expect(existsSync(shownPath(home))).toBe(false)
  })

  it('never prints an unpinned install', async () => {
    const { text } = await notice(tempHome(freshCache()))

    expect(text).toContain('npx agent-qa@latest init')
    expect(text).not.toMatch(/add -D|install agent-qa@latest|@latest -D/u)
  })
})

describe('the shared gate for the notice and the registry refresh', () => {
  it('opens only with terminals on both streams, outside CI, without --json and not silent', () => {
    expect(updateNoticeApplies(OPEN_GATE)).toBe(true)
    for (const [, gate] of CLOSED_GATES) {
      expect(updateNoticeApplies({ ...OPEN_GATE, ...gate })).toBe(false)
    }
  })

  it.each(CLOSED_GATES)(
    'with %s prints nothing, makes no request and leaves version-check.json byte for byte',
    async (_name, gate) => {
      const home = tempHome(staleCache())
      const before = readFileSync(cachePath(home))

      const { text, calls } = await notice(home, { gate })

      expect(text).toBe('')
      expect(calls).toEqual([])
      expect(existsSync(shownPath(home))).toBe(false)
      expect(readFileSync(cachePath(home)).equals(before)).toBe(true)
    },
  )

  it('with the gate open over a stale cache starts exactly one registry request', async () => {
    const home = tempHome(staleCache())

    const { text, calls } = await notice(home)

    expect(text).toContain('npx agent-qa@latest init')
    expect(calls).toEqual(['https://registry.npmjs.org/agent-qa'])
  })
})

describe('the program runs the notice after every command', () => {
  type NoticeInput = { json: boolean; logLevel?: string }

  async function parseWith(
    args: string[],
    updateNotice: (input: NoticeInput) => Promise<void>,
    exitCode?: number,
  ): Promise<typeof process.exitCode> {
    const prior = process.exitCode
    try {
      const program = createAgentQaProgram({ updateNotice }).exitOverride()
      program
        .command('notice-probe')
        .option('--json')
        .action(() => {
          if (exitCode !== undefined) process.exitCode = exitCode
        })
      await program.parseAsync(['node', 'agent-qa', ...args])
      return process.exitCode
    } finally {
      process.exitCode = prior
    }
  }

  function recordingNotice(): {
    inputs: NoticeInput[]
    notice: (input: NoticeInput) => Promise<void>
  } {
    const inputs: NoticeInput[] = []
    return {
      inputs,
      notice: async (input) => {
        inputs.push(input)
      },
    }
  }

  it('runs after the action and keeps the exit code the action set', async () => {
    const recorder = recordingNotice()

    expect(await parseWith(['notice-probe'], recorder.notice, 3)).toBe(3)
    expect(recorder.inputs).toEqual([{ json: false, logLevel: undefined }])
  })

  it('passes --json, --quiet and --log-level through', async () => {
    const recorder = recordingNotice()

    await parseWith(['notice-probe', '--json'], recorder.notice)
    await parseWith(['--quiet', 'notice-probe'], recorder.notice)
    await parseWith(['--log-level', 'warn', 'notice-probe'], recorder.notice)

    expect(recorder.inputs).toEqual([
      { json: true, logLevel: undefined },
      { json: false, logLevel: 'silent' },
      { json: false, logLevel: 'warn' },
    ])
  })

  it('swallows a notice that throws and leaves the exit code alone', async () => {
    const throwing = async (): Promise<void> => {
      throw new Error('notice failed')
    }

    expect(await parseWith(['notice-probe'], throwing, 3)).toBe(3)
  })
})

describe('the built CLI over pipes', () => {
  const CELL_BUDGET_MS = 60_000
  const NOTICE_TEXT = /is out; you have|npx agent-qa@latest init|Releases:/u

  function expectFresh(): void {
    const freshness = buildFreshness()
    expect(
      { missing: freshness.missing, stale: freshness.stale },
      `these cells drive the built CLI: ${REBUILD_INSTRUCTION}`,
    ).toEqual({ missing: [], stale: [] })
  }

  // A home whose cache names a newer version and is a day and an hour old on every clock.
  function staleHome(): string {
    const home = trackTempRoot(mkdtempSync(join(tmpdir(), 'agent-qa-notice-built-home-')))
    const dayAndHourAgo = new Date(Date.now() - 25 * HOUR_MS).toISOString()
    mkdirSync(join(home, '.agent-qa'), { recursive: true })
    writeFileSync(
      cachePath(home),
      JSON.stringify(
        { latestVersion: '9.9.9', checkedAt: dayAndHourAgo, lastAttemptedAt: dayAndHourAgo },
        null,
        2,
      ),
      'utf-8',
    )
    return home
  }

  // The child inherits no CI variable: spawnCollecting starts from PATH, HOME, TMPDIR and NODE_ENV.
  async function built(args: readonly string[], home: string) {
    const root = trackTempRoot(mkdtempSync(join(tmpdir(), 'agent-qa-notice-built-')))
    return await spawnCollecting(root, [CLI_ENTRY, ...args], {
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: join(home, '.config'),
      XDG_CACHE_HOME: join(home, '.cache'),
      XDG_DATA_HOME: join(home, '.local', 'share'),
      XDG_STATE_HOME: join(home, '.local', 'state'),
    })
  }

  it(
    'a command over pipes prints no notice, makes no registry request and exits promptly',
    async () => {
      expectFresh()
      const home = staleHome()
      const before = readFileSync(cachePath(home))

      const started = Date.now()
      const outcome = await built(['skills'], home)
      const elapsed = Date.now() - started

      expect(outcome.code, outcome.stderr).toBe(0)
      expect(outcome.stdout).not.toMatch(NOTICE_TEXT)
      expect(outcome.stderr).not.toMatch(NOTICE_TEXT)
      // A started refresh writes lastAttemptedAt first, so an unchanged file means no request.
      expect(readFileSync(cachePath(home)).equals(before)).toBe(true)
      expect(existsSync(shownPath(home))).toBe(false)
      expect(elapsed).toBeLessThan(3_000)
    },
    CELL_BUDGET_MS,
  )

  it(
    '--version prints only the version on stdout',
    async () => {
      expectFresh()
      const home = staleHome()

      const outcome = await built(['--version'], home)

      expect(outcome.code).toBe(0)
      expect(outcome.stdout).toBe(`${VERSION}\n`)
      expect(outcome.stderr).not.toMatch(NOTICE_TEXT)
    },
    CELL_BUDGET_MS,
  )
})
