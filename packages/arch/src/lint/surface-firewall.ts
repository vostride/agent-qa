import type { OwnershipContract } from '../contract-types.js'
import { classifySpecifier } from './extract-specifiers.js'
import type { SpecifierHit } from './extract-specifiers.js'
import { surfaceLedgerKey } from './surface-firewall-ledger.js'
import type { SurfaceLedgerEntry } from './surface-firewall-ledger.js'

// Membership here, not the declared class, arms the firewall.
export const FIREWALLED_SURFACE_DIRS = ['packages/cli', 'packages/mcp'] as const

// The function layer, the contract vocabulary and the composition root: sanctioned, not debt.
export const SURFACE_ALLOWED_INTERNAL_PACKAGES = [
  '@vostride/agent-qa-agent',
  '@vostride/agent-qa-agent-local',
  // Telemetry is composed at a host's root; the package publishes a port and one opt-out site.
  '@vostride/agent-qa-analytics',
  '@vostride/agent-qa-schema',
] as const

/**
 * Whole specifiers a firewalled surface may name although their package is not allowed. Core's
 * run-text output helper wraps what a surface prints and reads no data. The core root and every
 * other core subpath stay forbidden.
 */
export const SURFACE_ALLOWED_INTERNAL_SPECIFIERS = [
  '@vostride/agent-qa-core/run-text-output',
] as const

// Names are contract `packageName`s: the CLI publishes as `agent-qa`, not `@vostride/agent-qa-cli`.
export const EXPECTED_SURFACE_CLASS_PACKAGES = [
  '@vostride/agent-qa-dashboard',
  '@vostride/agent-qa-dashboard-ui',
  '@vostride/agent-qa-mcp',
  'agent-qa',
] as const

export interface SurfaceFirewallScan {
  packageDir: string
  hits: readonly SpecifierHit[]
}

function normalizeRepoPath(file: string): string {
  return file.replaceAll('\\', '/')
}

export function isFirewalledSurfaceDir(packageDir: string): boolean {
  return FIREWALLED_SURFACE_DIRS.includes(
    normalizeRepoPath(packageDir) as (typeof FIREWALLED_SURFACE_DIRS)[number],
  )
}

/**
 * Whole-specifier matching, never a substring test. `classifySpecifier` reduces a
 * specifier to its two-segment package name, so a subpath entry resolves to its own
 * package and a longer package name never collapses into a shorter one:
 * `agent-qa-safety-local` is not `agent-qa-safety`, and neither one is allow-listed
 * by the other. A `startsWith`/`includes` check would report both a false hit and —
 * far worse — a false PASS the moment the shorter name reappeared beside the longer.
 */
export function isForbiddenInternalSpecifier(specifier: string): boolean {
  const classified = classifySpecifier(specifier)
  if (classified.kind !== 'internal') {
    return false
  }
  if (
    SURFACE_ALLOWED_INTERNAL_SPECIFIERS.includes(
      specifier as (typeof SURFACE_ALLOWED_INTERNAL_SPECIFIERS)[number],
    )
  ) {
    return false
  }

  return !SURFACE_ALLOWED_INTERNAL_PACKAGES.includes(
    classified.pkgName as (typeof SURFACE_ALLOWED_INTERNAL_PACKAGES)[number],
  )
}

function surfaceDirForFile(file: string): string {
  const normalized = normalizeRepoPath(file)
  return (
    FIREWALLED_SURFACE_DIRS.find(dir => normalized.startsWith(`${dir}/`)) ?? 'ledger'
  )
}

// Per (file, specifier) pair, so a ledgered file that acquires a second forbidden import fails.
export function findSurfaceFirewallOffenders(
  hitsByPackage: readonly SurfaceFirewallScan[],
  ledger: readonly SurfaceLedgerEntry[],
): string[] {
  const offenders: string[] = []
  const ledgerKeys = new Set(ledger.map(surfaceLedgerKey))
  const coveredKeys = new Set<string>()

  for (const scan of hitsByPackage) {
    const packageDir = normalizeRepoPath(scan.packageDir)
    if (!isFirewalledSurfaceDir(packageDir)) {
      continue
    }

    for (const hit of scan.hits) {
      if (!isForbiddenInternalSpecifier(hit.specifier)) {
        continue
      }

      const file = normalizeRepoPath(hit.file)
      const key = surfaceLedgerKey({ file, specifier: hit.specifier })
      if (ledgerKeys.has(key)) {
        coveredKeys.add(key)
        continue
      }

      offenders.push(
        `${packageDir} | ${file}:${hit.line} | ${hit.specifier} | surface-firewall un-ledgered internal import`,
      )
    }
  }

  for (const entry of ledger) {
    const key = surfaceLedgerKey(entry)
    if (!coveredKeys.has(key)) {
      offenders.push(
        `${surfaceDirForFile(entry.file)} | ledger | ${key} | surface-firewall stale ledger entry`,
      )
    }
  }

  return offenders
}

// Arrival and departure are separate offenders, so the message names the mistake.
export function findSurfaceClassGoldenSetOffenders(
  contracts: readonly OwnershipContract[],
): string[] {
  const declared = new Set(
    contracts
      .filter(contract => contract.packageClasses.includes('surface'))
      .map(contract => contract.packageName),
  )
  const expected = new Set<string>(EXPECTED_SURFACE_CLASS_PACKAGES)
  const offenders: string[] = []

  for (const packageName of [...declared].sort()) {
    if (!expected.has(packageName)) {
      offenders.push(
        `surface-class-golden-set: ${packageName} declares surface but is absent the pinned set`,
      )
    }
  }

  for (const packageName of [...expected].sort()) {
    if (!declared.has(packageName)) {
      offenders.push(
        `surface-class-golden-set: ${packageName} is pinned as a surface but no longer declares the class`,
      )
    }
  }

  return offenders
}
