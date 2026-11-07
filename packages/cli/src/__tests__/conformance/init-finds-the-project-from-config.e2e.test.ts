// init reads --config as its config file: the lookup, a fresh write, --agent and the --dir refusal.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { spawnSync } from 'node:child_process'
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
  return trackTempRoot(mkdtempSync(join(tmpdir(), `agent-qa-init-config-${label}-`)))
}

async function agentQa(
  cwd: string,
  args: readonly string[],
): Promise<SpawnOutcome & { text: string }> {
  const home = tempFolder('home')
  const outcome = await spawnCollecting(cwd, [CLI_ENTRY, ...args], {
    HOME: home,
    USERPROFILE: home,
  })
  return { ...outcome, text: `${outcome.stdout}\n${outcome.stderr}` }
}

function plantConfig(root: string, path: string): void {
  mkdirSync(join(root, path, '..'), { recursive: true })
  writeFileSync(join(root, path), 'workspace: {}\n')
}

async function freshInitAtNamedConfig(): Promise<{
  root: string
  outcome: SpawnOutcome & { text: string }
}> {
  const root = tempFolder('fresh')
  const git = spawnSync('git', ['init', '--quiet'], { cwd: root, encoding: 'utf8' })
  expect(git.status, git.stderr).toBe(0)
  const outcome = await agentQa(root, ['--config', 'sub/custom.yaml', 'init', ...WEB_GEMINI])
  expect(outcome.code, outcome.text).toBe(0)
  return { root, outcome }
}

function configuration(outcome: SpawnOutcome & { text: string }): unknown {
  expect(outcome.code, outcome.text).toBe(0)
  const manifest = JSON.parse(outcome.stdout) as { posture: { configuration: unknown } }
  return manifest.posture.configuration
}

describe('init and the --config file', () => {
  it(
    'an existing config named by --config is found, and init asks nothing and writes nothing',
    async () => {
      expectFresh()
      const root = tempFolder('existing')
      const realRoot = realpathSync(root)
      plantConfig(root, join('sub', 'custom.yaml'))
      const outcome = await agentQa(root, ['--config', 'sub/custom.yaml', 'init', ...WEB_GEMINI])
      expect(outcome.code, outcome.text).toBe(0)
      expect(outcome.text).toContain(`Project is already initialized at ${join(realRoot, 'sub')}`)
      expect(readdirSync(join(root, 'sub'))).toEqual(['custom.yaml'])
      expect(existsSync(join(root, 'agent-qa.config.yaml'))).toBe(false)
    },
    CELL_BUDGET_MS,
  )

  it(
    '--dir and --config naming different folders are refused with both paths',
    async () => {
      expectFresh()
      const root = tempFolder('mismatch')
      const realRoot = realpathSync(root)
      const outcome = await agentQa(root, [
        '--config',
        'custom.yaml',
        'init',
        '--dir',
        'e2e',
        ...WEB_GEMINI,
      ])
      expect(outcome.code, outcome.text).toBe(2)
      expect(outcome.text).toContain(join(realRoot, 'e2e'))
      expect(outcome.text).toContain(join(realRoot, 'custom.yaml'))
      const frames = outcome.text.split('\n').filter((line) => /^\s+at\s/u.test(line))
      expect(frames, outcome.text).toEqual([])
      expect(existsSync(join(root, 'e2e'))).toBe(false)
      expect(existsSync(join(root, 'custom.yaml'))).toBe(false)
    },
    CELL_BUDGET_MS,
  )

  it(
    "init --agent with --dir reads that folder's config",
    async () => {
      expectFresh()
      const root = tempFolder('agent-dir')
      plantConfig(root, join('sub', 'agent-qa.config.yaml'))
      const outcome = await agentQa(root, ['init', '--agent', '--dir', 'sub'])
      expect(configuration(outcome)).not.toBe('absent')
    },
    CELL_BUDGET_MS,
  )

  it(
    'init --agent with --config reads the named file',
    async () => {
      expectFresh()
      const root = tempFolder('agent-config')
      plantConfig(root, join('sub', 'custom.yaml'))
      const outcome = await agentQa(root, ['--config', 'sub/custom.yaml', 'init', '--agent'])
      expect(configuration(outcome)).not.toBe('absent')
    },
    CELL_BUDGET_MS,
  )

  it(
    'a fresh init with --config writes the config at that path and the scaffold in its folder',
    async () => {
      expectFresh()
      const { root } = await freshInitAtNamedConfig()
      for (const path of [
        'custom.yaml',
        '.env.secrets.local',
        '.gitignore',
        join('agent-qa-knowledge', 'AGENTS.md'),
      ]) {
        expect(existsSync(join(root, 'sub', path)), path).toBe(true)
      }
      expect(existsSync(join(root, 'sub', 'agent-qa.config.yaml'))).toBe(false)
      expect(existsSync(join(root, 'agent-qa.config.yaml'))).toBe(false)
    },
    CELL_BUDGET_MS,
  )

  it(
    'the next steps for a named config carry --config before each agent-qa command',
    async () => {
      expectFresh()
      const { outcome } = await freshInitAtNamedConfig()
      expect(outcome.stdout).toContain('npx agent-qa --config custom.yaml validate')
      expect(outcome.stdout).toContain(
        'npx agent-qa --config custom.yaml auth set --config default --type api-key',
      )
      expect(outcome.stdout).toContain('npx agent-qa --config custom.yaml run')
      const bare = outcome.stdout
        .split('\n')
        .filter((line) => line.includes('npx agent-qa validate'))
      expect(bare).toEqual([])
    },
    CELL_BUDGET_MS,
  )
})
