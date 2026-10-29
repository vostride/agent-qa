// Raw storage state is never masked and never in evidence; only `{ name, fingerprint }` transits.

// Opaque to the runner: persisted and returned verbatim, never inspected or masked here.
export type StorageStateBlob = unknown

// Only this reference may reach `StepEvidence` or the handoff; the blob never leaves the store.
export interface StorageStateReference {
  /** The caller-supplied slot name (as authored; the store slugs it before it becomes a path). */
  name: string
  /** One-way fingerprint of the stored blob (the 343 `fingerprint()` idiom — identity, not the data). */
  fingerprint: string
}

// A runner-local implementation owns the filesystem writes; the loop records only the reference.
export interface StorageStatePort {
  // The name is slugged traversal-safe before it becomes a filename.
  save(name: string, state: StorageStateBlob): Promise<StorageStateReference>
  /**
   * Load the raw blob previously saved under `name`, or `undefined` when no such slot exists
   * (a missing name is never an error).
   */
  load(name: string): Promise<StorageStateBlob | undefined>
}
