// Manifest identity is re-derived, never trusted from storage.
import { canonicalJson } from '../determinism/canonical-json'
import {
  computeBundleIdentityHash,
  mintBundleId,
  type BundleIdentityCore,
  type BundleIdentityInput,
} from '../ids/content-address'
import { normalizeAnchor } from '../identity/normalize-anchor'
import type { BundleManifest } from './bundle-files'

function identityCoreToInput(core: BundleIdentityCore): BundleIdentityInput {
  return {
    kind: core.kind,
    ...(core.subtype === null ? {} : { subtype: core.subtype }),
    primaryAnchor: core.primaryAnchor,
    scope: core.scope,
    discriminantKey: core.discriminantKey,
  }
}

export function verifyManifestIdentity(
  manifest: Pick<BundleManifest, 'id' | 'identityHash' | 'identityCore'>,
): string[] {
  const violations: string[] = []
  const normalizedAnchor = normalizeAnchor(manifest.identityCore.primaryAnchor)

  if (canonicalJson(normalizedAnchor) !== canonicalJson(manifest.identityCore.primaryAnchor)) {
    violations.push('identityCore.primaryAnchor is not stored normalized')
  }

  const identityInput = identityCoreToInput(manifest.identityCore)
  const recomputedIdentityHash = computeBundleIdentityHash(identityInput)
  if (recomputedIdentityHash !== manifest.identityHash) {
    violations.push(
      `identityHash mismatch: recomputed ${recomputedIdentityHash}, stored ${manifest.identityHash}`,
    )
  }

  const recomputedId = mintBundleId(identityInput)
  if (recomputedId !== manifest.id) {
    violations.push(`id mismatch: recomputed ${recomputedId}, stored ${manifest.id}`)
  }

  return violations
}
