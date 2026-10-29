// The composition-subtree dependency carve-out.
//
// D-13 moved the host-neutral run composition into the local agent package so every host builds
// the same RunConfig. That is the right home and it has a cost: a package whose declared job is a
// durable job store now legitimately names the loop, the model accountant, the safety pipeline and
// the local run adapters. Left unscoped, "legitimately" decays — the next store file to want a
// token estimate takes one, and a lean store becomes a second composition root by accretion.
//
// So the allowance is scoped to a location rather than granted to the package: the heavy first-party
// packages below may be named ONLY by files under the composition subtree. The store proper reaches
// nothing but the neutral agent contracts and the shared vocabulary, and stays reviewable as a
// store. This is the reader-carveout shape applied one level in — a path-scoped allowance with a
// per-entry rationale, and, as there, both drift directions fail:
//
//   1. a scoped package named outside the subtree is an offender;
//   2. an allowance no file under the subtree uses is an offender, so the list shrinks by itself
//      rather than accumulating permissions for imports that left years earlier.
//
// Direction 2 also disarms the way a path-scoped rule usually dies. A subtly wrong prefix scopes
// zero files and then passes forever, reading as proof while checking nothing. Here a wrong prefix
// cannot be quiet: every real composition import would fall outside it and trip direction 1, and
// every allowance would go unused and trip direction 2.
//
// What this rule is NOT: it says where a dependency may be named, never that naming it is wise. The
// D-11 rule that the resume entry reaches no model package is a separate, narrower claim about one
// file, and a file living in this subtree does not answer it. Later composition entries — the local
// agent composer and the job-recovery composer both land here — are covered on arrival by the
// prefix, and must still satisfy whatever per-file rules name them.

import { classifySpecifier } from './extract-specifiers.js'
import type { OwnershipContract } from '../contract-types.js'
import type { SpecifierHit } from './extract-specifiers.js'

/** The package this carve-out guards. Named explicitly: no other package inherits the allowance. */
export const COMPOSITION_CARVEOUT_PACKAGE_DIR = 'packages/agent-local'

/** The one subtree inside it where heavy first-party dependencies are legal. */
export const COMPOSITION_SUBTREE = 'packages/agent-local/src/composition/'

/**
 * The scoped packages and why each is in the subtree. A rationale here is a claim about what the
 * composition does, so a reader who disagrees with the entry knows exactly which code to look at.
 */
export const COMPOSITION_ONLY_PACKAGES: Readonly<Record<string, string>> = {
  '@vostride/agent-qa-knowledge-local': 'run-scoped knowledge serving: the read-only reader binding the budgets size',
  '@vostride/agent-qa-model': 'token-accounting ceilings and the canonical tool-output compaction',
  '@vostride/agent-qa-runner': 'the member run config the composition assembles and the ports it fills',
  '@vostride/agent-qa-runner-local': 'the concrete run persistence adapters and the screenshot compressor',
  '@vostride/agent-qa-safety': 'the execution-context resolver the composition installs and reads',
  '@vostride/agent-qa-safety-local': 'execution-context detection and the run-safety scope',
  '@vostride/agent-qa-web': 'the accessibility check, loaded on demand for web adapters only',
}

function normalizeRepoPath(file: string): string {
  return file.replaceAll('\\', '/')
}

/** True when a repo-relative path sits inside the composition subtree. */
export function isCompositionFile(file: string): boolean {
  return normalizeRepoPath(file).startsWith(COMPOSITION_SUBTREE)
}

function scopedPackageFor(specifier: string): string | undefined {
  const classified = classifySpecifier(specifier)
  if (classified.kind !== 'internal') return undefined
  return classified.pkgName in COMPOSITION_ONLY_PACKAGES ? classified.pkgName : undefined
}

/**
 * Direction 1: a scoped package named by a file outside the composition subtree. Whole-package
 * matching via the shared classifier, so a subpath entry resolves to its own package and a longer
 * package name never collapses into a shorter one.
 */
export function findCompositionCarveoutOffenders(
  contract: OwnershipContract,
  hits: readonly SpecifierHit[],
): string[] {
  if (normalizeRepoPath(contract.packageDir) !== COMPOSITION_CARVEOUT_PACKAGE_DIR) {
    return []
  }

  const offenders: string[] = []

  for (const hit of hits) {
    const file = normalizeRepoPath(hit.file)
    const scoped = scopedPackageFor(hit.specifier)
    if (scoped === undefined || isCompositionFile(file)) continue

    offenders.push(
      `composition-carveout: ${file}:${hit.line} ⇏ ${hit.specifier}`
      + ` (${COMPOSITION_ONLY_PACKAGES[scoped]}; allowed only under ${COMPOSITION_SUBTREE}`
      + ' so the job store proper stays lean)',
    )
  }

  return offenders
}

/**
 * Direction 2: an allowance the subtree does not use. Self-shrinking, and the reason a wrong
 * subtree prefix cannot pass silently — an allowance can only be "used" by a file the prefix
 * actually matched.
 */
export function findCompositionCarveoutUnusedAllowances(
  contract: OwnershipContract,
  hits: readonly SpecifierHit[],
): string[] {
  if (normalizeRepoPath(contract.packageDir) !== COMPOSITION_CARVEOUT_PACKAGE_DIR) {
    return []
  }

  const used = new Set<string>()
  for (const hit of hits) {
    if (!isCompositionFile(normalizeRepoPath(hit.file))) continue
    const scoped = scopedPackageFor(hit.specifier)
    if (scoped !== undefined) used.add(scoped)
  }

  return Object.keys(COMPOSITION_ONLY_PACKAGES)
    .filter(pkgName => !used.has(pkgName))
    .sort()
    .map(pkgName => (
      `composition-carveout: ${pkgName} ⇏ no file under ${COMPOSITION_SUBTREE} names it`
      + ' (unused allowance — delete the entry rather than carry a permission nothing needs)'
    ))
}
