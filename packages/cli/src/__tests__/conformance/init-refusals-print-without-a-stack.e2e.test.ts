// init's refusals print their message with no stack frame and exit 2.

import { spawnSync } from 'node:child_process'
import { appendFileSync, mkdtempSync } from 'node:fs'
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

function folders(): { root: string; home: string } {
  return {
    root: trackTempRoot(mkdtempSync(join(tmpdir(), 'agent-qa-init-refusal-'))),
    home: trackTempRoot(mkdtempSync(join(tmpdir(), 'agent-qa-init-refusal-home-'))),
  }
}

async function init(
  root: string,
  home: string,
  args: readonly string[],
): Promise<SpawnOutcome & { text: string }> {
  const outcome = await spawnCollecting(root, [CLI_ENTRY, 'init', ...args], {
    HOME: home,
    USERPROFILE: home,
  })
  return { ...outcome, text: `${outcome.stdout}\n${outcome.stderr}` }
}

function git(root: string, home: string, args: readonly string[]): void {
  const result = spawnSync('git', [...args], {
    cwd: root,
    env: { PATH: process.env.PATH ?? '', HOME: home },
    stdio: 'ignore',
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} exited ${result.status}`)
}

function expectRefusal(outcome: SpawnOutcome & { text: string }, phrases: readonly string[]): void {
  expect(outcome.code, outcome.text).toBe(2)
  for (const phrase of phrases) expect(outcome.text).toContain(phrase)
  const lines = outcome.text.split('\n')
  expect(lines.filter((line) => /^\s+at\s/u.test(line)), outcome.text).toEqual([])
  expect(lines.filter((line) => line.startsWith('Node.js v')), outcome.text).toEqual([])
}

describe('init refusals', () => {
  it(
    'a .gitignore that un-ignores the secrets file is refused after the write with exit 2 and no stack frame',
    async () => {
      expectFresh()
      const { root, home } = folders()
      git(root, home, ['init', '--quiet'])
      const first = await init(root, home, WEB_GEMINI)
      expect(first.code, first.text).toBe(0)
      appendFileSync(join(root, '.gitignore'), '\n!.env.secrets.local\n')
      const refused = await init(root, home, ['--force', ...WEB_GEMINI])
      expectRefusal(refused, ['target .gitignore is unsafe', '.env.secrets.local'])
    },
    CELL_BUDGET_MS,
  )
})
