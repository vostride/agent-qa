// the shipped bootstrap reports a CLI that fails while
// loading with the framework line, then the error's stack, and exits 2. The built dist/cli.js is
// copied alone beside a cli-main.js this file writes, so the failure is the bootstrap's to report.

import { spawn } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
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

interface BootstrapOutcome {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
}

afterEach(() => {
  cleanupTempRoots()
})

async function runBootstrapBeside(cliMainSource: string): Promise<BootstrapOutcome> {
  if (process.platform === 'win32') throw new Error('POSIX run lifecycle required; never skip')
  const freshness = buildFreshness(ANCHORED_BUILDS)
  expect(
    { missing: freshness.missing, stale: freshness.stale },
    `these cells copy the built CLI entry: ${REBUILD_INSTRUCTION}`,
  ).toEqual({ missing: [], stale: [] })
  const root = trackTempRoot(mkdtempSync(join(tmpdir(), 'agent-qa-444-bootstrap-stack-')))
  mkdirSync(join(root, '.agent-qa'), { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8')
  copyFileSync(CLI_ENTRY, join(root, 'cli.js'))
  writeFileSync(join(root, 'cli-main.js'), cliMainSource, 'utf8')
  const child = spawn(process.execPath, [join(root, 'cli.js')], {
    cwd: root,
    env: hermeticEnv(root),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
  const budget = setTimeout(() => { child.kill('SIGKILL') }, 30_000)
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

describe('a CLI that fails while loading', () => {
  it('a CLI that throws while loading prints the framework line, then its stack, and exits 2',
    async () => {
      const outcome = await runBootstrapBeside(
        "throw new Error('bootstrap stack probe 444-27')\n",
      )
      const lines = outcome.stderr.split('\n')
      expect(lines[0], JSON.stringify(outcome)).toBe('Framework error: bootstrap stack probe 444-27')
      expect(lines.slice(1).join('\n'), JSON.stringify(outcome)).toMatch(/^\s+at .*cli-main\.js/m)
      expect(outcome.status, JSON.stringify(outcome)).toBe(2)
      expect(outcome.stdout, JSON.stringify(outcome)).toBe('')
    }, 60_000)

  it('a thrown non-error prints the framework line alone', async () => {
    const outcome = await runBootstrapBeside("throw 'bootstrap plain probe 444-27'\n")
    expect(outcome.stderr, JSON.stringify(outcome)).toBe(
      'Framework error: bootstrap plain probe 444-27\n',
    )
    expect(outcome.status, JSON.stringify(outcome)).toBe(2)
    expect(outcome.stdout, JSON.stringify(outcome)).toBe('')
  }, 60_000)
})
