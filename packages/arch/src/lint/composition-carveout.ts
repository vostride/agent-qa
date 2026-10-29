// Heavy packages may be named only under the composition subtree; an unused allowance also fails.

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
