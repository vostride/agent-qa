// init sets up the folder it runs in, and refuses --dir and --config in either position.

import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
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
const DIR_LINE =
  "agent-qa init sets up the folder it runs in and takes no --dir. Run it in the project's folder."
const CONFIG_LINE =
  "agent-qa init sets up the folder it runs in and takes no --config. Run it in the project's folder."

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
  return trackTempRoot(mkdtempSync(join(tmpdir(), `agent-qa-init-folder-${label}-`)))
}

function projectFolder(label: string): string {
  const root = tempFolder(label)
  mkdirSync(join(root, '.git'))
  return root
}

function listing(root: string): string[] {
  return readdirSync(root, { recursive: true, encoding: 'utf8' }).sort()
}

async function agentQa(
  cwd: string,
  args: readonly string[],
  env: Record<string, string> = {},
): Promise<SpawnOutcome & { text: string }> {
  const home = tempFolder('home')
  const outcome = await spawnCollecting(cwd, [CLI_ENTRY, ...args], {
    HOME: home,
    USERPROFILE: home,
    ...env,
  })
  return { ...outcome, text: `${outcome.stdout}\n${outcome.stderr}` }
}

function plantConfig(root: string): void {
  writeFileSync(join(root, 'agent-qa.config.yaml'), 'workspace: {}\n')
}

function escaped(line: string): string {
  return line.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

async function expectRefused(args: readonly string[], line: string): Promise<void> {
  expectFresh()
  const root = projectFolder('refused')
  const before = listing(root)
  const outcome = await agentQa(root, args)
  expect(outcome.code, outcome.text).toBe(2)
  expect(outcome.stderr.split('\n'), outcome.text).toContain(line)
  const frames = outcome.text.split('\n').filter((text) => /^\s+at\s/u.test(text))
  expect(frames, outcome.text).toEqual([])
  expect(listing(root)).toEqual(before)
}

describe('the folder init runs in', () => {
  it(
    'init in a folder with a config is already initialized and writes nothing',
    async () => {
      expectFresh()
      const root = projectFolder('existing')
      plantConfig(root)
      const before = listing(root)
      const outcome = await agentQa(root, ['init', ...WEB_GEMINI, '--pm', 'none', '--no-browsers'])
      expect(outcome.code, outcome.text).toBe(0)
      expect(outcome.text).toContain('Project is already initialized at')
      expect(listing(root)).toEqual(before)
    },
    CELL_BUDGET_MS,
  )

  it(
    'init --dir is refused and writes nothing',
    async () => {
      await expectRefused(['init', '--dir', 'e2e', ...WEB_GEMINI], DIR_LINE)
    },
    CELL_BUDGET_MS,
  )

  it(
    'a --config before init is refused and writes nothing',
    async () => {
      await expectRefused(['--config', 'custom.yaml', 'init', ...WEB_GEMINI], CONFIG_LINE)
    },
    CELL_BUDGET_MS,
  )

  it(
    'a --config after init is refused and writes nothing',
    async () => {
      await expectRefused(['init', '--config', 'custom.yaml', ...WEB_GEMINI], CONFIG_LINE)
    },
    CELL_BUDGET_MS,
  )

  it(
    'init --capabilities reads the config in the folder it runs in',
    async () => {
      expectFresh()
      const root = projectFolder('agent')
      plantConfig(root)
      const outcome = await agentQa(root, ['init', '--capabilities'])
      expect(outcome.code, outcome.text).toBe(0)
      const manifest = JSON.parse(outcome.stdout) as { posture: { configuration: unknown } }
      expect(manifest.posture.configuration).not.toBe('absent')
    },
    CELL_BUDGET_MS,
  )

  it(
    'a refused init --capabilities under GitHub Actions prints its block on stderr and nothing on stdout',
    async () => {
      expectFresh()
      const root = projectFolder('agent-refused')
      const outcome = await agentQa(root, ['init', '--capabilities', '--dir', 'e2e'], {
        GITHUB_ACTIONS: 'true',
      })
      expect(outcome.code, outcome.text).toBe(2)
      expect(outcome.stdout).toBe('')
      expect(outcome.stderr).toMatch(
        new RegExp(`^::stop-commands::([0-9a-f]{32})\\n${escaped(DIR_LINE)}\\n::\\1::\\n$`, 'u'),
      )
    },
    CELL_BUDGET_MS,
  )
})
