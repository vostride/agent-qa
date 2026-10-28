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
const INJECTED_NAME = 'MARK ##[error]x\n::set-output name=x::y'
const WRAPPED_PARSE_ERRORS =
  /::stop-commands::([0-9a-f]{32})\nFound 1 parse error\(s\):\n[\s\S]*?\n::\1::\n/u
const WRAPPED_BLOCK = /::stop-commands::([0-9a-f]{32})\n[\s\S]*?::\1::\n/gu

function wrappedBlocks(text: string): string[] {
  return [...text.matchAll(WRAPPED_BLOCK)].map((match) => match[0])
}

function outsidePairs(text: string): string {
  return text.replace(WRAPPED_BLOCK, '')
}

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

function limitsProject(): string {
  return project('limits', (testId) =>
    [
      `name: ${JSON.stringify(INJECTED_NAME)}`,
      `test-id: ${testId}`,
      'target: web',
      'use:',
      '  planner:',
      '    maxActions: 7',
      'steps:',
      '  - Open the page',
      '',
    ].join('\n'),
  )
}

function configNamesProject(
  label: string,
  edit: { platform?: string; secretsFile?: string } = {},
): string {
  const { root, configPath } = fixtureProject(`actions-output-${label}`)
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
    workspace: Record<string, unknown>
    registry?: unknown
  }
  config.registry = { devices: { [INJECTED_NAME]: { platform: edit.platform ?? 'android' } } }
  if (edit.secretsFile !== undefined) config.workspace.secretsFile = edit.secretsFile
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  writeFileSync(join(root, '.env'), '', 'utf8')
  writeFileSync(join(root, 'hooks.yaml'), 'hooks: []\n', 'utf8')
  return root
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

  it('run prints a test named in its planner limits inside a stop-commands pair under GitHub Actions', async () => {
    const root = limitsProject()
    const outcome = await spawnCollecting(root, [CLI_ENTRY, 'run'], { GITHUB_ACTIONS: 'true' })
    expect(outcome.stdout).toMatch(
      /::stop-commands::([0-9a-f]{32})\nLimits: \d+ actions, \d+ planning turns per step\nLimits for "MARK ##\[error\]x\n::set-output name=x::y": 7 actions, \d+ planning turns per step\n::\1::\n/u,
    )
    const outside = outsidePairs(outcome.stdout)
    expect(outside).not.toMatch(/^\s*::/mu)
    expect(outside).not.toContain('##[')
    expect(outcome.stderr).not.toContain('##[')
  })

  it('run prints the same planner limits with no stop-commands line off GitHub Actions', async () => {
    const root = limitsProject()
    const outcome = await spawnCollecting(root, [CLI_ENTRY, 'run'])
    expect(outcome.stdout).toMatch(
      /^Limits: [^\n]*\nLimits for "MARK ##\[error\]x\n::set-output name=x::y": 7 actions, /mu,
    )
    expect(outcome.stdout).toContain(`Limits for "${INJECTED_NAME}": 7 actions, `)
    expect(outcome.stdout).not.toContain('::stop-commands::')
  })

  it('run prints its own limits line bare when no test overrides the limits', async () => {
    const root = craftedNameProject()
    const outcome = await spawnCollecting(root, [CLI_ENTRY, 'run'], { GITHUB_ACTIONS: 'true' })
    expect(outsidePairs(outcome.stdout)).toMatch(
      /^Limits: \d+ actions, \d+ planning turns per step$/mu,
    )
  })
})

describe('agent-qa devices list output under GitHub Actions', () => {
  beforeAll(() => {
    expect(buildFreshness(), REBUILD_INSTRUCTION).toEqual({ missing: [], stale: [] })
  })

  afterEach(() => {
    cleanupTempRoots()
  })

  it('devices list prints its device rows inside a stop-commands pair under GitHub Actions', async () => {
    const root = configNamesProject('devices')
    const outcome = await spawnCollecting(root, [CLI_ENTRY, 'devices', 'list'], {
      GITHUB_ACTIONS: 'true',
    })
    expect(outcome.code).toBe(0)
    expect(
      wrappedBlocks(outcome.stdout).some(
        (block) => block.includes(INJECTED_NAME) && block.includes('android'),
      ),
    ).toBe(true)
    const outside = outsidePairs(outcome.stdout)
    expect(outside).toContain('Configured Devices')
    expect(outside).not.toMatch(/^\s*::/mu)
    expect(outside).not.toContain('##[')
  })

  it('devices list prints the same rows with no stop-commands line off GitHub Actions', async () => {
    const root = configNamesProject('devices')
    const outcome = await spawnCollecting(root, [CLI_ENTRY, 'devices', 'list'])
    expect(outcome.code).toBe(0)
    expect(outcome.stdout).toContain(INJECTED_NAME)
    expect(outcome.stdout).not.toContain('::stop-commands::')
  })

  it('devices list prints a config error naming a device inside a pair on stdout', async () => {
    const root = configNamesProject('devices-invalid', { platform: 'web' })
    const outcome = await spawnCollecting(root, [CLI_ENTRY, 'devices', 'list'], {
      GITHUB_ACTIONS: 'true',
    })
    expect(outcome.code).toBe(1)
    expect(
      wrappedBlocks(outcome.stdout).some(
        (block) => block.includes('Config error:') && block.includes('MARK ##[error]x'),
      ),
    ).toBe(true)
    expect(outcome.stderr).not.toContain('##[')
  })
})

describe('agent-qa config show output under GitHub Actions', () => {
  beforeAll(() => {
    expect(buildFreshness(), REBUILD_INSTRUCTION).toEqual({ missing: [], stale: [] })
  })

  afterEach(() => {
    cleanupTempRoots()
  })

  it('config show prints its resolved table inside a stop-commands pair under GitHub Actions', async () => {
    const root = configNamesProject('config')
    const outcome = await spawnCollecting(root, [CLI_ENTRY, 'config', 'show'], {
      GITHUB_ACTIONS: 'true',
    })
    expect(outcome.code).toBe(0)
    expect(
      wrappedBlocks(outcome.stdout).some((block) =>
        block.includes(`registry.devices.${INJECTED_NAME}.platform`),
      ),
    ).toBe(true)
    const outside = outsidePairs(outcome.stdout)
    expect(outside).toContain('Resolved Configuration:')
    expect(outside).not.toMatch(/^\s*::/mu)
    expect(outside).not.toContain('##[')
  })

  it('config show prints the same table with no stop-commands line off GitHub Actions', async () => {
    const root = configNamesProject('config')
    const outcome = await spawnCollecting(root, [CLI_ENTRY, 'config', 'show'])
    expect(outcome.code).toBe(0)
    expect(outcome.stdout).toContain(`registry.devices.${INJECTED_NAME}.platform`)
    expect(outcome.stdout).not.toContain('::stop-commands::')
  })

  it('config show prints a refusal naming the secrets file inside a pair on stdout', async () => {
    const root = configNamesProject('config-secrets', { secretsFile: '##[error]x.secrets.local' })
    const outcome = await spawnCollecting(root, [CLI_ENTRY, 'config', 'show'], {
      GITHUB_ACTIONS: 'true',
    })
    expect(outcome.code).toBe(1)
    expect(
      wrappedBlocks(outcome.stdout).some(
        (block) =>
          block.includes('Secrets file not found') && block.includes('##[error]x.secrets.local'),
      ),
    ).toBe(true)
    expect(outcome.stderr).not.toContain('##[')
  })
})
