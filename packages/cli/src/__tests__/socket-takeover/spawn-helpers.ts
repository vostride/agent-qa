import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { removeTempRoots } from '../temp-roots.js'

const PACKAGE_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const JITI = join(PACKAGE_ROOT, 'node_modules', '.bin', 'jiti')
const DAEMON_FIXTURE = fileURLToPath(new URL('./daemon.fixture.ts', import.meta.url))

export const LEG_TIMEOUT_MS = 180_000
export const CHILD_TIMEOUT_MS = 120_000
export const MARKER_TIMEOUT_MS = 90_000

export const TAKEOVER_ENV = {
  role: 'AGENT_QA_TAKEOVER_ROLE',
  root: 'AGENT_QA_TAKEOVER_ROOT',
  generation: 'AGENT_QA_TAKEOVER_GENERATION',
  readyMarker: 'AGENT_QA_TAKEOVER_READY_MARKER',
  report: 'AGENT_QA_TAKEOVER_REPORT',
} as const

export type TakeoverGeneration = 'predecessor' | 'successor'

export interface TakeoverPaths {
  readonly root: string
  readonly agentQaRoot: string
  readonly knowledgeRoot: string
  readonly readyMarker: Record<TakeoverGeneration, string>
  readonly report: Record<TakeoverGeneration, string>
}

export interface RunningChild {
  readonly child: ChildProcess
  readonly exited: Promise<[number | null, string | null]>
  output(): string
}

const temporaryRoots: string[] = []

export function makeRoot(label: string): TakeoverPaths {
  const root = mkdtempSync(join(tmpdir(), `agent-takeover-${label}-`))
  temporaryRoots.push(root)
  return {
    root,
    agentQaRoot: join(root, '.agent-qa'),
    knowledgeRoot: join(root, 'agent-qa-knowledge'),
    readyMarker: {
      predecessor: join(root, 'predecessor.ready.marker.json'),
      successor: join(root, 'successor.ready.marker.json'),
    },
    report: {
      predecessor: join(root, 'predecessor.report.json'),
      successor: join(root, 'successor.report.json'),
    },
  }
}

export function cleanupTakeoverRoots(): void {
  removeTempRoots(temporaryRoots.splice(0))
}

export function startDaemonChild(
  generation: TakeoverGeneration,
  paths: TakeoverPaths,
): RunningChild {
  const child = spawn(
    JITI,
    [DAEMON_FIXTURE],
    {
      cwd: PACKAGE_ROOT,
      env: {
        ...process.env,
        [TAKEOVER_ENV.role]: 'daemon',
        [TAKEOVER_ENV.root]: paths.root,
        [TAKEOVER_ENV.generation]: generation,
        [TAKEOVER_ENV.readyMarker]: paths.readyMarker[generation],
        [TAKEOVER_ENV.report]: paths.report[generation],
        AGENT_QA_MODEL_CACHE_DIR: join(paths.root, 'empty-model-cache'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  if (child.stdout === null || child.stderr === null) {
    throw new Error('takeover child pipes were not created')
  }
  let captured = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => { captured += chunk })
  child.stderr.on('data', (chunk: string) => { captured += chunk })
  return {
    child,
    exited: once(child, 'exit') as Promise<[number | null, string | null]>,
    output: () => captured,
  }
}

export async function killIfRunning(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  // A stopped child never reaps, so always resume before the fatal signal.
  child.kill('SIGCONT')
  const exited = once(child, 'exit')
  child.kill('SIGKILL')
  await exited
}

export async function awaitChildExit(running: RunningChild): Promise<{
  code: number | null
  signal: string | null
}> {
  const timer = setTimeout(() => running.child.kill('SIGKILL'), CHILD_TIMEOUT_MS)
  try {
    const [code, signal] = await running.exited
    return { code, signal }
  } finally {
    clearTimeout(timer)
  }
}

export async function waitForMarker(
  running: RunningChild,
  markerPath: string,
  selector: string,
): Promise<void> {
  const deadline = Date.now() + MARKER_TIMEOUT_MS
  while (!existsSync(markerPath)) {
    if (running.child.exitCode !== null || running.child.signalCode !== null) {
      throw new Error(`takeover child exited before ${selector}:\n${running.output()}`)
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${selector}:\n${running.output()}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

/**
 * Read the OS' own view of a pid's scheduling state.
 *
 * The stopped-ness of the predecessor is the premise of every assertion in this suite, so it is
 * observed from the kernel rather than inferred from the harness' own bookkeeping.
 */
export function processStateFromOs(pid: number): string {
  return execFileSync('ps', ['-p', String(pid), '-o', 'state='], { encoding: 'utf8' }).trim()
}
