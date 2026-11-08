// Errors that escape a command print through the run-text helper on the shipped bin.

import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import {
  CLI_ENTRY,
  REBUILD_INSTRUCTION,
  buildFreshness,
  cleanupTempRoots,
  spawnCollecting,
  trackTempRoot,
  type SpawnOutcome,
} from './spawned-chat.js'

const CELL_BUDGET_MS = 60_000
const WEB_GEMINI = ['--platform', 'web', '--llm', 'gemini', '--no-browsers']
const PAIR = /^::stop-commands::([0-9a-f]{32})\n[\s\S]*\n::\1::\n$/u
const WORKFLOW_COMMAND_FOLDER = '::set-output name=x::y'
const BUG_FOLDER = 'bug-trigger'
const BUG_LINE = 'Unexpected error: ##[error]x from bug-trigger'
const FRAME = /^\s+at /u

// Replaces realpath in the spawned child only, and only for the bug-trigger folder.
const BUG_PRELOAD = `import { createRequire, syncBuiltinESMExports } from 'node:module'
const require = createRequire(import.meta.url)
const fsPromises = require('node:fs/promises')
const original = fsPromises.realpath
fsPromises.realpath = (path, ...rest) =>
  String(path).endsWith('bug-trigger')
    ? Promise.reject(new TypeError('##[error]x from bug-trigger'))
    : original(path, ...rest)
syncBuiltinESMExports()
`

afterEach(() => {
  cleanupTempRoots()
})

function expectFresh(): void {
  const freshness = buildFreshness()
  expect(
    { missing: freshness.missing, stale: freshness.stale },
    `these cells drive the built CLI: ${REBUILD_INSTRUCTION}`,
  ).toEqual({ missing: [], stale: [] })
}

function tempFolder(label: string): string {
  return trackTempRoot(mkdtempSync(join(tmpdir(), `agent-qa-escaped-${label}-`)))
}

function homeLine(home: string): string {
  return `agent-qa init does not set up your home folder (${home}). Run it in the project's folder.`
}

function seen(outcome: SpawnOutcome): string {
  return JSON.stringify({ code: outcome.code, stdout: outcome.stdout, stderr: outcome.stderr })
}

function workflowCommandHome(): string {
  const home = join(tempFolder('home'), WORKFLOW_COMMAND_FOLDER)
  mkdirSync(home)
  return home
}

async function initInHome(
  home: string,
  extraEnv: Readonly<Record<string, string>> = {},
): Promise<SpawnOutcome> {
  return await spawnCollecting(home, [CLI_ENTRY, 'init', ...WEB_GEMINI], {
    HOME: home,
    USERPROFILE: home,
    ...extraEnv,
  })
}

describe('an escaped refusal on the shipped bin', () => {
  it(
    'under GitHub Actions a refusal quoting a workflow command prints inside one stop-commands pair',
    async () => {
      expectFresh()
      const home = workflowCommandHome()
      const refused = await initInHome(home, { GITHUB_ACTIONS: 'true' })
      expect(refused.code, seen(refused)).toBe(2)
      expect(refused.stdout, seen(refused)).toMatch(PAIR)
      expect(refused.stdout).toContain(homeLine(home))
      expect(refused.stderr, seen(refused)).not.toContain('::set-output')
    },
    CELL_BUDGET_MS,
  )

  it(
    'without GitHub Actions the same refusal prints its plain line on stderr',
    async () => {
      expectFresh()
      const home = workflowCommandHome()
      const refused = await initInHome(home)
      expect(refused.code, seen(refused)).toBe(2)
      expect(refused.stderr.split('\n'), seen(refused)).toContain(homeLine(home))
      expect(refused.stdout).not.toContain('::stop-commands::')
      expect(refused.stderr).not.toContain('::stop-commands::')
    },
    CELL_BUDGET_MS,
  )
})

function bugPreload(): string {
  const preload = join(tempFolder('preload'), 'bug-trigger-preload.mjs')
  writeFileSync(preload, BUG_PRELOAD, 'utf8')
  return preload
}

async function initHittingABug(
  extraEnv: Readonly<Record<string, string>> = {},
): Promise<SpawnOutcome & { bugFolder: string }> {
  const root = tempFolder('bug-root')
  const bugFolder = join(root, BUG_FOLDER)
  mkdirSync(bugFolder)
  const home = tempFolder('bug-home')
  const outcome = await spawnCollecting(
    bugFolder,
    ['--import', pathToFileURL(bugPreload()).href, CLI_ENTRY, 'init', ...WEB_GEMINI],
    { HOME: home, USERPROFILE: home, TMPDIR: join(root, '.agent-qa'), ...extraEnv },
  )
  return { ...outcome, bugFolder }
}

describe('a bug on the shipped bin', () => {
  it(
    'a bug prints Unexpected error with its stack frames and exits 1',
    async () => {
      expectFresh()
      const failed = await initHittingABug()
      expect(failed.code, seen(failed)).toBe(1)
      const lines = failed.stderr.split('\n')
      expect(lines[0], seen(failed)).toMatch(/^Unexpected error: ##\[error\]x from bug-trigger/u)
      expect(lines.filter((line) => FRAME.test(line)).length, seen(failed)).toBeGreaterThan(0)
      expect(readdirSync(failed.bugFolder)).toEqual([])
    },
    CELL_BUDGET_MS,
  )

  it(
    "under GitHub Actions a bug's block is one stop-commands pair",
    async () => {
      expectFresh()
      const failed = await initHittingABug({ GITHUB_ACTIONS: 'true' })
      expect(failed.code, seen(failed)).toBe(1)
      expect(failed.stdout, seen(failed)).toMatch(PAIR)
      expect(failed.stdout).toContain(BUG_LINE)
      expect(
        failed.stdout.split('\n').some((line) => FRAME.test(line)),
        seen(failed),
      ).toBe(true)
      expect(failed.stderr, seen(failed)).not.toContain('##[error]')
      expect(readdirSync(failed.bugFolder)).toEqual([])
    },
    CELL_BUDGET_MS,
  )
})
