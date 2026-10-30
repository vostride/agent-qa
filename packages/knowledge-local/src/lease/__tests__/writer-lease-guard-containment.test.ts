import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { threadId } from 'node:worker_threads'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  LEASE_FILE,
  LEASE_GUARD_DIR,
  LEASE_GUARD_STALE_MS,
  acquireWriterLease,
  heartbeatLease,
  readWriterLease,
  releaseLease,
} from '../writer-lease.js'
import { RESOLVE_TS_SOURCE_HOOK } from './source-import-hook.js'

// Each symlink target is a temp directory this file creates, with sentinel files that must survive.
const SOURCE_URL = new URL('../writer-lease.ts', import.meta.url).href

type Attempt = { kind: string; [key: string]: unknown }

function attempt(run: () => unknown): Attempt {
  try {
    return run() as Attempt
  } catch (error) {
    return { kind: 'threw', name: (error as Error).name, message: (error as Error).message }
  }
}

function snapshot(dir: string): Record<string, string> {
  const files: Record<string, string> = {}
  for (const name of readdirSync(dir).sort()) {
    files[name] = readFileSync(join(dir, name), 'utf8')
  }
  return files
}

function deadPid(): number {
  const exited = spawnSync(process.execPath, ['-e', ''])
  if (exited.pid === undefined) throw new Error('expected a spawned pid')
  return exited.pid
}

describe('the lease guard never reaches through a link or out of the knowledge root', () => {
  let root: string
  let knowledgeRoot: string
  let outside: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'knowledge-lease-guard-containment-'))
    knowledgeRoot = join(root, 'agent-qa-knowledge')
    outside = join(root, 'outside')
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, 'id_ed25519'), 'sentinel private key\n', 'utf8')
    writeFileSync(join(outside, 'config'), 'sentinel config\n', 'utf8')
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function guardDir(): string {
    return join(knowledgeRoot, LEASE_GUARD_DIR)
  }

  function acquire(): string {
    const acquired = acquireWriterLease(knowledgeRoot)
    if (acquired.kind !== 'acquired') throw new Error('expected an acquired writer lease')
    return acquired.leaseId
  }

  const release = (leaseId: string, at: string): unknown => releaseLease({ knowledgeRoot: at, leaseId })
  const beat = (leaseId: string, at: string): unknown => heartbeatLease({ knowledgeRoot: at, leaseId })

  it.each([
    ['a release', 'plain files (the bulk stray cleanup)', release, { kind: 'released' }, false],
    ['a beat', 'plain files (the bulk stray cleanup)', beat, { kind: 'heartbeated' }, false],
    ['a release', 'a file named like an owner (the reclaim)', release, { kind: 'released' }, true],
    ['a beat', 'a file named like an owner (the reclaim)', beat, { kind: 'heartbeated' }, true],
  ])('(a) %s over a guard path symlinked to a directory of %s removes the link, never a target file', (_op, _target, run, expected, ownerNamed) => {
    if (ownerNamed) {
      writeFileSync(join(outside, `owner-${randomUUID()}`), 'sentinel named like an owner\n', 'utf8')
    }
    const leaseId = acquire()
    const before = snapshot(outside)
    mkdirSync(dirname(guardDir()), { recursive: true })
    symlinkSync(outside, guardDir(), 'dir')

    const outcome = attempt(() => run(leaseId, knowledgeRoot))

    expect(snapshot(outside)).toEqual(before)
    expect(outcome).toMatchObject(expected)
    expect(existsSync(guardDir())).toBe(false)
  })

  it('(b) a beat over a guard path that is a symlink to a file removes the link, never the file', () => {
    const leaseId = acquire()
    const target = join(outside, 'id_ed25519')
    mkdirSync(dirname(guardDir()), { recursive: true })
    symlinkSync(target, guardDir(), 'file')

    const outcome = attempt(() => heartbeatLease({ knowledgeRoot, leaseId }))

    expect(readFileSync(target, 'utf8')).toBe('sentinel private key\n')
    expect(outcome).toMatchObject({ kind: 'heartbeated' })
    expect(existsSync(guardDir())).toBe(false)
  })

  it.each([
    ['memory/queue', () => join('memory', 'queue')],
    ['memory', () => 'memory'],
  ])('(c) refuses by name, before any guard work, when %s is a symlink out of the knowledge root', (_label, linkAt) => {
    const leaseId = acquire()
    const link = join(knowledgeRoot, linkAt())
    mkdirSync(dirname(link), { recursive: true })
    symlinkSync(outside, link, 'dir')
    const before = snapshot(outside)
    const leaseBefore = readFileSync(join(knowledgeRoot, LEASE_FILE))

    const released = attempt(() => releaseLease({ knowledgeRoot, leaseId }))
    const beat = attempt(() => heartbeatLease({ knowledgeRoot, leaseId }))

    expect({ released, beat }).toMatchObject({
      released: { kind: 'threw', name: 'KnowledgeRootContainmentError' },
      beat: { kind: 'threw', name: 'KnowledgeRootContainmentError' },
    })
    expect(String(released.message)).toContain(link)
    // Nothing was created, claimed or removed outside the root, and the lease is untouched.
    expect(snapshot(outside)).toEqual(before)
    expect(readFileSync(join(knowledgeRoot, LEASE_FILE))).toEqual(leaseBefore)
  })

  it('(c) keeps working through a symlink that stays inside the knowledge root', () => {
    const leaseId = acquire()
    mkdirSync(join(knowledgeRoot, 'real-memory'), { recursive: true })
    symlinkSync(join(knowledgeRoot, 'real-memory'), join(knowledgeRoot, 'memory'), 'dir')

    expect(heartbeatLease({ knowledgeRoot, leaseId })).toMatchObject({ kind: 'heartbeated' })
    expect(releaseLease({ knowledgeRoot, leaseId })).toEqual({ kind: 'released' })
    expect(lstatSync(join(knowledgeRoot, 'memory')).isSymbolicLink()).toBe(true)
  })

  it('(d) never unlinks the entries of an ownerless guard directory: it is moved aside whole', () => {
    const leaseId = acquire()
    mkdirSync(guardDir(), { recursive: true })
    writeFileSync(join(guardDir(), 'notes.md'), 'somebody else\'s bytes\n', 'utf8')

    const outcome = attempt(() => releaseLease({ knowledgeRoot, leaseId }))

    expect(outcome).toEqual({ kind: 'released' })
    expect(existsSync(guardDir())).toBe(false)
    const parent = dirname(guardDir())
    const aside = readdirSync(parent).filter((name) => name.startsWith(`${basename(guardDir())}.`))
    expect(aside).toHaveLength(1)
    expect(aside[0]).toMatch(/^lease-guard\.residue-[0-9a-f-]{36}$/)
    expect(snapshot(join(parent, aside[0]!))).toEqual({ 'notes.md': 'somebody else\'s bytes\n' })
  })

  it('(d) never reads an owner entry that is not a regular file: a guard holding one is moved aside whole', () => {
    // A FIFO blocks any reader forever, so the child is bounded and a hang is a measured failure.
    const fifo = join(outside, 'pipe')
    const made = spawnSync('mkfifo', [fifo])
    if (made.status !== 0) throw new Error(`mkfifo failed: ${String(made.stderr)}`)
    const leaseId = acquire()
    mkdirSync(guardDir(), { recursive: true })
    const ownerName = `owner-${randomUUID()}`
    symlinkSync(fifo, join(guardDir(), ownerName), 'file')

    const child = spawnSync(process.execPath, ['--input-type=module', '-e', [
      RESOLVE_TS_SOURCE_HOOK,
      'const lease = await import(process.env.LEASE_SOURCE_URL)',
      'const outcome = lease.releaseLease({ knowledgeRoot: process.env.LEASE_ROOT, leaseId: process.env.LEASE_ID })',
      'process.stdout.write(JSON.stringify(outcome))',
    ].join('\n')], {
      env: { ...process.env, LEASE_SOURCE_URL: SOURCE_URL, LEASE_ROOT: knowledgeRoot, LEASE_ID: leaseId },
      encoding: 'utf8',
      timeout: 8_000,
    })

    expect({ signal: child.signal, stdout: child.stdout }).toEqual({
      signal: null,
      stdout: JSON.stringify({ kind: 'released' }),
    })
    expect(lstatSync(fifo).isFIFO()).toBe(true)
    const parent = dirname(guardDir())
    const aside = readdirSync(parent).filter((name) => name.startsWith('lease-guard.residue-'))
    expect(aside).toHaveLength(1)
    expect(lstatSync(join(parent, aside[0]!, ownerName)).isSymbolicLink()).toBe(true)
  }, 20_000)
})

describe('a residue left by a thread of this very process is reclaimed in a waiter\'s budget', () => {
  let root: string
  let knowledgeRoot: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'knowledge-lease-guard-residue-'))
    knowledgeRoot = join(root, 'agent-qa-knowledge')
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function plantOwner(dir: string, owner: { pid: number; threadId: number; claimedAtNs: bigint }): string {
    const token = randomUUID()
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `owner-${token}`), `${JSON.stringify({
      pid: owner.pid,
      threadId: owner.threadId,
      token,
      claimedAtNs: String(owner.claimedAtNs),
    })}\n`, 'utf8')
    return `owner-${token}`
  }

  it('(e) a release after a beat worker was terminated inside its section reclaims the guard and releases', () => {
    const acquired = acquireWriterLease(knowledgeRoot)
    if (acquired.kind !== 'acquired') throw new Error('expected an acquired writer lease')
    // What `worker.terminate()` leaves when the beat is inside its section: this live process's
    // pid, another thread's id, claimed just now.
    plantOwner(join(knowledgeRoot, LEASE_GUARD_DIR), {
      pid: process.pid,
      threadId: threadId + 1_000,
      claimedAtNs: process.hrtime.bigint(),
    })

    const startedAtNs = process.hrtime.bigint()
    const released = attempt(() => releaseLease({ knowledgeRoot, leaseId: acquired.leaseId }))
    const waitedMs = Number(process.hrtime.bigint() - startedAtNs) / 1e6

    expect(released).toEqual({ kind: 'released' })
    expect(readWriterLease(knowledgeRoot)).toEqual({ kind: 'absent' })
    // It waited for the residue bound, not less: a live section is never cut short.
    expect(waitedMs).toBeGreaterThanOrEqual(LEASE_GUARD_STALE_MS - 50)
    expect(existsSync(join(knowledgeRoot, LEASE_GUARD_DIR))).toBe(false)
  }, 40_000)

  it('(e) a beat meets the same residue, reclaims it and beats', () => {
    const acquired = acquireWriterLease(knowledgeRoot)
    if (acquired.kind !== 'acquired') throw new Error('expected an acquired writer lease')
    plantOwner(join(knowledgeRoot, LEASE_GUARD_DIR), {
      pid: process.pid,
      threadId: threadId + 1_000,
      // Three seconds inside the stale bound.
      claimedAtNs: process.hrtime.bigint() - BigInt(LEASE_GUARD_STALE_MS - 3_000) * 1_000_000n,
    })

    expect(attempt(() => heartbeatLease({ knowledgeRoot, leaseId: acquired.leaseId })))
      .toMatchObject({ kind: 'heartbeated' })
  }, 40_000)

  it('sweeps a staging directory a dead holder leaked, and leaves a live one alone', () => {
    const acquired = acquireWriterLease(knowledgeRoot)
    if (acquired.kind !== 'acquired') throw new Error('expected an acquired writer lease')
    const parent = dirname(join(knowledgeRoot, LEASE_GUARD_DIR))
    const leaked = join(parent, `lease-guard.tmp-${randomUUID()}`)
    plantOwner(leaked, { pid: deadPid(), threadId: 0, claimedAtNs: process.hrtime.bigint() })
    const live = join(parent, `lease-guard.tmp-${randomUUID()}`)
    const liveOwner = plantOwner(live, {
      pid: process.pid,
      threadId: threadId + 1_000,
      claimedAtNs: process.hrtime.bigint(),
    })
    const foreign = join(parent, `lease-guard.tmp-${randomUUID()}`)
    mkdirSync(foreign)
    writeFileSync(join(foreign, 'notes.md'), 'not a staged guard\n', 'utf8')

    expect(heartbeatLease({ knowledgeRoot, leaseId: acquired.leaseId })).toMatchObject({
      kind: 'heartbeated',
    })

    expect(existsSync(leaked)).toBe(false)
    expect(readdirSync(live)).toEqual([liveOwner])
    expect(snapshot(foreign)).toEqual({ 'notes.md': 'not a staged guard\n' })
    expect(realpathSync(parent)).toBe(realpathSync(dirname(leaked)))
  })
})
