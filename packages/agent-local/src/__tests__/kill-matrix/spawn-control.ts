// The parent side, shared so a spawn protocol cannot drift between the two kill-matrix files.

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { expect } from 'vitest'

import { KILL_MATRIX_ENV } from './harness.js'

const CHILD_FIXTURE = fileURLToPath(new URL('./fixtures/job-worker-child.test.ts', import.meta.url))
const PACKAGE_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const VITEST = join(PACKAGE_ROOT, 'node_modules', 'vitest', 'vitest.mjs')

/** Generous on purpose: these legs spawn real processes and fsync real files under CI contention. */
export const LEG_TIMEOUT_MS = 180_000
export const CHILD_TIMEOUT_MS = 120_000
export const MARKER_TIMEOUT_MS = 90_000

export interface KillMatrixPaths {
  readonly root: string
  readonly agentQaRoot: string
  readonly invocations: string
  readonly consumption: string
  readonly marker: string
  readonly report: string
}

const temporaryRoots: string[] = []

export function makeRoot(label: string): KillMatrixPaths {
  const root = mkdtempSync(join(tmpdir(), `agent-kill-${label}-`))
  temporaryRoots.push(root)
  return {
    root,
    agentQaRoot: join(root, '.agent-qa'),
    // Deliberately OUTSIDE the runtime root: an artifact under it would be walked by the
    // checkpoint digest and would make the instrument part of what it measures.
    invocations: join(root, 'invocations.count'),
    consumption: join(root, 'consumption.log'),
    marker: join(root, 'crash.marker'),
    report: join(root, 'child.report.json'),
  }
}

/** Registered by each suite through `afterAll`. Idempotent, so two suites cannot fight over it. */
export function cleanupKillMatrixRoots(): void {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
}

export interface RunningChild {
  readonly child: ChildProcess
  output(): string
}

export function startChild(env: Record<string, string>): RunningChild {
  const child = spawn(
    process.execPath,
    [VITEST, 'run', CHILD_FIXTURE, '--pool=threads', '--maxWorkers=1'],
    {
      cwd: PACKAGE_ROOT,
      env: { ...process.env, [KILL_MATRIX_ENV.child]: '1', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  if (child.stdout === null || child.stderr === null) {
    throw new Error('kill-matrix child pipes were not created')
  }
  let captured = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    captured += chunk
  })
  child.stderr.on('data', (chunk: string) => {
    captured += chunk
  })
  return { child, output: () => captured }
}

export async function killIfRunning(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, 'exit')
  child.kill('SIGKILL')
  await exited
}

async function awaitChildExit(
  running: RunningChild,
): Promise<{ code: number | null; signal: string | null }> {
  const timer = setTimeout(() => {
    running.child.kill('SIGKILL')
  }, CHILD_TIMEOUT_MS)
  try {
    const [code, signal] = (await once(running.child, 'exit')) as [number | null, string | null]
    return { code, signal }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Run a child to completion, asserting it exited cleanly.
 *
 * The captured output is attached to every failure: a parent that only reports "timed out" hides
 * the child's stack, and the child is where the interesting failure always is.
 */
export async function runChildToCompletion(
  env: Record<string, string>,
  reportPath: string,
): Promise<Record<string, unknown>> {
  const running = startChild(env)
  try {
    const { code, signal } = await awaitChildExit(running)
    expect(
      { code, signal, output: code === 0 ? '' : running.output() },
      'the child was expected to finish its role and exit 0',
    ).toMatchObject({ code: 0, signal: null })
    const report = JSON.parse(readFileSync(reportPath, 'utf8')) as Record<string, unknown>
    expect(report.failed, `child report: ${JSON.stringify(report)}`).toBe(false)
    expect(report.pid).not.toBe(process.pid)
    return report
  } finally {
    await killIfRunning(running.child)
  }
}

/**
 * Run a child that is EXPECTED to be refused, and return its failure report.
 *
 * Separate from the success path rather than a flag on it, because "the child failed" is only ever
 * evidence when the leg said in advance that it would: a helper that tolerated either outcome would
 * turn every accidental child crash into a passing fencing leg.
 */
export async function runChildExpectingRefusal(
  env: Record<string, string>,
  reportPath: string,
): Promise<Record<string, unknown>> {
  const running = startChild(env)
  try {
    const { code, signal } = await awaitChildExit(running)
    expect(
      { exitedNonZero: code !== 0, signal },
      `the child was expected to be refused and exit non-zero:\n${running.output()}`,
    ).toEqual({ exitedNonZero: true, signal: null })
    const report = JSON.parse(readFileSync(reportPath, 'utf8')) as Record<string, unknown>
    expect(report.failed, `child report: ${JSON.stringify(report)}`).toBe(true)
    expect(report.pid).not.toBe(process.pid)
    return report
  } finally {
    await killIfRunning(running.child)
  }
}

export async function waitForCrashMarker(
  running: RunningChild,
  markerPath: string,
  selector: string,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + MARKER_TIMEOUT_MS
  while (!existsSync(markerPath)) {
    if (running.child.exitCode !== null || running.child.signalCode !== null) {
      throw new Error(`kill-matrix child exited before reaching ${selector}:\n${running.output()}`)
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${selector}:\n${running.output()}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return JSON.parse(readFileSync(markerPath, 'utf8')) as Record<string, unknown>
}

/**
 * The kill, proven rather than assumed.
 *
 * `signalCode`/`exitCode` are checked to be null BEFORE the signal — a child that had already
 * finished would otherwise be "killed" by a call that did nothing — and the exit is required to be
 * a signal death rather than any non-zero status.
 */
export async function sendRealSigkill(child: ChildProcess): Promise<void> {
  expect(child.exitCode, 'the child must still be running when the signal is sent').toBeNull()
  expect(child.signalCode).toBeNull()
  const exited = once(child, 'exit')
  expect(child.kill('SIGKILL')).toBe(true)
  const [code, signal] = (await exited) as [number | null, string | null]
  expect({ code, signal }).toEqual({ code: null, signal: 'SIGKILL' })
}
