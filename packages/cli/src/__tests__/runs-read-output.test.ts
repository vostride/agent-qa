import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { generateRunId, generateTestId } from '@vostride/agent-qa-ids'
import { FsHandoffStore } from '@vostride/agent-qa-runner-local'
import { CURRENT_HANDOFF_SCHEMA_VERSION } from '@vostride/agent-qa-schema'
import type { CompletedRunHandoff, PerTestOutcome } from '@vostride/agent-qa-schema'
import { Command } from 'commander'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createRunsCommand, renderMarkOutcome } from '../commands/runs.js'
import { renderRunList } from '../commands/runs-read.js'

const CRAFTED_NAME = '##[error]x ::set-output name=x::y'
const PAIR = /^::stop-commands::([0-9a-f]{32})\n[\s\S]*\n::\1::\n$/u

const roots: string[] = []

afterEach(() => {
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function project(): { configPath: string; runId: string } {
  const root = mkdtempSync(join(tmpdir(), 'agent-qa-runs-read-output-'))
  roots.push(root)
  const configPath = join(root, 'agent-qa.config.yaml')
  writeFileSync(configPath, 'workspace:\n  testMatch: [tests/**/*.yaml]\n  suiteMatch: [suites/**/*.suite.yaml]\n'
    + '  hooksFile: hooks.yaml\n  envFile: .env\n  secretsFile: .env.secrets.local\n'
    + 'use:\n  mobile:\n    appState: preserve\n')
  writeFileSync(join(root, '.env.secrets.local'), '')
  const runId = generateRunId()
  const handoff: CompletedRunHandoff = {
    schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION,
    runId: runId as CompletedRunHandoff['runId'],
    scope: { tier: 'product', key: 'shop' },
    buildOrdinal: 1,
    executionContext: 'local-headless',
    aggregateVerdict: 'failed',
    configDigests: { suiteConfigDigest: 'suite', testConfigDigest: 'test' },
    startedAt: 50,
    endedAt: 100,
    tests: [{
      testId: generateTestId(), testName: CRAFTED_NAME, filePath: 'tests/crafted.yaml', testIndex: 0,
      outcome: 'failed', steps: [],
    } as unknown as PerTestOutcome],
  }
  new FsHandoffStore({ root: join(root, '.agent-qa'), runId }).save(handoff)
  return { configPath, runId }
}

interface Invocation {
  stdout: string
  stderr: string
  writes: string[]
  exitCode: number | string | undefined
}

async function runs(configPath: string, args: readonly string[]): Promise<Invocation> {
  const stdout: string[] = []
  const stderr: string[] = []
  const writes: string[] = []
  const log = vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => {
    stdout.push(values.map(String).join(' '))
  })
  const error = vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => {
    stderr.push(values.map(String).join(' '))
  })
  const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    writes.push(String(chunk))
    return true
  })
  const priorExit = process.exitCode
  process.exitCode = undefined
  try {
    const program = new Command()
      .option('--config <path>', 'config file path')
      .addCommand(createRunsCommand())
    program.exitOverride()
    await program.parseAsync(['node', 'agent-qa', '--config', configPath, 'runs', ...args])
    return { stdout: stdout.join('\n'), stderr: stderr.join('\n'), writes, exitCode: process.exitCode }
  } finally {
    process.exitCode = priorExit
    log.mockRestore()
    error.mockRestore()
    write.mockRestore()
  }
}

describe('agent-qa runs output under GitHub Actions', () => {
  it('runs list prints what a run recorded as text inside one stop-commands pair', async () => {
    const { configPath } = project()
    const plain = await runs(configPath, ['list'])
    expect(plain.stdout).toContain(CRAFTED_NAME)
    vi.stubEnv('GITHUB_ACTIONS', 'true')

    const invocation = await runs(configPath, ['list'])

    expect(invocation.stdout).toBe('')
    expect(invocation.writes).toHaveLength(1)
    expect(invocation.writes[0]).toMatch(PAIR)
    expect(invocation.writes[0]).toContain(`\n${plain.stdout}\n`)
  })

  it('runs list --json carries no # and parses back to the same runs', async () => {
    const { configPath } = project()
    const plain = await runs(configPath, ['list', '--json'])
    expect(plain.stdout).toContain('#')
    vi.stubEnv('GITHUB_ACTIONS', 'true')

    const invocation = await runs(configPath, ['list', '--json'])

    expect(invocation.writes).toEqual([])
    expect(invocation.stdout).not.toContain('#')
    expect(JSON.parse(invocation.stdout)).toEqual(JSON.parse(plain.stdout))
  })

  it('a read failure prints its message inside a pair', async () => {
    const { configPath } = project()
    vi.stubEnv('GITHUB_ACTIONS', 'true')

    const invocation = await runs(configPath, ['overview', generateRunId()])

    expect(invocation.exitCode).toBe(1)
    expect(invocation.stderr).toBe('')
    expect(invocation.writes).toHaveLength(1)
    expect(invocation.writes[0]).toMatch(PAIR)
    expect(invocation.writes[0]).toContain('agent-qa runs overview: ')
  })

  it('a read failure under --json stays on stderr inside its pair, leaving stdout to the data', async () => {
    const { configPath } = project()
    vi.stubEnv('GITHUB_ACTIONS', 'true')

    const invocation = await runs(configPath, ['overview', generateRunId(), '--json'])

    expect(invocation.exitCode).toBe(1)
    expect(invocation.writes).toEqual([])
    expect(invocation.stdout).toBe('')
    expect(`${invocation.stderr}\n`).toMatch(PAIR)
  })

  it('a refused evidence flag under --json stays off stdout', async () => {
    const { configPath, runId } = project()
    vi.stubEnv('GITHUB_ACTIONS', 'true')

    const invocation = await runs(configPath, ['evidence', runId, '--json'])

    expect(invocation.exitCode).toBe(1)
    expect(invocation.writes).toEqual([])
    expect(invocation.stdout).toBe('')
    expect(`${invocation.stderr}\n`).toMatch(PAIR)
    expect(invocation.stderr).toContain('agent-qa runs evidence: name a document')
  })

  it('runs mark prints its outcome inside a pair and its --json receipt unwrapped', async () => {
    const { configPath } = project()
    const missing = generateRunId()
    vi.stubEnv('GITHUB_ACTIONS', 'true')

    const human = await runs(configPath, ['mark', missing, '--kind', 'false-fail'])
    const json = await runs(configPath, ['mark', missing, '--kind', 'false-fail', '--json'])

    expect(human.stdout).toBe('')
    expect(human.writes).toHaveLength(1)
    expect(human.writes[0]).toMatch(PAIR)
    expect(human.writes[0]).toContain(`run not found: ${missing}`)
    expect(json.writes).toEqual([])
    expect(JSON.parse(json.stdout)).toMatchObject({ runId: missing })
  })
})

describe('agent-qa runs output off GitHub Actions', () => {
  it('prints the rendered list and the plain JSON exactly as before', async () => {
    const { configPath } = project()

    const human = await runs(configPath, ['list'])
    const json = await runs(configPath, ['list', '--json'])

    expect(human.writes).toEqual([])
    expect(json.writes).toEqual([])
    const rows = JSON.parse(json.stdout) as Parameters<typeof renderRunList>[0]
    expect(human.stdout).toBe(renderRunList(rows, false))
    expect(json.stdout).toBe(JSON.stringify(rows, null, 2))
  })

  it('prints a mark outcome through its renderer', async () => {
    const { configPath } = project()
    const missing = generateRunId()

    const human = await runs(configPath, ['mark', missing, '--kind', 'false-fail'])
    const json = await runs(configPath, ['mark', missing, '--kind', 'false-fail', '--json'])

    expect(human.writes).toEqual([])
    expect(human.stdout).toBe(renderMarkOutcome(JSON.parse(json.stdout)))
    expect(json.stdout).toBe(JSON.stringify(JSON.parse(json.stdout)))
  })
})
