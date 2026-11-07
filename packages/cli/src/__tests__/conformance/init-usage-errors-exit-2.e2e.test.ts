// init's usage errors exit 2 with commander's own line; other commands keep exit 1.

import { existsSync, mkdtempSync } from 'node:fs'
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
const FRAME = /^\s+at /m

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
    root: trackTempRoot(mkdtempSync(join(tmpdir(), 'agent-qa-init-usage-'))),
    home: trackTempRoot(mkdtempSync(join(tmpdir(), 'agent-qa-init-usage-home-'))),
  }
}

async function cli(args: readonly string[]): Promise<SpawnOutcome & { root: string }> {
  const { root, home } = folders()
  const outcome = await spawnCollecting(root, [CLI_ENTRY, ...args], {
    HOME: home,
    USERPROFILE: home,
  })
  return { ...outcome, root }
}

describe('init usage errors', () => {
  it(
    "an unknown init option exits 2 with commander's message and no stack frame",
    async () => {
      expectFresh()
      const outcome = await cli(['init', '--nope'])
      expect(outcome.code).toBe(2)
      expect(outcome.stderr).toContain("unknown option '--nope'")
      expect(`${outcome.stdout}\n${outcome.stderr}`).not.toMatch(FRAME)
      expect(existsSync(join(outcome.root, 'agent-qa.config.yaml'))).toBe(false)
    },
    CELL_BUDGET_MS,
  )

  it(
    'an invalid init choice exits 2',
    async () => {
      expectFresh()
      for (const args of [
        ['init', '--platform', 'foo'],
        ['init', '--llm', 'gpt'],
      ]) {
        const outcome = await cli(args)
        expect(outcome.code, args.join(' ')).toBe(2)
        expect(outcome.stderr, args.join(' ')).toContain('Allowed choices are')
        expect(`${outcome.stdout}\n${outcome.stderr}`).not.toMatch(FRAME)
      }
    },
    CELL_BUDGET_MS,
  )

  it(
    'init help and the version exit 0',
    async () => {
      expectFresh()
      const help = await cli(['init', '--help'])
      expect(help.code).toBe(0)
      expect(help.stdout).toContain('--platform')
      const helpCommand = await cli(['help', 'init'])
      expect(helpCommand.code).toBe(0)
      const version = await cli(['--version'])
      expect(version.code).toBe(0)
      expect(version.stdout).toMatch(/^\d+\.\d+\.\d+\S*$/m)
    },
    CELL_BUDGET_MS,
  )

  it(
    'other commands keep exit 1 for usage errors',
    async () => {
      expectFresh()
      for (const args of [['run', '--nope'], ['nope'], ['config', 'set']]) {
        const outcome = await cli(args)
        expect(outcome.code, args.join(' ')).toBe(1)
      }
    },
    CELL_BUDGET_MS,
  )
})
