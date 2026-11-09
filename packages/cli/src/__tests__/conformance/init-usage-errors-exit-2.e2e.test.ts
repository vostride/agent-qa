// init's usage errors exit 2 with one line, commander's or init's own; other commands keep exit 1.

import { existsSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stripVTControlCharacters } from 'node:util'

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
const FRESH_SETUP_LINE =
  '--setup picks what a re-run of init sets up, and this folder is not set up yet. '
  + 'Run npx agent-qa init without --setup.'

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
    '--write-agent-instructions is an unknown option that exits 2 and writes nothing',
    async () => {
      expectFresh()
      const outcome = await cli(['init', '--write-agent-instructions'])
      expect(outcome.code).toBe(2)
      expect(outcome.stderr).toContain("unknown option '--write-agent-instructions'")
      expect(outcome.stdout).toBe('')
      expect(readdirSync(outcome.root)).toEqual([])
    },
    CELL_BUDGET_MS,
  )

  it(
    '--setup on a folder with no config exits 2 with one line and writes nothing',
    async () => {
      expectFresh()
      const outcome = await cli(['init', '--setup', 'gitignore'])
      expect(outcome.code).toBe(2)
      expect(stripVTControlCharacters(outcome.stderr).trim()).toBe(FRESH_SETUP_LINE)
      expect(outcome.stdout).toBe('')
      expect(readdirSync(outcome.root)).toEqual([])
    },
    CELL_BUDGET_MS,
  )

  it(
    '--setup on a folder with no config under --json prints one refused document with that line',
    async () => {
      expectFresh()
      for (const args of [
        ['init', '--json', '--setup', 'gitignore'],
        ['init', '--setup', 'gitignore', '--json'],
      ]) {
        const outcome = await cli(args)
        expect(outcome.code, args.join(' ')).toBe(2)
        const doc = JSON.parse(outcome.stdout) as Record<string, unknown>
        expect(doc, args.join(' ')).toMatchObject({
          format: 1,
          outcome: 'refused',
          exitCode: 2,
          steps: [],
          message: FRESH_SETUP_LINE,
        })
        expect(stripVTControlCharacters(outcome.stderr), args.join(' ')).toContain(FRESH_SETUP_LINE)
        expect(readdirSync(outcome.root), args.join(' ')).toEqual([])
      }
    },
    CELL_BUDGET_MS,
  )

  it(
    'an invalid --pm value before --json still prints one refused document',
    async () => {
      expectFresh()
      const outcome = await cli(['init', '--pm', 'gpt', '--json'])
      expect(outcome.code).toBe(2)
      const doc = JSON.parse(outcome.stdout) as Record<string, unknown>
      expect(doc).toMatchObject({ format: 1, outcome: 'refused', exitCode: 2, steps: [] })
      expect(doc.message).toContain('Allowed choices are')
      expect(readdirSync(outcome.root)).toEqual([])
    },
    CELL_BUDGET_MS,
  )

  it(
    'an invalid --pm choice exits 2',
    async () => {
      expectFresh()
      const outcome = await cli(['init', '--pm', 'gpt'])
      expect(outcome.code).toBe(2)
      expect(outcome.stderr).toContain('Allowed choices are')
      expect(`${outcome.stdout}\n${outcome.stderr}`).not.toMatch(FRAME)
    },
    CELL_BUDGET_MS,
  )

  it(
    'an unknown --llm exits 2 with one line naming the choices and writes nothing',
    async () => {
      expectFresh()
      const outcome = await cli(['init', '--platform', 'web', '--llm', 'gpt'])
      expect(outcome.code).toBe(2)
      expect(outcome.stderr).toContain(
        '--llm must be one of claude-code, codex, anthropic, openai, gemini, openai-compatible, '
          + 'anthropic-compatible, or the name of a saved credential',
      )
      expect(`${outcome.stdout}\n${outcome.stderr}`).not.toMatch(FRAME)
      expect(existsSync(join(outcome.root, 'agent-qa.config.yaml'))).toBe(false)
    },
    CELL_BUDGET_MS,
  )

  it(
    'an invalid --platform exits 2 with one line saying what to type and writes nothing',
    async () => {
      expectFresh()
      for (const [value, line] of [
        ['foo', '--platform takes web, android and ios, separated by commas.'],
        ['web+android', '--platform web+android is now --platform web,android.'],
      ] as const) {
        const outcome = await cli(['init', '--platform', value])
        expect(outcome.code, value).toBe(2)
        expect(outcome.stderr, value).toContain(line)
        expect(`${outcome.stdout}\n${outcome.stderr}`).not.toMatch(FRAME)
        expect(existsSync(join(outcome.root, 'agent-qa.config.yaml'))).toBe(false)
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
