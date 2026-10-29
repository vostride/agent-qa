// The serving facade opens the index ONCE (407-13, REVIEW CR-02).
//
// 407-03 extracted the degrade ladder into `classifyIndexFace` so `doctor` and the runner's rung
// resolver could ASK about the index without mutating it. The extraction closed the probe's
// connection unconditionally and had `openKnowledgeReader` open a SECOND one — a TOCTOU window in
// which lock contention from a writer, a drain or a sibling reader turns a perfectly healthy index
// into a durable `locked` rebuild request plus a process-lifetime swap to bundle scan.
//
// These cells instrument `openIndexReaderConnection` itself, because the defect is not visible in
// any observable of a single open: it is the SECOND open existing at all. The instrumented opener
// makes "how many times did the serving path open?" a first-class assertion, and lets cell (2)
// hold the lock across a window that no wall-clock race could hit reliably.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync } from 'node:fs'

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { classifyIndexFace, openKnowledgeReader } from '../index-reader.js'
import { indexDbPath, openIndexReaderConnection } from '../index-open.js'
import type { IndexReaderConnection } from '../index-open.js'
import { rebuildIndex } from '../index-rebuild.js'
import { REBUILD_MARKER_FILE } from '../rebuild-marker.js'
import { scaffoldKnowledgeRoot } from './fixtures/bundle-fixture.js'

// The rest of `index-open.js` passes through so `rebuildIndex` still builds a REAL index and the
// degrade ladder still runs its real `probeIndexHealth`. Only the reader-connection opener is
// observable.
vi.mock('../index-open.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../index-open.js')>()
  return { ...actual, openIndexReaderConnection: vi.fn(actual.openIndexReaderConnection) }
})

const opener = vi.mocked(openIndexReaderConnection)

type Opener = (knowledgeRoot: string, opts?: Parameters<typeof openIndexReaderConnection>[1]) =>
  IndexReaderConnection

let realOpen: Opener

beforeAll(async () => {
  const actual = await vi.importActual<typeof import('../index-open.js')>('../index-open.js')
  realOpen = actual.openIndexReaderConnection
})

const roots: string[] = []

beforeEach(() => {
  opener.mockReset()
  opener.mockImplementation((knowledgeRoot, opts) => realOpen(knowledgeRoot, opts))
})

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop()
    if (root !== undefined) rmSync(root, { recursive: true, force: true })
  }
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'index-single-open-'))
  roots.push(root)
  return root
}

function scaffoldedRoot(): string {
  const knowledgeRoot = join(tempRoot(), 'agent-qa-knowledge')
  scaffoldKnowledgeRoot(knowledgeRoot)
  return knowledgeRoot
}

async function healthyRoot(): Promise<string> {
  const knowledgeRoot = scaffoldedRoot()
  await rebuildIndex({ knowledgeRoot })
  return knowledgeRoot
}

function garbageRoot(): string {
  const knowledgeRoot = scaffoldedRoot()
  const dbPath = indexDbPath(knowledgeRoot)
  mkdirSync(dirname(dbPath), { recursive: true })
  writeFileSync(dbPath, 'not a sqlite database', 'utf8')
  return knowledgeRoot
}

function markerPath(knowledgeRoot: string): string {
  return join(knowledgeRoot, 'memory', 'index', REBUILD_MARKER_FILE)
}

function markerExists(knowledgeRoot: string): boolean {
  return existsSync(markerPath(knowledgeRoot))
}

function markerReason(knowledgeRoot: string): string {
  return JSON.parse(readFileSync(markerPath(knowledgeRoot), 'utf8')).reason
}

describe('openKnowledgeReader — one open on the healthy path', () => {
  it('opens a healthy index EXACTLY ONCE and serves from it', async () => {
    const knowledgeRoot = await healthyRoot()
    opener.mockClear()

    const reader = openKnowledgeReader(knowledgeRoot)
    try {
      expect(reader.source).toBe('index')
      expect(opener.mock.calls.length).toBe(1)
      expect(markerExists(knowledgeRoot)).toBe(false)
    } finally {
      reader.close()
    }
  })

  it('a lock arriving after the probe cannot degrade a healthy index', async () => {
    const knowledgeRoot = await healthyRoot()
    opener.mockClear()

    // The whole CR-02 mechanism, made deterministic: the FIRST open answers the real healthy
    // connection, and every later open behaves exactly as a contended sqlite open does — it
    // throws `database is locked`. Pre-fix this answered `scan` and wrote a `locked` rebuild
    // marker for an index that was, and remained, perfectly healthy.
    opener.mockImplementationOnce((root, opts) => realOpen(root, opts))
    opener.mockImplementation(() => {
      throw new Error('database is locked')
    })

    const reader = openKnowledgeReader(knowledgeRoot)
    try {
      expect(reader.source).toBe('index')
      expect(opener.mock.calls.length).toBe(1)
      expect(markerExists(knowledgeRoot)).toBe(false)
    } finally {
      reader.close()
    }
  })

  it('the pure probe still opens once, closes, and writes nothing', async () => {
    const knowledgeRoot = await healthyRoot()
    opener.mockClear()

    let closeCalls = 0
    opener.mockImplementation((root, opts) => {
      const connection = realOpen(root, opts)
      const close = connection.db.close.bind(connection.db)
      connection.db.close = (() => {
        closeCalls += 1
        close()
      }) as typeof connection.db.close
      return connection
    })

    expect(classifyIndexFace(knowledgeRoot)).toEqual({ source: 'index' })
    expect(opener.mock.calls.length).toBe(1)
    // asking about the index is not a mutation of it, and it is not a connection leak.
    expect(closeCalls).toBe(1)
    expect(markerExists(knowledgeRoot)).toBe(false)
  })

  it('a really locked index still degrades with the locked reason and the marker', async () => {
    const knowledgeRoot = await healthyRoot()
    opener.mockClear()

    const locker = new DatabaseSync(indexDbPath(knowledgeRoot), { timeout: 100 })
    locker.exec('PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE')
    try {
      const reader = openKnowledgeReader(knowledgeRoot)
      try {
        expect(reader.source).toBe('scan')
        expect(markerExists(knowledgeRoot)).toBe(true)
        expect(markerReason(knowledgeRoot)).toBe('locked')
      } finally {
        reader.close()
      }
    } finally {
      locker.exec('ROLLBACK')
      locker.close()
    }
  })

  it('garbage bytes still classify as corrupt through the shared core', () => {
    const knowledgeRoot = garbageRoot()
    opener.mockClear()

    const face = classifyIndexFace(knowledgeRoot)
    expect(face).toMatchObject({ source: 'scan', filePresent: true })
    expect(face.source === 'scan' ? face.reason : undefined).toBe('corrupt')
    expect(markerExists(knowledgeRoot)).toBe(false)

    const reader = openKnowledgeReader(knowledgeRoot)
    try {
      expect(reader.source).toBe('scan')
      expect(markerExists(knowledgeRoot)).toBe(true)
      expect(markerReason(knowledgeRoot)).toBe('corrupt')
    } finally {
      reader.close()
    }
  })
})
