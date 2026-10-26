import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { acquireMarkLock } from '../store/mark-lock.js'

const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const fixture = () => { const root = mkdtempSync(join(tmpdir(), 'mark-lock-')); roots.push(root); return root }

it.each(['EPERM', 'UNKNOWN'])('keeps an uncertain %s owner busy', async code => {
  const root = fixture(), lock = join(root, 'marks.jsonl.lock')
  mkdirSync(lock)
  const bytes = JSON.stringify({ schemaVersion: 2, kind: 'mark-ledger-lock', pid: process.pid,
    token: '11111111-1111-4111-8111-111111111111', runId: 'run' })
  writeFileSync(join(lock, 'owner.json'), bytes)
  vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('uncertain'), { code }) })
  vi.useFakeTimers()
  const rejected = expect(acquireMarkLock(lock, 'run', () => new Error('busy'))).rejects.toThrow('busy')
  await vi.advanceTimersByTimeAsync(10_000); await rejected
  expect(readFileSync(join(lock, 'owner.json'), 'utf8')).toBe(bytes)
  expect(readdirSync(root)).toEqual(['marks.jsonl.lock'])
})

it('does not release a different published generation', async () => {
  const root = fixture(), lock = join(root, 'marks.jsonl.lock')
  const release = await acquireMarkLock(lock, 'run', () => new Error('busy'))
  renameSync(lock, join(root, 'original'))
  const releaseNew = await acquireMarkLock(lock, 'run', () => new Error('busy'))
  const bytes = readFileSync(join(lock, 'owner.json'), 'utf8')
  release()
  expect(readFileSync(join(lock, 'owner.json'), 'utf8')).toBe(bytes)
  releaseNew()
  expect(existsSync(lock)).toBe(false)
})

it.each(['legacy-file', 'empty-directory', 'malformed-owner', 'foreign-owner'])('keeps %s busy without removing it', async mode => {
  const root = fixture(), lock = join(root, 'marks.jsonl.lock')
  if (mode === 'legacy-file') writeFileSync(lock, '')
  else {
    mkdirSync(lock)
    if (mode !== 'empty-directory') writeFileSync(join(lock, 'owner.json'), mode === 'malformed-owner' ? '{}'
      : JSON.stringify({ schemaVersion: 2, kind: 'mark-ledger-lock', pid: process.pid,
        token: '11111111-1111-4111-8111-111111111111', runId: 'foreign' }))
  }
  vi.useFakeTimers()
  const rejected = expect(acquireMarkLock(lock, 'run', () => new Error('busy'))).rejects.toThrow('busy')
  await vi.advanceTimersByTimeAsync(10_000); await rejected
  expect(existsSync(lock)).toBe(true)
  expect(readdirSync(root)).toEqual(['marks.jsonl.lock'])
})

it('retains dead-G so a delayed competing reclaimer cannot remove newer live H', async () => {
  const root = fixture(), lock = join(root, 'marks.jsonl.lock')
  const children: ChildProcess[] = [], closed: Promise<void>[] = []
  let output = ''
  const launch = (name: string, extra: Record<string, string> = {}) => {
    const entered = join(root, name + '.entered')
    const child = spawn(process.execPath, ['--experimental-transform-types',
      fileURLToPath(new URL('./fixtures/mark-lock-child.mjs', import.meta.url)),
      JSON.stringify({ lock, runId: 'run', entered, ...extra })], { stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout!.on('data', bytes => { output += String(bytes) })
    child.stderr!.on('data', bytes => { output += String(bytes) })
    children.push(child); closed.push(new Promise(resolve => child.on('close', () => resolve())))
    return { child, entered, closed: closed.at(-1)! }
  }
  const until = async (path: string) => {
    const end = Date.now() + 10_000
    while (!existsSync(path) && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 10))
    expect(existsSync(path), output).toBe(true)
  }
  try {
    const dead = launch('dead', { release: join(root, 'never') })
    await until(dead.entered)
    const generationG = JSON.parse(readFileSync(dead.entered, 'utf8'))
    dead.child.kill('SIGKILL'); await dead.closed
    const pauseRead = join(root, 'a.observed'), resumeRead = join(root, 'a.resume')
    const a = launch('a', { pauseRead, resumeRead })
    await until(pauseRead)
    const releaseB = join(root, 'b.release')
    const b = launch('b', { release: releaseB })
    await until(b.entered)
    const generationH = readFileSync(join(lock, 'owner.json'), 'utf8')
    expect(JSON.parse(generationH).token).not.toBe(generationG.token)
    writeFileSync(resumeRead, '')
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(existsSync(a.entered)).toBe(false)
    expect(readFileSync(join(lock, 'owner.json'), 'utf8')).toBe(generationH)
    const tombstone = `${lock}.dead-${generationG.token}`
    expect(readdirSync(tombstone)).toEqual(['owner.json'])
    expect(JSON.parse(readFileSync(join(tombstone, 'owner.json'), 'utf8'))).toEqual(generationG)
    writeFileSync(releaseB, ''); await b.closed; await a.closed
    expect(a.child.exitCode, output).toBe(0)
    expect(b.child.exitCode, output).toBe(0)
    expect(existsSync(a.entered)).toBe(true)
    expect(existsSync(lock)).toBe(false)
    expect(readdirSync(tombstone)).toEqual(['owner.json'])
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await Promise.all(closed)
  }
}, 25_000)

it('publishes a mark lock owner at 2 and keeps a dead owner stamped 1 busy until it reads 2', async () => {
  const lock = join(fixture(), 'marks.jsonl.lock')
  const release = await acquireMarkLock(lock, 'run', () => new Error('busy'))
  const ownerFile = join(lock, 'owner.json')
  const written = readFileSync(ownerFile, 'utf8')
  const owner = JSON.parse(written)
  expect(written).toBe(JSON.stringify(owner))
  expect(owner).toMatchObject({ schemaVersion: 2, kind: 'mark-ledger-lock', pid: process.pid, runId: 'run' })
  release()
  mkdirSync(lock)
  const planted = JSON.stringify({ ...owner, schemaVersion: 1 })
  writeFileSync(ownerFile, planted)
  vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }) })
  vi.useFakeTimers()
  const rejected = expect(acquireMarkLock(lock, 'run', () => new Error('busy'))).rejects.toThrow('busy')
  await vi.advanceTimersByTimeAsync(10_000); await rejected
  vi.useRealTimers()
  expect(readFileSync(ownerFile, 'utf8')).toBe(planted)
  writeFileSync(ownerFile, written)
  const reaped = await acquireMarkLock(lock, 'run', () => new Error('busy'))
  expect(JSON.parse(readFileSync(ownerFile, 'utf8')).token).not.toBe(owner.token)
  reaped()
})
