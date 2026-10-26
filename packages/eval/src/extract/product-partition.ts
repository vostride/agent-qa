import type { ScopeKey } from '@vostride/agent-qa-schema'

/**
 * A 'product' tier with a real name passes through; an unnamed or 'unknown' product and any
 * non-product tier map to the 'default' partition.
 */
export function resolveProductPartition(scope: ScopeKey): string {
  if (scope.tier === 'product' && scope.key !== '' && scope.key !== 'unknown') {
    return scope.key
  }
  return 'default'
}
