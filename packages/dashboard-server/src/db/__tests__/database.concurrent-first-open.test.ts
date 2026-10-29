import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DashboardDatabase } from '../database.js'
import { createDashboardSqliteDatabase } from '../sqlite.js'

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const DASHBOARD_DIST = join(PACKAGE_ROOT, 'dist', 'index.js')
const CORE_DIST = join(
  PACKAGE_ROOT,
  'node_modules',
  '@vostride',
  'agent-qa-core',
  'dist',
  'index.js',
)
const DASHBOARD_SRC = join(PACKAGE_ROOT, 'src')
const CORE_SRC = resolve(PACKAGE_ROOT, '../core/src')
const PROCESSES = 8
const TRIALS = 10

// 2026-10-17 (443-17, GAP-D4): the children run the built dists, so a stale one tests old code.
function newestProductSource(sourceRoot: string) {
  let newest: string | undefined
  let mtimeMs = -Infinity
  let count = 0
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!entry.isFile() || !entry.name.endsWith('.ts')) continue
      if (/\.test(?:-d)?\.ts$/.test(entry.name)) continue
      count += 1
      const stat = statSync(full)
      if (stat.mtimeMs > mtimeMs) {
        newest = full
        mtimeMs = stat.mtimeMs
      }
    }
  }
  if (existsSync(sourceRoot)) walk(sourceRoot)
  return { newest, mtimeMs, count }
}

function buildStaleness(artifact: string, sourceRoot: string) {
  if (!existsSync(artifact)) return `${artifact} is missing`
  const { newest, mtimeMs } = newestProductSource(sourceRoot)
  if (newest === undefined) return `${sourceRoot} holds no product source`
  if (mtimeMs > statSync(artifact).mtimeMs) return `${newest} is newer than ${artifact}`
  return undefined
}

// 2026-10-17 (443-review, WR-06): --force, because a turbo cache hit leaves an mtime-stale dist untouched.
function requireFreshBuild(artifact: string, sourceRoot: string) {
  const reason = buildStaleness(artifact, sourceRoot)
  if (reason !== undefined)
    throw new Error(`${reason}; run pnpm build --force in agent-qa before this file`)
}

const CHILD_SCRIPT = `
import { existsSync } from 'node:fs'
const [dashboardUrl, coreUrl, dbPath, startFile, ownerPid] = process.argv.slice(2)
const { DashboardDatabase } = await import(dashboardUrl)
const { generateRunId } = await import(coreUrl)
process.stdout.write('ready\\n')
while (!existsSync(startFile)) {}
try {
  const runOwnership = ownerPid === undefined
    ? undefined
    : {
        self: { pid: Number(ownerPid), incarnation: 'fresh-open-' + ownerPid, host: 'fresh-open-host' },
        probe: { isAlive: () => true, incarnationOf: () => undefined },
      }
  const db = new DashboardDatabase(runOwnership === undefined ? { dbPath } : { dbPath, runOwnership })
  const id = generateRunId()
  const at = new Date().toISOString()
  try {
    if (runOwnership === undefined) {
      db.insertRun({ id, name: 'fresh-open', status: 'passed', duration: 0, startedAt: at, endedAt: at })
    } else if (!db.claimRunningRow(id, { name: 'fresh-open claim', startedAt: at })) {
      throw new Error('claim refused')
    }
  } finally {
    db.close()
  }
  process.stdout.write('ok ' + id + '\\n')
} catch (error) {
  process.stdout.write('ERR ' + JSON.stringify({
    name: error?.name,
    code: error?.code,
    errcode: error?.errcode,
    message: error?.message,
  }) + '\\n')
}
`

interface ChildOutcome {
  readonly line: string
  readonly ok: boolean
  readonly id?: string
  readonly error?: { name?: string; code?: string; errcode?: number; message?: string }
}

let root: string
let childScript: string
let trialCounter = 0

function requirePosix(): void {
  if (process.platform === 'win32') throw new Error('POSIX run lifecycle required; never skip')
}

beforeAll(() => {
  requirePosix()
  requireFreshBuild(DASHBOARD_DIST, DASHBOARD_SRC)
  requireFreshBuild(CORE_DIST, CORE_SRC)
  root = mkdtempSync(join(tmpdir(), 'agent-qa-443-fresh-open-'))
  childScript = join(root, 'fresh-open-child.mjs')
  writeFileSync(childScript, CHILD_SCRIPT)
})

afterAll(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true })
})

function parseOutcome(stdout: string, stderr: string): ChildOutcome {
  const line =
    stdout
      .split('\n')
      .map((one) => one.trim())
      .filter((one) => one !== '' && one !== 'ready')
      .at(-1) ?? `no outcome; stderr: ${stderr.trim()}`
  if (line.startsWith('ok ')) return { line, ok: true, id: line.slice(3) }
  if (line.startsWith('ERR ')) return { line, ok: false, error: JSON.parse(line.slice(4)) }
  return { line, ok: false }
}

async function openTogether(
  dbPath: string,
  owners: ReadonlyArray<number | undefined>,
): Promise<ChildOutcome[]> {
  const startFile = join(root, `start-${trialCounter++}`)
  let ready = 0
  let release: () => void = () => {}
  const allReady = new Promise<void>((done) => {
    release = done
  })
  const outcomes = owners.map(
    (owner) =>
      new Promise<ChildOutcome>((settle) => {
        const args = [
          childScript,
          pathToFileURL(DASHBOARD_DIST).href,
          pathToFileURL(CORE_DIST).href,
          dbPath,
          startFile,
          ...(owner === undefined ? [] : [String(owner)]),
        ]
        const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
        let stdout = ''
        let stderr = ''
        let counted = false
        child.stdout.on('data', (chunk: Buffer) => {
          stdout += chunk.toString()
          if (!counted && stdout.includes('ready\n')) {
            counted = true
            ready += 1
            if (ready === owners.length) release()
          }
        })
        child.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString()
        })
        child.on('close', () => {
          if (!counted) {
            counted = true
            ready += 1
            if (ready === owners.length) release()
          }
          settle(parseOutcome(stdout, stderr))
        })
      }),
  )
  await allReady
  writeFileSync(startFile, '')
  return Promise.all(outcomes)
}

function readFile(dbPath: string): { version: number; ids: string[]; owners: Map<string, number> } {
  const raw = createDashboardSqliteDatabase(dbPath)
  try {
    const version = raw.pragma('user_version', { simple: true }) as number
    const rows = raw.prepare('SELECT id, owner_pid FROM runs').all() as Array<{
      id: string
      owner_pid: number | null
    }>
    return {
      version,
      ids: rows.map((row) => row.id).sort(),
      owners: new Map(rows.map((row) => [row.id, Number(row.owner_pid)])),
    }
  } finally {
    raw.close()
  }
}

function schemaOf(dbPath: string): string {
  const raw = createDashboardSqliteDatabase(dbPath)
  try {
    return JSON.stringify(
      raw.prepare('SELECT type, name, sql FROM sqlite_master ORDER BY type, name').all(),
    )
  } finally {
    raw.close()
  }
}

const sha256 = (path: string): string =>
  createHash('sha256').update(readFileSync(path)).digest('hex')

describe('concurrent first open of a fresh runs database', () => {
  it('eight processes opening one fresh runs.db at once all succeed', async () => {
    const tally = new Map<string, number>()
    let okOpens = 0
    for (let trial = 0; trial < TRIALS; trial += 1) {
      const dbPath = join(root, `trial-${trial}`, '.agent-qa', 'runs.db')
      const outcomes = await openTogether(
        dbPath,
        Array.from({ length: PROCESSES }, () => undefined),
      )
      for (const outcome of outcomes) {
        const key = outcome.ok
          ? 'ok'
          : `${outcome.error?.code ?? outcome.error?.name ?? 'no outcome'} ${outcome.error?.errcode ?? ''} ${outcome.error?.message ?? outcome.line}`
        tally.set(key, (tally.get(key) ?? 0) + 1)
      }
      okOpens += outcomes.filter((outcome) => outcome.ok).length
      const file = readFile(dbPath)
      expect(file.version, `trial ${trial} user_version`).toBe(2)
      const inserted = outcomes
        .flatMap((outcome) => (outcome.id === undefined ? [] : [outcome.id]))
        .sort()
      expect(file.ids, `trial ${trial} rows`).toEqual(inserted)
    }
    const summary = [...tally].map(([outcome, count]) => `${count} x ${outcome}`).join('; ')
    expect(okOpens, `ok opens of ${PROCESSES * TRIALS} (${summary})`).toBe(PROCESSES * TRIALS)
  }, 120_000)

  it('two processes claiming different ids on one file each keep their own row', async () => {
    const dbPath = join(root, 'two-owners', 'runs.db')
    const outcomes = await openTogether(dbPath, [7101, 7102])
    expect(outcomes.map((outcome) => outcome.line)).toEqual([
      expect.stringMatching(/^ok r_/),
      expect.stringMatching(/^ok r_/),
    ])
    const [first, second] = outcomes.map((outcome) => outcome.id!)
    expect(first).not.toBe(second)
    const file = readFile(dbPath)
    expect(file.version).toBe(2)
    expect(file.ids).toEqual([first, second].sort())
    expect(file.owners.get(first)).toBe(7101)
    expect(file.owners.get(second)).toBe(7102)
  }, 60_000)

  it('an older file is still refused before anything touches it', async () => {
    const dbPath = join(root, 'older', 'runs.db')
    mkdirSync(dirname(dbPath), { recursive: true })
    const raw = createDashboardSqliteDatabase(dbPath)
    try {
      raw.exec('CREATE TABLE runs (id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL)')
      raw.exec("INSERT INTO runs (id, name, status) VALUES ('r_old', 'old run', 'passed')")
      raw.exec('PRAGMA user_version = 1')
    } finally {
      raw.close()
    }
    const before = sha256(dbPath)

    const outcomes = await openTogether(
      dbPath,
      Array.from({ length: PROCESSES }, () => undefined),
    )
    expect(outcomes).toHaveLength(PROCESSES)
    for (const outcome of outcomes) {
      expect(outcome.ok, outcome.line).toBe(false)
      expect(outcome.error?.name, outcome.line).toBe('RunsDatabaseVersionRefusedError')
      expect(outcome.error?.message).toBe(
        `${dbPath} was written by an older agent-qa (runs database version 1). ` +
          'Delete it and run again; agent-qa creates a new one.',
      )
    }
    expect(sha256(dbPath)).toBe(before)
    expect(existsSync(`${dbPath}-wal`)).toBe(false)
  }, 60_000)

  it('one process opening the same fresh file twice keeps one schema', () => {
    const dbPath = join(root, 'twice', 'runs.db')
    const referencePath = join(root, 'twice-reference', 'runs.db')
    const reference = new DashboardDatabase({ dbPath: referencePath })
    reference.close()

    const first = new DashboardDatabase({ dbPath })
    const second = new DashboardDatabase({ dbPath })
    second.close()
    first.close()

    expect(readFile(dbPath).version).toBe(2)
    const schema = schemaOf(dbPath)
    expect(JSON.parse(schema).length).toBeGreaterThan(0)
    expect(schema).toBe(schemaOf(referencePath))
  })
})

describe('the builds these cells import are current', () => {
  it('a dist older than its source is refused with a rebuild instruction', () => {
    const pkg = join(root, 'fresh-build', 'pkg')
    const src = join(pkg, 'src')
    const product = join(src, 'a.ts')
    const testFile = join(src, '__tests__', 'b.test.ts')
    const dist = join(pkg, 'dist', 'index.js')
    mkdirSync(join(src, '__tests__'), { recursive: true })
    mkdirSync(dirname(dist), { recursive: true })
    writeFileSync(product, 'export const a = 1\n')
    writeFileSync(testFile, 'export {}\n')
    writeFileSync(dist, 'export const a = 1\n')
    const base = 1_700_000_000
    utimesSync(product, base, base)
    utimesSync(testFile, base, base)
    utimesSync(dist, base + 100, base + 100)

    expect(() => requireFreshBuild(dist, src)).not.toThrow()

    utimesSync(testFile, base + 200, base + 200)
    expect(() => requireFreshBuild(dist, src)).not.toThrow()

    utimesSync(product, base + 300, base + 300)
    expect(() => requireFreshBuild(dist, src)).toThrow(
      /a\.ts is newer than .*index\.js; run pnpm build --force in agent-qa before this file$/,
    )

    rmSync(dist)
    expect(() => requireFreshBuild(dist, src)).toThrow(
      /index\.js is missing; run pnpm build --force in agent-qa before this file$/,
    )

    const testsOnly = join(root, 'fresh-build', 'tests-only')
    const testsOnlyDist = join(testsOnly, 'dist', 'index.js')
    mkdirSync(join(testsOnly, 'src', '__tests__'), { recursive: true })
    mkdirSync(dirname(testsOnlyDist), { recursive: true })
    writeFileSync(join(testsOnly, 'src', '__tests__', 'b.test.ts'), 'export {}\n')
    writeFileSync(testsOnlyDist, 'export {}\n')
    expect(() => requireFreshBuild(testsOnlyDist, join(testsOnly, 'src'))).toThrow(
      /no product source; run pnpm build --force in agent-qa before this file$/,
    )
  })

  it('the dashboard and core builds these cells import are current', () => {
    expect(() => requireFreshBuild(DASHBOARD_DIST, DASHBOARD_SRC)).not.toThrow()
    expect(() => requireFreshBuild(CORE_DIST, CORE_SRC)).not.toThrow()
    expect(newestProductSource(DASHBOARD_SRC).count).toBeGreaterThan(20)
  })
})
