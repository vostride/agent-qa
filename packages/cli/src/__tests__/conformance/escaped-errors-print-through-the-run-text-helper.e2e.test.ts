// Errors that escape a command print through the run-text helper on the shipped bin.

import { mkdirSync, mkdtempSync } from 'node:fs'
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
const PAIR = /^::stop-commands::([0-9a-f]{32})\n[\s\S]*\n::\1::\n$/u
const WORKFLOW_COMMAND_FOLDER = '::set-output name=x::y'

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
  return `agent-qa init does not set up your home folder (${home}). Run it in the project's folder, or pass --dir <folder>.`
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
