// The per-VALUE cross-boundary classifier (Phase 395-04, D-02 · CFGM-01).
//
// PER VALUE, NOT PER OP, AND THAT IS THE WHOLE DECISION. D-02 put this flag on the PROPOSAL because
// a static map from op ids to answers cannot see the case that matters: `config.field.set` on
// `registry.targets.shop.url` is an innocuous edit when the origin stays the same and a change of
// which machine this product will drive when it does not. The same op, the same path, two different
// answers — decided by the VALUES, which is the only place the difference exists.
//
// CLOSED REASONS, AND NOTHING ELSE MAY BE INVENTED. The output is constrained to
// `CROSS_BOUNDARY_REASONS`, the closed vocabulary `schema` owns, because the grant machinery refuses
// on these words and every surface renders them: a fifth class invented here would read fine in an
// inbox and match nothing on the enforcement side. There are four reasons, and the vocabulary is
// schema's.
//
// WHOLE-INPUT BY CONSTRUCTION (D-03). Nothing here is a whitelist of settable fields, and the two
// rules that could most easily have become one are deliberately not:
//
//   - secret-adjacency is `isSecretAdjacentConfigField`, which is SHIPPED BESIDE THE CONSTANT it
//     reads and matches subtree roots in both directions. It is imported rather than re-derived: a
//     second spelling of that rule is a second judgement, and 395-02 already measured that the
//     easy-to-miss direction (an edit ABOVE a root, which replaces the whole subtree) is the one
//     that lets the WIDEST edit through unflagged.
//   - new-origin is decided by PARSING BOTH VALUES, never by matching the path against a list of
//     url-ish names. A config that grows a second URL-valued field next year is covered on the day
//     it is added, which a name list would not be. The cost is stated: a value that parses as an
//     absolute URL and is not one gets an origin comparison it did not need, which can only ever
//     flag MORE, and flagging more asks a person a question they can answer in one word.
//
// ABSENT-TO-PRESENT IS A NEW ORIGIN. A target that had no URL and now has one is not "unchanged
// origin"; it is the first origin, which is exactly the fresh ask D-14 says scaffolding a target
// deserves.

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

/**
 * Everything the classifier is allowed to know. A record of FACTS, never of ports.
 *
 * `pinnedFileSet` ARRIVES AS AN ARGUMENT rather than being enumerated here, and the enumeration it
 * arrives from is `schema`'s `enumerateConfigFileSet` — the same one the host's config-files port
 * reads bytes for and 395-06's porcelain check scopes to. One enumeration, three consumers: a copy
 * here would fail in the permissive direction, silently, the day the set grew a member.
 */
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

/**
 * Classify one proposal's cross-boundary-ness from its actual values (D-02).
 *
 * REASONS COME BACK IN `CROSS_BOUNDARY_REASONS` ORDER AND WITHOUT DUPLICATES, so two proposals that
 * cross the same boundaries render and compare identically regardless of the order a caller happened
 * to enumerate its edits in. Ordering that follows the input is ordering a caller can perturb.
 */
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
