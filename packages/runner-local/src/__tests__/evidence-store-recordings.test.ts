import { createHash } from 'node:crypto'
import {
  copyFileSync, existsSync, fsyncSync, mkdtempSync, openSync, readFileSync, readSync,
  readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import type { EvidenceArtifactStorePort } from '@vostride/agent-qa-runner'
import { RecordingRefSchema } from '@vostride/agent-qa-schema'
import { FsEvidenceArtifactStore } from '../evidence-artifact-store.js'

const io = vi.hoisted(() => ({ beforeRename: undefined as undefined | ((from: string, to: string) => void) }))
vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs')>()
  return {
    ...fs,
    copyFileSync: vi.fn(fs.copyFileSync),
    fsyncSync: vi.fn(fs.fsyncSync),
    openSync: vi.fn(fs.openSync),
    readFileSync: vi.fn(fs.readFileSync),
    readSync: vi.fn(fs.readSync),
    statSync: vi.fn(fs.statSync),
    renameSync: vi.fn((from: string, to: string) => {
      io.beforeRename?.(from, to)
      return fs.renameSync(from, to)
    }),
  }
})

const roots: string[] = []
const readChunks = vi.mocked(readSync as (
  fd: number, buffer: NodeJS.ArrayBufferView, offset: number, length: number, position: number | null,
) => number)
const bytes = Buffer.from('recording bytes: 0123456789')
const sha = createHash('sha256').update(bytes).digest('hex')
function fixture(payload = bytes) {
  const root = mkdtempSync(join(tmpdir(), 'recording-store-'))
  roots.push(root)
  const staging = join(root, 'recording.webm')
  writeFileSync(staging, payload)
  const store = new FsEvidenceArtifactStore({ root, runId: 'run-recording' }) as
    FsEvidenceArtifactStore & Required<EvidenceArtifactStorePort>
  return { root, staging, store, dir: join(root, 'runs', 'run-recording', 'blobs') }
}

afterEach(() => {
  io.beforeRename = undefined
  vi.restoreAllMocks()
  vi.clearAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

test('REC-STORE-HASH-BY-PATH: hashes all chunks into a schema-valid recording reference', () => {
  const payload = Buffer.alloc(2 * 1024 * 1024 + 19, 0x6a)
  payload[payload.length - 1] = 0x42
  const { store, staging } = fixture(payload)
  expect(store.persistRecording).toBeTypeOf('function')
  const result = store.persistRecording(staging)
  const digest = createHash('sha256').update(payload).digest('hex')
  expect(result).toEqual({ ref: { id: `recording:${digest}`, sha: digest }, byteLength: payload.length })
  expect(RecordingRefSchema.parse(result.ref)).toEqual(result.ref)
  expect(readFileSync).not.toHaveBeenCalled()
  expect(readChunks.mock.calls.length).toBeGreaterThanOrEqual(3)
  expect(readChunks.mock.calls.every(call => call[3] <= 1024 * 1024)).toBe(true)
  expect(createHash('sha256').update(store.getBlob(digest)!).digest('hex')).toBe(digest)
})

test('REC-STORE-ATOMIC-PUBLISH: no partial target and no temporary survives publication', () => {
  const { store, staging, dir } = fixture()
  expect(store.persistRecording).toBeTypeOf('function')
  let publications = 0
  io.beforeRename = (from, to) => {
    expect(store.getBlob(sha)).toBeUndefined()
    if (to === join(dir, sha)) {
      publications++
      expect(from).toMatch(/\.tmp$/)
      expect(fsyncSync).toHaveBeenCalled()
      expect(readFileSync(from)).toEqual(bytes)
    }
  }
  store.persistRecording(staging)
  expect(publications).toBe(1)
  expect(readdirSync(dir)).toEqual([sha])
  expect(Buffer.from(store.getBlob(sha)!)).toEqual(bytes)
  expect(fsyncSync).toHaveBeenCalledTimes(6)
})

test('REC-STORE-STAGING-UNLINKED: success consumes staging bytes', () => {
  for (const path of ['rename', 'copy', 'existing'] as const) {
    const { store, staging } = fixture()
    expect(store.persistRecording).toBeTypeOf('function')
    if (path === 'existing') {
      store.persistRecording(staging)
      writeFileSync(staging, bytes)
    }
    // Rename consumes its source itself. Copy and deduplication require the final unlink.
    io.beforeRename = from => {
      if (path === 'copy' && from === staging) {
        throw Object.assign(new Error('cross device'), { code: 'EXDEV' })
      }
    }
    const saved = store.persistRecording(staging)
    expect(existsSync(staging), path).toBe(false)
    expect(Buffer.from(store.getBlob(saved.ref.sha)!), path).toEqual(bytes)
    io.beforeRename = undefined
  }
})

test.each(['stage', 'publish', 'hash', 'file-sync', 'directory-sync', 'copy'])(
  'REC-STORE-FAILURE-UNLINKS: %s failure removes staging and temporary bytes', stage => {
    const { store, staging, dir } = fixture()
    expect(store.persistRecording).toBeTypeOf('function')
    const failure = Object.assign(new Error('injected recording failure'), { code: 'EIO' })
    let syncs = 0
    const originalSync = vi.mocked(fsyncSync).getMockImplementation()!
    const originalRead = readChunks.getMockImplementation()!
    const originalCopy = vi.mocked(copyFileSync).getMockImplementation()!
    io.beforeRename = (_from, to) => {
      if (stage === 'stage' || (stage === 'publish' && to === join(dir, sha))) throw failure
      if (stage === 'copy') throw Object.assign(new Error('cross device'), { code: 'EXDEV' })
    }
    vi.mocked(fsyncSync).mockImplementation(fd => {
      syncs++
      if ((stage === 'file-sync' && syncs === 1) || (stage === 'directory-sync' && syncs === 2)) throw failure
      originalSync(fd)
    })
    if (stage === 'hash') readChunks.mockImplementation(() => { throw failure })
    if (stage === 'copy') vi.mocked(copyFileSync).mockImplementation(() => { throw failure })
    try {
      expect(() => store.persistRecording(staging)).toThrow('injected recording failure')
      expect(existsSync(staging)).toBe(false)
      expect(existsSync(dir) ? readdirSync(dir) : []).toEqual(stage === 'directory-sync' ? [sha] : [])
    } finally {
      vi.mocked(fsyncSync).mockImplementation(originalSync)
      readChunks.mockImplementation(originalRead)
      vi.mocked(copyFileSync).mockImplementation(originalCopy)
    }
  },
)

test('REC-STORE-ZERO-LENGTH-REFUSED: empty staging throws without publishing the empty digest', () => {
  const { store, staging, dir } = fixture(Buffer.alloc(0))
  expect(store.persistRecording).toBeTypeOf('function')
  expect(() => store.persistRecording(staging)).toThrow(/empty|zero/i)
  expect(existsSync(staging)).toBe(false)
  expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([])
})

test('REC-STORE-IDEMPOTENT: identical bytes share one durable blob', () => {
  const { store, staging, dir } = fixture()
  expect(store.persistRecording).toBeTypeOf('function')
  const first = store.persistRecording(staging)
  writeFileSync(staging, bytes)
  vi.clearAllMocks()
  expect(store.persistRecording(staging)).toEqual(first)
  expect(readdirSync(dir)).toEqual([sha])
  expect(existsSync(staging)).toBe(false)
  expect(renameSync).not.toHaveBeenCalled()
  expect(fsyncSync).toHaveBeenCalledTimes(6)
})

test('REC-STORE-EXDEV-FALLBACK: cross-device staging copies privately before atomic publication', () => {
  const { store, staging, dir } = fixture()
  expect(store.persistRecording).toBeTypeOf('function')
  io.beforeRename = from => {
    if (from === staging) throw Object.assign(new Error('cross device'), { code: 'EXDEV' })
    expect(store.getBlob(sha)).toBeUndefined()
  }
  expect(store.persistRecording(staging).ref.sha).toBe(sha)
  expect(copyFileSync).toHaveBeenCalledOnce()
  expect(existsSync(staging)).toBe(false)
  expect(readdirSync(dir)).toEqual([sha])
  expect(Buffer.from(store.getBlob(sha)!)).toEqual(bytes)
})

test.each(['EINVAL', 'EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EBADF', 'EISDIR'])(
  'REC-STORE-ATOMIC-PUBLISH: directory sync tolerates %s after file sync', code => {
    const { store, staging } = fixture()
    expect(store.persistRecording).toBeTypeOf('function')
    const original = vi.mocked(fsyncSync).getMockImplementation()!
    let calls = 0
    vi.mocked(fsyncSync).mockImplementation(fd => {
      if (++calls === 2) throw Object.assign(new Error('directory refusal'), { code })
      original(fd)
    })
    try {
      expect(store.persistRecording(staging).ref.sha).toBe(sha)
      expect(calls).toBeGreaterThan(2)
    } finally {
      vi.mocked(fsyncSync).mockImplementation(original)
    }
  },
)

test('REC-STORE-SIZE: stats the blob without reading and reports missing bytes honestly', () => {
  const { store } = fixture()
  expect(store.blobSize).toBeTypeOf('function')
  expect(store.blobSize(sha)).toBeUndefined()
  store.persistDecisionScreenshot(bytes)
  vi.clearAllMocks()
  expect(store.blobSize(sha)).toBe(bytes.length)
  expect(readFileSync).not.toHaveBeenCalled()
  expect(readSync).not.toHaveBeenCalled()
})

test('REC-STORE-RANGE: reads inclusive clamped slices and refuses out-of-bounds intervals', () => {
  const { store } = fixture()
  expect(store.readBlobRange).toBeTypeOf('function')
  expect(store.readBlobRange(sha, 0, 2)).toBeUndefined()
  store.persistDecisionScreenshot(bytes)
  vi.clearAllMocks()
  expect(Buffer.from(store.readBlobRange(sha, 3, 7)!)).toEqual(bytes.subarray(3, 8))
  expect(Buffer.from(store.readBlobRange(sha, bytes.length - 1, bytes.length + 100)!)).toEqual(bytes.subarray(-1))
  expect(store.readBlobRange(sha, bytes.length, bytes.length + 100)).toBeUndefined()
  expect(store.readBlobRange(sha, bytes.length + 1, bytes.length + 100)).toBeUndefined()
  expect(store.readBlobRange(sha, 5, 4)).toBeUndefined()
  for (const start of [-1, 0.5, NaN, Infinity]) expect(store.readBlobRange(sha, start, 8)).toBeUndefined()
  for (const end of [NaN, Infinity, 0.5]) expect(store.readBlobRange(sha, 0, end)).toBeUndefined()
  expect(readFileSync).not.toHaveBeenCalled()
  expect(readChunks.mock.calls.map(call => [call[3], call[4]])).toEqual([[5, 3], [1, bytes.length - 1]])
})

test('REC-STORE-RANGE: short reads fill the requested slice without zero padding', () => {
  const { store } = fixture()
  expect(store.readBlobRange).toBeTypeOf('function')
  store.persistDecisionScreenshot(bytes)
  const original = readChunks.getMockImplementation()!
  readChunks.mockImplementation((fd, buffer, offset, length, position) =>
    original(fd, buffer, offset, Math.min(Number(length), 2), position))
  try {
    expect(Buffer.from(store.readBlobRange(sha, 3, 9)!)).toEqual(bytes.subarray(3, 10))
  } finally {
    readChunks.mockImplementation(original)
  }
})

test('REC-STORE-SHA-GUARD: invalid sha never reaches filesystem calls', () => {
  const { store } = fixture()
  expect(store.blobSize).toBeTypeOf('function')
  expect(store.readBlobRange).toBeTypeOf('function')
  vi.clearAllMocks()
  for (const value of ['../recording.webm', '', 'a'.repeat(63), 'a'.repeat(65), 'G'.repeat(64), sha.toUpperCase()]) {
    expect(store.blobSize(value)).toBeUndefined()
    expect(store.readBlobRange(value, 0, 3)).toBeUndefined()
  }
  expect(statSync).not.toHaveBeenCalled()
  expect(openSync).not.toHaveBeenCalled()
})

test('REC-STORE-DISCARD: consumes abandoned staging, tolerates absence, and protects evidence paths', () => {
  const { store, staging, root, dir } = fixture()
  expect(store.discardRecording).toBeTypeOf('function')
  store.discardRecording(staging)
  expect(existsSync(staging)).toBe(false)
  expect(() => store.discardRecording(staging)).not.toThrow()
  expect(existsSync(dir)).toBe(false)
  store.persistDecisionScreenshot(bytes)
  const target = join(dir, sha)
  expect(() => store.discardRecording(target)).toThrow(/blob|evidence/i)
  expect(() => store.discardRecording(dir)).toThrow(/blob|evidence/i)
  symlinkSync(dir, join(root, 'blob-alias'))
  expect(() => store.discardRecording(join(root, 'blob-alias', sha))).toThrow(/blob|evidence/i)
  expect(readFileSync(target)).toEqual(bytes)
})

test('REC-STORE-DISCARD: persisting a blob path cannot move or delete durable evidence', () => {
  const { store, dir } = fixture()
  expect(store.persistRecording).toBeTypeOf('function')
  store.persistDecisionScreenshot(bytes)
  expect(() => store.persistRecording(join(dir, sha))).toThrow(/blob|evidence/i)
  expect(readFileSync(join(dir, sha))).toEqual(bytes)
})
