// Concrete filesystem storage-state store (Phase 360, D-14 / STORAGE-STATE).
//
// Implements the storage-neutral `StorageStatePort` from @vostride/agent-qa-runner. This is a
// storageImplementation home for node:fs/promises + node:path (the same boundary as
// FsActionCache) — ALL storage-state fs writes live here, never in the runner (validate:arch
// storageNeutral). On-disk layout:
//
//   <root>/storage-states/<slug(name)>.json
//
// D-14 raw-but-local: the RAW adapter storage-state blob (auth material) is written verbatim so
// it can be restored, under the gitignored `.agent-qa` runtime dir. It is never masked and never
// enters evidence — `save` returns only a `{ name, fingerprint }` reference. The name is slugged
// traversal-safe (the 356 `slugBranch` idiom) so a planner-supplied `../..`-shaped name can never
// escape the storage-states root. Durability is independent of the action-cache schema
// version — storage states persist across runs per the spec's auth-reuse intent.

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
    // slugBranch neutralizes `..`, path separators, and leading/trailing dots so the slug is a
    // single safe path segment that can never traverse out of storage-states/.
    return join(this.storageStatesDir(), `${slugBranch(name)}.json`)
  }
}
