// Concrete filesystem content-addressed evidence artifact store.
//
// Implements the storage-neutral `EvidenceArtifactStorePort` from @vostride/agent-qa-runner. This
// is a storageImplementation home for node:crypto + node:fs + node:path (the FsHandoffStore /
// FsRunArtifactStore boundary) — the sha-keyed screenshot-byte writes live here, never in the
// runner (validate:arch storageNeutral). On-disk layout, in the SAME run family as
// events.jsonl / handoff.json / artifact.json:
//
//   <root>/runs/<slug(runId)>/blobs/<sha>
//
// The runId directory component is slugged traversal-safe (the shared `slugBranch` idiom via
// RUNS_SUBDIR) so a planner-supplied `../..`-shaped runId can never escape the runs root; the path
// is never re-minted here. Filenames ARE the lowercase SHA-256 of their exact bytes, so a repeat
// write of identical bytes overwrites the same file and stays idempotent. `getBlob` validates the
// lowercase 64-hex shape before any path use so a malformed/traversal-shaped sha can never address
// an arbitrary file; ENOENT is honest absence, other host failures surface.
//
// PRESENCE IS A STAT, NOT A READ. `hasBlob` answers whether a run still holds
// the bytes behind an artifact ref so a durable read can annotate a whole run's refs without
// loading a single screenshot; it runs the SAME regex guard first, for the same reason, and
// touches the filesystem only after the shape is known good.

import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync,
  unlinkSync, writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { chmodSync, copyFileSync, fstatSync, readSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { RECORDING_REF_PREFIX } from '@vostride/agent-qa-schema'
import type { PersistedRecording } from '@vostride/agent-qa-runner'

import type { ArtifactRef, EvidenceDocument } from '@vostride/agent-qa-schema'
import { EvidenceArtifactRefSchema, EvidenceDocumentSchema } from '@vostride/agent-qa-schema'
import type { EvidenceArtifactStorePort } from '@vostride/agent-qa-runner'

import { slugBranch } from './branch-resolver.js'
import { RUNS_SUBDIR } from './event-log.js'

/** Subdirectory under each slugged run dir holding the content-addressed evidence blobs. */
export const RUN_EVIDENCE_BLOBS_SUBDIR = 'blobs'

const SHA256_HEX_RE = /^[0-9a-f]{64}$/

const DIRECTORY_SYNC_TOLERATED_CODES = ['EINVAL', 'EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EBADF', 'EISDIR'] as const

export interface FsEvidenceArtifactStoreConfig {
  /** Runtime root (e.g. DEFAULT_AGENT_QA_DIR = '.agent-qa'). */
  root: string
  /** The run these blobs belong to; slugged before it becomes a path segment. */
  runId: string
}

export class FsEvidenceArtifactStore implements EvidenceArtifactStorePort {
  private readonly dir: string
  private readonly durabilityRoot: string

  constructor(config: FsEvidenceArtifactStoreConfig) {
    this.dir = join(config.root, RUNS_SUBDIR, slugBranch(config.runId), RUN_EVIDENCE_BLOBS_SUBDIR)
    this.durabilityRoot = dirname(join(config.root, '.'))
  }

  persistDecisionScreenshot(bytes: Uint8Array): ArtifactRef {
    const sha = createHash('sha256').update(bytes).digest('hex')
    mkdirSync(this.dir, { recursive: true })
    writeFileSync(join(this.dir, sha), bytes)
    return { id: `decision-screenshot:${sha}`, sha }
  }

  persistEvidenceDocument(document: Exclude<EvidenceDocument, { kind: 'variables' }>): ArtifactRef {
    // Validate the actual serialization, but retain its exact property/record order. Parsing
    // and reserializing a Zod object would reorder keys and change the content address.
    const bytes = Buffer.from(JSON.stringify(document))
    const parsed = EvidenceDocumentSchema.parse(JSON.parse(bytes.toString('utf8')))
    if (parsed.kind === 'variables') throw new Error('Variable evidence is stored inline')
    const sha = createHash('sha256').update(bytes).digest('hex')
    const prefix = parsed.kind === 'aria' ? 'aria-state:' : `${parsed.kind}-evidence:`
    const ref = EvidenceArtifactRefSchema.parse({ id: `${prefix}${sha}`, sha })
    mkdirSync(this.dir, { recursive: true })
    const target = join(this.dir, sha)
    const existing = this.getBlob(sha)
    if (existing !== undefined && Buffer.from(existing).equals(bytes)) {
      // A competing writer may have renamed but not synced its directory yet. Confirm both
      // the complete file and directory ourselves before returning the deduplicated ref.
      this.syncPath(target)
      this.syncDirectories()
      return ref
    }
    const temporary = join(this.dir, `.${sha}.${randomUUID()}.tmp`)
    const fd = openSync(temporary, 'wx', 0o600)
    let opened = true
    try {
      writeFileSync(fd, bytes)
      fsyncSync(fd)
      closeSync(fd)
      opened = false
      // Concurrent identical documents have identical complete bytes. Replacing either
      // complete inode is safe; a reader can never observe the temporary partial content.
      renameSync(temporary, target)
      this.syncDirectories()
      return ref
    } finally {
      if (opened) closeSync(fd)
      try {
        unlinkSync(temporary)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
  }

  private syncDirectories(): void {
    // mkdir(recursive) may have created any part of the run family. Sync each parent
    // entry as well, including when a competing writer created it before this call.
    for (let path = this.dir; ; path = dirname(path)) {
      try {
        this.syncPath(path)
      } catch (error) {
        // The file bytes were synced before rename. Some filesystems refuse directory fsync,
        // and that refusal is not data loss.
        const code = (error as NodeJS.ErrnoException).code
        if (!DIRECTORY_SYNC_TOLERATED_CODES.some(tolerated => tolerated === code)) throw error
      }
      if (path === this.durabilityRoot || dirname(path) === path) return
    }
  }

  private syncPath(path: string): void {
    const fd = openSync(path, 'r')
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  }

  hasBlob(sha: string): boolean {
    if (!SHA256_HEX_RE.test(sha)) return false
    return existsSync(join(this.dir, sha))
  }

  persistRecording(stagingPath: string): PersistedRecording {
    this.assertRecordingStagingPath(stagingPath)
    let recordingTemp: string | undefined
    try {
      const byteLength = statSync(stagingPath).size
      if (byteLength === 0) throw new Error('Cannot persist an empty recording')
      const hash = createHash('sha256')
      const fd = openSync(stagingPath, 'r')
      try {
        const chunk = Buffer.allocUnsafe(1024 * 1024)
        let total = 0
        for (;;) {
          const count = readSync(fd, chunk, 0, chunk.length, null)
          if (count === 0) break
          total += count
          hash.update(chunk.subarray(0, count))
        }
        if (total !== byteLength) throw new Error('Recording changed while hashing')
      } finally {
        closeSync(fd)
      }
      const sha = hash.digest('hex')
      const result: PersistedRecording = {
        ref: { id: `${RECORDING_REF_PREFIX}${sha}`, sha }, byteLength,
      }
      mkdirSync(this.dir, { recursive: true })
      const target = join(this.dir, sha)
      if (this.blobSize(sha) !== undefined) {
        this.syncPath(target)
        this.syncDirectories()
        return result
      }
      recordingTemp = join(this.dir, `.${sha}.${randomUUID()}.tmp`)
      try {
        renameSync(stagingPath, recordingTemp)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
        copyFileSync(stagingPath, recordingTemp)
      }
      chmodSync(recordingTemp, 0o600)
      this.syncPath(recordingTemp)
      renameSync(recordingTemp, target)
      this.syncDirectories()
      return result
    } finally {
      try {
        if (recordingTemp !== undefined) this.unlinkRecordingStaging(recordingTemp)
      } finally {
        this.unlinkRecordingStaging(stagingPath)
      }
    }
  }

  blobSize(sha: string): number | undefined {
    if (!SHA256_HEX_RE.test(sha)) return undefined
    try {
      return statSync(join(this.dir, sha)).size
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  readBlobRange(sha: string, start: number, end: number): Uint8Array | undefined {
    if (!SHA256_HEX_RE.test(sha)) return undefined
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) return undefined
    let fd: number
    try {
      fd = openSync(join(this.dir, sha), 'r')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    try {
      const size = fstatSync(fd).size
      if (start >= size) return undefined
      const length = Math.min(end, size - 1) - start + 1
      const bytes = new Uint8Array(length)
      let offset = 0
      while (offset < length) {
        const count = readSync(fd, bytes, offset, length - offset, start + offset)
        if (count === 0) throw new Error('Recording blob ended before the requested range')
        offset += count
      }
      return bytes
    } finally {
      closeSync(fd)
    }
  }

  discardRecording(stagingPath: string): void {
    this.assertRecordingStagingPath(stagingPath)
    this.unlinkRecordingStaging(stagingPath)
  }

  private assertRecordingStagingPath(stagingPath: string): void {
    const inside = (dir: string, path: string) => {
      const tail = relative(dir, path)
      return tail === '' || (tail !== '..' && !tail.startsWith(`..${sep}`) && !isAbsolute(tail))
    }
    if (inside(resolve(this.dir), resolve(stagingPath))) {
      throw new Error('Recording staging path must be outside the evidence blob directory')
    }
    try {
      if (inside(realpathSync(this.dir), realpathSync(stagingPath))) {
        throw new Error('Recording staging path must be outside the evidence blob directory')
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  private unlinkRecordingStaging(path: string): void {
    try {
      unlinkSync(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  getBlob(sha: string): Uint8Array | undefined {
    if (!SHA256_HEX_RE.test(sha)) return undefined
    try {
      return new Uint8Array(readFileSync(join(this.dir, sha)))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw err
    }
  }
}
