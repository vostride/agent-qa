// Filesystem cassette bundle store (Phase 367, D-05/D-06/D-07).
//
// Owns the storageImplementation write leg behind eval's in-memory ExtractedCassette contract.
// Each deterministic bundle is recreated in full before publication:
//
//   <output-root>/<slugged cassette id segments>/
//   ├── cassette.json
//   └── blobs/<verified lowercase 64-hex sha>
//
// Every id segment delegates to schema's security-reviewed slugBranch sanitizer. Blob names are
// validated and their bytes are hashed with node:crypto before path use; corrupt copy-in degrades
// completeness loudly instead of publishing bytes under an untrue content address.

import { createHash } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  guardCassette,
  type Cassette,
  type ExtractedCassette,
  type ExtractedBlob,
} from '@vostride/agent-qa-eval'
import { slugBranch } from '@vostride/agent-qa-schema'

export const CASSETTE_FILE = 'cassette.json'
export const BLOBS_SUBDIR = 'blobs'
export const DEFAULT_EVAL_CASSETTES_SUBDIR = 'eval/cassettes'

const BLOB_SHA_RE = /^[0-9a-f]{64}$/

export interface FsCassetteStoreConfig {
  /** Runtime root (normally the workdir's `.agent-qa` directory). */
  root: string
}

export interface WrittenCassette {
  id: string
  dir: string
  writtenBlobShas: string[]
  corruptBlobShas: string[]
}

function byteSha(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function addUnique(values: string[], value: string): void {
  if (!values.includes(value)) values.push(value)
}

function withMissingBlobs(cassette: Cassette, missingShas: readonly string[]): Cassette {
  if (missingShas.length === 0) return cassette
  const combined = [...(cassette.completeness.missingBlobShas ?? [])]
  for (const sha of missingShas) addUnique(combined, sha)
  return {
    ...cassette,
    completeness: {
      ...cassette.completeness,
      status: 'evidence-incomplete',
      missingBlobShas: combined,
    },
  }
}

export class FsCassetteStore {
  private readonly outputRoot: string

  constructor(config: FsCassetteStoreConfig) {
    this.outputRoot = join(config.root, DEFAULT_EVAL_CASSETTES_SUBDIR)
  }

  write(extracted: ExtractedCassette): WrittenCassette {
    const sourceCassette = guardCassette(extracted.cassette)
    const dir = join(
      this.outputRoot,
      ...sourceCassette.id.split('/').map(segment => slugBranch(segment)),
    )
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })

    const verifiedBlobs: ExtractedBlob[] = []
    const writtenBlobShas: string[] = []
    const corruptBlobShas: string[] = []
    const copyInMissingShas: string[] = []

    for (const blob of extracted.blobs) {
      if (!BLOB_SHA_RE.test(blob.sha)) {
        addUnique(corruptBlobShas, blob.sha)
        continue
      }
      if (byteSha(blob.bytes) !== blob.sha) {
        addUnique(corruptBlobShas, blob.sha)
        addUnique(copyInMissingShas, blob.sha)
        continue
      }
      if (!writtenBlobShas.includes(blob.sha)) {
        verifiedBlobs.push(blob)
        writtenBlobShas.push(blob.sha)
      }
    }

    if (verifiedBlobs.length > 0) {
      const blobsDir = join(dir, BLOBS_SUBDIR)
      mkdirSync(blobsDir, { recursive: true })
      for (const blob of verifiedBlobs) writeFileSync(join(blobsDir, blob.sha), blob.bytes)
    }

    const cassette = guardCassette(withMissingBlobs(sourceCassette, copyInMissingShas))
    writeFileSync(join(dir, CASSETTE_FILE), `${JSON.stringify(cassette, null, 2)}\n`, 'utf8')

    return {
      id: cassette.id,
      dir,
      writtenBlobShas,
      corruptBlobShas,
    }
  }
}
