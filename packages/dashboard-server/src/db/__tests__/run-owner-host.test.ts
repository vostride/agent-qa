import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, readlinkSync, rmSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  classifyRunOwner,
  createRunOwnerHostResolver,
  DashboardDatabase,
  defaultRunOwnership,
  orphanSummary,
  resolveRunOwnerHost,
  type RunOwnerProbe,
} from '../index.js'

const UUID = 'a1b2c3d4-e5f6-4789-abcd-0123456789ef'
const DIGEST = createHash('sha256').update(UUID.toUpperCase()).digest('hex')
const UUID_IDENTITY = /^macos-uuid-sha256:[0-9a-f]{64}$/

function namesInTurn(...names: string[]): () => string {
  let next = 0
  return () => names[Math.min(next++, names.length - 1)]
}

function countedUuidReader(...answers: Array<string | undefined>) {
  const reader = { calls: 0, read: () => answers[Math.min(reader.calls++, answers.length - 1)] }
  return reader
}

const inertProbe: RunOwnerProbe = { isAlive: () => true, incarnationOf: () => undefined }

function seedThenClassifyAfterRename(first: () => string, second: () => string) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-qa-442-host-'))
  const dbPath = join(dir, 'runs.db')
  const seeding = new DashboardDatabase({
    dbPath,
    runOwnership: {
      self: { pid: 4242, incarnation: 'proc-starttime:7', host: first() },
      probe: inertProbe,
    },
  })
  const dashboard = new DashboardDatabase({
    dbPath,
    runOwnership: {
      self: { pid: 1000, incarnation: 'proc-starttime:1', host: second() },
      probe: { isAlive: (pid) => pid !== 4242, incarnationOf: () => undefined },
    },
  })
  try {
    const id = seeding.insertRun({
      name: 'Stamped before the rename',
      status: 'running',
      duration: 0,
      startedAt: '2026-10-16T00:00:00.000Z',
      endedAt: '2026-10-16T00:00:00.000Z',
    })
    const owner = dashboard.readRunOwner(id)
    if (owner === undefined) throw new Error('the running row carries no owner')
    const verdict = classifyRunOwner(owner, dashboard.runOwnership)
    const finalized = verdict === 'gone' && dashboard.finalizeOrphanRun(id, owner)
    return { verdict, finalized, run: dashboard.getRun(id) }
  } finally {
    seeding.close()
    dashboard.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('host identity', () => {
  it('a macOS host is its hardware UUID digest, unchanged when the host name changes', () => {
    const reader = countedUuidReader(UUID)
    const resolve = createRunOwnerHostResolver({
      platform: 'darwin',
      hostname: namesInTurn('name-1', 'name-2'),
      readPlatformUuid: reader.read,
    })
    const first = resolve()
    const second = resolve()
    expect(first).toMatch(UUID_IDENTITY)
    expect(first).toBe(`macos-uuid-sha256:${DIGEST}`)
    expect(second).toBe(first)
    for (const leaked of [UUID, UUID.toUpperCase(), 'name-1', 'name-2']) {
      expect(first).not.toContain(leaked)
    }
    expect(reader.calls).toBe(1)
  })

  it('a macOS read failure names the host name under its own prefix, never equals a UUID identity, and is retried', () => {
    const reader = countedUuidReader(undefined, UUID)
    const resolve = createRunOwnerHostResolver({
      platform: 'darwin',
      hostname: () => 'name-1',
      readPlatformUuid: reader.read,
    })
    const fallback = resolve()
    const identity = resolve()
    expect(fallback).toBe('hostname:name-1')
    expect(identity).toBe(`macos-uuid-sha256:${DIGEST}`)
    expect(identity).not.toBe(fallback)
    expect(reader.calls).toBe(2)

    const dead = { isAlive: () => false, incarnationOf: () => undefined }
    const verdict = classifyRunOwner(
      { pid: 4242, incarnation: 'proc-starttime:7', host: fallback },
      { self: { pid: 1000, incarnation: 'proc-starttime:1', host: identity }, probe: dead },
    )
    expect(verdict).toBe('unknown')
  })

  it('Windows hosts keep os.hostname(), and Linux hosts name their pid namespace', () => {
    const windowsUuid = countedUuidReader(UUID)
    const windowsNamespace = countedNamespaceReader('pid:[4026532001]')
    const windows = createRunOwnerHostResolver({
      platform: 'win32',
      hostname: () => 'build-box.local',
      readPlatformUuid: windowsUuid.read,
      readPidNamespace: windowsNamespace.read,
    })
    expect(windows()).toBe('build-box.local')
    expect(windows()).toBe('build-box.local')
    expect(windowsUuid.calls).toBe(0)
    expect(windowsNamespace.calls).toBe(0)

    const linuxUuid = countedUuidReader(UUID)
    const linux = createRunOwnerHostResolver({
      platform: 'linux',
      hostname: () => 'build-box.local',
      readPlatformUuid: linuxUuid.read,
      readPidNamespace: () => 'pid:[4026532001]',
    })
    expect(linux()).toBe('linux-pidns:4026532001:build-box.local')
    expect(linuxUuid.calls).toBe(0)
  })

  it("this machine's identity is its UUID digest on macOS, its pid namespace and host name on Linux, and its host name elsewhere", () => {
    if (process.platform === 'darwin') {
      expect(resolveRunOwnerHost()).toMatch(UUID_IDENTITY)
    } else if (process.platform === 'linux') {
      const inode = (() => {
        try {
          return /^pid:\[(\d+)\]$/.exec(readlinkSync('/proc/self/ns/pid'))?.[1]
        } catch {
          return undefined
        }
      })()
      if (inode === undefined) expect(resolveRunOwnerHost()).toMatch(/^linux-pidns-unread:/)
      else expect(resolveRunOwnerHost()).toBe(`linux-pidns:${inode}:${hostname()}`)
    } else {
      expect(resolveRunOwnerHost()).toBe(hostname())
    }
  })

  it('a dead owner stamped before the host name changed is still finalized as an orphan', () => {
    const named = (platform: 'darwin' | 'win32', name: string) =>
      createRunOwnerHostResolver({ platform, hostname: () => name, readPlatformUuid: () => UUID })
    const renamed = seedThenClassifyAfterRename(
      named('darwin', 'name-1'),
      named('darwin', 'name-2'),
    )
    expect(renamed.verdict).toBe('gone')
    expect(renamed.finalized).toBe(true)
    expect(renamed.run?.status).toBe('failed')
    expect(renamed.run?.failureSummary).toBe(orphanSummary(4242))

    const byHostName = seedThenClassifyAfterRename(
      named('win32', 'name-1'),
      named('win32', 'name-2'),
    )
    expect(byHostName.verdict).toBe('unknown')
    expect(byHostName.run?.status).toBe('running')
  })

  it("a handle injected without a host stamps and classifies with this machine's identity", () => {
    const here = resolveRunOwnerHost()
    const db = new DashboardDatabase({
      dbPath: ':memory:',
      runOwnership: {
        self: { pid: process.pid, incarnation: 'proc-starttime:7' },
        probe: inertProbe,
      },
    })
    try {
      const id = db.insertRun({
        name: 'Stamped by a host-less injector',
        status: 'running',
        duration: 0,
        startedAt: '2026-10-16T00:00:00.000Z',
        endedAt: '2026-10-16T00:00:00.000Z',
      })
      const owner = db.readRunOwner(id)
      expect(owner?.host).toBe(here)
      expect(db.runOwnership.self.host).toBe(here)
      if (owner === undefined) throw new Error('the running row carries no owner')
      expect(classifyRunOwner(owner, db.runOwnership)).toBe('self')
      expect(defaultRunOwnership().self.host).toBe(here)
    } finally {
      db.close()
    }
  })
})

const HOST_NAMESPACE = 'pid:[4026531836]'
const CONTAINER_NAMESPACE = 'pid:[4026532001]'
const HOST_IDENTITY = 'linux-pidns:4026531836:build-box'
const CONTAINER_IDENTITY = 'linux-pidns:4026532001:build-box'
const THROWS = Symbol('throws')

function linuxResolver(
  name: string,
  readPidNamespace: () => string | undefined,
  readPlatformUuid?: () => string | undefined,
) {
  const options = {
    platform: 'linux' as const,
    hostname: () => name,
    readPidNamespace,
    readPlatformUuid,
  }
  return createRunOwnerHostResolver(options)
}

function countedNamespaceReader(...answers: Array<string | undefined | typeof THROWS>) {
  const reader = {
    calls: 0,
    read: (): string | undefined => {
      const answer = answers[Math.min(reader.calls++, answers.length - 1)]
      if (answer === THROWS) throw new Error('readlink /proc/self/ns/pid failed')
      return answer
    },
  }
  return reader
}

const namespaceProbe: RunOwnerProbe = {
  isAlive: (pid) => pid === 12,
  incarnationOf: (pid) => (pid === 12 ? 'proc-starttime:12' : undefined),
}

function namespaceOwnership() {
  const here = linuxResolver('build-box', () => HOST_NAMESPACE)()
  const container = linuxResolver('build-box', () => CONTAINER_NAMESPACE)()
  return {
    here,
    container,
    ownership: {
      self: { pid: 1000, incarnation: 'proc-starttime:900000', host: here },
      probe: namespaceProbe,
    },
  }
}

describe('pid namespace identity', () => {
  it('a Linux identity names this pid namespace and this host name, read once', () => {
    const reader = countedNamespaceReader(CONTAINER_NAMESPACE)
    const uuidReader = countedUuidReader(UUID)
    const resolve = linuxResolver('build-box', reader.read, uuidReader.read)
    expect(resolve()).toBe(CONTAINER_IDENTITY)
    expect(resolve()).toBe(CONTAINER_IDENTITY)
    expect(reader.calls).toBe(1)
    expect(uuidReader.calls).toBe(0)
  })

  it('two pid namespaces never share an identity, even under one host name', () => {
    const host = linuxResolver('build-box', () => HOST_NAMESPACE)()
    const container = linuxResolver('build-box', () => CONTAINER_NAMESPACE)()
    const boxA = linuxResolver('box-a', () => HOST_NAMESPACE)()
    const boxB = linuxResolver('box-b', () => HOST_NAMESPACE)()
    expect(container).not.toBe(host)
    expect(boxB).not.toBe(boxA)
    for (const identity of [host, container, boxA, boxB]) {
      expect(identity).not.toBe('build-box')
      expect(identity).not.toBe('hostname:build-box')
    }
  })

  it('two processes in one pid namespace on one machine share an identity', () => {
    for (const namespace of [CONTAINER_NAMESPACE, HOST_NAMESPACE]) {
      const first = linuxResolver('build-box', () => namespace)()
      const second = linuxResolver('build-box', () => namespace)()
      expect(second).toBe(first)
    }
  })

  it('an unreadable or malformed pid namespace falls back under its own prefix, never equals a namespace identity, and is retried', () => {
    const reader = countedNamespaceReader(
      undefined,
      THROWS,
      'net:[4026532001]',
      'pid:[]',
      'pid:[12a]',
      CONTAINER_NAMESPACE,
    )
    const resolve = linuxResolver('build-box', reader.read)
    const fallbacks = [resolve(), resolve(), resolve(), resolve(), resolve()]
    for (const fallback of fallbacks) {
      expect(fallback).toMatch(/^linux-pidns-unread:/)
      expect(fallback).toBe(fallbacks[0])
      expect(fallback).not.toBe(CONTAINER_IDENTITY)
      expect(fallback).not.toBe(HOST_IDENTITY)
    }
    expect(resolve()).toBe(CONTAINER_IDENTITY)
    expect(resolve()).toBe(CONTAINER_IDENTITY)
    expect(reader.calls).toBe(6)
  })

  it('two processes whose pid namespace cannot be read never share an identity', () => {
    const first = linuxResolver('build-box', () => undefined)
    const second = linuxResolver('build-box', () => undefined)
    const firstIdentity = first()
    const secondIdentity = second()
    expect(secondIdentity).not.toBe(firstIdentity)
    expect(first()).toBe(firstIdentity)
    expect(second()).toBe(secondIdentity)
    for (const identity of [firstIdentity, secondIdentity]) expect(identity).not.toBe('build-box')
  })

  it('a row stamped with the bare host name an earlier agent-qa wrote is another host to a Linux reader', () => {
    const { here } = namespaceOwnership()
    const verdict = classifyRunOwner(
      { pid: 4242, incarnation: 'proc-starttime:7', host: 'build-box' },
      {
        self: { pid: 1000, incarnation: 'proc-starttime:1', host: here },
        probe: { isAlive: () => false, incarnationOf: () => undefined },
      },
    )
    expect(verdict).toBe('unknown')
  })

  it("an owner in another pid namespace under this host name is unknown, whether its pid is dead here or another process's", () => {
    const { container, ownership } = namespaceOwnership()
    const owners = [
      { pid: 7, incarnation: 'proc-starttime:884211', host: container },
      { pid: 12, incarnation: 'proc-starttime:884300', host: container },
    ]
    expect(owners.map((owner) => classifyRunOwner(owner, ownership))).toEqual([
      'unknown',
      'unknown',
    ])
  })

  it('an owner in this pid namespace whose pid is dead is still gone', () => {
    const { here, ownership } = namespaceOwnership()
    const owners = [
      { pid: 7, incarnation: 'proc-starttime:884211', host: here },
      { pid: 12, incarnation: 'proc-starttime:884300', host: here },
    ]
    expect(owners.map((owner) => classifyRunOwner(owner, ownership))).toEqual(['gone', 'gone'])
  })
})
