// Storage-neutral storage-state persistence port.
// CRITICAL: provider-neutral + storage-neutral. No node:* imports, no fs/sharp, no
// core/model/adapter package imports. Type-only, no implementation — a runner-local
// storageImplementation (FsStorageStateStore) realizes it, mirroring the ActionPlanCache
// port/impl split so ALL fs writes stay out of the runner (validate:arch storageNeutral).
//
// D-14 law (raw-but-local): `storageState save` persists the RAW adapter storage-state blob
// (auth material — cookies/localStorage/origins) so it can be restored verbatim. It is:
//   - never masked  — masking would make it un-restorable;
//   - never in evidence or the handoff — only the `{ name, fingerprint }` reference transits;
//   - durable across runs — per the spec's auth-reuse intent (not coupled to the action-cache
//     schema version).
// The raw blob lives under the gitignored `.agent-qa/storage-states/` runtime dir; a
// traversal-safe name slug keeps a planner-supplied name from escaping that root.

/**
 * The raw storage-state blob (adapter-produced; e.g. a Playwright storageState object). Opaque
 * to the runner — persisted and returned verbatim, never inspected or masked here.
 */
export type StorageStateBlob = unknown

/**
 * The evidence-safe reference to a persisted storage state. This — and ONLY this — is
 * what may transit into `StepEvidence`/the handoff: the name plus a one-way fingerprint of the
 * stored blob. The blob itself never leaves the store.
 */
export interface StorageStateReference {
  /** The caller-supplied slot name (as authored; the store slugs it before it becomes a path). */
  name: string
  /** One-way fingerprint of the stored blob (the 343 `fingerprint()` idiom — identity, not the data). */
  fingerprint: string
}

/**
 * The runner-facing storage-state persistence seam. A runner-local implementation owns
 * the `.agent-qa/storage-states/` filesystem writes; the loop injects it beside `cache` and
 * records only the returned reference.
 */
export interface StorageStatePort {
  /**
   * Persist the raw storage-state blob under `name` and return the evidence-safe reference.
   * The name is slugged traversal-safe before it becomes a filename.
   */
  save(name: string, state: StorageStateBlob): Promise<StorageStateReference>
  /**
   * Load the raw blob previously saved under `name`, or `undefined` when no such slot exists
   * (a missing name is never an error).
   */
  load(name: string): Promise<StorageStateBlob | undefined>
}
