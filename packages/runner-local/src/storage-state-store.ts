// Raw auth material, written verbatim and never masked; `save` returns only name and fingerprint.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { sha256hex16 } from '@vostride/agent-qa-schema'
import type { StorageStateBlob, StorageStatePort, StorageStateReference } from '@vostride/agent-qa-runner'

import { slugBranch } from './branch-resolver.js'

/** Subdirectory under the runtime root holding the raw storage-state blobs. */
export const STORAGE_STATES_SUBDIR = 'storage-states'

export interface FsStorageStateStoreConfig {
  /** Runtime root (e.g. DEFAULT_AGENT_QA_DIR = '.agent-qa'). */
  root: string
}

export class FsStorageStateStore implements StorageStatePort {
  private readonly root: string

  constructor(config: FsStorageStateStoreConfig) {
    this.root = config.root
  }

  async save(name: string, state: StorageStateBlob): Promise<StorageStateReference> {
    const dir = this.storageStatesDir()
    await mkdir(dir, { recursive: true })
    // Deterministic JSON so an identical blob fingerprints identically across runs.
    const serialized = JSON.stringify(state)
    await writeFile(this.entryPath(name), `${serialized}\n`, 'utf-8')
    // 343 fingerprint() idiom — the shipped sha256hex16 determinism primitive, never hand-rolled.
    return { name, fingerprint: sha256hex16(serialized) }
  }

  async load(name: string): Promise<StorageStateBlob | undefined> {
    let raw: string
    try {
      raw = await readFile(this.entryPath(name), 'utf-8')
    } catch (err) {
      // A missing slot is never an error — undefined, no throw.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw err
    }
    try {
      return JSON.parse(raw) as StorageStateBlob
    } catch {
      // A corrupt/partial blob reads as absent rather than crashing the run.
      return undefined
    }
  }

  private storageStatesDir(): string {
    return join(this.root, STORAGE_STATES_SUBDIR)
  }

  private entryPath(name: string): string {
    // `slugBranch` makes the name one safe path segment inside `storage-states/`.
    return join(this.storageStatesDir(), `${slugBranch(name)}.json`)
  }
}
