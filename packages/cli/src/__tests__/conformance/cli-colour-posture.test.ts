// 2026-10-18 (444-14, D-42, D-47): the shipped bin prints no colour code without a terminal. The
// environment is built here from hermeticEnv, never from the 433 fixture's spawn env.

import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  ANCHORED_BUILDS,
  CLI_ENTRY,
  REBUILD_INSTRUCTION,
  buildFreshness,
  cleanupTempRoots,
  hermeticEnv,
  trackTempRoot,
} from './spawned-chat.js'

const MISSING_TEST_LINE = 'Error: Workspace test file not found: tests/missing.yaml'
const COLOUR_CODE = '\x1b['

interface BinOutcome {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
}

afterEach(() => {
  cleanupTempRoots()
})

function missingTestProject(): { root: string; configPath: string } {
  const root = trackTempRoot(mkdtempSync(join(tmpdir(), 'agent-qa-444-ci-colour-')))
  const configPath = join(root, 'agent-qa.config.yaml')
  writeFileSync(
    configPath,
    [
      'workspace:',
      '  testMatch:',
      "    - 'tests/**/*.yaml'",
      '  suiteMatch:',
      "    - 'suites/**/*.suite.yaml'",
      '  hooksFile: hooks.yaml',
      '  envFile: .env',
      '  secretsFile: .env.secrets.local',
      'use:',
      '  mobile:',
      '    appState: preserve',
      '',
    ].join('\n'),
    'utf8',
  )
  writeFileSync(join(root, '.env'), '', 'utf8')
  writeFileSync(join(root, '.env.secrets.local'), '', 'utf8')
  writeFileSync(join(root, 'hooks.yaml'), 'hooks: []\n', 'utf8')
  mkdirSync(join(root, '.agent-qa'), { recursive: true })
  return { root, configPath }
}

async function runMissingTest(extraEnv: Readonly<Record<string, string>>): Promise<BinOutcome> {
  if (process.platform === 'win32') throw new Error('POSIX run lifecycle required; never skip')
  const freshness = buildFreshness(ANCHORED_BUILDS)
  expect(
    { missing: freshness.missing, stale: freshness.stale },
    `these cells drive the built CLI: ${REBUILD_INSTRUCTION}`,
  ).toEqual({ missing: [], stale: [] })
  const project = missingTestProject()
  const env: NodeJS.ProcessEnv = { ...hermeticEnv(project.root), CI: 'true' }
  delete env.NO_COLOR
  delete env.FORCE_COLOR
  Object.assign(env, extraEnv)
  const child = spawn(
    process.execPath,
    [CLI_ENTRY, '--config', project.configPath, 'run', 'tests/missing.yaml'],
    { cwd: project.root, env, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
  const budget = setTimeout(() => { child.kill('SIGKILL') }, 60_000)
  try {
    const status = await new Promise<number | null>((settle, fail) => {
      child.once('error', fail)
      child.once('close', (code) => settle(code))
    })
    return { status, stdout, stderr }
  } finally {
    clearTimeout(budget)
  }
}

describe('the shipped bin\'s colour posture', () => {
  it('the shipped bin under CI=true with stdout piped prints no colour code', async () => {
    const outcome = await runMissingTest({})
    expect(outcome.stderr, JSON.stringify(outcome)).toContain(MISSING_TEST_LINE)
    expect(outcome.status, JSON.stringify(outcome)).toBe(1)
    expect(outcome.stdout.includes(COLOUR_CODE), JSON.stringify(outcome.stdout)).toBe(false)
    expect(outcome.stderr.includes(COLOUR_CODE), JSON.stringify(outcome.stderr)).toBe(false)
  }, 90_000)

  it('the shipped bin with FORCE_COLOR prints colour codes', async () => {
    const outcome = await runMissingTest({ FORCE_COLOR: '1' })
    expect(outcome.stderr, JSON.stringify(outcome)).toContain(MISSING_TEST_LINE)
    expect(outcome.status, JSON.stringify(outcome)).toBe(1)
    expect(outcome.stderr.includes(COLOUR_CODE), JSON.stringify(outcome.stderr)).toBe(true)
  }, 90_000)
})
