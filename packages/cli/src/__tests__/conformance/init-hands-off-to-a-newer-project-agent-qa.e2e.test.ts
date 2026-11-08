// A newer agent-qa installed in the project takes over init; a planted or misnamed copy never runs.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { getAgentQaVersion } from '@vostride/agent-qa-core'
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
const INIT_ARGS = [
  'init',
  '--platform',
  'web',
  '--llm',
  'gemini',
  '--pm',
  'none',
  '--no-browsers',
  '--agents',
  'none',
]
const RUNNING_VERSION = getAgentQaVersion().trim()
const FAKE_EXIT = 7
// A copy that does not take over still runs init's validate step, which it passes.
const FAKE_CLI = `process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), handedOff: process.env.AGENT_QA_HANDED_OFF ?? null }) + '\\n')
process.exit(process.argv[2] === 'validate' ? 0 : ${FAKE_EXIT})
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
  return trackTempRoot(mkdtempSync(join(tmpdir(), `agent-qa-hand-off-${label}-`)))
}

function projectFolder(label: string): string {
  const root = tempFolder(label)
  mkdirSync(join(root, '.git'))
  return root
}

function plantCopy(
  folder: string,
  manifest: { name?: string; version: string; bin?: unknown },
): string {
  const packageDir = join(folder, 'node_modules', 'agent-qa')
  mkdirSync(packageDir, { recursive: true })
  writeFileSync(
    join(packageDir, 'package.json'),
    `${JSON.stringify({ name: 'agent-qa', bin: { 'agent-qa': 'cli.js' }, ...manifest }, null, 2)}\n`,
  )
  writeFileSync(join(packageDir, 'cli.js'), FAKE_CLI)
  return packageDir
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

function fakeRan(outcome: SpawnOutcome): boolean {
  return outcome.stdout.includes('"argv"')
}

function initialized(root: string): boolean {
  return existsSync(join(root, 'agent-qa.config.yaml'))
}

describe('init hands off to a newer project agent-qa', () => {
  it(
    "a newer project agent-qa runs init with the same arguments and its exit code is init's",
    async () => {
      expectFresh()
      const root = projectFolder('newer')
      plantCopy(root, { version: '99.0.0' })

      const outcome = await agentQa(root, INIT_ARGS)

      expect(outcome.code, outcome.text).toBe(FAKE_EXIT)
      expect(outcome.stdout.split('\n'), outcome.text).toContain(
        JSON.stringify({ argv: INIT_ARGS, handedOff: '1' }),
      )
      expect(outcome.stderr.split('\n'), outcome.text).toContain(
        `Handing over to the project's agent-qa 99.0.0 (node_modules/agent-qa), which is newer than this one (${RUNNING_VERSION}).`,
      )
      expect(readdirSync(root).sort()).toEqual(['.git', 'node_modules'])
      expect(readdirSync(join(root, 'node_modules'))).toEqual(['agent-qa'])
    },
    CELL_BUDGET_MS,
  )

  it(
    'an equal version does not take over',
    async () => {
      expectFresh()
      const root = projectFolder('equal')
      plantCopy(root, { version: RUNNING_VERSION })

      const outcome = await agentQa(root, INIT_ARGS)

      expect(outcome.code, outcome.text).toBe(0)
      expect(fakeRan(outcome), outcome.text).toBe(false)
      expect(initialized(root)).toBe(true)
    },
    CELL_BUDGET_MS,
  )

  it(
    'an agent-qa started by a hand-off does not hand off again',
    async () => {
      expectFresh()
      const root = projectFolder('handed-off')
      plantCopy(root, { version: '99.0.0' })

      const outcome = await agentQa(root, INIT_ARGS, { AGENT_QA_HANDED_OFF: '1' })

      expect(outcome.code, outcome.text).toBe(0)
      expect(fakeRan(outcome), outcome.text).toBe(false)
      expect(initialized(root)).toBe(true)
    },
    CELL_BUDGET_MS,
  )

  it(
    'a copy above the git root is never run',
    async () => {
      expectFresh()
      const parent = tempFolder('above')
      plantCopy(parent, { version: '99.0.0' })
      const root = join(parent, 'app')
      mkdirSync(join(root, '.git'), { recursive: true })

      const outcome = await agentQa(root, INIT_ARGS)

      expect(outcome.code, outcome.text).toBe(0)
      expect(fakeRan(outcome), outcome.text).toBe(false)
      expect(initialized(root)).toBe(true)
    },
    CELL_BUDGET_MS,
  )

  it(
    'a package not named agent-qa is never run',
    async () => {
      expectFresh()
      const root = projectFolder('misnamed')
      plantCopy(root, { name: 'not-agent-qa', version: '99.0.0' })

      const outcome = await agentQa(root, INIT_ARGS)

      expect(outcome.code, outcome.text).toBe(0)
      expect(fakeRan(outcome), outcome.text).toBe(false)
      expect(initialized(root)).toBe(true)
    },
    CELL_BUDGET_MS,
  )

  it(
    'a bin outside its package is never run',
    async () => {
      expectFresh()
      const root = projectFolder('escaping-bin')
      plantCopy(root, { version: '99.0.0', bin: '../evil.js' })
      writeFileSync(join(root, 'node_modules', 'evil.js'), FAKE_CLI)

      const outcome = await agentQa(root, INIT_ARGS)

      expect(outcome.code, outcome.text).toBe(0)
      expect(fakeRan(outcome), outcome.text).toBe(false)
      expect(initialized(root)).toBe(true)
    },
    CELL_BUDGET_MS,
  )

  it(
    'init --capabilities never hands off',
    async () => {
      expectFresh()
      const root = projectFolder('agent')
      plantCopy(root, { version: '99.0.0' })

      const outcome = await agentQa(root, ['init', '--capabilities'])

      expect(outcome.code, outcome.text).toBe(0)
      expect(fakeRan(outcome), outcome.text).toBe(false)
      const manifest = JSON.parse(outcome.stdout) as { rows?: unknown; posture?: unknown }
      expect(manifest.rows).toEqual(expect.any(Array))
      expect(manifest.posture).toEqual(expect.any(Object))
    },
    CELL_BUDGET_MS,
  )
})
