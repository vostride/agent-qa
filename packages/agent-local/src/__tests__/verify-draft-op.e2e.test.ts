// Every case goes through the registered op on a composed host, with a faithful fixture executor.

import { mkdirSync, mkdtempSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  AUTHORING_DRAFT_VERIFY_FUNCTION_ID,
  FunctionNotBoundError,
  invokeFunction,
} from '@vostride/agent-qa-agent'
import type { JobModelCapability } from '@vostride/agent-qa-agent'
import { foldRunOutcomes } from '@vostride/agent-qa-knowledge-local'
import { FsEventLog, HANDOFF_FILE, RUNS_SUBDIR, slugBranch } from '@vostride/agent-qa-runner-local'
import {
  CURRENT_HANDOFF_SCHEMA_VERSION,
  DraftReceiptSchema,
  MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
  asRunId,
  exercisedAnchors,
} from '@vostride/agent-qa-schema'
import type {
  Action,
  CompletedRunHandoff,
  DraftReceipt,
  ElementInfo,
  FunctionCaller,
  MaskedResolvedConfig,
  MemberTestOutcome,
  RunsStartInput,
  StepEvidence,
  SubActionEvidence,
} from '@vostride/agent-qa-schema'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { composeLocalAgent } from '../composition/compose-local-agent.js'
import type {
  DraftAuthoringPort,
  LocalAgentHost,
  RunExecutionPort,
} from '../composition/compose-local-agent.js'

const MASKED_CONFIG: MaskedResolvedConfig = {
  schemaVersion: MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
  configPath: '/fixture/agent-qa.config.yaml',
  entries: [],
}

/** A person holding every scope, so a refusal below can only ever be the axis under test. */
const HUMAN: FunctionCaller = {
  surface: 'test',
  origin: 'human',
}

const JOB_MODEL: JobModelCapability = {
  modelId: 'fixture:verify-draft-op',
  generate: () => Promise.reject(new Error('no model is reachable from a keep-gate evaluation')),
}

const MINT_IDENTITY = (filePath: string): string => filePath

const LOCAL_FORM_URL = 'http://127.0.0.1:8931/form.html'

/**
 * The accept control, spelled as the HOST would hand it over.
 *
 * Step text copied verbatim from `packages/agent/src/authoring/__tests__/fixtures/corpus/
 * accept-control.yaml`, and `filePath` in the workspace-relative identity spelling the runner
 * records on `PerTestOutcome.filePath` — the join gates 1-2 make. A path spelled any other way
 * would make every run report `absent` for its own draft, and gate 1 would fail for a join reason
 * wearing a draft reason's clothes.
 */
const ACCEPT_CONTROL = {
  testId: 't_hong-lat-plot-noise-memory-common-binary-tol-liv-argent',
  filePath: 'tests/accept-control.yaml',
  testName: 'Confirm the local account form page heading',
  // Required on the descriptor; nothing here compiles, but the parse really yields it.
  target: 'local-form',
  steps: [
    'Type "alice" into the Username field',
    'Verify the page heading says "Local Form"',
  ],
  contentDigest: 'e2edigestacceptcontrol',
} as const

interface SubActionFixture {
  readonly type: string
  readonly ref: string
  readonly role: string
  readonly name: string
}

/** What the accept control exercises: the Username textbox, then the page heading. */
const ACCEPT_CONTROL_SUBACTIONS: readonly (readonly SubActionFixture[])[] = [
  [{ type: 'fill', ref: 'e1', role: 'textbox', name: 'username' }],
  [{ type: 'assertValue', ref: 'e2', role: 'heading', name: 'local form' }],
]

function elementInfo(fixture: SubActionFixture): ElementInfo {
  return {
    ref: fixture.ref,
    role: fixture.role,
    name: fixture.name,
    nameNormalized: fixture.name,
    state: { enabled: true, focused: false, visible: true },
    labels: {},
    attributes: {},
  } as unknown as ElementInfo
}

function subAction(fixture: SubActionFixture): SubActionEvidence {
  return {
    plan: `plan ${fixture.type}`,
    plannedAction: { type: fixture.type, ref: fixture.ref } as unknown as Action,
    stateBefore: {
      platform: 'web',
      tree: '',
      elements: [elementInfo(fixture)],
      refMap: {},
      timestamp: 0,
      metadata: {},
      url: LOCAL_FORM_URL,
    },
    result: { success: true },
  } as unknown as SubActionEvidence
}

function stepEvidence(index: number, subActions: readonly SubActionFixture[]): StepEvidence {
  return {
    stepIndex: index,
    stepText: ACCEPT_CONTROL.steps[index] ?? `step ${index}`,
    cacheStatus: 'miss',
    // REQUIRED by the handoff's own structural guard, which is why it is here and not omitted as
    // decoration: this fixture is read back through `loadCompletedRunHandoff`, the real version
    // guard the composition's runs reader uses, so a shape it refuses is a run that does not exist
    // as far as gates 1-2 are concerned.
    servedBrief: {
      scope: { tier: 'product', key: 'local-form' },
      asOfBuild: 1,
      budget: 1,
      truncation: 'none',
      channel1: [],
      channel2: [],
      channel3: [],
    },
    subActions: subActions.map(subAction),
    verifierVerdict: { pass: true, reasoning: 'fixture' },
  } as unknown as StepEvidence
}

/**
 * One completed gate-run record, carrying BOTH durable markers.
 *
 * The markers are on the RECORD and not merely on the request, because `runs.start` copies them
 * off the record — so a fixture that stamped only the request would model a host that silently
 * dropped the flags, and the evaluator would (correctly) halt with `GateRunNotFlaggedError`.
 */
function gateRunHandoff(runId: string, outcome: MemberTestOutcome): CompletedRunHandoff {
  return {
    schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION,
    runId: asRunId(runId),
    scope: { tier: 'product', key: 'local-form' },
    buildOrdinal: 1,
    gateRun: true,
    excludedFromOutcomes: true,
    executionContext: 'local-headless',
    aggregateVerdict: outcome === 'failed' ? 'failed' : 'passed',
    configDigests: { suiteConfigDigest: 'suite', testConfigDigest: 'test' },
    startedAt: 1,
    endedAt: 2,
    tests: [
      {
        testId: ACCEPT_CONTROL.testId,
        testName: ACCEPT_CONTROL.testName,
        filePath: ACCEPT_CONTROL.filePath,
        testIndex: 0,
        outcome,
        steps: ACCEPT_CONTROL_SUBACTIONS.map((subActions, index) => stepEvidence(index, subActions)),
      },
    ],
  } as unknown as CompletedRunHandoff
}

/**
 * An ORDINARY completed run — neither marker — holding the draft's own identity and one sibling.
 *
 * Both are needed. The sibling is what proves the fold landed and the fingerprint lane is live; the
 * draft's own member is what makes the exclusion a filter rather than a no-op. The sibling
 * exercises a DIFFERENT element, so a union built without the draft leaves the draft's two elements
 * novel, and a union built with them leaves nothing novel at all — the two readings disagree, which
 * is the only shape in which this case measures anything.
 */
function suiteHandoff(runId: string): CompletedRunHandoff {
  return {
    schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION,
    runId: asRunId(runId),
    scope: { tier: 'product', key: 'local-form' },
    buildOrdinal: 1,
    executionContext: 'local-headless',
    aggregateVerdict: 'passed',
    configDigests: { suiteConfigDigest: 'suite', testConfigDigest: 'test' },
    startedAt: 1,
    endedAt: 2,
    tests: [
      {
        testId: ACCEPT_CONTROL.testId,
        testName: ACCEPT_CONTROL.testName,
        filePath: ACCEPT_CONTROL.filePath,
        testIndex: 0,
        outcome: 'passed',
        steps: ACCEPT_CONTROL_SUBACTIONS.map((subActions, index) => stepEvidence(index, subActions)),
      },
      {
        testId: 't_sibling',
        testName: 'Submit the local account form',
        filePath: 'tests/sibling.yaml',
        testIndex: 1,
        outcome: 'passed',
        steps: [stepEvidence(0, [{ type: 'click', ref: 'e3', role: 'button', name: 'submit' }])],
      },
    ],
  } as unknown as CompletedRunHandoff
}

interface FixtureExecutor {
  readonly port: RunExecutionPort
  readonly startInputs: RunsStartInput[]
}

/**
 * A run executor that writes what a real one writes: the run's first event, then its handoff.
 *
 * Each call mints the next run id, so gates 1-2 see three DISTINCT runs rather than one record
 * read three times — the distinction gate 2 is entirely about.
 */
function fixtureExecutor(agentQaRoot: string, outcomes: readonly MemberTestOutcome[]): FixtureExecutor {
  const startInputs: RunsStartInput[] = []
  return {
    startInputs,
    port: {
      execute(request) {
        const index = startInputs.length
        startInputs.push(request)
        const runId = `RUN-GATE-${index}`
        new FsEventLog({ root: agentQaRoot, runId }).append({
          seq: 1,
          ts: 1,
          runId,
          type: 'runStarted',
          payload: {},
        } as never)
        const runDir = join(agentQaRoot, RUNS_SUBDIR, slugBranch(runId))
        mkdirSync(runDir, { recursive: true })
        writeFileSync(
          join(runDir, HANDOFF_FILE),
          `${JSON.stringify(gateRunHandoff(runId, outcomes[index] ?? 'passed'))}\n`,
          'utf8',
        )
        return Promise.resolve({ runId: asRunId(runId) })
      },
    },
  }
}

/**
 * The host's draft-authoring capability, faked at exactly the seam the CLI binds.
 *
 * NOT a fake of the evaluator, and not a fake of any gate: this is the one thing `packages/agent`
 * genuinely cannot do (it is `storageNeutral` — it can neither stat a path nor parse YAML), and
 * the CLI's real implementation over `parseTestFile` and `workspaceRelativeIdentityPath` is
 * exercised by that package's own suite. Everything downstream of it below is production code.
 */
function draftAuthoring(options: {
  readonly suiteTextCorpus?: readonly {
    readonly filePath: string
    readonly testName: string
    readonly stepsText: readonly string[]
  }[]
} = {}): DraftAuthoringPort {
  return {
    parseDraft(filePath) {
      if (filePath !== ACCEPT_CONTROL.filePath) {
        return Promise.resolve({ kind: 'not-found' as const })
      }
      return Promise.resolve({ kind: 'parsed' as const, draft: { ...ACCEPT_CONTROL } })
    },
    suiteTextCorpus() {
      return Promise.resolve(options.suiteTextCorpus ?? [])
    },
    // Nothing here authors, so deriving a scope throws rather than answering.
    deriveDefaultScope(): Promise<never> {
      throw new Error('this file evaluates an existing draft, so no scope is derived')
    },
    // Served only to the compile prompt, which this file never runs, so it throws.
    configuredTargetNames(): Promise<never> {
      throw new Error('this file evaluates an existing draft, so no vocabulary is served')
    },
    // Never reached: nothing in this file authors or repairs a draft.
    applyPatchesToDraft(): Promise<never> {
      throw new Error('this case never enters repair, so no patch set is ever applied')
    },
    stageDraft() {
      return Promise.reject(new Error('no draft is authored from a keep-gate evaluation'))
    },
    // A verify writes nothing, so reaching the writer would be a verify that wrote.
    publishDraft(): Promise<never> {
      return Promise.reject(new Error('a keep-gate evaluation writes no test file'))
    },
  }
}

describe('authoring.draft.verify end to end through the composition root', () => {
  let root: string
  let agentQaRoot: string
  const hosts: LocalAgentHost[] = []

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'verify-draft-op-'))
    agentQaRoot = join(root, '.agent-qa')
    mkdirSync(agentQaRoot, { recursive: true })
  })

  afterEach(() => {
    for (const composed of hosts.splice(0)) void composed.close()
    rmSync(root, { recursive: true, force: true })
  })

  function compose(input: {
    readonly executor?: RunExecutionPort
    readonly authoring?: DraftAuthoringPort
  }): LocalAgentHost {
    const host = composeLocalAgent({
      mask: (text) => text,
      agentQaRoot,
      mintQuarantineIdentityPath: MINT_IDENTITY,
      config: { getMasked: () => Promise.resolve(MASKED_CONFIG) },
      knowledgeRoot: () => join(root, 'agent-qa-knowledge'),
      model: () => JOB_MODEL,
      ...(input.executor === undefined ? {} : { runExecution: input.executor }),
      ...(input.authoring === undefined ? {} : { draftAuthoring: input.authoring }),
    })
    hosts.push(host)
    return host
  }

  it('returns a keep-eligible receipt for the accept control and persists it under the runtime root', async () => {
    const executor = fixtureExecutor(agentQaRoot, ['passed', 'passed', 'passed'])
    const host = compose({ executor: executor.port, authoring: draftAuthoring() })

    const receipt = (await invokeFunction(
      host.registry,
      AUTHORING_DRAFT_VERIFY_FUNCTION_ID,
      { draftPath: ACCEPT_CONTROL.filePath },
      HUMAN,
    )) as DraftReceipt

    // Schema-valid at the boundary a caller reads, not merely shaped like a receipt.
    expect(DraftReceiptSchema.safeParse(receipt).success).toBe(true)
    expect(receipt.disposition).toBe('keep-eligible')
    expect(receipt.gates.executesDefinitive.pass).toBe(true)
    expect(receipt.gates.stableVerdict.pass).toBe(true)
    expect(receipt.gates.addsValue.pass).toBe(true)
    expect(receipt.gates.falsifiableAssertion.pass).toBe(true)
    expect(receipt.stabilityRunsCompleted).toBe(3)

    // The gate-runs really went through `runs.start`, and every one of them carried both markers.
    expect(executor.startInputs).toHaveLength(3)
    for (const started of executor.startInputs) {
      expect(started.gateRun).toBe(true)
      expect(started.excludedFromOutcomes).toBe(true)
      expect(started.patterns).toEqual([ACCEPT_CONTROL.filePath])
    }

    // The op returns the receipt and the store holds it, one file named for the digest.
    const receiptsDir = join(agentQaRoot, 'draft-receipts')
    expect(existsSync(receiptsDir)).toBe(true)
    const names = readdirSync(receiptsDir)
    expect(names).toEqual([`${ACCEPT_CONTROL.contentDigest}.json`])
    const persisted = JSON.parse(readFileSync(join(receiptsDir, names[0] as string), 'utf8')) as unknown
    expect(persisted).toEqual(receipt)
  })

  // The verify arm gets the written test's suite path; the writer rejects if a verify ever writes.
  it('verifies the written test at its suite path, and writes nothing', async () => {
    const executor = fixtureExecutor(agentQaRoot, ['passed', 'passed', 'passed'])
    const host = compose({ executor: executor.port, authoring: draftAuthoring() })

    const receipt = (await invokeFunction(
      host.registry,
      AUTHORING_DRAFT_VERIFY_FUNCTION_ID,
      { draftPath: ACCEPT_CONTROL.filePath },
      HUMAN,
    )) as DraftReceipt

    expect(ACCEPT_CONTROL.filePath.startsWith('tests/.agent-qa-drafts/')).toBe(false)
    expect(receipt.draftRef).toEqual({
      filePath: ACCEPT_CONTROL.filePath,
      testId: ACCEPT_CONTROL.testId,
      testName: ACCEPT_CONTROL.testName,
      contentDigest: ACCEPT_CONTROL.contentDigest,
    })
    expect(executor.startInputs.map((started) => started.patterns))
      .toEqual([[ACCEPT_CONTROL.filePath], [ACCEPT_CONTROL.filePath], [ACCEPT_CONTROL.filePath]])
    expect(readdirSync(join(agentQaRoot, 'draft-receipts')))
      .toEqual([`${ACCEPT_CONTROL.contentDigest}.json`])
  })

  it('forces unverified in draft mode, on one run rather than the pinned N', async () => {
    const executor = fixtureExecutor(agentQaRoot, ['passed', 'passed', 'passed'])
    const host = compose({ executor: executor.port, authoring: draftAuthoring() })

    const receipt = (await invokeFunction(
      host.registry,
      AUTHORING_DRAFT_VERIFY_FUNCTION_ID,
      { draftPath: ACCEPT_CONTROL.filePath, draftMode: true },
      HUMAN,
    )) as DraftReceipt

    expect(receipt.disposition).toBe('unverified')
    expect(receipt.stabilityRunsCompleted).toBe(1)
    expect(executor.startInputs).toHaveLength(1)
    // Unverified even with every gate passing.
    expect(receipt.gates.executesDefinitive.pass).toBe(true)
    expect(receipt.gates.stableVerdict.pass).toBe(true)
  })

  it('refuses BY NAME on a host that cannot parse a draft — covered, not missing', async () => {
    const executor = fixtureExecutor(agentQaRoot, ['passed'])
    const host = compose({ executor: executor.port })

    const listed = host.registry
      .list(HUMAN)
      .find((declaration) => declaration.id === AUTHORING_DRAFT_VERIFY_FUNCTION_ID)
    expect(listed?.bindingStatus).toBe('unbound')

    await expect(invokeFunction(
      host.registry,
      AUTHORING_DRAFT_VERIFY_FUNCTION_ID,
      { draftPath: ACCEPT_CONTROL.filePath },
      HUMAN,
    )).rejects.toBeInstanceOf(FunctionNotBoundError)
    // A refusal, not a run: nothing was executed on the way to it.
    expect(executor.startInputs).toHaveLength(0)
  })

  it('refuses a host that cannot start a run, on the same footing', async () => {
    const host = compose({ authoring: draftAuthoring() })

    const listed = host.registry
      .list(HUMAN)
      .find((declaration) => declaration.id === AUTHORING_DRAFT_VERIFY_FUNCTION_ID)
    expect(listed?.bindingStatus).toBe('unbound')

    await expect(invokeFunction(
      host.registry,
      AUTHORING_DRAFT_VERIFY_FUNCTION_ID,
      { draftPath: ACCEPT_CONTROL.filePath },
      HUMAN,
    )).rejects.toBeInstanceOf(FunctionNotBoundError)
  })

  it('refuses a draftPath naming no file, by its own name and before any run', async () => {
    const executor = fixtureExecutor(agentQaRoot, ['passed'])
    const host = compose({ executor: executor.port, authoring: draftAuthoring() })

    const failure = await invokeFunction(
      host.registry,
      AUTHORING_DRAFT_VERIFY_FUNCTION_ID,
      { draftPath: 'tests/nothing-is-here.yaml' },
      HUMAN,
    ).then(() => undefined, (error: unknown) => error as Error)

    expect(failure?.name).toBe('DraftFileNotFoundError')
    expect(failure?.message).toContain('tests/nothing-is-here.yaml')
    expect(executor.startInputs).toHaveLength(0)
  })

  it('refuses a draftPath that is not a test file before it consults the host at all', async () => {
    const executor = fixtureExecutor(agentQaRoot, ['passed'])
    const host = compose({ executor: executor.port, authoring: draftAuthoring() })

    const failure = await invokeFunction(
      host.registry,
      AUTHORING_DRAFT_VERIFY_FUNCTION_ID,
      { draftPath: 'tests/accept-control.yaml.bak' },
      HUMAN,
    ).then(() => undefined, (error: unknown) => error as Error)

    // A whole-suffix check, not a substring one: the path CONTAINS `.yaml` and is still refused.
    expect(failure?.name).toBe('DraftNotAYamlFileError')
    expect(executor.startInputs).toHaveLength(0)
  })

  it('never measures a draft against itself, however the suite text corpus is populated', async () => {
    // The draft is a suite member, so the text lane must not compare it with its own bytes.
    const executor = fixtureExecutor(agentQaRoot, ['passed', 'passed', 'passed'])
    const host = compose({
      executor: executor.port,
      authoring: draftAuthoring({
        suiteTextCorpus: [
          {
            filePath: ACCEPT_CONTROL.filePath,
            testName: ACCEPT_CONTROL.testName,
            stepsText: ACCEPT_CONTROL.steps,
          },
          {
            filePath: 'tests/unrelated.yaml',
            testName: 'Delete an archived invoice from the billing ledger',
            stepsText: ['Open the billing ledger', 'Delete the archived invoice'],
          },
        ],
      }),
    })

    const receipt = (await invokeFunction(
      host.registry,
      AUTHORING_DRAFT_VERIFY_FUNCTION_ID,
      { draftPath: ACCEPT_CONTROL.filePath },
      HUMAN,
    )) as DraftReceipt

    expect(receipt.gates.addsValue.pass).toBe(true)
    const comparedIdentities = receipt.addsValueFinding.comparedTests.map(
      (compared) => compared.filePath,
    )
    expect(comparedIdentities).not.toContain(ACCEPT_CONTROL.filePath)
    // The unrelated entry DID join the lane, so the exclusion above is a filter and not an
    // empty corpus.
    expect(comparedIdentities).toEqual(['tests/unrelated.yaml'])
  })

  it('never measures a draft against its OWN fingerprint rows either', async () => {
    // Its own identity is in the index, so the union excludes it; rows come from the real fold.
    const knowledgeRoot = join(root, 'agent-qa-knowledge')
    mkdirSync(knowledgeRoot, { recursive: true })
    foldRunOutcomes({
      knowledgeRoot,
      handoff: suiteHandoff('RUN-SUITE-1'),
      extractAnchors: exercisedAnchors,
    })

    const executor = fixtureExecutor(agentQaRoot, ['passed', 'passed', 'passed'])
    const host = compose({ executor: executor.port, authoring: draftAuthoring() })

    const receipt = (await invokeFunction(
      host.registry,
      AUTHORING_DRAFT_VERIFY_FUNCTION_ID,
      { draftPath: ACCEPT_CONTROL.filePath },
      HUMAN,
    )) as DraftReceipt

    const comparedIdentities = receipt.addsValueFinding.comparedTests.map(
      (compared) => compared.filePath,
    )
    // The fold really landed — the sibling identity is on the FINGERPRINT lane, which only rows in
    // the derived index can put it on. Without this the case would pass over an empty database and
    // certify nothing.
    expect(comparedIdentities).toEqual(['tests/sibling.yaml'])
    expect(receipt.addsValueFinding.comparedTests[0]?.lane).toBe('fingerprint')
    // …and the draft's own rows, which are in that same table, did not cover it.
    expect(receipt.gates.addsValue.pass).toBe(true)
    expect(receipt.addsValueFinding.novelElements.length).toBeGreaterThan(0)
  })
})
