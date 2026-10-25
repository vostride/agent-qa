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
  EVAL_LOCAL_MAIN_ENTRY_ALLOWLIST,
  findEvalLocalAllowanceUnusedOffenders,
  findEvalLocalMainEntryOffenders,
} from '../lint/eval-local-reader-carveout.js'
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

/**
 * Source text for the startRun() pin (and, since 432-19, the gate-absence census), keyed by
 * repo-relative path.
 *
 * Routed through `sourceFilesFor` on purpose: it already drops `__tests__`, so a test file that
 * plants an acquisition as a fixture string is never read as a production acquisition.
 */
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

describe('arch lint (LINT-01..05)', () => {
  it('every contract-bearing package satisfies its class rules and dep contract', () => {
    const offenders: string[] = []
    const contracts: readonly OwnershipContract[] = ARCH_MANIFEST.packages
    const surfaceScans: SurfaceFirewallScan[] = []
    const pinSources: StartRunPinSource[] = []
    // "Exactly one importer" is a property of the workspace, not of any one package, so the
    // reader-scanned hits are accumulated and judged once after the loop.
    const readerScannedHits: SpecifierHit[] = []
    // 414 D-20. The eval-local main-entry allowance is likewise a workspace property: "used by
    // nobody" cannot be decided from one package's slice, so every contract's source hits are
    // accumulated here and the unused-allowance direction is judged once after the loop.
    const evalLocalHits: SpecifierHit[] = []

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
      // D-11 layer 3. Handed whole MODULES rather than the flat hit list the rules above take,
      // because it walks an import closure and a file with no imports at all still has to be
      // resolvable — derived from hits alone, such a file would look like a hole in the graph.
      if (contract.packageDir === RESUME_PATH_PACKAGE_DIR) {
        offenders.push(
          ...findResumePathModelFreeOffenders(resumePathModules(contract.packageDir, repoRoot)),
        )
      }
      if (isFirewalledSurfaceDir(contract.packageDir)) {
        surfaceScans.push({ packageDir: contract.packageDir, hits: sourceHits })
      }
      offenders.push(...findKnowledgeLocalWallOffenders(contract, sourceHits))
      // 414 D-20 / ROOT-10 SC5: over EVERY contract, not the reader carve-out's scanned-dirs
      // slice — the packages this rule exists to hold (`agent`, `agent-local`,
      // `knowledge-local`) are not in that list, and a rule that never sees them would pass
      // forever while reading like proof.
      offenders.push(...findEvalLocalMainEntryOffenders(contract, sourceHits))
      evalLocalHits.push(...sourceHits)
    }

    offenders.push(...findKnowledgeWriterSingletonOffenders(readerScannedHits))
    offenders.push(...findEvalLocalAllowanceUnusedOffenders(evalLocalHits))
    offenders.push(...findSurfaceFirewallOffenders(surfaceScans, SURFACE_FIREWALL_LEDGER))
    offenders.push(...findSurfaceClassGoldenSetOffenders(contracts))
    // 2026-10-01 (432-19, D-03/D-15): the evaluate() pin is deleted with the gate it policed. The
    // startRun() pin is the one run pin left, over the same `__tests__`-free sources.
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
    // 2026-08-17 (Phase 398 plan 03). The aggregate above ranges ARCH_MANIFEST, so a package whose
    // contract exists but is NOT registered has its class rules, dep reconciliation and cycle
    // position taken on trust — and the contract-less rule cannot see it, because that rule reads
    // the FILESYSTEM and the file is right there. Found by mutation: deleting the analytics entry
    // from the manifest left the arch lint green at 41/41.
    //
    // `manifest.test.ts` already asserts exactly this equality, so the rule is REUSED rather than
    // restated — a second census of the same two sets is the drift the census idiom exists to
    // prevent. What was missing was not a rule; it was this script CALLING it.
    offenders.push(
      ...findSetMismatchOffenders(
        'manifest vs on-disk contracts',
        contracts.map(contract => contract.packageDir),
        contractBearingDirs(repoRoot),
      ),
    )

    expect(offenders).toEqual([])
    // Walks and scans every contract-bearing package in the workspace, so its cost tracks
    // workspace size rather than anything this case controls. ~1.5s on a developer machine,
    // over the 5s default on a 2-core CI runner (first automatic CI run, 2026-08-02).
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

  // 2026-08-17 (Phase 398 plan 03). The mutation that motivated the CALL: deleting
  // `AGENT_QA_ANALYTICS_OWNERSHIP_CONTRACT` from ARCH_MANIFEST left this file green at 41/41,
  // because the contract-less check reads the filesystem and the file was still there. An unranged
  // package is one whose dep set and class rules are taken on trust, so the omission has to red
  // HERE.
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
          // This fixture reads arch's real manifest; retain its compiler baseline.
          externalDependencies: ['typescript', 'declared-only'],
        }),
        [fixtureHit('typescript'), fixtureHit('runtime-only')],
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
      externalDependencies: ['typescript'],
    })
    const configHits = [
      fixtureHit('node:fs', { file: 'packages/arch/vitest.config.ts' }),
      fixtureHit('tsup', { file: 'packages/arch/tsup.config.ts', line: 2 }),
      fixtureHit('vitest/config', { file: 'packages/arch/vitest.config.ts', line: 3 }),
    ]

    expect(findClassRuleOffenders(configAwareContract, configHits)).toEqual([
      'packages/arch | packages/arch/vitest.config.ts:1 | node:fs | browserSafe forbids node:*',
    ])
    expect(findDepReconciliationOffenders(configAwareContract, [fixtureHit('typescript')], repoRoot))
      .toEqual([])
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

describe('arch lint surface firewall (FUNC-02) held-out fixtures', () => {
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

  it('held-out firewall leaves non-firewalled surfaces alone until M5 admits them', () => {
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

  it('held-out firewall exempts only the ledgered pair, never the whole file (D-03)', () => {
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

  it('held-out firewall counts a type-only import as a violation (D-04)', () => {
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

  it('held-out golden surface set fails in both drift directions (D-02)', () => {
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

  it('the shipped ledger stays exact, dated, and closed to new-in-384 surface code (D-01)', () => {
    const newInPhase384 = [
      'packages/cli/src/commands/fn.ts',
      'packages/cli/src/composition/masked-config.ts',
      // The schema-derived visibility walker (Plan 10). It reads the config schema as DATA
      // handed in at the composition root, so it names no internal package of its own —
      // pinned here so that stays true rather than being remembered.
      'packages/cli/src/composition/config-visibility.ts',
    ]

    for (const entry of SURFACE_FIREWALL_LEDGER) {
      expect(entry.clearedBy.trim()).not.toEqual('')
      expect(entry.reason.trim()).not.toEqual('')
      expect(entry.file.endsWith('/')).toBe(false)
      expect(entry.file).toMatch(/\.(ts|tsx|js|mjs|cjs|css)$/)
      expect(FIREWALLED_SURFACE_DIRS.some(dir => entry.file.startsWith(`${dir}/`))).toBe(true)
      expect(newInPhase384).not.toContain(entry.file)
    }

    const keys = SURFACE_FIREWALL_LEDGER.map(entry => `${entry.file} :: ${entry.specifier}`)
    expect(new Set(keys).size).toEqual(keys.length)
  })
})

describe('arch lint composition carve-out (385-08 / D-13) registration and scope', () => {
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
    expect(aggregate).toContain('findEvalLocalMainEntryOffenders(contract, sourceHits)')
    expect(aggregate).toContain('findEvalLocalAllowanceUnusedOffenders(evalLocalHits)')
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

  // A path-keyed pin whose path has moved matches nothing and reports nothing. Both reader files
  // must exist, and the scanned-dirs list must actually contain the package each one lives in, or
  // the reader carve-out is silently covering fewer files than it claims.
  // D-14/SC5. The allow-list is a directory PREFIX, so the shipped value alone permits any number
  // of importers under it; what makes "the single place" true is the singleton rule, and what makes
  // the singleton rule reach the right subtree is that the prefix names a directory that exists
  // inside a scanned package. Both halves are asserted, because either one alone is satisfiable by
  // a wrong implementation.
  it('the writer allowance is one entry, and it points inside a scanned package that exists', () => {
    expect([...KNOWLEDGE_WRITER_ALLOWLIST]).toEqual(['packages/agent-local/src/composition/'])

    for (const entry of KNOWLEDGE_WRITER_ALLOWLIST) {
      expect(existsSync(join(repoRoot, entry))).toBe(true)
      expect(
        READER_CARVEOUT_SCANNED_DIRS.some(dir => entry.startsWith(`${dir}/`)),
      ).toBe(true)
    }
  })

  // 414 D-20 / ROOT-10 SC5, and the same shape hazard one rule over. A prefix naming a directory
  // that does not exist — or one no contract-bearing package owns, so the aggregate never walks
  // it — matches nothing: the offender direction could never fire on the real tree, and the
  // unused-allowance direction would fire on every run, which is the pressure that gets a rule
  // deleted rather than fixed. Both halves are asserted, because either alone is satisfiable by a
  // wrong value.
  it('the eval-local main-entry allowance is one prefix, and it points inside a contract-bearing package that exists', () => {
    expect([...EVAL_LOCAL_MAIN_ENTRY_ALLOWLIST]).toEqual(['packages/cli/'])

    for (const entry of EVAL_LOCAL_MAIN_ENTRY_ALLOWLIST) {
      expect(existsSync(join(repoRoot, entry))).toBe(true)
      // Spelled through the shipped prefix rather than repeating 'packages/cli', so a future
      // widening cannot leave this cell asserting about a package the rule no longer names.
      const owner = ARCH_MANIFEST.packages.find(
        contract => entry === `${contract.packageDir}/`,
      )
      expect(owner).toBeDefined()
    }
  })

  // D-11 layer 3, and the same relocation hazard one rule over: the resume-path rule is keyed on
  // an exact file path, so a pin left pointing at a moved file would match nothing, report nothing
  // and still read like proof. The rule reports that case itself; this asserts the pin is right on
  // the real tree, and that the package it names is one the aggregate actually walks.
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

  // D-13/D-15 widened the firewall allow-list by exactly one entry; 398-10 (D-17) by exactly one
  // more. Pinned by equality so a private power cannot join by looking like it belongs — every
  // arrival is a line in this file with a phase attached to it.
  it('the surface allow-list is exactly the function layer, the vocabulary, the composition root and analytics', () => {
    expect([...SURFACE_ALLOWED_INTERNAL_PACKAGES]).toEqual([
      '@vostride/agent-qa-agent',
      '@vostride/agent-qa-agent-local',
      // 2026-08-17 (Phase 398 plan 10, D-17): telemetry is a HOST concern a host composes at its
      // root and holds a port for. What this edge replaces is the ambient
      // `captureAnalytics`/`flushAnalytics` pair reachable from any file in the process, so the
      // widening narrows what can emit rather than widening it.
      '@vostride/agent-qa-analytics',
      '@vostride/agent-qa-schema',
    ])
  })
})

// 2026-10-01 (432-19, D-03/D-15): the evaluate() pin's held-out fixtures are re-spelled. Its last two
// acquisitions (safety's in-run gate hook and the safety barrel's re-export) left with the gate, so
// the pin is deleted rather than kept at zero entries. What its fixtures measured survives in two
// places: the ABSENCE of every gate acquisition (C432-NO-EVALUATE, an independent statement census
// over the real tree) and the SHARED SCANNER's forms and stale-entry direction, now measured on the
// one run pin that remains (C432-ARCH-RETAINED-PINS).
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

describe('arch lint run pins after the gate (432-19, D-03/D-15)', () => {
  it('C432-NO-EVALUATE: the gate pin, the gate modules and every production gate acquisition are gone', () => {
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
    // Non-vacuity: the census reads the barrel's real values, which still include the classifier.
    expect(barrelValues).toContain('classifyRisk')
  })

  // RE-TITLED 2026-10-03 (quick-261003-tsr, IN-38): was '…the census fires on every form a returning
  // gate acquisition could take'. The census does not count a whole-module barrel import or a
  // dynamic `import()` of a retired module; the barrel-values check and the retired modules'
  // absence in the cell above are what catch those.
  it('C432-NO-EVALUATE: the census fires on a named gate value from the barrel, aliased or multi-line, and on any static import or re-export of a retired gate module', () => {
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
    expect(gateAcquisitions(['import {', '  classifyRisk,', '  evaluate,', '} from "@vostride/agent-qa-safety"'].join('\n'), 'packages/mcp/src/x.ts'))
      .toHaveLength(1)
    // And it stays quiet on what is not an acquisition: a type, a comment, a call token, an
    // unrelated value from the same barrel.
    expect(gateAcquisitions('import type { AuditSink } from "@vostride/agent-qa-safety"', 'packages/cli/src/x.ts')).toEqual([])
    expect(gateAcquisitions('// import { evaluate } from "@vostride/agent-qa-safety"', 'packages/cli/src/x.ts')).toEqual([])
    expect(gateAcquisitions('const t = await page.evaluate(() => document.title)', 'packages/web/src/x.ts')).toEqual([])
    expect(gateAcquisitions('import { classifyRisk } from "@vostride/agent-qa-safety"', 'packages/eval/src/x.ts')).toEqual([])
  })

  it('C432-INVOKE-DIRECT: the former surface, run-invocation and hook call-sites acquire nothing', () => {
    for (const file of [FORMER_INVOKE, FORMER_RUN_CORE]) {
      expect(gateAcquisitions(readRepoFile(file), file), file).toEqual([])
    }
    // The hook itself is gone, and so is the barrel's re-export of the gate.
    expect(existsSync(join(repoRoot, FORMER_GATE_HOOK))).toBe(false)
    expect(gateAcquisitions(readRepoFile(SAFETY_BARREL), SAFETY_BARREL)).toEqual([])
  })

  it('C432-ARCH-RETAINED-PINS: the ONE startRun pin is retained with its two entries and is clean over the real tree', () => {
    expect(Object.keys(STARTRUN_PIN).sort()).toEqual(
      ['packages/agent-local/src/composition/run-invocation-core.ts', 'packages/runner/src/index.ts'].sort(),
    )
    for (const rationale of Object.values(STARTRUN_PIN)) expect(rationale.trim()).not.toEqual('')
    const sources = ARCH_MANIFEST.packages.flatMap((contract) => pinSourcesFor(contract.packageDir))
    expect(findStartRunPinOffenders(sources)).toEqual([])
    // Non-vacuity: the core really is an acquisition, so the clean answer is not a blind scanner.
    expect(findStartRunAcquisitions(readRepoFile(FORMER_RUN_CORE), FORMER_RUN_CORE)).toHaveLength(1)
  })

  it('C432-ARCH-RETAINED-PINS: the shared scanner keeps every acquisition form the gate pin measured', () => {
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
      'import { projectRiskAction } from "@vostride/agent-qa-runner"',
      'const r = await page.evaluate(() => 1)',
    ]) {
      expect(startRunScan({ file: fourth, source }), source).toEqual([])
    }
  })

  it('C432-ARCH-RETAINED-PINS: a pin entry that no longer acquires is reported stale (self-shrinking)', () => {
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

describe('arch lint agent barrel export set (FUNC-01 / SC1) held-out fixtures', () => {
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
    // No `*Spec` value of any name: a spec carries its own implementation, so exporting
    // one hands a surface a dispatch path that never reaches the gate (T-384-20).
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

// 414 D-19 / D-20 / D-18, ROOT-10 SC5. The requirement says the proposer-side read port "has no
// method that can return a private held-out entry — an arch lint cell REDs if one
// is added", so the cell has to live HERE: the arch package's test run covers the whole of this
// file, and a pin that only ran under the eval-local suite would satisfy the words but not the
// requirement.
//
// It reads the barrel's RAW SOURCE rather than importing it, for two reasons. The arch package
// must never import the thing it polices — that would make a firewall a dependent of what it
// walls off — and raw source needs no `dist/`, so the cell is honest on a clean checkout and
// during a broken build, which is exactly when a widening would slip through.
//
// This is one of THREE pins on the same surface. The other two live beside the port: the runtime
// key-set cell in `packages/eval-local/src/__tests__/reader.test.ts` and the never-bar in
// `packages/eval-local/src/__tests__/reader.test-d.ts`. This one is the only one in the arch
// package, and the only one that sees a NEW export before anyone imports it.
const EVAL_LOCAL_READER_BARREL = 'packages/eval-local/src/reader.ts'
const PUBLISH_SURFACE_VALIDATOR = 'scripts/validate-publish-surface.mjs'

/**
 * The sorted VALUE export names a barrel publishes.
 *
 * Values are the whole question: a value is power a proposer can reach, a type is not. So
 * `export type { … } from '…'` and `export type X =` / `export interface X` are excluded, and an
 * inline `type Foo` member inside a value clause is excluded with them. A bare `export { x }`
 * with no `from` counts exactly like a re-export — it widens the barrel by the same one name.
 *
 * A hand-rolled extractor rather than the TypeScript compiler for the same reason the file is
 * read raw: `packages/arch` may not depend on the packages it polices, and this rule must run
 * before anything is built.
 */
function readerValueExports(source: string): string[] {
  const names: string[] = []

  for (const match of source.matchAll(/\bexport\s+(type\s+)?\{([^}]*)\}/g)) {
    if (match[1] !== undefined) continue
    for (const member of (match[2] ?? '').split(',')) {
      const trimmed = member.trim()
      if (trimmed === '' || /^type\s/.test(trimmed)) continue
      const parts = trimmed.split(/\s+as\s+/)
      names.push((parts[parts.length - 1] ?? trimmed).trim())
    }
  }

  for (const match of source.matchAll(
    /\bexport\s+(?!type\b|interface\b)(?:async\s+)?(?:function|const|class|let|var)\s+([A-Za-z_$][\w$]*)/g,
  )) {
    names.push(match[1] ?? '')
  }

  return names.sort()
}

describe('arch lint eval-local reader port (414 D-19/D-20) — source-anchored export-set pin', () => {
  // The relocation hazard this file guards everywhere else: a path-keyed pin whose path has moved
  // matches nothing, reports nothing, and still reads like proof. The barrel must EXIST.
  it('the eval-local /reader subpath exports exactly one value, openCorpusReader (414 D-19/D-20)', () => {
    expect(existsSync(join(repoRoot, EVAL_LOCAL_READER_BARREL))).toBe(true)

    expect(readerValueExports(readRepoFile(EVAL_LOCAL_READER_BARREL))).toEqual(['openCorpusReader'])
  })

  // The pin above is only worth its line if the extractor can actually see an arrival. Both
  // directions are fed literal source, so the extractor's failing direction is proven INSIDE
  // the arch lint tests rather than asserted about elsewhere.
  it('the export-set extractor sees a planted value export and ignores a type-only re-export', () => {
    const barrel = readRepoFile(EVAL_LOCAL_READER_BARREL)

    expect(
      readerValueExports(`${barrel}\nexport function readPrivateEntries() { return [] }\n`),
    ).toEqual(['openCorpusReader', 'readPrivateEntries'])

    expect(readerValueExports(`${barrel}\nexport type { Foo } from './x.js'\n`)).toEqual([
      'openCorpusReader',
    ])
  })

  // D-18: the subpath is only a boundary if it is actually published. The publish-surface
  // validator asserted the `./reader` triple for knowledge-local alone; a per-package `if` is how
  // a second package quietly ships an unguarded subpath, so the condition is now a LIST and both
  // members are named here.
  it('the publish-surface validator asserts the ./reader triple for both subpath packages', () => {
    const source = readRepoFile(PUBLISH_SURFACE_VALIDATOR)
    const start = source.indexOf('READER_SUBPATH_PACKAGES')
    expect(start).toBeGreaterThan(-1)

    const declaration = source.slice(start, source.indexOf(']', start) + 1)
    expect(declaration).toContain('@vostride/agent-qa-knowledge-local')
    expect(declaration).toContain('@vostride/agent-qa-eval-local')
    expect(source).toContain('READER_SUBPATH_PACKAGES.includes(record.pkg.name)')
  })
})
