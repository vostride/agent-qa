// The model points at an unbindable port, so a planner retry never lands in the target's `hits`.

import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { getAgentQaVersion, getAgentQaVersionCheckCachePath } from '@vostride/agent-qa-core'
import { generateSuiteId, generateTestId } from '@vostride/agent-qa-ids'

import { createRunRecord, doorRunAttributes } from '../../commands/run.js'
import type { RunRecord } from '../../commands/run.js'
import { removeTempRoots } from '../../__tests__/temp-roots.js'

export {
  CountingTarget,
  auditRows,
  buildOrdinalsExist,
  eventTypes,
  runDirs,
} from '../../commands/__tests__/suite-run-fixture.js'
export type { AuditRow, FixtureEnvironment } from '../../commands/__tests__/suite-run-fixture.js'

export interface InProcessFixture {
  /** The project directory, real-pathed (macOS `/var` → `/private/var`). */
  readonly project: string
  /** The absolute config path a door hands the producer. */
  readonly configPath: string
  /** `<configDir>/.agent-qa`, the root the evidence check reads. */
  readonly agentQaRoot: string
  /** The workspace-relative path of the standalone test file. */
  readonly testPattern: string
  /** The workspace-relative path of the suite file. */
  readonly suitePattern: string
  /** The suite member's own test id, so a cell can assert the MEMBER ran. */
  readonly memberTestId: string
  /** The second suite member's test id, present only under `secondSuiteMember`. */
  readonly secondMemberTestId?: string
  /** The standalone test's id. */
  readonly directTestId: string
  /** The name the one target is declared under — `IN_PROCESS_TARGET_NAME`, carried per fixture. */
  readonly targetName: string
  /** The second target's name, present only under `secondTarget` — `SECOND_TARGET_NAME`. */
  readonly secondTargetName?: string
  /** The workspace-relative path of the test naming the second target, under `secondTarget`. */
  readonly secondTestPattern?: string
}

export interface InProcessFixtureInput {
  readonly origin: string
  // `undefined` writes no declaration at all: the undeclared case.
  readonly environment?: 'local' | 'shared' | undefined
  /** Omit the env file, so the input preflight has a real refusal to make. */
  readonly omitEnvFile?: boolean
  /** Omit the hooks file. */
  readonly omitHooksFile?: boolean
  /** Omit the secrets file. */
  readonly omitSecretsFile?: boolean
  // Plants one declared secret so masking checks are not vacuous; `omitSecretsFile` overrides it.
  readonly plantedSecret?: string
  /** The path the first target's URL carries after the origin. Defaults to `/in-process-thing`. */
  readonly targetPath?: string
  /** The one step every test the fixture writes carries, in place of the default `Verify` step. */
  readonly stepText?: string
  readonly emptyTestFile?: boolean
  // A door that resolves config before refusing reports `PluginNotInstalledError` instead.
  readonly declareUninstalledAuthPlugin?: boolean
  // Both targets share one explicit `product:`, or `requireSingleInvocationProduct` refuses first.
  readonly secondTarget?: boolean
  /**
   * Declare `use.browser` explicitly as a HEADED chromium (401 UAT item 14).
   *
   * WHY A KNOB AND NOT A CONSTANT. The cancel-isolation cell needs a member it can HOLD OPEN, and
   * the only production frame a browser-less machine can be parked in is `adapter.setup`'s
   * `chromium.launch(...)` — parked there by planting a stand-in executable under a temp
   * `PLAYWRIGHT_BROWSERS_PATH`. Playwright resolves a DIFFERENT binary for each mode
   * (`chromium_headless_shell-<rev>/…` headless, `chromium-<rev>/…` headed) and publishes exactly
   * one of them through its own API, `chromium.executablePath()` — the headed one. Declaring the
   * mode here is what lets the cell name the planted path from playwright's own answer instead of
   * hand-spelling a revision-and-platform path that would rot on the next bump.
   *
   * `name:` rides along because `use.browser` is validated as a whole and refuses a nameless block.
   * Absent leaves the config's bytes exactly as they were, which is every other cell's posture:
   * `buildPlatformConfig` defaults to `chromium` + `headless: true` with no `use.browser` at all.
   */
  readonly headedBrowser?: boolean
  /**
   * List a SECOND member in the suite (401 UAT item 14).
   *
   * WHY IT EXISTS. A one-member suite cannot show a TRUNCATED event log: whether the member is
   * aborted mid-flight or fails on its own, the run publishes one member's events and stops, so the
   * cancelled run and the un-cancelled one carry the same member count. With two members the
   * difference is the run's own remaining work — the shell's cancel branch skips member 1 SILENTLY
   * (`skippedPerTestOutcome`, no publish), while a run that was allowed to reach its member-0
   * failure poisons the fail-fast group and publishes member 1's `testFinished`. That one envelope
   * is the difference between "the abort stopped the run" and "the run finished on its own", which
   * is the whole claim.
   *
   * The second member names the SAME target and has the same shape as the first, so it changes the
   * member COUNT and nothing else.
   */
  readonly secondSuiteMember?: boolean
  /**
   * Declare `use.parallel: true` in the CONFIG (401 UAT item 15).
   *
   * WHY IT EXISTS, AND WHY IT IS THE CONFIG'S OWN KNOB. The dashboard's `JobQueue` gives a
   * NON-parallel web run exclusive access to every slot (`findNextEligible`: "Sequential web:
   * needs ALL slots free"), so two ask-tier runs triggered from a browser reach their gates one
   * after the other and their confirms never overlap — measured, before this knob existed. The
   * overlapping-confirm arm of UAT item 15 therefore has nothing to observe unless the runs are
   * eligible to be active at once, and `use.parallel` is the shipped, documented way a project
   * says so (`readConfigUseParallel` → `effectiveParallel` → the queued row).
   *
   * IT IS WRITTEN IN THE CONFIG RATHER THAN IN A TEST FILE because the trigger route reads BOTH
   * (`fileParallel ?? configParallel ?? false`) and the config is the one place that covers every
   * test the fixture writes, so a cell that triggers two DIFFERENT files gets the same posture as
   * one that triggers the same file twice.
   */
  readonly parallelRuns?: boolean
  // The explicit-count arm; `parallelRuns` alone is the default-ceiling arm.
  readonly workerCount?: number
  /** Write `use.cache: false` in the config, so every test the fixture writes runs with the cache off. */
  readonly cacheOff?: boolean
  /** With `secondTarget`, the suite's `target:` names the second target while its member keeps the first. */
  readonly suiteOnSecondTarget?: boolean
}

/** The package name the knob above declares. Not installed, and named so a reader can tell. */
export const UNINSTALLED_AUTH_PLUGIN_PACKAGE = '@acme/auth-plugin-NOT-INSTALLED'

// Exported so cells read the name the config writer interpolates rather than retyping it.
export const IN_PROCESS_TARGET_NAME = 'in-process-thing'

/** The second target's name, declared only when `secondTarget` is set. Its own one definition. */
export const SECOND_TARGET_NAME = 'the-second-thing'

/** The name `plantedSecret` declares its value under. One definition, so a cell need not retype it. */
export const PLANTED_SECRET_NAME = 'AGENT_QA_PLANTED_SECRET'

const createdProjects: string[] = []

// No hook here, because other test files import this module inside cells.
export function removeInProcessFixtures(): void {
  removeTempRoots(createdProjects.splice(0))
}

/**
 * A temporary HOME whose update-check cache is fresh. The run command's update notice reads
 * `~/.agent-qa/version-check.json` and fetches the registry once that cache is a day old, so a cell
 * that points HOME here answers from the cache: no network, and nothing written to the real home.
 * The cell stubs HOME to it and removes it with its other roots.
 */
export function freshUpdateCheckHome(): string {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'in-process-home-')))
  createdProjects.push(home)
  const now = new Date().toISOString()
  const cachePath = getAgentQaVersionCheckCachePath(home)
  mkdirSync(dirname(cachePath), { recursive: true })
  writeFileSync(cachePath, `${JSON.stringify({ latestVersion: getAgentQaVersion(), checkedAt: now, lastAttemptedAt: now })}\n`)
  return home
}

/**
 * Write a project with one target, one standalone test and one suite over its own member.
 *
 * Every knob above changes EXACTLY ONE thing, which is what lets a denial cell and its allow
 * control differ in one field and nothing else.
 */
export function createInProcessFixture(input: InProcessFixtureInput): InProcessFixture {
  const step = input.stepText === undefined
    ? '  - Verify the page says "Example"'
    : `  - ${JSON.stringify(input.stepText)}`
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'in-process-run-')))
  createdProjects.push(project)
  mkdirSync(join(project, 'tests'), { recursive: true })
  mkdirSync(join(project, 'suites'), { recursive: true })

  const directTestId = generateTestId()
  const memberTestId = generateTestId()

  writeFileSync(
    join(project, 'agent-qa.config.yaml'),
    [
      'workspace:',
      '  testMatch:',
      "    - 'tests/**/*.yaml'",
      '  suiteMatch:',
      "    - 'suites/**/*.suite.yaml'",
      '  hooksFile: hooks.yaml',
      '  envFile: .env',
      '  secretsFile: .env.secrets.local',
      'registry:',
      '  targets:',
      `    ${IN_PROCESS_TARGET_NAME}:`,
      '      platform: web',
      `      url: ${input.origin}${input.targetPath ?? '/in-process-thing'}`,
      ...(input.environment === undefined ? [] : [`      environment: ${input.environment}`]),
      // Only under the knob, so the default fixture's bytes are exactly what they were.
      ...(input.secondTarget === true ? ['      product: one-product'] : []),
      ...(input.secondTarget === true
        ? [
            `    ${SECOND_TARGET_NAME}:`,
            '      platform: web',
            `      url: ${input.origin}/the-second-thing`,
            '      environment: local',
            '      product: one-product',
          ]
        : []),
      '  llms:',
      '    - name: unreachable',
      '      provider: openai-compatible',
      '      model: gpt-4o-mini',
      '      baseURL: http://127.0.0.1:1/v1',
      ...(input.declareUninstalledAuthPlugin === true
        ? ['plugins:', '  auth:', `    - package: '${UNINSTALLED_AUTH_PLUGIN_PACKAGE}'`]
        : []),
      'use:',
      ...(input.headedBrowser === true
        ? ['  browser:', '    name: chromium', '    headless: false']
        : []),
      ...(input.parallelRuns === true ? ['  parallel: true'] : []),
      ...(input.workerCount === undefined ? [] : [`  workers: ${input.workerCount}`]),
      ...(input.cacheOff === true ? ['  cache: false'] : []),
      '  llm: unreachable',
      '  mobile:',
      '    appState: preserve',
      '',
    ].join('\n'),
  )
  if (input.omitHooksFile !== true) writeFileSync(join(project, 'hooks.yaml'), 'hooks: []\n')
  if (input.omitEnvFile !== true) writeFileSync(join(project, '.env'), '')
  if (input.omitSecretsFile !== true) {
    writeFileSync(
      join(project, '.env.secrets.local'),
      input.plantedSecret === undefined ? '' : `${PLANTED_SECRET_NAME}=${input.plantedSecret}\n`,
    )
  }

  writeFileSync(
    join(project, 'tests', 'direct.yaml'),
    input.emptyTestFile === true
      ? '# a file that parses to zero runnable tests\n'
      : [
          `test-id: ${directTestId}`,
          'name: the standalone test',
          `target: ${IN_PROCESS_TARGET_NAME}`,
          'steps:',
          step,
          '',
        ].join('\n'),
  )
  const secondTestId = generateTestId()
  if (input.secondTarget === true) {
    writeFileSync(
      join(project, 'tests', 'second.yaml'),
      [
        `test-id: ${secondTestId}`,
        'name: the second target\'s test',
        `target: ${SECOND_TARGET_NAME}`,
        'steps:',
        step,
        '',
      ].join('\n'),
    )
  }

  writeFileSync(
    join(project, 'tests', 'member.yaml'),
    [
      `test-id: ${memberTestId}`,
      'name: the suite member',
      `target: ${IN_PROCESS_TARGET_NAME}`,
      'steps:',
      step,
      '',
    ].join('\n'),
  )
  const secondMemberTestId = generateTestId()
  if (input.secondSuiteMember === true) {
    writeFileSync(
      join(project, 'tests', 'member-2.yaml'),
      [
        `test-id: ${secondMemberTestId}`,
        'name: the second suite member',
        `target: ${IN_PROCESS_TARGET_NAME}`,
        'steps:',
        step,
        '',
      ].join('\n'),
    )
  }
  writeFileSync(
    join(project, 'suites', 'gate.suite.yaml'),
    [
      `suite-id: ${generateSuiteId()}`,
      'name: the in-process suite',
      `target: ${
        input.secondTarget === true && input.suiteOnSecondTarget === true
          ? SECOND_TARGET_NAME
          : IN_PROCESS_TARGET_NAME
      }`,
      'tests:',
      '  - test: tests/member.yaml',
      `    id: ${memberTestId}`,
      ...(input.secondSuiteMember === true
        ? ['  - test: tests/member-2.yaml', `    id: ${secondMemberTestId}`]
        : []),
      '',
    ].join('\n'),
  )

  return {
    project,
    configPath: join(project, 'agent-qa.config.yaml'),
    agentQaRoot: join(project, '.agent-qa'),
    testPattern: 'tests/direct.yaml',
    suitePattern: 'suites/gate.suite.yaml',
    memberTestId,
    ...(input.secondSuiteMember === true ? { secondMemberTestId } : {}),
    directTestId,
    targetName: IN_PROCESS_TARGET_NAME,
    ...(input.secondTarget === true
      ? { secondTargetName: SECOND_TARGET_NAME, secondTestPattern: 'tests/second.yaml' }
      : {}),
  }
}

const openTestRunRecords: RunRecord[] = []

/** A run record for a cell that calls the drive directly; `closeTestRunRecords` closes it. */
export function testRunRecord(): RunRecord {
  const record = createRunRecord({ attributes: doorRunAttributes('cli'), warn: () => {} })
  openTestRunRecords.push(record)
  return record
}

export function closeTestRunRecords(): void {
  for (const record of openTestRunRecords.splice(0)) record.close()
}
