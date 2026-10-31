import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  NATIVE_STORE_DENYLIST,
  PACKAGE_CLASS_RULES,
  PROVIDER_SDK_FORBIDDEN_PREFIX,
} from '../contract-types.js'
import { AGENT_QA_CORE_HOST_BASELINE } from '../core-host-baseline.js'
import type { OwnershipContract, PackageClass } from '../contract-types.js'
import { findClassRuleOffenders } from '../lint/classify-rule.js'
import {
  configFilesFor,
  extractSpecifiers,
  sourceFilesFor,
  specifiersInSource,
  type SpecifierHit,
} from '../lint/extract-specifiers.js'
import { applyLedger, transitionalLeaks } from '../lint/apply-ledger.js'
import { findDepReconciliationOffenders, findSetMismatchOffenders } from '../lint/reconcile-deps.js'
import { AGENT_QA_CORE_MIGRATION_LEDGER } from '../../../core/src/ownership-contract.js'
import { findCycleOffenders } from '../lint/walk-dag.js'
import { findDirectionOffenders } from '../lint/direction.js'
import {
  findKnowledgeWriteOffenders,
  WRITE_SURFACE_PACKAGES,
} from '../lint/knowledge-write.js'
import {
  findKnowledgeLocalWallOffenders,
  findKnowledgeWriterSingletonOffenders,
  findReaderCarveoutOffenders,
  KNOWLEDGE_READER_FILES,
  KNOWLEDGE_WRITER_ALLOWLIST,
  READER_CARVEOUT_SCANNED_DIRS,
} from '../lint/reader-carveout.js'
import {
  COMPOSITION_CARVEOUT_PACKAGE_DIR,
  findCompositionCarveoutOffenders,
  findCompositionCarveoutUnusedAllowances,
} from '../lint/composition-carveout.js'
import {
  RESUME_PATH_ENTRY_FILES,
  RESUME_PATH_PACKAGE_DIR,
  findResumePathModelFreeOffenders,
  resumePathModules,
} from '../lint/resume-path-model-free.js'
import {
  contractBearingDirs,
  findContractlessWorkspaceOffenders,
  workspaceMemberDirs,
} from '../lint/workspace-members.js'
import {
  EXPECTED_SURFACE_CLASS_PACKAGES,
  FIREWALLED_SURFACE_DIRS,
  findSurfaceClassGoldenSetOffenders,
  findSurfaceFirewallOffenders,
  isFirewalledSurfaceDir,
  SURFACE_ALLOWED_INTERNAL_PACKAGES,
  SURFACE_ALLOWED_INTERNAL_SPECIFIERS,
  type SurfaceFirewallScan,
} from '../lint/surface-firewall.js'
import {
  SURFACE_FIREWALL_LEDGER,
  type SurfaceLedgerEntry,
} from '../lint/surface-firewall-ledger.js'
import {
  normalizeRepoPath,
  parseModuleStatements,
  readClause,
  resolveRelative,
} from '../lint/evaluate-pin.js'
import {
  findStartRunAcquisitions,
  findStartRunPinOffenders,
  STARTRUN_PIN,
  type StartRunPinSource,
} from '../lint/startrun-pin.js'
import {
  AGENT_BARREL_FILE,
  EXPECTED_AGENT_BARREL_EXPORTS,
  EXPECTED_AGENT_BARREL_TYPE_EXPORTS,
  EXPECTED_AGENT_BARREL_VALUE_EXPORTS,
  findAgentBarrelOffenders,
  readAgentBarrelExports,
} from '../lint/agent-barrel.js'
import { ARCH_MANIFEST } from '../manifest.js'

const testDir = dirname(fileURLToPath(import.meta.url))
const packagesRoot = join(testDir, '..', '..', '..')
const repoRoot = join(packagesRoot, '..')

function hitsFromFiles(files: readonly string[]): SpecifierHit[] {
  return files
    .flatMap(extractSpecifiers)
    .map(hit => ({
      ...hit,
      file: relative(repoRoot, hit.file),
    }))
}

function packageSourceHits(contract: OwnershipContract): SpecifierHit[] {
  return hitsFromFiles(sourceFilesFor(contract.packageDir, repoRoot))
}

// Through `sourceFilesFor`, which drops `__tests__`, so a fixture string is never a production hit.
function pinSourcesFor(packageDir: string): StartRunPinSource[] {
  return sourceFilesFor(packageDir, repoRoot).map(file => ({
    file: relative(repoRoot, file).replaceAll('\\', '/'),
    source: readFileSync(file, 'utf8'),
  }))
}

function readRepoFile(repoRelativePath: string): string {
  return readFileSync(join(repoRoot, repoRelativePath), 'utf8')
}

function packageAllHits(contract: OwnershipContract): SpecifierHit[] {
  return hitsFromFiles([
    ...sourceFilesFor(contract.packageDir, repoRoot),
    ...configFilesFor(contract.packageDir, repoRoot),
  ])
}

function fixtureContract(overrides: Partial<OwnershipContract> = {}): OwnershipContract {
  return {
    packageName: '@vostride/agent-qa-fixture',
    packageDir: 'packages/fixture',
    packageClasses: ['providerNeutral'],
    allowedResponsibilities: [],
    forbiddenResponsibilities: [],
    externalDependencies: [],
    internalDependencies: [],
    ...overrides,
  }
}

function fixtureHit(specifier: string, overrides: Partial<SpecifierHit> = {}): SpecifierHit {
  return {
    specifier,
    file: 'fixture.ts',
    line: 1,
    ...overrides,
  }
}

function fixtureLedgerEntry(target: string) {
  return {
    rule: 'providerNeutral' as PackageClass,
    target,
    clearedBy: 'fixture',
    reason: 'fixture ledger entry',
  }
}

const FIXTURE_SURFACE_FILE = 'packages/cli/src/fixture.ts'

function surfaceLedgerFixture(specifier: string, file = FIXTURE_SURFACE_FILE): SurfaceLedgerEntry {
  return { file, specifier, clearedBy: 'fixture', reason: 'fixture surface ledger entry' }
}

function surfaceScan(
  hits: readonly SpecifierHit[],
  packageDir = 'packages/cli',
): SurfaceFirewallScan[] {
  return [{ packageDir, hits }]
}

function surfaceHit(specifier: string, line = 1, file = FIXTURE_SURFACE_FILE): SpecifierHit {
  return { specifier, file, line }
}

function surfaceClassContracts(packageNames: readonly string[]): OwnershipContract[] {
  return packageNames.map(packageName =>
    fixtureContract({
      packageName,
      packageDir: `packages/${packageName.replace('@vostride/', '')}`,
      packageClasses: ['surface'],
    }),
  )
}

describe('arch lint class rules and dep contracts', () => {
  it('every contract-bearing package satisfies its class rules and dep contract', () => {
    const offenders: string[] = []
    const contracts: readonly OwnershipContract[] = ARCH_MANIFEST.packages
    const surfaceScans: SurfaceFirewallScan[] = []
    const pinSources: StartRunPinSource[] = []
    // "Exactly one importer" is a property of the workspace, not of any one package, so the
    // reader-scanned hits are accumulated and judged once after the loop.
    const readerScannedHits: SpecifierHit[] = []

    for (const contract of contracts) {
      pinSources.push(...pinSourcesFor(contract.packageDir))
      const sourceHits = packageSourceHits(contract)
      const allHits = packageAllHits(contract)

      if (contract.packageClasses.includes('transitional')) {
        offenders.push(
          ...applyLedger(
            transitionalLeaks(allHits),
            contract.ledger ?? [],
            new Set(AGENT_QA_CORE_HOST_BASELINE),
          ),
        )
      } else {
        offenders.push(...findClassRuleOffenders(contract, allHits))
      }

      offenders.push(...findDepReconciliationOffenders(contract, sourceHits, repoRoot))
      if (READER_CARVEOUT_SCANNED_DIRS.includes(
        contract.packageDir as (typeof READER_CARVEOUT_SCANNED_DIRS)[number],
      )) {
        offenders.push(...findReaderCarveoutOffenders(sourceHits))
        readerScannedHits.push(...sourceHits)
      }
      offenders.push(...findCompositionCarveoutOffenders(contract, sourceHits))
      offenders.push(...findCompositionCarveoutUnusedAllowances(contract, sourceHits))
      // Takes whole modules: a file with no imports still has to resolve in the import closure.
      if (contract.packageDir === RESUME_PATH_PACKAGE_DIR) {
        offenders.push(
          ...findResumePathModelFreeOffenders(resumePathModules(contract.packageDir, repoRoot)),
        )
      }
      if (isFirewalledSurfaceDir(contract.packageDir)) {
        surfaceScans.push({ packageDir: contract.packageDir, hits: sourceHits })
      }
      offenders.push(...findKnowledgeLocalWallOffenders(contract, sourceHits))
    }

    offenders.push(...findKnowledgeWriterSingletonOffenders(readerScannedHits))
    offenders.push(...findSurfaceFirewallOffenders(surfaceScans, SURFACE_FIREWALL_LEDGER))
    offenders.push(...findSurfaceClassGoldenSetOffenders(contracts))
    offenders.push(...findStartRunPinOffenders(pinSources))
    offenders.push(...findAgentBarrelOffenders(readRepoFile(AGENT_BARREL_FILE)))
    offenders.push(...findCycleOffenders(contracts))
    offenders.push(...findDirectionOffenders(contracts))
    offenders.push(...findKnowledgeWriteOffenders(contracts))
    offenders.push(
      ...findContractlessWorkspaceOffenders(
        workspaceMemberDirs(repoRoot),
        contractBearingDirs(repoRoot),
      ),
    )
    // An unregistered contract skips its class and dependency rules, so both sets must match.
    offenders.push(
      ...findSetMismatchOffenders(
        'manifest vs on-disk contracts',
        contracts.map(contract => contract.packageDir),
        contractBearingDirs(repoRoot),
      ),
    )

    expect(offenders).toEqual([])
    // Walks every contract-bearing package, so its cost tracks workspace size.
  }, 30_000)
})

describe('arch lint held-out fixtures', () => {
  it('held-out workspace-member contract check rejects a contract-less member', () => {
    expect(
      findContractlessWorkspaceOffenders(
        ['packages/with-contract', 'packages/without-contract'],
        ['packages/with-contract'],
      ),
    ).toEqual([
      'packages/without-contract: workspace package missing src/ownership-contract.ts',
    ])
  })

  it('held-out registration equality fails in both drift directions', () => {
    expect(
      findSetMismatchOffenders(
        'manifest vs on-disk contracts',
        ['packages/registered'],
        ['packages/registered', 'packages/analytics'],
      ),
    ).toEqual(['manifest vs on-disk contracts: missing packages/analytics'])

    expect(
      findSetMismatchOffenders(
        'manifest vs on-disk contracts',
        ['packages/registered', 'packages/deleted'],
        ['packages/registered'],
      ),
    ).toEqual(['manifest vs on-disk contracts: unexpected packages/deleted'])
  })

  // A rule nobody invokes keeps its own unit tests passing forever. Source-anchored on this file,
  // the convention the composition carve-out already uses one describe block down.
  it('the aggregate invokes the registration equality against the real manifest', () => {
    const aggregateSource = readFileSync(fileURLToPath(import.meta.url), 'utf8')
    const aggregate = aggregateSource.slice(
      aggregateSource.indexOf('every contract-bearing package satisfies'),
      aggregateSource.indexOf('expect(offenders).toEqual([])'),
    )

    expect(aggregate).toContain("findSetMismatchOffenders(\n        'manifest vs on-disk contracts'")
    expect(contractBearingDirs(repoRoot)).toContain('packages/analytics')
    expect(ARCH_MANIFEST.packages.map(contract => contract.packageDir)).toContain(
      'packages/analytics',
    )
  })

  it('held-out provider firewall rejects provider SDKs and accepts the ai substrate', () => {
    expect(PACKAGE_CLASS_RULES.providerNeutral.allowed).toContain('ai')

    expect(
      findClassRuleOffenders(
        fixtureContract({ packageClasses: ['providerNeutral'] }),
        [fixtureHit(`${PROVIDER_SDK_FORBIDDEN_PREFIX}openai`)],
      ),
    ).toEqual([
      `packages/fixture | fixture.ts:1 | ${PROVIDER_SDK_FORBIDDEN_PREFIX}openai | providerNeutral forbids @ai-sdk/*`,
    ])

    expect(
      findClassRuleOffenders(
        fixtureContract({ packageClasses: ['providerNeutral'] }),
        [fixtureHit('ai')],
      ),
    ).toEqual([])
  })

  it('held-out knowledge-write firewall rejects neutral packages that depend on the agent write surface', () => {
    const neutralContract = fixtureContract({
      packageName: '@vostride/agent-qa-neutral',
      packageDir: 'packages/neutral',
      packageClasses: ['providerNeutral', 'storageNeutral'],
      internalDependencies: [WRITE_SURFACE_PACKAGES[0]],
    })

    expect(findKnowledgeWriteOffenders([neutralContract])).toEqual([
      `knowledge-write: @vostride/agent-qa-neutral (providerNeutral) ⇏ ${WRITE_SURFACE_PACKAGES[0]} (write surface)`,
    ])
  })

  it('held-out knowledge-write firewall accepts the schema-only runner shape', () => {
    const runnerContract = fixtureContract({
      packageName: '@vostride/agent-qa-runner',
      packageDir: 'packages/runner',
      packageClasses: ['providerNeutral', 'storageNeutral'],
      internalDependencies: ['@vostride/agent-qa-schema'],
    })

    expect(findKnowledgeWriteOffenders([runnerContract])).toEqual([])
  })

  it('held-out storage seam rejects native store packages and Node filesystem imports', () => {
    expect(NATIVE_STORE_DENYLIST).toContain('better-sqlite3')

    expect(
      findClassRuleOffenders(
        fixtureContract({ packageClasses: ['storageNeutral'] }),
        [fixtureHit('better-sqlite3'), fixtureHit('node:fs', { line: 2 })],
      ),
    ).toEqual([
      'packages/fixture | fixture.ts:1 | better-sqlite3 | storageNeutral forbids better-sqlite3',
      'packages/fixture | fixture.ts:2 | node:fs | storageNeutral forbids node:fs',
    ])
  })

  it('held-out safety class set rejects provider SDKs and direct filesystem imports', () => {
    expect(PACKAGE_CLASS_RULES.providerNeutral.allowed).toContain('ai')

    const safetyContract = fixtureContract({
      packageClasses: ['providerNeutral', 'storageNeutral'],
    })

    expect(
      findClassRuleOffenders(safetyContract, [
        fixtureHit(`${PROVIDER_SDK_FORBIDDEN_PREFIX}openai`),
        fixtureHit('node:fs', { line: 2 }),
      ]),
    ).toEqual([
      `packages/fixture | fixture.ts:1 | ${PROVIDER_SDK_FORBIDDEN_PREFIX}openai | providerNeutral forbids ${PROVIDER_SDK_FORBIDDEN_PREFIX}*`,
      'packages/fixture | fixture.ts:2 | node:fs | storageNeutral forbids node:fs',
    ])

    expect(findClassRuleOffenders(safetyContract, [fixtureHit('ai')])).toEqual([])
  })

  it('held-out browserSafe seam rejects Node imports while schema real scan stays clean', () => {
    expect(
      findClassRuleOffenders(
        fixtureContract({ packageClasses: ['browserSafe'] }),
        [fixtureHit('node:path')],
      ),
    ).toEqual([
      'packages/fixture | fixture.ts:1 | node:path | browserSafe forbids node:*',
    ])

    const schemaContract = ARCH_MANIFEST.packages.find(
      contract => contract.packageDir === 'packages/schema',
    )
    expect(schemaContract).toBeDefined()
    expect(findClassRuleOffenders(schemaContract!, packageAllHits(schemaContract!))).toEqual([])
  })

  it('held-out dep reconciliation reports missing and unexpected dependency drift', () => {
    expect(
      findDepReconciliationOffenders(
        fixtureContract({
          packageDir: 'packages/arch',
          // This fixture reads arch's real manifest, which declares no runtime dependency.
          externalDependencies: ['declared-only'],
        }),
        [fixtureHit('runtime-only')],
        repoRoot,
      ),
    ).toEqual([
      'packages/arch external deps: missing declared-only',
      'packages/arch external deps: unexpected runtime-only',
      'packages/arch package.json vs contract: missing declared-only',
    ])
  })

  it('held-out config hits feed class rules without becoming runtime dep drift', () => {
    const configAwareContract = fixtureContract({
      packageDir: 'packages/arch',
      packageClasses: ['browserSafe'],
    })
    const configHits = [
      fixtureHit('node:fs', { file: 'packages/arch/vitest.config.ts' }),
      fixtureHit('tsdown', { file: 'packages/arch/tsdown.config.ts', line: 2 }),
      fixtureHit('vitest/config', { file: 'packages/arch/vitest.config.ts', line: 3 }),
    ]

    expect(findClassRuleOffenders(configAwareContract, configHits)).toEqual([
      'packages/arch | packages/arch/vitest.config.ts:1 | node:fs | browserSafe forbids node:*',
    ])
    expect(findDepReconciliationOffenders(configAwareContract, [], repoRoot)).toEqual([])
  })

  it('held-out DAG walk reports synthetic cycles and accepts acyclic contracts', () => {
    const packageA = fixtureContract({
      packageName: '@vostride/agent-qa-a',
      packageDir: 'packages/a',
      internalDependencies: ['@vostride/agent-qa-b'],
    })
    const packageB = fixtureContract({
      packageName: '@vostride/agent-qa-b',
      packageDir: 'packages/b',
      internalDependencies: ['@vostride/agent-qa-a'],
    })

    expect(findCycleOffenders([packageA, packageB])).toEqual([
      'cycle: @vostride/agent-qa-a -> @vostride/agent-qa-b -> @vostride/agent-qa-a',
    ])
    expect(findCycleOffenders([packageA, fixtureContract({
      packageName: '@vostride/agent-qa-b',
      packageDir: 'packages/b',
    })])).toEqual([])
  })

  it('held-out direction firewall rejects neutral to storageImplementation and accepts adapter to port', () => {
    const neutral = fixtureContract({
      packageName: '@vostride/agent-qa-neutral',
      packageDir: 'packages/neutral',
      packageClasses: ['storageNeutral'],
      internalDependencies: ['@vostride/agent-qa-local'],
    })
    const local = fixtureContract({
      packageName: '@vostride/agent-qa-local',
      packageDir: 'packages/local',
      packageClasses: ['storageImplementation'],
      internalDependencies: ['@vostride/agent-qa-neutral'],
    })

    expect(findDirectionOffenders([neutral, local])).toEqual([
      'direction: @vostride/agent-qa-neutral (storageNeutral) ⇏ @vostride/agent-qa-local (storageImplementation)',
    ])
    expect(findDirectionOffenders([local])).toEqual([])
  })

  it('held-out core ledger reports uncovered and stale entries while accepting covered leaks', () => {
    expect(
      applyLedger(
        transitionalLeaks([fixtureHit(`${PROVIDER_SDK_FORBIDDEN_PREFIX}openai`)]),
        [],
      ),
    ).toEqual([
      `packages/core | fixture.ts:1 | ${PROVIDER_SDK_FORBIDDEN_PREFIX}openai | unwaived transitional leak`,
    ])

    expect(applyLedger([], [fixtureLedgerEntry('sharp')])).toEqual([
      'packages/core | ledger | sharp | stale ledger entry',
    ])

    expect(
      applyLedger(
        transitionalLeaks([fixtureHit(`${PROVIDER_SDK_FORBIDDEN_PREFIX}openai`)]),
        [fixtureLedgerEntry(`${PROVIDER_SDK_FORBIDDEN_PREFIX}openai`)],
      ),
    ).toEqual([])
  })

  it('held-out core ratchet rejects new off-baseline node and native-store imports', () => {
    expect(
      applyLedger(
        transitionalLeaks([
          fixtureHit('node:dgram'),
          fixtureHit('better-sqlite3', { line: 2 }),
        ]),
        AGENT_QA_CORE_MIGRATION_LEDGER,
        new Set(AGENT_QA_CORE_HOST_BASELINE),
      ),
    ).toEqual([
      'packages/core | fixture.ts:1 | node:dgram | unwaived transitional leak',
      'packages/core | fixture.ts:2 | better-sqlite3 | unwaived transitional leak',
    ])
  })
})

describe('arch lint surface firewall held-out fixtures', () => {
  it('held-out firewall reports an un-ledgered internal import and accepts the allow-list', () => {
    expect(
      findSurfaceFirewallOffenders(
        surfaceScan([surfaceHit('@vostride/agent-qa-runner-local', 7)]),
        [],
      ),
    ).toEqual([
      `packages/cli | ${FIXTURE_SURFACE_FILE}:7 | @vostride/agent-qa-runner-local | surface-firewall un-ledgered internal import`,
    ])

    expect(
      findSurfaceFirewallOffenders(
        surfaceScan(SURFACE_ALLOWED_INTERNAL_PACKAGES.map(specifier => surfaceHit(specifier))),
        [],
      ),
    ).toEqual([])
  })

  it('held-out firewall admits core\'s run-text output subpath and nothing else of core', () => {
    expect(
      findSurfaceFirewallOffenders(
        surfaceScan([surfaceHit('@vostride/agent-qa-core/run-text-output', 3)]),
        [],
      ),
    ).toEqual([])

    expect(
      findSurfaceFirewallOffenders(
        surfaceScan([
          surfaceHit('@vostride/agent-qa-core', 4),
          surfaceHit('@vostride/agent-qa-core/logging', 5),
          surfaceHit('@vostride/agent-qa-core/run-text-output/extra', 6),
          surfaceHit('@vostride/agent-qa-core/run-text-output.js', 7),
        ]),
        [],
      ),
    ).toEqual([
      `packages/cli | ${FIXTURE_SURFACE_FILE}:4 | @vostride/agent-qa-core | surface-firewall un-ledgered internal import`,
      `packages/cli | ${FIXTURE_SURFACE_FILE}:5 | @vostride/agent-qa-core/logging | surface-firewall un-ledgered internal import`,
      `packages/cli | ${FIXTURE_SURFACE_FILE}:6 | @vostride/agent-qa-core/run-text-output/extra | surface-firewall un-ledgered internal import`,
      `packages/cli | ${FIXTURE_SURFACE_FILE}:7 | @vostride/agent-qa-core/run-text-output.js | surface-firewall un-ledgered internal import`,
    ])
  })

  it('held-out firewall leaves non-firewalled surfaces alone', () => {
    expect(FIREWALLED_SURFACE_DIRS).toEqual(['packages/cli', 'packages/mcp'])
    expect(EXPECTED_SURFACE_CLASS_PACKAGES).toContain('@vostride/agent-qa-dashboard')

    expect(
      findSurfaceFirewallOffenders(
        surfaceScan(
          [surfaceHit('@vostride/agent-qa-runner-local', 3, 'packages/dashboard-server/src/x.ts')],
          'packages/dashboard-server',
        ),
        [],
      ),
    ).toEqual([])
  })

  it('held-out firewall exempts only the ledgered pair, never the whole file', () => {
    const ledger = [surfaceLedgerFixture('@vostride/agent-qa-runner-local')]
    const ledgeredHit = surfaceHit('@vostride/agent-qa-runner-local', 7)

    expect(findSurfaceFirewallOffenders(surfaceScan([ledgeredHit]), ledger)).toEqual([])

    expect(
      findSurfaceFirewallOffenders(
        surfaceScan([ledgeredHit, surfaceHit('@vostride/agent-qa-core', 9)]),
        ledger,
      ),
    ).toEqual([
      `packages/cli | ${FIXTURE_SURFACE_FILE}:9 | @vostride/agent-qa-core | surface-firewall un-ledgered internal import`,
    ])
  })

  it('held-out firewall reports a ledger entry whose leak is gone as stale (self-shrinking)', () => {
    expect(
      findSurfaceFirewallOffenders(
        surfaceScan([surfaceHit('@vostride/agent-qa-core', 4)]),
        [
          surfaceLedgerFixture('@vostride/agent-qa-core'),
          surfaceLedgerFixture('@vostride/agent-qa-runner-local'),
        ],
      ),
    ).toEqual([
      `packages/cli | ledger | ${FIXTURE_SURFACE_FILE} :: @vostride/agent-qa-runner-local | surface-firewall stale ledger entry`,
    ])
  })

  it('held-out firewall matches whole specifiers, never substrings', () => {
    const safetyLocalLedger = [surfaceLedgerFixture('@vostride/agent-qa-safety-local')]
    expect(
      findSurfaceFirewallOffenders(
        surfaceScan([
          surfaceHit('@vostride/agent-qa-safety-local', 5),
          surfaceHit('@vostride/agent-qa-safety', 6),
        ]),
        safetyLocalLedger,
      ),
    ).toEqual([
      `packages/cli | ${FIXTURE_SURFACE_FILE}:6 | @vostride/agent-qa-safety | surface-firewall un-ledgered internal import`,
    ])

    const readerLedger = [surfaceLedgerFixture('@vostride/agent-qa-knowledge-local/reader')]
    expect(
      findSurfaceFirewallOffenders(
        surfaceScan([
          surfaceHit('@vostride/agent-qa-knowledge-local/reader', 5),
          surfaceHit('@vostride/agent-qa-knowledge-local', 6),
        ]),
        readerLedger,
      ),
    ).toEqual([
      `packages/cli | ${FIXTURE_SURFACE_FILE}:6 | @vostride/agent-qa-knowledge-local | surface-firewall un-ledgered internal import`,
    ])

    const mainLedger = [surfaceLedgerFixture('@vostride/agent-qa-knowledge-local')]
    expect(
      findSurfaceFirewallOffenders(
        surfaceScan([
          surfaceHit('@vostride/agent-qa-knowledge-local', 5),
          surfaceHit('@vostride/agent-qa-knowledge-local/reader', 6),
        ]),
        mainLedger,
      ),
    ).toEqual([
      `packages/cli | ${FIXTURE_SURFACE_FILE}:6 | @vostride/agent-qa-knowledge-local/reader | surface-firewall un-ledgered internal import`,
    ])
  })

  it('held-out firewall counts a type-only import as a violation', () => {
    const source = [
      'import { Command } from "commander"',
      'import type { AuditSink } from "@vostride/agent-qa-safety"',
      '// a comment naming @vostride/agent-qa-runner is not an import',
    ].join('\n')
    const hits = specifiersInSource(source, FIXTURE_SURFACE_FILE)

    expect(hits.map(hit => hit.specifier)).toEqual(['commander', '@vostride/agent-qa-safety'])
    expect(findSurfaceFirewallOffenders(surfaceScan(hits), [])).toEqual([
      `packages/cli | ${FIXTURE_SURFACE_FILE}:2 | @vostride/agent-qa-safety | surface-firewall un-ledgered internal import`,
    ])
  })

  it('held-out golden surface set fails in both drift directions', () => {
    expect(
      findSurfaceClassGoldenSetOffenders(surfaceClassContracts(EXPECTED_SURFACE_CLASS_PACKAGES)),
    ).toEqual([])

    expect(
      findSurfaceClassGoldenSetOffenders(
        surfaceClassContracts([...EXPECTED_SURFACE_CLASS_PACKAGES, '@vostride/agent-qa-chat']),
      ),
    ).toEqual([
      'surface-class-golden-set: @vostride/agent-qa-chat declares surface but is absent the pinned set',
    ])

    expect(
      findSurfaceClassGoldenSetOffenders(
        surfaceClassContracts(
          EXPECTED_SURFACE_CLASS_PACKAGES.filter(name => name !== '@vostride/agent-qa-mcp'),
        ),
      ),
    ).toEqual([
      'surface-class-golden-set: @vostride/agent-qa-mcp is pinned as a surface but no longer declares the class',
    ])
  })

  it('the shipped ledger stays exact, dated, and closed to the newer surface files', () => {
    const newerSurfaceFiles = [
      'packages/cli/src/commands/fn.ts',
      'packages/cli/src/composition/masked-config.ts',
    ]

    for (const entry of SURFACE_FIREWALL_LEDGER) {
      expect(entry.clearedBy.trim()).not.toEqual('')
      expect(entry.reason.trim()).not.toEqual('')
      expect(entry.file.endsWith('/')).toBe(false)
      expect(entry.file).toMatch(/\.(ts|tsx|js|mjs|cjs|css)$/)
      expect(FIREWALLED_SURFACE_DIRS.some(dir => entry.file.startsWith(`${dir}/`))).toBe(true)
      expect(newerSurfaceFiles).not.toContain(entry.file)
    }

    const keys = SURFACE_FIREWALL_LEDGER.map(entry => `${entry.file} :: ${entry.specifier}`)
    expect(new Set(keys).size).toEqual(keys.length)
  })
})

describe('arch lint composition carve-out registration and scope', () => {
  // The carve-out's own behaviour is unit-tested beside the rule. What can only be checked here is
  // that the aggregate actually CALLS it: a rule nobody invokes passes every build, and its unit
  // tests keep passing too, so nothing anywhere goes red. Source-anchored on this file, the
  // wm-flush delegate-anchor convention.
  it('the aggregate invokes both directions of the carve-out', () => {
    const aggregateSource = readFileSync(fileURLToPath(import.meta.url), 'utf8')
    const aggregate = aggregateSource.slice(
      aggregateSource.indexOf('every contract-bearing package satisfies'),
      aggregateSource.indexOf('expect(offenders).toEqual([])'),
    )

    expect(aggregate).toContain('findCompositionCarveoutOffenders(contract, sourceHits)')
    expect(aggregate).toContain('findCompositionCarveoutUnusedAllowances(contract, sourceHits)')
    expect(aggregate).toContain('findReaderCarveoutOffenders(sourceHits)')
    expect(aggregate).toContain('findKnowledgeWriterSingletonOffenders(readerScannedHits)')
    expect(aggregate).toContain(
      'findResumePathModelFreeOffenders(resumePathModules(contract.packageDir, repoRoot))',
    )
  })

  it('guards a package that is actually contract-bearing and scanned', () => {
    const guarded = ARCH_MANIFEST.packages.find(
      contract => contract.packageDir === COMPOSITION_CARVEOUT_PACKAGE_DIR,
    )
    expect(guarded).toBeDefined()
    expect(sourceFilesFor(COMPOSITION_CARVEOUT_PACKAGE_DIR, repoRoot).length).toBeGreaterThan(0)
  })

  // A path-keyed pin whose path moves matches nothing, so the prefix must name a real directory.
  it('the writer allowance is one entry, and it points inside a scanned package that exists', () => {
    expect([...KNOWLEDGE_WRITER_ALLOWLIST]).toEqual(['packages/agent-local/src/composition/'])

    for (const entry of KNOWLEDGE_WRITER_ALLOWLIST) {
      expect(existsSync(join(repoRoot, entry))).toBe(true)
      expect(
        READER_CARVEOUT_SCANNED_DIRS.some(dir => entry.startsWith(`${dir}/`)),
      ).toBe(true)
    }
  })

  // A pin left at a moved file matches nothing, so this checks the pin against the real tree.
  it('the resume-path pin points at files that exist inside a contract-bearing package', () => {
    expect([...RESUME_PATH_ENTRY_FILES]).toEqual([
      'packages/agent-local/src/composition/compose-job-recovery.ts',
    ])
    const walked = ARCH_MANIFEST.packages.find(
      (contract) => contract.packageDir === RESUME_PATH_PACKAGE_DIR,
    )
    expect(walked).toBeDefined()
    for (const entry of RESUME_PATH_ENTRY_FILES) {
      expect(existsSync(join(repoRoot, entry))).toBe(true)
      expect(entry.startsWith(`${RESUME_PATH_PACKAGE_DIR}/`)).toBe(true)
    }
    // The scanned set the aggregate hands the rule is non-empty and contains the pinned entry —
    // the check that separates "no offender" from "nothing was read".
    const scanned = resumePathModules(RESUME_PATH_PACKAGE_DIR, repoRoot).map(
      (module) => module.file,
    )
    expect(scanned.length).toBeGreaterThan(0)
    for (const entry of RESUME_PATH_ENTRY_FILES) expect(scanned).toContain(entry)
  })

  it('every pinned reader file exists and sits inside a scanned package', () => {
    for (const file of KNOWLEDGE_READER_FILES) {
      expect(existsSync(join(repoRoot, file))).toBe(true)
      expect(
        READER_CARVEOUT_SCANNED_DIRS.some(dir => file.startsWith(`${dir}/`)),
      ).toBe(true)
    }
  })

  // Pinned by equality, so a new entry is a visible edit to this list.
  it('the surface allow-list is exactly the function layer, the vocabulary, the composition root and analytics', () => {
    expect([...SURFACE_ALLOWED_INTERNAL_PACKAGES]).toEqual([
      '@vostride/agent-qa-agent',
      '@vostride/agent-qa-agent-local',
      // Telemetry is a host concern: a host composes it at its root and holds a port.
      '@vostride/agent-qa-analytics',
      '@vostride/agent-qa-schema',
    ])
  })

  it('the surface specifier allowance is exactly core\'s run-text output subpath', () => {
    expect([...SURFACE_ALLOWED_INTERNAL_SPECIFIERS]).toEqual([
      '@vostride/agent-qa-core/run-text-output',
    ])
  })
})

const RETIRED_GATE_MODULES = [
  'packages/safety/src/policy/gate.ts',
  'packages/safety/src/policy/gate-hook.ts',
  'packages/safety/src/policy/scope.ts',
  'packages/safety/src/ports/policy-ports.ts',
] as const
const SAFETY_SPECIFIER = '@vostride/agent-qa-safety'
// The names the gate published as VALUES. A production file importing any of them from the safety
// barrel, or anything at all from a retired gate module path, would be a gate acquisition.
const RETIRED_GATE_VALUES = [
  'evaluate',
  'resolveAsk',
  'baseVerdict',
  'buildExecutionAuditRow',
  'createPolicyGateToolCallHook',
  'requiresFailClosed',
  'NO_STANDING_APPROVALS',
  'DENY_CONFIRM',
  'scopeMatches',
  'grantCovers',
] as const
// The former call-sites. They stay named so the census proves the acquisitions left WITH their
// pin entries.
const FORMER_INVOKE = 'packages/agent/src/functions/invoke.ts'
const FORMER_RUN_CORE = 'packages/agent-local/src/composition/run-invocation-core.ts'
const FORMER_GATE_HOOK = 'packages/safety/src/policy/gate-hook.ts'
const SAFETY_BARREL = 'packages/safety/src/index.ts'

/** Every statement in one file that would acquire a retired gate, by the scanner the pins share. */
function gateAcquisitions(source: string, file: string): string[] {
  const hits: string[] = []
  for (const statement of parseModuleStatements(source)) {
    const shape = readClause(statement.clause)
    if (shape.typeOnly) continue
    const fromBarrel = statement.specifier === SAFETY_SPECIFIER
      || statement.specifier.startsWith(`${SAFETY_SPECIFIER}/`)
    const fromRetiredModule = statement.specifier.startsWith('.')
      && RETIRED_GATE_MODULES.some(
        (module) => `${resolveRelative(file, statement.specifier)}.ts` === module,
      )
    if (fromRetiredModule) {
      hits.push(`${file}:${statement.line} ⇏ ${statement.specifier}`)
      continue
    }
    if (fromBarrel && shape.valueNames.some((name) => (RETIRED_GATE_VALUES as readonly string[]).includes(name))) {
      hits.push(`${file}:${statement.line} ⇏ ${statement.specifier}`)
    }
  }
  return hits
}

function startRunPinnedFixtures(): StartRunPinSource[] {
  return [
    { file: 'packages/runner/src/index.ts', source: 'export { startRun } from "./run/shell.js"' },
    { file: FORMER_RUN_CORE, source: 'import { startRun } from "@vostride/agent-qa-runner"' },
  ]
}

function startRunScan(...extra: readonly StartRunPinSource[]): string[] {
  return findStartRunPinOffenders([...startRunPinnedFixtures(), ...extra])
}

describe('arch lint run pins after the gate', () => {
  it('the gate pin, the gate modules and every production gate acquisition are gone', () => {
    // The pin module keeps only the shared scanner: no permitted set, no finder, no offender check.
    const pinModule = readRepoFile('packages/arch/src/lint/evaluate-pin.ts')
    expect(pinModule).not.toMatch(/export const EVALUATE_PIN\b/)
    expect(pinModule).not.toMatch(/export function findEvaluate/)
    for (const module of RETIRED_GATE_MODULES) {
      expect(existsSync(join(repoRoot, module)), module).toBe(false)
    }

    // The census, over EVERY production source the manifest ranges (tests are dropped by
    // `sourceFilesFor`): nothing imports a retired gate value from the safety barrel and nothing
    // imports a retired gate module by path.
    const sources = ARCH_MANIFEST.packages.flatMap((contract) => pinSourcesFor(contract.packageDir))
    expect(sources.length).toBeGreaterThan(500)
    expect(sources.map((entry) => entry.file)).toContain(SAFETY_BARREL)
    expect(sources.flatMap((entry) => gateAcquisitions(entry.source, entry.file))).toEqual([])

    // The barrel publishes no retired gate value. Read as SOURCE, so the cell needs no build.
    const barrelValues = parseModuleStatements(readRepoFile(SAFETY_BARREL))
      .flatMap((statement) => readClause(statement.clause).valueNames)
    for (const retired of RETIRED_GATE_VALUES) {
      expect(barrelValues, retired).not.toContain(retired)
    }
    // Non-vacuity: the census reads the barrel's real values.
    expect(barrelValues).toContain('createMaskingMiddleware')
  })

  it('the census fires on a named gate value from the barrel, aliased or multi-line, and on any static import or re-export of a retired gate module', () => {
    // Held-out fixtures, so the absence above is a measurement and not a scanner that sees nothing.
    expect(gateAcquisitions('import { evaluate } from "@vostride/agent-qa-safety"', 'packages/runner/src/x.ts'))
      .toEqual(['packages/runner/src/x.ts:1 ⇏ @vostride/agent-qa-safety'])
    expect(gateAcquisitions('import { evaluate as runGate } from "@vostride/agent-qa-safety"', 'packages/runner/src/x.ts'))
      .toHaveLength(1)
    expect(gateAcquisitions('export { evaluate } from "./policy/gate"', SAFETY_BARREL)).toEqual([
      `${SAFETY_BARREL}:1 ⇏ ./policy/gate`,
    ])
    expect(gateAcquisitions('import { resolveAsk } from "../policy/gate"', 'packages/safety/src/hooks/x.ts'))
      .toHaveLength(1)
    expect(gateAcquisitions('import { createPolicyGateToolCallHook } from "../policy/gate-hook"', 'packages/safety/src/hooks/x.ts'))
      .toHaveLength(1)
    expect(gateAcquisitions(['import {', '  createMaskingMiddleware,', '  evaluate,', '} from "@vostride/agent-qa-safety"'].join('\n'), 'packages/mcp/src/x.ts'))
      .toHaveLength(1)
    // And it stays quiet on what is not an acquisition: a type, a comment, a call token, an
    // unrelated value from the same barrel.
    expect(gateAcquisitions('import type { AuditSink } from "@vostride/agent-qa-safety"', 'packages/cli/src/x.ts')).toEqual([])
    expect(gateAcquisitions('// import { evaluate } from "@vostride/agent-qa-safety"', 'packages/cli/src/x.ts')).toEqual([])
    expect(gateAcquisitions('const t = await page.evaluate(() => document.title)', 'packages/web/src/x.ts')).toEqual([])
    expect(gateAcquisitions('import { createMaskingMiddleware } from "@vostride/agent-qa-safety"', 'packages/eval/src/x.ts')).toEqual([])
  })

  it('the former surface, run-invocation and hook call-sites acquire nothing', () => {
    for (const file of [FORMER_INVOKE, FORMER_RUN_CORE]) {
      expect(gateAcquisitions(readRepoFile(file), file), file).toEqual([])
    }
    // The hook itself is gone, and so is the barrel's re-export of the gate.
    expect(existsSync(join(repoRoot, FORMER_GATE_HOOK))).toBe(false)
    expect(gateAcquisitions(readRepoFile(SAFETY_BARREL), SAFETY_BARREL)).toEqual([])
  })

  it('the ONE startRun pin is retained with its two entries and is clean over the real tree', () => {
    expect(Object.keys(STARTRUN_PIN).sort()).toEqual(
      ['packages/agent-local/src/composition/run-invocation-core.ts', 'packages/runner/src/index.ts'].sort(),
    )
    for (const rationale of Object.values(STARTRUN_PIN)) expect(rationale.trim()).not.toEqual('')
    const sources = ARCH_MANIFEST.packages.flatMap((contract) => pinSourcesFor(contract.packageDir))
    expect(findStartRunPinOffenders(sources)).toEqual([])
    // Non-vacuity: the core really is an acquisition, so the clean answer is not a blind scanner.
    expect(findStartRunAcquisitions(readRepoFile(FORMER_RUN_CORE), FORMER_RUN_CORE)).toHaveLength(1)
  })

  it('the shared scanner keeps every acquisition form the gate pin measured', () => {
    const fourth = 'packages/cli/src/commands/second-starter.ts'
    // named import, aliased import, re-export, whole-module dynamic load naming the symbol
    for (const source of [
      'import { startRun } from "@vostride/agent-qa-runner"',
      'import { startRun as begin } from "@vostride/agent-qa-runner"',
      'export { startRun } from "@vostride/agent-qa-runner"',
      'const { startRun } = await import("@vostride/agent-qa-runner")',
    ]) {
      expect(startRunScan({ file: fourth, source }), source).toEqual([
        `startrun-pin: ${fourth}:1 ⇏ @vostride/agent-qa-runner (un-pinned run-starter acquisition)`,
      ])
    }
    // a relative shell-module acquisition from inside the runner
    expect(startRunScan({ file: 'packages/runner/src/run/second.ts', source: 'import { startRun } from "./shell.js"' }))
      .toEqual(['startrun-pin: packages/runner/src/run/second.ts:1 ⇏ ./shell.js (un-pinned run-starter acquisition)'])
    // a multi-line clause
    expect(startRunScan({
      file: fourth,
      source: ['import {', '  RunConfig,', '  startRun,', '} from "@vostride/agent-qa-runner"'].join('\n'),
    })).toHaveLength(1)
    // and the quiet forms: comment, type-only, unrelated value, call token
    for (const source of [
      '// import { startRun } from "@vostride/agent-qa-runner"',
      'import type { RunConfig } from "@vostride/agent-qa-runner"',
      'import { renderObservationLine } from "@vostride/agent-qa-runner"',
      'const r = await page.evaluate(() => 1)',
    ]) {
      expect(startRunScan({ file: fourth, source }), source).toEqual([])
    }
  })

  it('a pin entry that no longer acquires is reported stale (self-shrinking)', () => {
    const fixtures = startRunPinnedFixtures()
    expect(findStartRunPinOffenders(fixtures.filter((entry) => entry.file !== FORMER_RUN_CORE))).toEqual([
      `startrun-pin: ${FORMER_RUN_CORE} ⇏ pin entry no longer acquires the run starter (stale)`,
    ])
    expect(findStartRunPinOffenders(fixtures.filter((entry) => entry.file !== 'packages/runner/src/index.ts'))).toEqual([
      'startrun-pin: packages/runner/src/index.ts ⇏ pin entry no longer acquires the run starter (stale)',
    ])
    expect(normalizeRepoPath('packages\\runner\\src\\index.ts')).toBe('packages/runner/src/index.ts')
  })
})

describe('arch lint agent barrel export set held-out fixtures', () => {
  it('pins the real barrel export set by exact equality, values and types apart', () => {
    expect(readAgentBarrelExports(readRepoFile(AGENT_BARREL_FILE))).toEqual({
      values: [...EXPECTED_AGENT_BARREL_VALUE_EXPORTS],
      types: [...EXPECTED_AGENT_BARREL_TYPE_EXPORTS],
    })
    expect(EXPECTED_AGENT_BARREL_EXPORTS).toEqual(
      [...EXPECTED_AGENT_BARREL_VALUE_EXPORTS, ...EXPECTED_AGENT_BARREL_TYPE_EXPORTS].sort(),
    )
  })

  it('exports no spec-level dispatch symbol — invokeFunction is the only way in', () => {
    expect(EXPECTED_AGENT_BARREL_VALUE_EXPORTS).toContain('invokeFunction')
    for (const forbidden of [
      'FunctionSpec',
      'FunctionStreamSpec',
      'invoke',
      'createRegistryFromSpecs',
      'registryInternals',
    ]) {
      expect(EXPECTED_AGENT_BARREL_EXPORTS).not.toContain(forbidden)
    }
    // A spec carries its own implementation, so exporting one opens a path around the gate.
    expect(EXPECTED_AGENT_BARREL_EXPORTS.filter(name => name.endsWith('Spec'))).toEqual([])
  })

  it('fires when the barrel gains an export the pin does not carry', () => {
    const withExtra = [
      readRepoFile(AGENT_BARREL_FILE),
      'export { createRegistryFromSpecs } from "./functions/registry.js"',
    ].join('\n')

    expect(findAgentBarrelOffenders(withExtra)).toEqual([
      'agent-barrel: unexpected value export createRegistryFromSpecs',
    ])
  })

  it('fires when the barrel loses an export the pin carries', () => {
    const withoutInvoke = readRepoFile(AGENT_BARREL_FILE).replace('  invokeFunction,\n', '')

    expect(findAgentBarrelOffenders(withoutInvoke)).toEqual([
      'agent-barrel: missing value export invokeFunction',
    ])
  })

  it('fires when a pinned TYPE export is promoted to a value export', () => {
    const promoted = readRepoFile(AGENT_BARREL_FILE).replace(
      'export type { CreateFunctionRegistryOptions, FunctionRegistry }',
      'export { CreateFunctionRegistryOptions, FunctionRegistry }',
    )

    expect(findAgentBarrelOffenders(promoted)).toEqual([
      'agent-barrel: unexpected value export CreateFunctionRegistryOptions',
      'agent-barrel: unexpected value export FunctionRegistry',
      'agent-barrel: missing type export CreateFunctionRegistryOptions',
      'agent-barrel: missing type export FunctionRegistry',
    ])
  })
})
