import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { expect } from 'vitest'

import { removeTempRoots } from '../temp-roots.js'
import type { FixtureVariant } from './fixtures.js'

const PACKAGE_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const VITEST = join(PACKAGE_ROOT, 'node_modules', 'vitest', 'vitest.mjs')
const CHILD_FIXTURE = fileURLToPath(new URL('./dual-host.test.ts', import.meta.url))

export const LEG_TIMEOUT_MS = 180_000
export const CHILD_TIMEOUT_MS = 150_000
export const MARKER_TIMEOUT_MS = 90_000

export const DUAL_HOST_ENV = {
  child: 'AGENT_QA_DUAL_HOST_CHILD',
  host: 'AGENT_QA_DUAL_HOST_HOST',
  root: 'AGENT_QA_DUAL_HOST_ROOT',
  fixture: 'AGENT_QA_DUAL_HOST_FIXTURE',
  report: 'AGENT_QA_DUAL_HOST_REPORT',
  marker: 'AGENT_QA_DUAL_HOST_MARKER',
  variant: 'AGENT_QA_DUAL_HOST_VARIANT',
} as const

export interface DualHostPaths {
  readonly root: string
  readonly agentQaRoot: string
  readonly knowledgeRoot: string
  readonly report: string
  readonly marker: string
}

export interface LegReport {
  readonly failed: false
  readonly pid: number
  readonly host: 'one-shot' | 'daemon'
  readonly variant: FixtureVariant
  readonly candidateIds: readonly string[]
  readonly bundleTree: string
  readonly logicalDump: string
  readonly epoch: number
  readonly bundleCount: number
  readonly authorOrder: readonly string[]
  readonly commitOrder: readonly string[]
  readonly dispositions: readonly {
    candidateId: string
    status: string
    relationTypes: readonly string[]
  }[]
  readonly embedStatuses: readonly string[]
  readonly runReceipt: Record<string, unknown>
  readonly sessionReceipts: readonly Record<string, unknown>[]
  readonly daemonEvents: readonly Record<string, unknown>[]
}

const temporaryRoots: string[] = []

export function makeRoot(label: string): DualHostPaths {
  const root = mkdtempSync(join(tmpdir(), `agent-dual-host-${label}-`))
  temporaryRoots.push(root)
  return {
    root,
    agentQaRoot: join(root, '.agent-qa'),
    knowledgeRoot: join(root, 'agent-qa-knowledge'),
    report: join(root, 'leg.report.json'),
    marker: join(root, 'leg.complete.marker'),
  }
}

export function cleanupDualHostRoots(): void {
  removeTempRoots(temporaryRoots.splice(0))
}

interface RunningChild {
  readonly child: ChildProcess
  output(): string
}

function startChild(
  host: 'one-shot' | 'daemon',
  paths: DualHostPaths,
  fixtureFile: string,
  variant: FixtureVariant,
): RunningChild {
  const child = spawn(
    process.execPath,
    [
      VITEST,
      'run',
      CHILD_FIXTURE,
      '--pool=threads',
      '--maxWorkers=1',
    ],
    {
      cwd: PACKAGE_ROOT,
      env: {
        ...process.env,
        [DUAL_HOST_ENV.child]: '1',
        [DUAL_HOST_ENV.host]: host,
        [DUAL_HOST_ENV.root]: paths.root,
        [DUAL_HOST_ENV.fixture]: fixtureFile,
        [DUAL_HOST_ENV.report]: paths.report,
        [DUAL_HOST_ENV.marker]: paths.marker,
        [DUAL_HOST_ENV.variant]: variant,
        // A fresh, empty model cache makes both child hosts resolve cold-artifact.
        AGENT_QA_MODEL_CACHE_DIR: join(paths.root, 'empty-model-cache'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  if (child.stdout === null || child.stderr === null) {
    throw new Error('dual-host child pipes were not created')
  }
  let captured = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => { captured += chunk })
  child.stderr.on('data', (chunk: string) => { captured += chunk })
  return { child, output: () => captured }
}

function partialReport(reportPath: string): string {
  return existsSync(reportPath) ? readFileSync(reportPath, 'utf8') : 'not written'
}

async function waitForMarker(
  running: RunningChild,
  marker: string,
  reportPath: string,
): Promise<void> {
  const deadline = Date.now() + MARKER_TIMEOUT_MS
  while (!existsSync(marker)) {
    if (running.child.exitCode !== null || running.child.signalCode !== null) {
      throw new Error(
        `dual-host child exited before its marker (report: ${partialReport(reportPath)}):\n${running.output()}`,
      )
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `timed out waiting for dual-host marker (report: ${partialReport(reportPath)}):\n${running.output()}`,
      )
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

async function stopIfRunning(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, 'exit')
  child.kill('SIGKILL')
  await exited
}

export async function runLeg(
  host: 'one-shot' | 'daemon',
  paths: DualHostPaths,
  fixtureFile: string,
  variant: FixtureVariant,
): Promise<LegReport> {
  const running = startChild(host, paths, fixtureFile, variant)
  const timeout = setTimeout(() => running.child.kill('SIGKILL'), CHILD_TIMEOUT_MS)
  // Subscribe before observing the marker so a fast child cannot exit between the two waits.
  const exited = once(running.child, 'exit') as Promise<[number | null, string | null]>
  try {
    await waitForMarker(running, paths.marker, paths.report)
    const [code, signal] = await exited
    expect(
      { code, signal, output: code === 0 ? '' : running.output() },
      `${host} child must exit cleanly`,
    ).toMatchObject({ code: 0, signal: null })
    const report = JSON.parse(readFileSync(paths.report, 'utf8')) as LegReport
    expect(report.failed).toBe(false)
    expect(report.pid).not.toBe(process.pid)
    expect(report.host).toBe(host)
    return report
  } finally {
    clearTimeout(timeout)
    await stopIfRunning(running.child)
  }
}
