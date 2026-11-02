import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { classifySpecifier } from './extract-specifiers.js'
import type { OwnershipContract } from '../contract-types.js'
import type { SpecifierHit } from './extract-specifiers.js'

export function findSetMismatchOffenders(
  label: string,
  actualValues: readonly string[],
  expectedValues: readonly string[],
): string[] {
  const actual = new Set(actualValues)
  const expected = new Set(expectedValues)
  const offenders: string[] = []

  for (const expectedValue of expected) {
    if (!actual.has(expectedValue)) {
      offenders.push(`${label}: missing ${expectedValue}`)
    }
  }

  for (const actualValue of actual) {
    if (!expected.has(actualValue)) {
      offenders.push(`${label}: unexpected ${actualValue}`)
    }
  }

  return offenders.sort()
}

export function findDepReconciliationOffenders(
  contract: OwnershipContract,
  hits: readonly SpecifierHit[],
  repoRoot: string,
): string[] {
  const realExternal = new Set<string>()
  const realInternal = new Set<string>()

  for (const hit of hits) {
    const classified = classifySpecifier(hit.specifier)
    if (classified.kind === 'external') {
      realExternal.add(classified.pkgName)
    } else if (classified.kind === 'internal') {
      realInternal.add(classified.pkgName)
    }
  }

  const packageJsonDeps = readExternalPackageJsonDependencies(repoRoot, contract.packageDir)

  return [
    ...findSetMismatchOffenders(
      `${contract.packageDir} external deps`,
      [...realExternal].sort(),
      [...contract.externalDependencies].sort(),
    ),
    ...findSetMismatchOffenders(
      `${contract.packageDir} internal deps`,
      [...realInternal].sort(),
      [...contract.internalDependencies].sort(),
    ),
    ...(contract.publishesSelfContainedBundle
      ? findSelfContainedBundleOffenders(contract, packageJsonDeps)
      : findSetMismatchOffenders(
          `${contract.packageDir} package.json vs contract`,
          packageJsonDeps.dependencies,
          [...contract.externalDependencies].sort(),
        )),
  ]
}

interface ExternalPackageJsonDependencies {
  dependencies: string[]
  devDependencies: string[]
}

function findSelfContainedBundleOffenders(
  contract: OwnershipContract,
  packageJsonDeps: ExternalPackageJsonDependencies,
): string[] {
  const label = contract.packageDir
  const devDependencies = new Set(packageJsonDeps.devDependencies)
  const missing = contract.externalDependencies.filter(
    dependency => !devDependencies.has(dependency),
  )

  return [
    ...missing.map(dependency => `${label} devDependencies vs contract: missing ${dependency}`),
    ...packageJsonDeps.dependencies.map(
      dependency => `${label} dependencies of a self-contained bundle: unexpected ${dependency}`,
    ),
  ].sort()
}

function readExternalPackageJsonDependencies(
  repoRoot: string,
  packageDir: string,
): ExternalPackageJsonDependencies {
  const packageJson: unknown = JSON.parse(
    readFileSync(join(repoRoot, packageDir, 'package.json'), 'utf8'),
  )
  if (typeof packageJson !== 'object' || packageJson === null) {
    return { dependencies: [], devDependencies: [] }
  }

  return {
    dependencies: externalPackageNames(
      'dependencies' in packageJson ? packageJson.dependencies : undefined,
    ),
    devDependencies: externalPackageNames(
      'devDependencies' in packageJson ? packageJson.devDependencies : undefined,
    ),
  }
}

function externalPackageNames(block: unknown): string[] {
  if (typeof block !== 'object' || block === null) {
    return []
  }

  return Object.keys(block)
    .filter(dependency => !dependency.startsWith('@vostride/agent-qa-'))
    .sort()
}
