// Decided per value, not per op: one path can keep or change its origin depending on the values.

import {
  CROSS_BOUNDARY_REASONS,
  isSecretAdjacentConfigField,
} from '@vostride/agent-qa-schema'
import type { CrossBoundaryReason } from '@vostride/agent-qa-schema'

import type { ConfigFieldValue } from './ports.js'

/** One field this proposal edits, with the value it replaces — both sides, or the rule is blind. */
export interface CrossBoundaryFieldEdit {
  readonly configPath: string
  /** Absent means the path held no scalar before the edit. See `ConfigFieldSetResult`. */
  readonly oldValue?: ConfigFieldValue
  readonly newValue: ConfigFieldValue
}

// `pinnedFileSet` comes from `enumerateConfigFileSet`, so a new member cannot slip past unflagged.
export interface CrossBoundaryFacts {
  readonly fieldEdits: readonly CrossBoundaryFieldEdit[]
  /** Whether this proposal ADDS a hook — code this project will execute. Never inferred from a path. */
  readonly addsHook: boolean
  /** Workspace-relative paths this proposal would write. */
  readonly filesTouched: readonly string[]
  /** The pinned config file set, as `enumerateConfigFileSet` answered it for this workspace. */
  readonly pinnedFileSet: readonly string[]
}

export interface CrossBoundaryVerdict {
  readonly crossBoundary: boolean
  readonly reasons: readonly CrossBoundaryReason[]
}

/**
 * The origin of a value, or `undefined` when the value is not an absolute URL.
 *
 * SCHEME, HOST AND PORT — the three facts that decide whether traffic goes somewhere else. A path
 * change under one origin is an ordinary edit; `http` → `https` on one host is NOT, because the two
 * are different origins by every definition that matters and one of them is a downgrade.
 *
 * `URL` normalises the default port away on its own (`https://x:443` and `https://x` are one
 * origin), which is the behaviour wanted here: a person asked to re-approve a redundant port
 * spelling would learn to answer without reading.
 */
function originOf(value: ConfigFieldValue | undefined): string | undefined {
  if (typeof value !== 'string') return undefined
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return undefined
  }
  if (parsed.host === '') return undefined
  return `${parsed.protocol}//${parsed.host}`
}

// Reasons come back in `CROSS_BOUNDARY_REASONS` order without duplicates, whatever the input order.
export function computeCrossBoundary(facts: CrossBoundaryFacts): CrossBoundaryVerdict {
  const found = new Set<CrossBoundaryReason>()

  for (const edit of facts.fieldEdits) {
    if (isSecretAdjacentConfigField(edit.configPath)) found.add('secret-adjacent-field')

    const newOrigin = originOf(edit.newValue)
    // A value that is not a URL cannot change an origin — and a value that IS one is compared
    // against what it replaced, including the case where it replaced nothing.
    if (newOrigin !== undefined && newOrigin !== originOf(edit.oldValue)) found.add('new-origin')
  }

  if (facts.addsHook) found.add('hook-added')

  const pinned = new Set(facts.pinnedFileSet)
  if (facts.filesTouched.some((path) => !pinned.has(path))) found.add('out-of-set-path')

  const reasons = CROSS_BOUNDARY_REASONS.filter((reason) => found.has(reason))
  return { crossBoundary: reasons.length > 0, reasons }
}
