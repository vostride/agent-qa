import {
  NATIVE_STORE_DENYLIST,
  PROVIDER_SDK_FORBIDDEN_PREFIX,
} from '../contract-types.js'
import { inScopedHostBaseline } from '../core-host-scoped-baseline.js'
import type { ScopedHostBaselineEntry } from '../core-host-scoped-baseline.js'
import { HOST_EXTERNALS, matchesDenylistEntry } from './denylist.js'
import { classifySpecifier } from './extract-specifiers.js'
import type { LedgerEntry } from '../contract-types.js'
import type { SpecifierHit } from './extract-specifiers.js'

export function transitionalLeaks(hits: readonly SpecifierHit[]): SpecifierHit[] {
  return hits.filter(hit => {
    const classified = classifySpecifier(hit.specifier)
    if (classified.kind === 'node') {
      return true
    }

    return (
      classified.kind === 'external' &&
      (classified.pkgName.startsWith(PROVIDER_SDK_FORBIDDEN_PREFIX) ||
        HOST_EXTERNALS.has(classified.pkgName) ||
        NATIVE_STORE_DENYLIST.some(entry => matchesDenylistEntry(classified.pkgName, entry)))
    )
  })
}

export function applyLedger(
  leaks: readonly SpecifierHit[],
  ledger: readonly LedgerEntry[],
  baseline: ReadonlySet<string> = new Set<string>(),
  scoped: readonly ScopedHostBaselineEntry[] = [],
): string[] {
  const offenders: string[] = []
  const ledgerTargets = new Set(ledger.map(entry => entry.target))
  const hitTargets = new Set<string>()

  for (const leak of leaks) {
    const target = targetForLeak(leak)
    if (ledgerTargets.has(target)) {
      hitTargets.add(target)
      continue
    }

    if (baseline.has(target) || inScopedHostBaseline(leak, scoped)) {
      continue
    }

    offenders.push(
      `packages/core | ${leak.file}:${leak.line} | ${leak.specifier} | unwaived transitional leak`,
    )
  }

  for (const entry of ledger) {
    if (!hitTargets.has(entry.target)) {
      offenders.push(`packages/core | ledger | ${entry.target} | stale ledger entry`)
    }
  }

  return offenders
}

function targetForLeak(leak: SpecifierHit): string {
  const classified = classifySpecifier(leak.specifier)
  if (classified.kind === 'external') {
    return classified.pkgName
  }

  return leak.specifier
}
