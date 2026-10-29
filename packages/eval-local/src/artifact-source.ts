// `absentArtifactSource` marks unservable refs; the sha is validated before any path use.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { ArtifactSource } from '@vostride/agent-qa-eval'
import { FsEvidenceArtifactStore } from '@vostride/agent-qa-runner-local'

const BLOB_SHA_RE = /^[0-9a-f]{64}$/

export const absentArtifactSource: ArtifactSource = {
  getBlob: () => undefined,
}

export interface DirArtifactSourceConfig {
  /** Directory containing one file per lowercase 64-hex content sha. */
  dir: string
}

export class DirArtifactSource implements ArtifactSource {
  private readonly dir: string

  constructor(config: DirArtifactSourceConfig) {
    this.dir = config.dir
  }

  getBlob(sha: string): Uint8Array | undefined {
    if (!BLOB_SHA_RE.test(sha)) return undefined

    try {
      return new Uint8Array(readFileSync(join(this.dir, sha)))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }
}

export interface FsRunArtifactSourceConfig {
  /** Runtime root the production run store persisted under (e.g. `.agent-qa`). */
  root: string
  /** The run whose sha-keyed screenshot blobs this source reads. */
  runId: string
}

// Production-shaped read leg over the exact runner-local store that persisted planner screenshots.
// Run layout, slugging, and sha validation live in FsEvidenceArtifactStore; this adapter only binds
// eval's neutral ArtifactSource port to that store's read method.
export class FsRunArtifactSource implements ArtifactSource {
  private readonly store: FsEvidenceArtifactStore

  constructor(config: FsRunArtifactSourceConfig) {
    this.store = new FsEvidenceArtifactStore({ root: config.root, runId: config.runId })
  }

  getBlob(sha: string): Uint8Array | undefined {
    return this.store.getBlob(sha)
  }
}
