// init's refusals print their message with no stack frame and exit 2.

import { spawnSync } from 'node:child_process'
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { managedBlockLockPath } from '../../commands/init-filesystem.js'
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
const WEB_CLAUDE_CODE = ['--platform', 'web', '--llm', 'claude-code']
const NOT_AN_OBJECT = 'must contain a JSON object to declare agent-qa.'

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
  const root = trackTempRoot(mkdtempSync(join(tmpdir(), 'agent-qa-init-refusal-')))
  mkdirSync(join(root, '.git'))
  return {
    root,
    home: trackTempRoot(mkdtempSync(join(tmpdir(), 'agent-qa-init-refusal-home-'))),
  }
}

async function init(
  root: string,
  home: string,
  args: readonly string[],
): Promise<SpawnOutcome & { text: string }> {
  const pm = args.includes('--pm') ? [] : ['--pm', 'none']
  const argv = [CLI_ENTRY, 'init', ...args, ...pm, '--no-browsers']
  const outcome = await spawnCollecting(root, argv, {
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
  expect(
    lines.filter((line) => /^\s+at\s/u.test(line)),
    outcome.text,
  ).toEqual([])
  expect(
    lines.filter((line) => line.startsWith('Node.js v')),
    outcome.text,
  ).toEqual([])
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

  it(
    'a knowledge .gitignore that the parent repository ignores is refused after the scaffold',
    async () => {
      expectFresh()
      const { root, home } = folders()
      git(root, home, ['init', '--quiet'])
      writeFileSync(join(root, '.gitignore'), 'agent-qa-knowledge/**\n')
      const refused = await init(root, home, WEB_GEMINI)
      expectRefusal(refused, ['agent-qa-knowledge/.gitignore is unsafe'])
    },
    CELL_BUDGET_MS,
  )

  it(
    'a malformed managed block in .gitignore is refused',
    async () => {
      expectFresh()
      const { root, home } = folders()
      const gitignore = join(root, '.gitignore')
      writeFileSync(gitignore, '# agent-qa init:start\nfoo\n')
      const before = readFileSync(gitignore)
      const refused = await init(root, home, WEB_GEMINI)
      expectRefusal(refused, ['Refusing malformed target .gitignore'])
      expect(readFileSync(gitignore)).toEqual(before)
    },
    CELL_BUDGET_MS,
  )

  it(
    'a held managed-block lock is refused',
    async () => {
      expectFresh()
      const { root, home } = folders()
      const lock = managedBlockLockPath(join(root, '.gitignore'))
      writeFileSync(lock, 'another writer\n')
      const refused = await init(root, home, WEB_GEMINI)
      expectRefusal(refused, ['already exists'])
      expect(readFileSync(lock, 'utf8')).toBe('another writer\n')
    },
    CELL_BUDGET_MS,
  )

  it(
    'a package.json that is not valid JSON is refused with its path',
    async () => {
      expectFresh()
      const { root, home } = folders()
      const packageJson = join(root, 'package.json')
      writeFileSync(packageJson, '{ not json')
      const refused = await init(root, home, WEB_CLAUDE_CODE)
      expectRefusal(refused, [
        `Refusing to update ${join(realpathSync(root), 'package.json')}: it is not valid JSON (`,
      ])
      expect(readFileSync(packageJson, 'utf8')).toBe('{ not json')
    },
    CELL_BUDGET_MS,
  )

  it(
    'a package.json that is not an object is refused with its path',
    async () => {
      expectFresh()
      const { root, home } = folders()
      const packageJson = join(root, 'package.json')
      writeFileSync(packageJson, '[]')
      const refused = await init(root, home, WEB_CLAUDE_CODE)
      expectRefusal(refused, [NOT_AN_OBJECT, join(realpathSync(root), 'package.json')])
      expect(readFileSync(packageJson, 'utf8')).toBe('[]')
    },
    CELL_BUDGET_MS,
  )

  it(
    'a config path that is a symbolic link is refused',
    async () => {
      expectFresh()
      const { root, home } = folders()
      writeFileSync(join(root, 'elsewhere.yaml'), 'version: 1\n')
      symlinkSync(join(root, 'elsewhere.yaml'), join(root, 'agent-qa.config.yaml'))
      const refused = await init(root, home, WEB_GEMINI)
      expectRefusal(refused, ['existing path is a symbolic link'])
    },
    CELL_BUDGET_MS,
  )
})
