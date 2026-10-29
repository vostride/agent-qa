// The vec0 leg mirrors these clauses in metadata syntax; change both together.
export interface PreFilterOptions {
  product: string
  testKey: string
  suiteKey: string
  productKey: string
  globalKey: string
  includeSuperseded?: boolean
}

export interface PreFilterPredicate {
  sql: string
  binds: string[]
}

export interface ScopeLadderPredicateOptions {
  /** Slugged product column value used for the physical tenancy wall. */
  productRow?: string
  /** Logical product scope key stored in record frontmatter. */
  productScope?: string
  /** The member scope requested by Channel 1 or Channel 2. */
  requestedScope?: { tier: 'global' | 'product' | 'suite' | 'test'; key: string }
  /** Known containing scopes, currently the suite that owns a test member. */
  parentScopes?: readonly { tier: 'global' | 'product' | 'suite' | 'test'; key: string }[]
}

function distinctScopePairs(
  scopes: readonly { tier: 'global' | 'product' | 'suite' | 'test'; key: string }[],
): Array<{ tier: 'product' | 'suite' | 'test'; key: string }> {
  const seen = new Set<string>()
  const result: Array<{ tier: 'product' | 'suite' | 'test'; key: string }> = []
  for (const scope of scopes) {
    if (scope.tier === 'global') continue
    const identity = `${scope.tier}\u0000${scope.key}`
    if (seen.has(identity)) continue
    seen.add(identity)
    result.push({ tier: scope.tier, key: scope.key })
  }
  return result
}

/**
 * Shared serving scope ladder for Channel 1 and Channel 2.
 *
 * A concrete request admits global records plus every known containing scope. A test request
 * therefore sees product -> suite (when supplied) -> test, while sibling suites/tests remain
 * excluded by paired tier/key predicates. With no request, callers retain the product-wide scan
 * used by automatic caution matching.
 */
export function scopeLadderPredicate(
  options: ScopeLadderPredicateOptions,
): PreFilterPredicate {
  const clauses: string[] = []
  const binds: string[] = []

  if (options.productRow !== undefined) {
    clauses.push("(r.product = ? OR r.scope_tier = 'global')")
    binds.push(options.productRow)
  }

  const requested = options.requestedScope
  if (requested !== undefined) {
    if (requested.tier === 'global') {
      clauses.push("r.scope_tier = 'global'")
    } else {
      const scopes = distinctScopePairs([
        ...(options.productScope === undefined
          ? []
          : [{ tier: 'product' as const, key: options.productScope }]),
        ...(options.parentScopes ?? []),
        requested,
      ])
      const pairClauses = scopes.map(() => '(r.scope_tier = ? AND r.scope_key = ?)')
      clauses.push(`(r.scope_tier = 'global'${pairClauses.length === 0 ? '' : ` OR ${pairClauses.join(' OR ')}`})`)
      for (const scope of scopes) binds.push(scope.tier, scope.key)
    }
  }

  return {
    sql: clauses.length === 0 ? '1 = 1' : clauses.join('\nAND '),
    binds,
  }
}

export function preFilterPredicate(options: PreFilterOptions): PreFilterPredicate {
  const clauses = [
    ...(options.includeSuperseded === true
      ? []
      : ["r.status NOT IN ('deprecated', 'superseded')"]),
    "(r.product = ? OR r.scope_tier = 'global')",
    'r.scope_key IN (?, ?, ?, ?)',
  ]

  return {
    sql: clauses.join('\nAND '),
    binds: [
      options.product,
      options.testKey,
      options.suiteKey,
      options.productKey,
      options.globalKey,
    ],
  }
}
