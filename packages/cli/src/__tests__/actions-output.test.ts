// Spawns the built `dist/cli.js`; run `pnpm build` at the repository root first.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { generateTestId } from '@vostride/agent-qa-ids'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import {
  CLI_ENTRY,
  REBUILD_INSTRUCTION,
  buildFreshness,
  cleanupTempRoots,
  fixtureProject,
  spawnCollecting,
} from './conformance/spawned-chat.js'

const CRAFTED_NAME = '::set-output name=x::y ##[error]x'
const CRAFTED_STEPS = '::set-output name=x::y'
const WRAPPED_PARSE_ERRORS =
  /::stop-commands::([0-9a-f]{32})\nFound 1 parse error\(s\):\n[\s\S]*?\n::\1::\n/u

function project(label: string, testYaml: (testId: string) => string): string {
  const { root, configPath } = fixtureProject(`actions-output-${label}`)
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>
  config.registry = { targets: { web: { platform: 'web', url: 'http://127.0.0.1:8931' } } }
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  writeFileSync(join(root, '.env'), '', 'utf8')
  writeFileSync(join(root, 'hooks.yaml'), 'hooks: []\n', 'utf8')
  mkdirSync(join(root, 'tests'), { recursive: true })
  writeFileSync(join(root, 'tests', 'crafted.yaml'), testYaml(generateTestId()), 'utf8')
  return root
}

function craftedNameProject(): string {
  return project('name', (testId) =>
    [
      `name: ${JSON.stringify(CRAFTED_NAME)}`,
      `test-id: ${testId}`,
      'target: web',
      'steps:',
      '  - Open the page',
      '',
    ].join('\n'),
  )
}

function parseErrorProject(): string {
  return project('parse', (testId) =>
    [
      'name: Broken',
      `test-id: ${testId}`,
      'target: web',
      `steps: ${JSON.stringify(CRAFTED_STEPS)}`,
      '',
    ].join('\n'),
  )
}

describe('agent-qa run output under GitHub Actions', () => {
  beforeAll(() => {
    expect(buildFreshness(), REBUILD_INSTRUCTION).toEqual({ missing: [], stale: [] })
  })

  afterEach(() => {
    cleanupTempRoots()
  })

  it('run prints a workflow-command-shaped test name as text under GitHub Actions', async () => {
    const root = craftedNameProject()
    const outcome = await spawnCollecting(root, [CLI_ENTRY, 'run', '--dry-run'], {
      GITHUB_ACTIONS: 'true',
    })
    expect(outcome.stderr).toBe('')
    expect(outcome.code).toBe(0)
    expect(outcome.stdout).toMatch(
      /::stop-commands::([0-9a-f]{32})\n[^\n]*::set-output name=x::y ##\[error\]x[^\n]*\n::\1::\n/u,
    )
  })

  it('run prints the same test name with no stop-commands line off GitHub Actions', async () => {
    const root = craftedNameProject()
    const outcome = await spawnCollecting(root, [CLI_ENTRY, 'run', '--dry-run'])
    expect(outcome.code).toBe(0)
    expect(outcome.stdout).toContain(CRAFTED_NAME)
    expect(outcome.stdout).not.toContain('::stop-commands::')
  })

  it('run prints a parse error quoting a workflow command inside a pair on stdout', async () => {
    const root = parseErrorProject()
    const outcome = await spawnCollecting(root, [CLI_ENTRY, 'run', '--dry-run'], {
      GITHUB_ACTIONS: 'true',
    })
    expect(outcome.code).toBe(2)
    expect(outcome.stderr).not.toContain(CRAFTED_STEPS)
    const block = WRAPPED_PARSE_ERRORS.exec(outcome.stdout)?.[0]
    expect(block).toContain(`steps: "${CRAFTED_STEPS}"`)
  })

  it('run prints the parse error on stderr with no stop-commands line elsewhere', async () => {
    const root = parseErrorProject()
    const outcome = await spawnCollecting(root, [CLI_ENTRY, 'run', '--dry-run'])
    expect(outcome.code).toBe(2)
    expect(outcome.stderr).toContain(`steps: "${CRAFTED_STEPS}"`)
    expect(outcome.stdout).not.toContain(CRAFTED_STEPS)
    expect(`${outcome.stdout}${outcome.stderr}`).not.toContain('::stop-commands::')
  })
})
