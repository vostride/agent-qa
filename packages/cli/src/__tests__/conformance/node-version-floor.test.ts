// C445-NODE-FLOOR (445-01, D-21): an unsupported Node is refused before cli-main or node:sqlite loads

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { afterAll, describe, expect, it } from 'vitest'

import {
  ANCHORED_BUILDS,
  CLI_ENTRY,
  REBUILD_INSTRUCTION,
  buildFreshness,
  cleanupTempRoots,
  hermeticEnv,
  trackTempRoot,
} from './spawned-chat.js'

const INSTALL_LINE =
  'Install Node.js 24 or newer from https://nodejs.org/, then run the command again.'

const HOOKS = `import { appendFileSync } from 'node:fs'
export async function resolve(specifier, context, next) {
  appendFileSync(process.env.TRACE_FILE, specifier + '\\n')
  return next(specifier, context)
}
`

const REGISTER = `import { register } from 'node:module'
register('./hooks.mjs', import.meta.url)
`

function spoofSource(version: string): string {
  return `Object.defineProperty(process, 'version', { value: ${JSON.stringify(version)}, configurable: true, enumerable: true })
Object.defineProperty(process, 'versions', { value: { ...process.versions, node: ${JSON.stringify(version.slice(1))} }, configurable: true, enumerable: true })
`
}

interface FloorRun {
  readonly args: readonly string[]
  readonly spoof: string | undefined
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
  readonly trace: readonly string[]
}

let counter = 0

function makeRoot(): string {
  const root = trackTempRoot(mkdtempSync(join(tmpdir(), 'agent-qa-445-node-floor-')))
  mkdirSync(join(root, '.agent-qa'), { recursive: true })
  writeFileSync(join(root, 'hooks.mjs'), HOOKS, 'utf8')
  writeFileSync(join(root, 'register.mjs'), REGISTER, 'utf8')
  return root
}

function runBin(args: readonly string[], spoof?: string): FloorRun {
  if (process.platform === 'win32') throw new Error('POSIX run lifecycle required; never skip')
  const root = makeRoot()
  counter += 1
  const traceFile = join(root, `trace-${counter}.txt`)
  const preloads: string[] = []
  if (spoof !== undefined) {
    const spoofPath = join(root, `spoof-${counter}.mjs`)
    writeFileSync(spoofPath, spoofSource(spoof), 'utf8')
    preloads.push('--import', pathToFileURL(spoofPath).href)
  }
  preloads.push('--import', pathToFileURL(join(root, 'register.mjs')).href)
  const result = spawnSync(process.execPath, [...preloads, CLI_ENTRY, ...args], {
    cwd: root,
    env: { ...hermeticEnv(root), TRACE_FILE: traceFile },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
  })
  const trace = existsSync(traceFile)
    ? readFileSync(traceFile, 'utf8').split('\n').filter((line) => line !== '')
    : []
  return { args, spoof, status: result.status, stdout: result.stdout, stderr: result.stderr, trace }
}

function seen(run: FloorRun): string {
  return JSON.stringify(
    {
      args: run.args,
      spoof: run.spoof,
      status: run.status,
      stdout: run.stdout,
      stderr: run.stderr,
      traceLines: run.trace.length,
      traceHead: run.trace.slice(0, 5),
      cliMain: run.trace.filter((line) => line.includes('cli-main')),
      nodeSqlite: run.trace.filter((line) => line.includes('node:sqlite')),
    },
    null,
    2,
  )
}

function expectFresh(): void {
  const freshness = buildFreshness(ANCHORED_BUILDS)
  expect(
    { missing: freshness.missing, stale: freshness.stale },
    `these cells drive the built CLI: ${REBUILD_INSTRUCTION}`,
  ).toEqual({ missing: [], stale: [] })
}

function expectRefused(run: FloorRun, version: string): void {
  expect(run.trace.length, `the tracer recorded nothing\n${seen(run)}`).toBeGreaterThan(0)
  expect(
    run.trace.filter((line) => line.includes('cli-main') || line.includes('node:sqlite')),
    `cli-main or node:sqlite loaded under Node ${version}\n${seen(run)}`,
  ).toEqual([])
  expect(run.stderr, seen(run)).toBe(
    `agent-qa needs Node.js 24 or newer. This is Node.js ${version}.\n${INSTALL_LINE}\n`,
  )
  expect(run.stdout, seen(run)).toBe('')
  expect(run.status, seen(run)).toBe(2)
}

function expectLoaded(run: FloorRun): void {
  expect(run.stderr, seen(run)).not.toContain('agent-qa needs Node.js')
  expect(
    run.trace.some((line) => line.includes('cli-main')),
    `the CLI did not load\n${seen(run)}`,
  ).toBe(true)
  expect(run.status, seen(run)).toBe(0)
}

afterAll(() => {
  cleanupTempRoots()
})

describe('the Node version floor', () => {
  it('an unsupported Node stops the bin before cli-main or node:sqlite loads', () => {
    expectFresh()
    expectRefused(runBin(['--version'], 'v22.0.0'), 'v22.0.0')
  })

  it('every subcommand is refused the same way, mcp included', () => {
    expectFresh()
    expectRefused(runBin(['mcp', '--help'], 'v22.0.0'), 'v22.0.0')
  })

  it('the floor compares the integer major: 23.99.99 and 9.11.2 are refused, 24.0.0 and 100.0.0 pass', () => {
    expectFresh()
    for (const version of ['v23.99.99', 'v9.11.2']) {
      expectRefused(runBin(['--version'], version), version)
    }
    for (const version of ['v24.0.0', 'v100.0.0']) {
      expectLoaded(runBin(['--version'], version))
    }
  })

  it('a supported Node loads the CLI', () => {
    expectFresh()
    const run = runBin(['--version'])
    expectLoaded(run)
    expect(
      run.trace.some((line) => line.includes('node:sqlite')),
      `the tracer never saw node:sqlite on a supported Node\n${seen(run)}`,
    ).toBe(true)
  })
})
