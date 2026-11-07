// init refuses to set up the home folder, however the folder is spelled, and writes nothing there.

import { mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
const WEB_GEMINI = ['--platform', 'web', '--llm', 'gemini']

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
  return trackTempRoot(mkdtempSync(join(tmpdir(), `agent-qa-init-home-${label}-`)))
}

function homeLine(home: string): string {
  return `agent-qa init does not set up your home folder (${home}). Run it in the project's folder, or pass --dir <folder>.`
}

function listing(root: string): string[] {
  return readdirSync(root, { recursive: true, encoding: 'utf8' }).sort()
}

async function init(
  cwd: string,
  home: string,
  args: readonly string[],
): Promise<SpawnOutcome & { text: string }> {
  const outcome = await spawnCollecting(cwd, [CLI_ENTRY, 'init', ...args], {
    HOME: home,
    USERPROFILE: home,
  })
  return { ...outcome, text: `${outcome.stdout}\n${outcome.stderr}` }
}

function expectHomeRefusal(outcome: SpawnOutcome & { text: string }, home: string): void {
  expect(outcome.code, outcome.text).toBe(2)
  expect(outcome.text).toContain(homeLine(home))
  const lines = outcome.text.split('\n')
  expect(
    lines.filter((line) => /^\s+at\s/u.test(line)),
    outcome.text,
  ).toEqual([])
}

describe('init and the home folder', () => {
  it(
    'init run in the home folder is refused',
    async () => {
      expectFresh()
      const home = tempFolder('cwd')
      const before = listing(home)
      const refused = await init(home, home, WEB_GEMINI)
      expectHomeRefusal(refused, home)
      expect(listing(home)).toEqual(before)
    },
    CELL_BUDGET_MS,
  )

  it(
    '--dir naming the home folder with a trailing slash is refused',
    async () => {
      expectFresh()
      const home = tempFolder('slash')
      const cwd = tempFolder('slash-cwd')
      const before = listing(home)
      const refused = await init(cwd, home, ['--dir', `${home}/`, ...WEB_GEMINI])
      expectHomeRefusal(refused, home)
      expect(listing(home)).toEqual(before)
    },
    CELL_BUDGET_MS,
  )

  it(
    '--dir through a symlink to the home folder is refused',
    async () => {
      expectFresh()
      const home = tempFolder('link')
      const cwd = tempFolder('link-cwd')
      symlinkSync(home, join(cwd, 'link'), 'dir')
      const before = listing(home)
      const cwdBefore = listing(cwd)
      const refused = await init(cwd, home, ['--dir', 'link', ...WEB_GEMINI])
      expectHomeRefusal(refused, home)
      expect(listing(home)).toEqual(before)
      expect(listing(cwd)).toEqual(cwdBefore)
    },
    CELL_BUDGET_MS,
  )

  it(
    'the home folder is refused even when a config is already there',
    async () => {
      expectFresh()
      const home = tempFolder('config')
      const config = join(home, 'agent-qa.config.yaml')
      writeFileSync(config, 'workspace: {}\n')
      const bytes = readFileSync(config)
      const before = listing(home)
      const refused = await init(home, home, WEB_GEMINI)
      expectHomeRefusal(refused, home)
      expect(refused.text).not.toContain('already initialized')
      expect(readFileSync(config)).toEqual(bytes)
      expect(listing(home)).toEqual(before)
    },
    CELL_BUDGET_MS,
  )

  it(
    '--force does not override the home refusal',
    async () => {
      expectFresh()
      const home = tempFolder('force')
      const config = join(home, 'agent-qa.config.yaml')
      writeFileSync(config, 'workspace: {}\n')
      const bytes = readFileSync(config)
      const before = listing(home)
      const refused = await init(home, home, ['--force', ...WEB_GEMINI])
      expectHomeRefusal(refused, home)
      expect(refused.text).not.toContain('already initialized')
      expect(readFileSync(config)).toEqual(bytes)
      expect(listing(home)).toEqual(before)
    },
    CELL_BUDGET_MS,
  )
})
