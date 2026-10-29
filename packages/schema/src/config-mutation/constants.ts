// Pinned constants, not configuration: a guard a project can switch off is only a default.

// Cross-boundary is decided per value, so this is the set of reasons, never a map from ops.
export const CROSS_BOUNDARY_REASONS = [
  'secret-adjacent-field',
  'new-origin',
  'hook-added',
  'out-of-set-path',
] as const

export type CrossBoundaryReason = (typeof CROSS_BOUNDARY_REASONS)[number]

// Subtree roots, not leaves: a key added under a root is covered without listing it.
export const SECRET_ADJACENT_CONFIG_FIELDS = [
  'workspace.envFile',
  'workspace.secretsFile',
  'services.authState',
  'plugins.auth',
  'plugins.providers',
  'registry.targets.*.authState',
  'use.authState',
] as const

export type SecretAdjacentConfigField = (typeof SECRET_ADJACENT_CONFIG_FIELDS)[number]

// Matches both ways: an edit above a root replaces its subtree, so it is secret-adjacent too.
export function isSecretAdjacentConfigField(path: string): boolean {
  const segments = path.split('.')
  return SECRET_ADJACENT_CONFIG_FIELDS.some((root) => {
    const rootSegments = root.split('.')
    const shared = Math.min(segments.length, rootSegments.length)
    for (let index = 0; index < shared; index++) {
      if (rootSegments[index] === '*') continue
      if (rootSegments[index] !== segments[index]) return false
    }
    return true
  })
}
