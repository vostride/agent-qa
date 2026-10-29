// A live run is gone only on proof, whatever environment stamped it.

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

import {
  classifyRunOwner,
  completeRunOwnership,
  ownedElsewhere,
} from '@vostride/agent-qa-dashboard'
import type { RunOwner } from '@vostride/agent-qa-dashboard'
import { afterAll, afterEach, describe, expect, it } from 'vitest'

import { composeRunOwnership } from '../../composition/run-owner-probe.js'
import { processIsAlive } from '../../daemon/registration.js'
import {
  readOwner,
  readRow,
  refuseWithoutPosixRunLifecycle,
  twoRunProject,
} from './cli-run-fixture.js'
import type { TwoRunProject } from './cli-run-fixture.js'
import { removeInProcessFixtures } from '../../composition/__tests__/in-process-run-fixture.js'

const CELL_BUDGET_MS = 120_000
const OWNER_LINE_BUDGET_MS = 60_000
const FAKE_PS_START = 'Thu Jan  1 00:00:00 1970'
const READING_ENVIRONMENT = { TZ: 'Asia/Kathmandu', LC_ALL: 'C', LANG: 'C' } as const

const resolveBuilt = createRequire(import.meta.url).resolve

const OWNER_SCRIPT = `import { createRequire } from 'node:module'

process.stdin.resume()
process.stdin.on('end', () => process.exit(0))
const require = createRequire(import.meta.url)
const { LOCAL_DAEMON_CAPABILITIES } = require(process.env.STAMPED_OWNER_AGENT_LOCAL)
const { DashboardDatabase } = require(process.env.STAMPED_OWNER_DASHBOARD)
const self = {
  pid: process.pid,
  incarnation: LOCAL_DAEMON_CAPABILITIES.resolveProcessIncarnation(process.pid) ?? null,
}
const db = new DashboardDatabase({
  dbPath: process.env.STAMPED_OWNER_DB,
  runOwnership: { self, probe: { isAlive: () => true, incarnationOf: () => undefined } },
})
let id
let owner
try {
  const startedAt = new Date().toISOString()
  id = db.insertRun({
    name: 'Run stamped by pid ' + String(process.pid),
    status: 'running',
    duration: 0,
    startedAt,
    endedAt: startedAt,
  })
  db.insertRunArtifact({ runId: id, kind: 'test' })
  owner = db.readRunOwner(id)
} finally {
  db.close()
}
process.stdout.write(JSON.stringify({ id, owner }) + '\\n')
`

interface StampedOwner {
  readonly label: string
  readonly child: ChildProcess
  readonly id: string
  readonly owner: RunOwner
}

interface Scene {
  readonly origin: string
  close(): Promise<void>
}

interface Cell {
  readonly root: string
  readonly project: TwoRunProject
  readonly children: Array<{ child: ChildProcess; closed: Promise<void> }>
  scene?: Scene
  restoreReading?: () => void
}

let cell: Cell | undefined

afterEach(async () => {
  const open = cell
  cell = undefined
  if (open === undefined) return
  open.restoreReading?.()
  for (const { child } of open.children) child.stdin?.end()
  await Promise.allSettled(open.children.map(({ closed }) => closed))
  try {
    await open.scene?.close()
  } finally {
    try {
      await open.project.close()
    } finally {
      rmSync(open.root, { recursive: true, force: true })
    }
  }
})
afterAll(() => { removeInProcessFixtures() })

async function openCell(): Promise<Cell> {
  refuseWithoutPosixRunLifecycle()
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cross-environment-owner-')))
  try {
    writeFileSync(join(root, 'stamped-owner.mjs'), OWNER_SCRIPT)
    cell = { root, project: await twoRunProject(), children: [] }
    return cell
  } catch (error) {
    rmSync(root, { recursive: true, force: true })
    throw error
  }
}

function fakePsDirectory(root: string): string {
  const directory = join(root, 'fake-ps')
  mkdirSync(directory)
  writeFileSync(join(directory, 'ps'), `#!/bin/sh\nprintf '${FAKE_PS_START}\\n'\n`, { mode: 0o755 })
  return directory
}

function readingEnvironment(): () => void {
  const saved = Object.keys(READING_ENVIRONMENT).map((key) => [key, process.env[key]] as const)
  Object.assign(process.env, READING_ENVIRONMENT)
  let restored = false
  return () => {
    if (restored) return
    restored = true
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

function pinReading(at: Cell): () => void {
  const restore = readingEnvironment()
  at.restoreReading = restore
  return restore
}

async function startStampedOwner(
  at: Cell,
  label: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<StampedOwner> {
  const child = spawn(process.execPath, [join(at.root, 'stamped-owner.mjs')], {
    cwd: at.root,
    env: {
      ...env,
      STAMPED_OWNER_AGENT_LOCAL: resolveBuilt('@vostride/agent-qa-agent-local'),
      STAMPED_OWNER_DASHBOARD: resolveBuilt('@vostride/agent-qa-dashboard'),
      STAMPED_OWNER_DB: at.project.dbPath,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const closed = new Promise<void>((settle) => {
    child.once('close', () => {
      settle()
    })
    child.once('error', () => {
      settle()
    })
  })
  at.children.push({ child, closed })
  let stdout = ''
  let stderr = ''
  child.stderr!.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8')
  })
  const line = await new Promise<string>((settle, fail) => {
    const budget = setTimeout(() => {
      fail(new Error(`the ${label} owner printed no line in time:\n${stderr}`))
    }, OWNER_LINE_BUDGET_MS)
    child.stdout!.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
      const end = stdout.indexOf('\n')
      if (end >= 0) {
        clearTimeout(budget)
        settle(stdout.slice(0, end))
      }
    })
    child.once('error', (error) => {
      clearTimeout(budget)
      fail(error)
    })
    child.once('close', (code, signal) => {
      clearTimeout(budget)
      fail(new Error(`the ${label} owner exited (${String(code ?? signal)}) first:\n${stderr}`))
    })
  })
  const { id, owner } = JSON.parse(line) as { id: string; owner: RunOwner }
  return { label, child, id, owner }
}

async function startBothOwners(at: Cell): Promise<StampedOwner[]> {
  const fakePs = fakePsDirectory(at.root)
  const zoneAndLocale = await startStampedOwner(at, 'TZ=UTC LC_ALL=fr_FR.UTF-8', {
    ...process.env,
    TZ: 'UTC',
    LC_ALL: 'fr_FR.UTF-8',
    LANG: 'fr_FR.UTF-8',
  })
  const shadowedPs = await startStampedOwner(at, `a ps printing ${FAKE_PS_START}`, {
    ...process.env,
    PATH: `${fakePs}${delimiter}${process.env.PATH ?? ''}`,
  })
  return [zoneAndLocale, shadowedPs]
}

function expectLiveStampedRunning(at: Cell, stamped: StampedOwner): void {
  expect(processIsAlive(stamped.owner.pid)).toBe(true)
  expect(stamped.owner.incarnation).toEqual(expect.any(String))
  expect(readRow(at.project, stamped.id).status).toBe('running')
  expect(readOwner(at.project, stamped.id)).toEqual(stamped.owner)
}

function snapshot(at: Cell, id: string): string {
  return JSON.stringify({
    row: readRow(at.project, id),
    owner: readOwner(at.project, id),
    artifact: at.project.db.getRunArtifact(id),
  })
}

// The scene's fixture loads playwright-core, so it is imported only when a cell needs the scene.
async function openSceneOver(at: Cell): Promise<Scene> {
  const { openDashboardScene } = await import('./run-doors-fixture.js')
  const scene = await openDashboardScene(
    {
      root: at.project.project,
      configPath: at.project.configPath,
      agentQaRoot: at.project.agentQaRoot,
      suitePath: at.project.suitePattern,
      testPath: at.project.testPattern,
      testId: at.project.directTestId,
    },
    { dbPath: at.project.dbPath },
  )
  at.scene = scene
  return scene
}

describe('run ownership across time zones and locales', () => {
  it(
    'the composed probe reads a live run stamped under another time zone, locale or ps as alive',
    async () => {
      const at = await openCell()
      const owners = await startBothOwners(at)
      for (const stamped of owners) expectLiveStampedRunning(at, stamped)
      const ownership = completeRunOwnership(composeRunOwnership())

      const restore = pinReading(at)
      try {
        const read = owners.map((stamped) => ({
          stampedUnder: stamped.label,
          stamp: stamped.owner.incarnation,
          readHere: ownership.probe.incarnationOf(stamped.owner.pid),
          state: classifyRunOwner(stamped.owner, ownership),
        }))
        expect(
          read.map(({ state }) => state),
          JSON.stringify(read),
        ).toEqual(['alive', 'alive'])
      } finally {
        restore()
      }
      for (const stamped of owners) expect(processIsAlive(stamped.owner.pid)).toBe(true)
    },
    CELL_BUDGET_MS,
  )

  it(
    'a dashboard started under another time zone and locale leaves a live run running and byte-equal',
    async () => {
      const at = await openCell()
      const owners = await startBothOwners(at)
      for (const stamped of owners) expectLiveStampedRunning(at, stamped)
      const before = owners.map((stamped) => snapshot(at, stamped.id))

      const restore = pinReading(at)
      try {
        await openSceneOver(at)
        const rows = owners.map((stamped) => readRow(at.project, stamped.id))
        expect(
          rows.map((row) => row.status),
          JSON.stringify(rows.map((row) => ({ status: row.status, summary: row.failureSummary }))),
        ).toEqual(['running', 'running'])
        expect(owners.map((stamped) => snapshot(at, stamped.id))).toEqual(before)
      } finally {
        restore()
      }
      for (const stamped of owners) expect(processIsAlive(stamped.owner.pid)).toBe(true)
    },
    CELL_BUDGET_MS,
  )

  it(
    'a cancel from another time zone and locale is refused with 409 and writes nothing',
    async () => {
      const at = await openCell()
      // Started before the owners, so its startup sweep has no running row to read.
      const scene = await openSceneOver(at)
      const owners = await startBothOwners(at)
      for (const stamped of owners) expectLiveStampedRunning(at, stamped)
      const before = owners.map((stamped) => snapshot(at, stamped.id))

      const restore = pinReading(at)
      try {
        const answers: Array<{ status: number; body: unknown }> = []
        for (const stamped of owners) {
          const response = await fetch(
            `${scene.origin}/api/runs/${encodeURIComponent(stamped.id)}/cancel`,
            { method: 'POST' },
          )
          answers.push({ status: response.status, body: await response.json() })
        }
        expect(answers).toEqual(
          owners.map((stamped) => ({
            status: 409,
            body: {
              error: ownedElsewhere(stamped.owner.pid),
              reason: 'owned-by-live-process',
              ownerPid: stamped.owner.pid,
            },
          })),
        )
        expect(owners.map((stamped) => snapshot(at, stamped.id))).toEqual(before)
      } finally {
        restore()
      }
      for (const stamped of owners) expect(processIsAlive(stamped.owner.pid)).toBe(true)
    },
    CELL_BUDGET_MS,
  )
})
