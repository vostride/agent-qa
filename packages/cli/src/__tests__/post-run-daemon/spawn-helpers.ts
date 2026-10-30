// A leg checks the child reached its marker, lived to the signal, died by SIGKILL, and left no pid.

import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { expect } from 'vitest'

import { removeTempRoots } from '../temp-roots.js'

const PACKAGE_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const JITI = join(PACKAGE_ROOT, 'node_modules', '.bin', 'jiti')
const DAEMON_FIXTURE = fileURLToPath(new URL('./daemon.fixture.ts', import.meta.url))

/** Generous on purpose: these legs spawn real processes and wait out a real 30s lease TTL. */
export const LEG_TIMEOUT_MS = 300_000
export const MARKER_TIMEOUT_MS = 120_000

export const POST_RUN_DAEMON_ENV = {
  role: 'AGENT_QA_POST_RUN_DAEMON_ROLE',
  root: 'AGENT_QA_POST_RUN_DAEMON_ROOT',
  generation: 'AGENT_QA_POST_RUN_DAEMON_GENERATION',
  readyMarker: 'AGENT_QA_POST_RUN_DAEMON_READY',
  report: 'AGENT_QA_POST_RUN_DAEMON_REPORT',
  /**
   * The file the daemon-side `curate-memory` fold publishes the instant it is ENTERED.
   *
   * This is what makes the kill land between the two chain stages rather than somewhere a sleep
   * happened to put it: by the time these bytes exist, `analyze-run`'s `completeAndChain`
   * transaction has committed and `curate-memory` is claimed and inside its handler.
   */
  enteredMarker: 'AGENT_QA_POST_RUN_DAEMON_ENTERED',
  /** The fold returns only once this file exists. Absent ⇒ the fold parks until it is killed. */
  gate: 'AGENT_QA_POST_RUN_DAEMON_GATE',
} as const

export type DaemonGeneration = 'first' | 'restarted'

export interface PostRunDaemonPaths {
  readonly root: string
  readonly agentQaRoot: string
  readonly knowledgeRoot: string
  readonly gate: string
  readonly enteredMarker: Record<DaemonGeneration, string>
  readonly readyMarker: Record<DaemonGeneration, string>
  readonly report: Record<DaemonGeneration, string>
}

const temporaryRoots: string[] = []

export function makePostRunDaemonRoot(label: string): PostRunDaemonPaths {
  const root = mkdtempSync(join(tmpdir(), `agent-qa-${label}-`))
  temporaryRoots.push(root)
  const paths: PostRunDaemonPaths = {
    root,
    agentQaRoot: join(root, '.agent-qa'),
    knowledgeRoot: join(root, 'agent-qa-knowledge'),
    gate: join(root, 'curation.gate'),
    enteredMarker: {
      first: join(root, 'first.curation-entered.json'),
      restarted: join(root, 'restarted.curation-entered.json'),
    },
    readyMarker: {
      first: join(root, 'first.ready.json'),
      restarted: join(root, 'restarted.ready.json'),
    },
    report: {
      first: join(root, 'first.report.json'),
      restarted: join(root, 'restarted.report.json'),
    },
  }
  mkdirSync(paths.agentQaRoot, { recursive: true })
  mkdirSync(paths.knowledgeRoot, { recursive: true })
  return paths
}

export function cleanupPostRunDaemonRoots(): void {
  removeTempRoots(temporaryRoots.splice(0))
}

export interface RunningDaemon {
  readonly child: ChildProcess
  readonly generation: DaemonGeneration
  output(): string
}

const running: ChildProcess[] = []

export function startPostRunDaemon(
  generation: DaemonGeneration,
  paths: PostRunDaemonPaths,
): RunningDaemon {
  const child = spawn(JITI, [DAEMON_FIXTURE], {
    cwd: PACKAGE_ROOT,
    env: {
      ...process.env,
      [POST_RUN_DAEMON_ENV.role]: 'daemon',
      [POST_RUN_DAEMON_ENV.root]: paths.root,
      [POST_RUN_DAEMON_ENV.generation]: generation,
      [POST_RUN_DAEMON_ENV.readyMarker]: paths.readyMarker[generation],
      [POST_RUN_DAEMON_ENV.report]: paths.report[generation],
      [POST_RUN_DAEMON_ENV.enteredMarker]: paths.enteredMarker[generation],
      [POST_RUN_DAEMON_ENV.gate]: paths.gate,
      AGENT_QA_MODEL_CACHE_DIR: join(paths.root, 'empty-model-cache'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  running.push(child)
  if (child.stdout === null || child.stderr === null) {
    throw new Error('post-run daemon child pipes were not created')
  }
  let captured = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => { captured += chunk })
  child.stderr.on('data', (chunk: string) => { captured += chunk })
  return { child, generation, output: () => captured }
}

export async function killIfRunning(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, 'exit')
  child.kill('SIGKILL')
  await exited
}

/**
 * The other way a daemon can go: an operator stop.
 *
 * SIGTERM rather than SIGKILL, awaited to a real exit, because the closed-socket proof needs the
 * socket to be genuinely gone — a killed daemon leaves its address behind and would let a later
 * reader wonder whether anything could still have been asked.
 */
export async function stopDaemonGracefully(daemon: RunningDaemon): Promise<number | null> {
  expect(daemon.child.exitCode, 'the daemon must still be running to be stopped').toBeNull()
  const exited = once(daemon.child, 'exit')
  expect(daemon.child.kill('SIGTERM')).toBe(true)
  const [code] = (await exited) as [number | null, string | null]
  return code
}

export async function stopAllPostRunDaemons(): Promise<void> {
  for (const child of running.splice(0)) await killIfRunning(child)
}

export async function waitForMarker(
  daemon: RunningDaemon,
  markerPath: string,
  selector: string,
  timeoutMs = MARKER_TIMEOUT_MS,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs
  while (!existsSync(markerPath)) {
    if (daemon.child.exitCode !== null || daemon.child.signalCode !== null) {
      throw new Error(
        `the ${daemon.generation} daemon exited before ${selector}:\n${daemon.output()}`,
      )
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${selector}:\n${daemon.output()}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return JSON.parse(readFileSync(markerPath, 'utf8')) as Record<string, unknown>
}

/** Poll a predicate the parent can evaluate itself (durable rows, file bytes). */
export async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  message: string,
  timeoutMs = MARKER_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return
    if (Date.now() > deadline) throw new Error(message)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

/**
 * The kill, proven rather than assumed (the 385 `sendRealSigkill` contract, verbatim in intent).
 *
 * Liveness is asserted BEFORE the signal, and the exit is required to be a signal death rather
 * than any non-zero status — a daemon that shut down gracefully would otherwise satisfy a crash
 * proof by having politely released its lease and finished its chain.
 */
export async function sendRealSigkill(child: ChildProcess): Promise<void> {
  expect(child.exitCode, 'the daemon must still be running when the signal is sent').toBeNull()
  expect(child.signalCode).toBeNull()
  const exited = once(child, 'exit')
  expect(child.kill('SIGKILL')).toBe(true)
  const [code, signal] = (await exited) as [number | null, string | null]
  expect({ code, signal }).toEqual({ code: null, signal: 'SIGKILL' })
}

/** The kernel's own answer, so "the holder's process is gone" is never inferred from bookkeeping. */
export function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return true
    throw error
  }
}
