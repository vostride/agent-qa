// Branch write-skip policy for the local action-plan cache store.
//
// Branch is a storage namespace, never a cache-key component. The policy is
// resolved in the CLI / runner-local composition root (branch + CI + flags) and
// passed to the store; the key builder in `@vostride/agent-qa-runner` never sees
// a branch. Reads are always allowed (the store handles branch -> default
// fallback); this predicate governs writes only.

export interface CachePolicy {
  /** The branch the current run executes on (raw, un-slugged). */
  currentBranch: string
  /** The repo's default branch (raw, un-slugged) — the read-fallback namespace. */
  defaultBranch: string
  /** default branch ∪ any configured protected branches. */
  protectedBranches: readonly string[]
  /** Resolved in the CLI (reusing the CI vendor-var set), passed in here. */
  isCI: boolean
  /** `--save-cache` — force writes even on a protected branch. */
  saveCache: boolean
  /** `--disable-cache` — short-circuit both reads and writes. */
  disableCache: boolean
}

/**
 * Writes are skipped when the current branch is protected (default ∪ configured)
 * unless `--save-cache` or CI; `--disable-cache` forbids all writes. Reads are not
 * governed here.
 */
export function shouldWrite(policy: CachePolicy): boolean {
  if (policy.disableCache) return false
  const protectedNow = policy.protectedBranches.includes(policy.currentBranch)
  return !protectedNow || policy.saveCache || policy.isCI
}
