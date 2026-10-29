// One path through the registered op on a composed host; only the model and the parse are faked.

import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  AUTHORING_DRAFT_VERIFY_FUNCTION_ID,
  AUTHORING_DRAFT_WRITE_FUNCTION_ID,
  AUTHORING_FUNNEL_GET_FUNCTION_ID,
  RUNS_DIGEST_FUNCTION_ID,
  FunctionNotBoundError,
  authoringFanOutBound,
  invokeFunction,
} from '@vostride/agent-qa-agent'
import type { JobModelCapability, JobModelRequest } from '@vostride/agent-qa-agent'
import {
  getActiveExecutionContext,
  resolveExecutionContext,
  setActiveExecutionContextResolver,
} from '@vostride/agent-qa-safety'
// Spelled locally so a supplied confirm port can be smuggled in and shown never to be called.
interface ConfirmPort {
  readonly surface: 'tty-prompt'
  readonly ask: (action: RiskActionDescriptor) => boolean
}
import { FsEventLog, HANDOFF_FILE, RUNS_SUBDIR, slugBranch } from '@vostride/agent-qa-runner-local'
import {
  AUTHORING_DEDUP_CONTINUATIONS,
  AuthoringDraftWriteOutputSchema,
  CURRENT_HANDOFF_SCHEMA_VERSION,
  DRAFT_STABILITY_RUNS_N,
  MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
  asRunId,
  authoredSuiteTargetPath,
  computeDraftDisposition,
  exercisedAnchors,
  renderFanOutPreview,
} from '@vostride/agent-qa-schema'
import { foldRunOutcomes } from '@vostride/agent-qa-knowledge-local'
import type {
  Action,
  AuthoringDraftWriteOutput,
  AuthoringFunnelGetOutput,
  CompletedRunHandoff,
  DraftReceipt,
  MemberTestOutcome,
  RunDigest,
  ElementInfo,
  FunctionCaller,
  MaskedResolvedConfig,
  RiskActionDescriptor,
  RunsStartInput,
  StepEvidence,
  SubActionEvidence,
} from '@vostride/agent-qa-schema'
import { parse as parseYaml } from 'yaml'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { composeLocalAgent } from '../composition/compose-local-agent.js'
import type {
  DraftAuthoringPort,
  DraftParseOutcome,
  DraftStageOutcome,
  LocalAgentHost,
  RunExecutionPort,
} from '../composition/compose-local-agent.js'


// Whatever sits under the proposals directory, so nothing filed is read off the directory itself.
function filedProposals(agentQaRoot: string): readonly string[] {
  const dir = join(agentQaRoot, 'proposals')
  return existsSync(dir) ? readdirSync(dir) : []
}

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

// Everything the evaluator needs and nothing more.
const RUN_AND_READ_ONLY: FunctionCaller = {
  surface: 'test',
  origin: 'human',
}

const INTENT = 'Check that the local account form shows its heading'
const SCOPE = { tier: 'product', key: 'local-form' } as const

const DRAFT_TEST_NAME = 'Confirm the local account form page heading'

// The one document the scripted model emits: a whole test, because creation is not an edit.
const MODEL_DOCUMENT = `name: ${DRAFT_TEST_NAME}
target: local-form
use:
  browser:
    headless: true
steps:
  - Type "alice" into the Username field
  - Verify the page heading says "Local Form"
`

const DRAFT_STEPS: readonly string[] = [
  'Type "alice" into the Username field',
  'Verify the page heading says "Local Form"',
]

interface SuiteTextEntryFixture {
  readonly filePath: string
  readonly testName: string
  readonly stepsText: readonly string[]
}

/**
 * A suite test the INTENT above already describes, in different words.
 *
 * Every one of the intent's nine normalized tokens appears in this test's text and this test adds
 * one of its own, so the Jaccard is 9/10 -- comfortably over the pinned 0.45 rather than balanced
 * on it. The boundary itself is pinned by the frozen corpus in `packages/agent`; what this file
 * proves is that a refusal travels the whole composed path, which wants an unambiguous input.
 */
const NEAR_DUPLICATE_SUITE_TEST: SuiteTextEntryFixture = {
  filePath: 'tests/local-form-heading.yaml',
  testName: 'Check the local account form heading',
  stepsText: ['Verify that the form shows its heading'],
}

/** A suite test about something else entirely -- the control the refusal must NOT name. */
const DISTANT_SUITE_TEST: SuiteTextEntryFixture = {
  filePath: 'tests/billing-ledger.yaml',
  testName: 'Delete an archived invoice from the billing ledger',
  stepsText: ['Open the billing ledger', 'Delete the archived invoice'],
}

interface SubActionFixture {
  readonly type: string
  readonly ref: string
  readonly role: string
  readonly name: string
}

/** What the draft exercises: the Username textbox, then the page heading. */
const DRAFT_SUBACTIONS: readonly (readonly SubActionFixture[])[] = [
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
      url: 'http://127.0.0.1:8931/form.html',
    },
    result: { success: true },
  } as unknown as SubActionEvidence
}

function stepEvidence(index: number, subActions: readonly SubActionFixture[]): StepEvidence {
  return {
    stepIndex: index,
    stepText: DRAFT_STEPS[index] ?? `step ${index}`,
    cacheStatus: 'miss',
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
 * One completed gate-run, carrying BOTH durable markers and the draft's own identity.
 *
 * `filePath` is read off the run REQUEST rather than spelled here, which is what makes this
 * fixture unable to paper over a path defect: the loop staged the draft at a digest-derived path
 * and handed exactly that path to `runs.start`, and gates 1-2 find the draft's member by comparing
 * against these bytes. A hard-coded path would make the join pass no matter what the shelf minted.
 */
// Overridable so corpus cells author distinct drafts; one fixed name fails `addsValue`.
interface DraftRunIdentity {
  readonly testName: string
  readonly elementName: string
}

const FIXED_RUN_IDENTITY: DraftRunIdentity = {
  testName: DRAFT_TEST_NAME,
  elementName: 'local form',
}

function gateRunHandoff(
  runId: string,
  filePath: string,
  identity: DraftRunIdentity = FIXED_RUN_IDENTITY,
  // Parameterised so a cell can produce a gate-2 flip, the only state the consultation reaches.
  outcome: MemberTestOutcome = 'passed',
): CompletedRunHandoff {
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
        testId: identity.testName,
        testName: identity.testName,
        filePath,
        testIndex: 0,
        outcome,
        steps: DRAFT_SUBACTIONS
          .map((subActions) => subActions.map((fixture) => (
            fixture.role === 'heading' ? { ...fixture, name: identity.elementName } : fixture
          )))
          .map((subActions, index) => stepEvidence(index, subActions)),
      },
    ],
  } as unknown as CompletedRunHandoff
}

// Computed through `authoredSuiteTargetPath`, so the fixture names the file the accept arm writes.
const JOIN_TARGET = authoredSuiteTargetPath('tests/.agent-qa-drafts/any.yaml', DRAFT_TEST_NAME)
const FLAKY_NEIGHBOUR = 'Show the account banner'
const STABLE_NEIGHBOUR = 'Submit the local account form'

/**
 * An ORDINARY completed run over the JOIN TARGET — neither durable marker, so it FOLDS.
 *
 * Two members, and the pair is what makes the assertion a filter rather than a wildcard: one
 * neighbour whose outcome moves across builds, one that does not. `buildOrdinal` is a parameter
 * because a flip is a fact about two builds — the projection keeps `{buildOrdinal, passed}`
 * entries, and two folds at the same ordinal are one entry, which is a stable neighbour wearing a
 * flaky one's clothes.
 */
function neighbourSuiteHandoff(
  runId: string,
  buildOrdinal: number,
  flakyOutcome: MemberTestOutcome,
): CompletedRunHandoff {
  return {
    schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION,
    runId: asRunId(runId),
    scope: { tier: 'product', key: 'local-form' },
    buildOrdinal,
    executionContext: 'local-headless',
    aggregateVerdict: flakyOutcome === 'failed' ? 'failed' : 'passed',
    configDigests: { suiteConfigDigest: 'suite', testConfigDigest: 'test' },
    startedAt: 1,
    endedAt: 2,
    tests: [
      {
        testId: 't_flaky-neighbour',
        testName: FLAKY_NEIGHBOUR,
        filePath: JOIN_TARGET,
        testIndex: 0,
        outcome: flakyOutcome,
        steps: [stepEvidence(0, [{ type: 'click', ref: 'e3', role: 'button', name: 'banner' }])],
      },
      {
        testId: 't_stable-neighbour',
        testName: STABLE_NEIGHBOUR,
        filePath: JOIN_TARGET,
        testIndex: 1,
        outcome: 'passed',
        steps: [stepEvidence(0, [{ type: 'click', ref: 'e4', role: 'button', name: 'submit' }])],
      },
    ],
  } as unknown as CompletedRunHandoff
}

interface FixtureExecutor {
  readonly port: RunExecutionPort
  readonly startInputs: RunsStartInput[]
}

function fixtureExecutor(
  agentQaRoot: string,
  resolveIdentity: (filePath: string) => DraftRunIdentity = () => FIXED_RUN_IDENTITY,
  /** Per-run member outcomes, in start order. Absent means every run passes (the default). */
  outcomes: readonly MemberTestOutcome[] = [],
): FixtureExecutor {
  const startInputs: RunsStartInput[] = []
  return {
    startInputs,
    port: {
      execute(request) {
        const index = startInputs.length
        startInputs.push(request)
        const runId = `RUN-LOOP-${index}`
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
          `${JSON.stringify(gateRunHandoff(
            runId,
            request.patterns?.[0] ?? 'tests/missing.yaml',
            resolveIdentity(request.patterns?.[0] ?? 'tests/missing.yaml'),
            outcomes[index] ?? 'passed',
          ))}\n`,
          'utf8',
        )
        return Promise.resolve({ runId: asRunId(runId) })
      },
    },
  }
}

interface ScriptedModel {
  readonly capability: () => JobModelCapability
  readonly requests: JobModelRequest[]
}

/** One fixed valid document, whatever it is asked — and a record of what it was asked. */
function scriptedModel(document = MODEL_DOCUMENT): ScriptedModel {
  const requests: JobModelRequest[] = []
  return {
    requests,
    capability: () => ({
      modelId: 'fixture:authoring-loop',
      generate(request) {
        requests.push(request)
        return Promise.resolve({ text: document })
      },
    }),
  }
}

// Knows only the prompt: it adapts the block's example and throws when the block is absent.

const FORMAT_BLOCK_TITLE = 'Test document format'
const FORMAT_EXAMPLE_MARKER = 'A complete document looks exactly like this:'
const TARGETS_BLOCK_TITLE = 'Configured targets'

// Matched as a rule, because a block that merely mentions `context` does not permit it.
const CONTEXT_OPTIONAL_RULE = /^`context` is optional:/m

/** What the generator has left when the prompt teaches it nothing: nothing. */
class FormatBlockMissingError extends Error {
  constructor() {
    super(`the prompt carries no "${FORMAT_BLOCK_TITLE}" block, and this generator knows no `
      + 'document schema of its own')
    this.name = 'FormatBlockMissingError'
  }
}

/** The same posture one key over: no served vocabulary, no invented target. */
class TargetVocabularyMissingError extends Error {
  constructor() {
    super(`the prompt serves no "${TARGETS_BLOCK_TITLE}" block, and this generator will not `
      + 'invent a target')
    this.name = 'TargetVocabularyMissingError'
  }
}

/** One `## `-titled block's body, off the rendered markdown a model is handed. */
function promptBlockBody(text: string, title: string): string | undefined {
  for (const part of text.split(/^## /m).slice(1)) {
    const split = part.indexOf('\n\n')
    if (part.slice(0, split) === title) return part.slice(split + 2).replace(/\n+$/, '')
  }
  return undefined
}

// Picks a served name; the scope is only a hint, because it names a product, not a target.
function targetFromVocabulary(request: JobModelRequest, scopeKey: string): string {
  const served = promptBlockBody(request.prompt, TARGETS_BLOCK_TITLE)
  const names = (served ?? '').split('\n').map((line) => line.trim()).filter((line) => line !== '')
  if (names.length === 0) throw new TargetVocabularyMissingError()
  return names.find((name) => name.includes(scopeKey) || scopeKey.includes(name))
    ?? (names[0] as string)
}

/** The block's own body, or the generator's refusal — the one lift both generators below share. */
function formatBlockOrThrow(request: JobModelRequest): string {
  const format = promptBlockBody(request.system ?? '', FORMAT_BLOCK_TITLE)
  if (format === undefined) throw new FormatBlockMissingError()
  if (format.indexOf(FORMAT_EXAMPLE_MARKER) < 0) throw new FormatBlockMissingError()
  return format
}

// Copies the example's `target` verbatim, the way a model skipping one bullet would.
function exampleWithIntentName(request: JobModelRequest): string {
  const format = formatBlockOrThrow(request)
  const marker = format.indexOf(FORMAT_EXAMPLE_MARKER)
  const example = `${format.slice(marker + FORMAT_EXAMPLE_MARKER.length).trim()}\n`
  const intent = promptBlockBody(request.prompt, 'Intent') ?? ''
  return example.replace(/^name: .*$/m, () => `name: ${intent}`)
}

function documentFromPrompt(request: JobModelRequest): string {
  const format = formatBlockOrThrow(request)
  const intent = promptBlockBody(request.prompt, 'Intent') ?? ''
  const scope = promptBlockBody(request.prompt, 'Scope') ?? ''
  const target = targetFromVocabulary(request, scope.split(':')[1] ?? scope)

  const document = exampleWithIntentName(request)
    .replace(/^target: .*$/m, () => `target: ${target}`)

  // A FIFTH KEY, EMITTED ONLY BECAUSE THE BLOCK TAUGHT IT, with its value derived from the Intent
  // block rather than spelled here.
  if (!CONTEXT_OPTIONAL_RULE.test(format)) return document
  return document.replace(
    /^target: .*$/m,
    (line) => `${line}\ncontext: Standing background for this test — ${intent}`,
  )
}

function formatFollowingModel(): ScriptedModel {
  const requests: JobModelRequest[] = []
  return {
    requests,
    capability: () => ({
      modelId: 'fixture:format-following',
      generate(request) {
        requests.push(request)
        // The refinement round asks about an EXISTING draft and carries no format block; a
        // generator with nothing to add says so. The compile call is the one under test.
        if (!/^Agent context: authoring\.draft\.write — compile /.test(request.system ?? '')) {
          return Promise.resolve({ text: 'no changes needed' })
        }
        return Promise.resolve({ text: documentFromPrompt(request) })
      },
    }),
  }
}

// Emits the example's `target` against a host declaring another, and records what it emitted.
function exampleTargetCopyingModel(): {
  readonly capability: () => JobModelCapability
  readonly requests: JobModelRequest[]
  readonly documents: string[]
} {
  const requests: JobModelRequest[] = []
  const documents: string[] = []
  return {
    requests,
    documents,
    capability: () => ({
      modelId: 'fixture:example-target-copying',
      generate(request) {
        requests.push(request)
        if (!/^Agent context: authoring\.draft\.write — compile /.test(request.system ?? '')) {
          return Promise.resolve({ text: 'no changes needed' })
        }
        const text = exampleWithIntentName(request)
        documents.push(text)
        return Promise.resolve({ text })
      },
    }),
  }
}

const SHELF_DIR = 'tests/.agent-qa-drafts'

/** The written-test receipt on the op's answer, read as data. */
function writtenOf(result: AuthoringDraftWriteOutput): unknown {
  return (result as Record<string, unknown>)['written']
}

/**
 * The host's draft-authoring capability, over a REAL temp workspace.
 *
 * `stageDraft` hashes the bytes it was handed, writes them at the digest-derived shelf path, and
 * answers the descriptor; `parseDraft` re-reads that file FROM DISK and re-derives the digest from
 * what it finds there. The two are deliberately separate reads of one file, so the receipt's
 * `contentDigest` is a fact about bytes that survived a round trip rather than a value handed
 * along in memory.
 */
/**
 * The EASY branch this file's fixtures have always been on: one target whose product IS its name.
 *
 * Named rather than inlined so the HARD branch below reads as the deliberate contrast it is.
 */
const CONFIGURED_TARGETS: readonly string[] = ['local-form']

// `storefront-web` declares `product: storefront`, so the derived scope is not a configured target.
const TWO_CONFIGURED_TARGETS: readonly string[] = ['local-form', 'storefront-web']

function draftAuthoring(workspace: string, suiteText: readonly {
  readonly filePath: string
  readonly testName: string
  readonly stepsText: readonly string[]
}[] = [], targetNames: readonly string[] = CONFIGURED_TARGETS): DraftAuthoringPort {
  function describe(contents: string, filePath: string): DraftStageOutcome {
    let document: unknown
    try {
      document = parseYaml(contents)
    } catch (error) {
      return { kind: 'unparsable', reason: (error as Error).message }
    }
    const test = document as { name?: unknown; target?: unknown; steps?: unknown } | null
    if (test === null || typeof test.name !== 'string' || !Array.isArray(test.steps)) {
      return { kind: 'unparsable', reason: 'the document is not a single test with name and steps' }
    }
    // `TestDefinitionSchema` requires `target`, so the fake refuses rather than defaulting one.
    if (typeof test.target !== 'string') {
      return { kind: 'unparsable', reason: 'the document carries no `target`' }
    }
    const target = test.target
    return {
      kind: 'staged',
      draft: {
        testId: test.name,
        filePath,
        testName: test.name,
        target,
        steps: test.steps.map((step) => String(step)),
        contentDigest: createHash('sha256').update(contents).digest('hex'),
      },
    }
  }

  return {
    // Throws because every case supplies its scope; a fake that answered one would hide derivation.
    deriveDefaultScope(): Promise<never> {
      throw new Error('every case here supplies a scope, so nothing derives one')
    },
    // Never reached: no case routes to repair.
    applyPatchesToDraft(): Promise<never> {
      throw new Error('this case never enters repair, so no patch set is ever applied')
    },
    stageDraft(contents: string): Promise<DraftStageOutcome> {
      const contentDigest = createHash('sha256').update(contents).digest('hex')
      const filePath = `${SHELF_DIR}/${contentDigest}.yaml`
      const described = describe(contents, filePath)
      if (described.kind === 'unparsable') return Promise.resolve(described)
      const absolute = join(workspace, filePath)
      mkdirSync(dirname(absolute), { recursive: true })
      writeFileSync(absolute, contents, 'utf8')
      return Promise.resolve(described)
    },

    // Keeps the host's two guards, the read bytes and the shelf's own bytes, and runs nothing else.
    publishDraft(request) {
      const target = join(workspace, request.targetPath)
      const found = existsSync(target)
        ? createHash('sha256').update(readFileSync(target)).digest('hex')
        : undefined
      if (found !== request.sourceDigest) {
        return Promise.resolve({
          kind: 'not-written' as const,
          targetPath: request.targetPath,
          reason: 'target-changed' as const,
        })
      }
      const bytes = readFileSync(join(workspace, request.draftPath))
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, bytes)
      return Promise.resolve({
        kind: 'written' as const,
        filePath: request.targetPath,
        contentDigest: createHash('sha256').update(bytes).digest('hex'),
      })
    },

    parseDraft(filePath: string): Promise<DraftParseOutcome> {
      let contents: string
      try {
        contents = readFileSync(join(workspace, filePath), 'utf8')
      } catch {
        return Promise.resolve({ kind: 'not-found' })
      }
      const described = describe(contents, filePath)
      return Promise.resolve(
        described.kind === 'staged'
          ? { kind: 'parsed', draft: described.draft }
          : { kind: 'unparsable', reason: described.reason },
      )
    },

    suiteTextCorpus() {
      return Promise.resolve(suiteText)
    },

    // Handed the names, because these cells measure that the loop serves whatever the host answers.
    configuredTargetNames() {
      return Promise.resolve(targetNames)
    },
  }
}

// Records what it is asked, so a cell can show the confirm port is never called.
function recordingConfirm(answer: boolean): {
  readonly port: ConfirmPort
  readonly actions: RiskActionDescriptor[]
} {
  const actions: RiskActionDescriptor[] = []
  return {
    actions,
    port: {
      // A TERMINAL double: every scene in this suite is a CLI dispatch.
      surface: 'tty-prompt',
      ask: (action: RiskActionDescriptor) => {
        actions.push(action)
        return answer
      },
    },
  }
}

describe('authoring.draft.write end to end through the composition root', () => {
  let root: string
  let agentQaRoot: string
  let workspace: string
  const hosts: LocalAgentHost[] = []

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'authoring-loop-'))
    agentQaRoot = join(root, '.agent-qa')
    workspace = join(root, 'workspace')
    mkdirSync(agentQaRoot, { recursive: true })
    mkdirSync(workspace, { recursive: true })

    setActiveExecutionContextResolver(() => resolveExecutionContext({ isTty: true, ciMarkers: false }))
    expect(getActiveExecutionContext()).toBe('local-interactive')
  })

  afterEach(() => {
    for (const composed of hosts.splice(0)) void composed.close()
    rmSync(root, { recursive: true, force: true })
    // Restore the MODULE default rather than the detector, so no TTY-shaped ambient leaks into a
    // later file that shares this worker.
    setActiveExecutionContextResolver(() => 'local-headless')
  })

  function compose(input: {
    readonly executor?: RunExecutionPort
    readonly authoring?: DraftAuthoringPort
    readonly model?: () => JobModelCapability
    readonly confirm?: ConfirmPort
  }): LocalAgentHost {
    const host = composeLocalAgent({
      mask: (text) => text,
      agentQaRoot,
      mintQuarantineIdentityPath: (filePath: string) => filePath,
      config: { getMasked: () => Promise.resolve(MASKED_CONFIG) },
      knowledgeRoot: () => join(root, 'agent-qa-knowledge'),
      model: input.model ?? (() => scriptedModel().capability()),
      // The composition input declares no confirm; a supplied port is smuggled past the type.
      ...{ confirm: input.confirm ?? { surface: 'tty-prompt', ask: () => true } } as object,
      ...(input.executor === undefined ? {} : { runExecution: input.executor }),
      ...(input.authoring === undefined ? {} : { draftAuthoring: input.authoring }),
    })
    hosts.push(host)
    return host
  }

  it('turns one intent into a staged draft and the receipt the evaluator minted', async () => {
    const executor = fixtureExecutor(agentQaRoot)
    const model = scriptedModel()
    const host = compose({
      executor: executor.port,
      authoring: draftAuthoring(workspace),
      model: model.capability,
    })

    const result = (await invokeFunction(
      host.registry,
      AUTHORING_DRAFT_WRITE_FUNCTION_ID,
      { intent: INTENT, scope: SCOPE },
      HUMAN,
    )) as AuthoringDraftWriteOutput

    // Schema-valid at the boundary a caller reads, not merely shaped like the output.
    expect(AuthoringDraftWriteOutputSchema.safeParse(result).success).toBe(true)
    expect(result.outcome).toBe('drafted')

    // The compile and the one refinement round, each system block leading with `Agent context:`.
    expect(model.requests).toHaveLength(2)
    expect(model.requests[0]?.system).toMatch(/^Agent context: authoring\.draft\.write — compile /)
    expect(model.requests[1]?.system).toMatch(/^Agent context: authoring\.draft\.write — refine /)

    // The draft really is on the shelf, at the digest-derived name, and the receipt's digest is
    // the sha256 of the bytes that are there. This is the write→read join: the shelf wrote them,
    // the parse re-read them, and the two agree.
    const staged = readdirSync(join(workspace, SHELF_DIR))
    expect(staged).toHaveLength(1)
    const shelfBytes = readFileSync(join(workspace, SHELF_DIR, staged[0] as string), 'utf8')
    const shelfDigest = createHash('sha256').update(shelfBytes).digest('hex')
    expect(result.draftRef?.contentDigest).toBe(shelfDigest)
    expect(staged[0]).toBe(`${shelfDigest}.yaml`)
    expect(result.draftRef?.filePath).toBe(`${SHELF_DIR}/${shelfDigest}.yaml`)
    expect(result.receipt?.draftRef.contentDigest).toBe(shelfDigest)

    // The receipt is the evaluator's: four separately-named gate booleans, N stability runs, and
    // a disposition that equals what `computeDraftDisposition` — the ONE derivation site — says
    // about those gates. Comparing against the function rather than against a literal is what
    // makes this unable to certify a second reading of the rule.
    const receipt = result.receipt
    expect(receipt).toBeDefined()
    expect(receipt?.gates.executesDefinitive.pass).toBe(true)
    expect(receipt?.gates.stableVerdict.pass).toBe(true)
    expect(receipt?.gates.addsValue.pass).toBe(true)
    expect(receipt?.gates.falsifiableAssertion.pass).toBe(true)
    expect(receipt?.stabilityRunsCompleted).toBe(DRAFT_STABILITY_RUNS_N)
    expect(receipt?.disposition).toBe(computeDraftDisposition({
      gates: {
        executesDefinitive: true,
        stableVerdict: true,
        addsValue: true,
        falsifiableAssertion: true,
      },
      stabilityRunsRequested: DRAFT_STABILITY_RUNS_N,
      stabilityRunsCompleted: DRAFT_STABILITY_RUNS_N,
    }))

    // Stage 4 really reached `runs.start`, on the staged path, with both gate-run markers.
    expect(executor.startInputs).toHaveLength(DRAFT_STABILITY_RUNS_N)
    for (const started of executor.startInputs) {
      expect(started.gateRun).toBe(true)
      expect(started.excludedFromOutcomes).toBe(true)
      expect(started.patterns).toEqual([`${SHELF_DIR}/${shelfDigest}.yaml`])
    }

    // …and the receipt was PERSISTED, keyed by the same digest — one store, one answer.
    expect(readdirSync(join(agentQaRoot, 'draft-receipts'))).toEqual([`${shelfDigest}.json`])
  })

  it('writes a KEEP-ELIGIBLE draft to its target with its receipt', async () => {
    const executor = fixtureExecutor(agentQaRoot)
    const host = compose({
      executor: executor.port,
      authoring: draftAuthoring(workspace),
      model: scriptedModel().capability,
    })

    const result = (await invokeFunction(
      host.registry,
      AUTHORING_DRAFT_WRITE_FUNCTION_ID,
      { intent: INTENT, scope: SCOPE },
      HUMAN,
    )) as AuthoringDraftWriteOutput

    expect(result.receipt?.disposition).toBe('keep-eligible')
    const targetPath = authoredSuiteTargetPath(
      result.draftRef?.filePath ?? '',
      result.draftRef?.testName ?? '',
    )
    expect(targetPath).toBe('tests/confirm-the-local-account-form-page-heading.yaml')
    const shelfBytes = readFileSync(join(workspace, result.draftRef?.filePath ?? 'missing'))
    expect(existsSync(join(workspace, targetPath))).toBe(true)
    expect(readFileSync(join(workspace, targetPath)).equals(shelfBytes)).toBe(true)
    expect(readdirSync(join(workspace, 'tests')).sort())
      .toEqual(['.agent-qa-drafts', 'confirm-the-local-account-form-page-heading.yaml'])
    expect(writtenOf(result)).toEqual({
      file: {
        kind: 'written',
        filePath: targetPath,
        contentDigest: result.draftRef?.contentDigest,
      },
      disposition: 'keep-eligible',
      gates: {
        executesDefinitive: true,
        stableVerdict: true,
        addsValue: true,
        falsifiableAssertion: true,
      },
    })
    expect(filedProposals(agentQaRoot)).toEqual([])
  })

  it('writes an UNVERIFIED draft-mode draft, saying it is unverified', async () => {
    const executor = fixtureExecutor(agentQaRoot)
    const host = compose({
      executor: executor.port,
      authoring: draftAuthoring(workspace),
      model: scriptedModel().capability,
    })

    const result = (await invokeFunction(
      host.registry,
      AUTHORING_DRAFT_WRITE_FUNCTION_ID,
      { intent: INTENT, scope: SCOPE, draftMode: true },
      HUMAN,
    )) as AuthoringDraftWriteOutput

    expect(result.outcome).toBe('drafted')
    expect(result.receipt?.disposition).toBe('unverified')
    expect(executor.startInputs).toHaveLength(1)
    const targetPath = 'tests/confirm-the-local-account-form-page-heading.yaml'
    expect(existsSync(join(workspace, targetPath))).toBe(true)
    expect(writtenOf(result)).toEqual({
      file: { kind: 'written', filePath: targetPath, contentDigest: result.draftRef?.contentDigest },
      disposition: 'unverified',
      gates: {
        executesDefinitive: true,
        stableVerdict: true,
        addsValue: true,
        falsifiableAssertion: true,
      },
    })
  })

  // THE RETRY EDGE. Authoring the same test twice mints the same bytes and the same target, and the
  // second final write finds the first one there: a NEW test claims its target is absent, so it is
  // refused as `target-changed` and the file already written is left exactly as it was.
  it('a second identical draft does not overwrite the first written test', async () => {
    const executor = fixtureExecutor(agentQaRoot)
    const host = compose({
      executor: executor.port,
      authoring: draftAuthoring(workspace),
      model: scriptedModel().capability,
    })
    const target = join(workspace, 'tests/confirm-the-local-account-form-page-heading.yaml')

    const first = (await invokeFunction(
      host.registry,
      AUTHORING_DRAFT_WRITE_FUNCTION_ID,
      { intent: INTENT, scope: SCOPE },
      HUMAN,
    )) as AuthoringDraftWriteOutput
    expect(writtenOf(first)).toMatchObject({ file: { kind: 'written' } })
    writeFileSync(target, `${readFileSync(target, 'utf8')}# kept by a person\n`)
    const edited = readFileSync(target)

    const second = (await invokeFunction(
      host.registry,
      AUTHORING_DRAFT_WRITE_FUNCTION_ID,
      { intent: INTENT, scope: SCOPE },
      HUMAN,
    )) as AuthoringDraftWriteOutput

    expect(second.outcome).toBe('drafted')
    expect(writtenOf(second)).toMatchObject({
      file: {
        kind: 'not-written',
        targetPath: 'tests/confirm-the-local-account-form-page-heading.yaml',
        reason: 'target-changed',
      },
      disposition: 'keep-eligible',
    })
    expect(readFileSync(target).equals(edited)).toBe(true)
  })

  // A flip fails gate 2, so a `rejected` draft must not exist at its target even if the call threw.
  it('never writes a REJECTED draft to its target', async () => {
    const executor = fixtureExecutor(agentQaRoot, () => FIXED_RUN_IDENTITY, ['passed', 'failed'])
    const host = compose({
      executor: executor.port,
      authoring: draftAuthoring(workspace),
      model: scriptedModel().capability,
    })

    const answer = await invokeFunction(
      host.registry,
      AUTHORING_DRAFT_WRITE_FUNCTION_ID,
      { intent: INTENT, scope: SCOPE },
      HUMAN,
    ).then(
      (value) => value as AuthoringDraftWriteOutput,
      (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
    )

    const receipts = readdirSync(join(agentQaRoot, 'draft-receipts'))
    expect(receipts).toHaveLength(1)
    const receipt = JSON.parse(
      readFileSync(join(agentQaRoot, 'draft-receipts', receipts[0] as string), 'utf8'),
    ) as DraftReceipt
    expect(receipt.disposition).toBe('rejected')
    expect(receipt.gates.stableVerdict.pass).toBe(false)
    expect(existsSync(join(workspace, 'tests/confirm-the-local-account-form-page-heading.yaml')))
      .toBe(false)
    expect(readdirSync(join(workspace, 'tests'))).toEqual(['.agent-qa-drafts'])
    if (!(answer instanceof Error)) {
      expect(answer.outcome).not.toBe('drafted')
      expect(writtenOf(answer)).toBeUndefined()
    }
  })

  it('lists as bound on a composed host, off the declarations rather than CLI stdout', () => {
    const executor = fixtureExecutor(agentQaRoot)
    const host = compose({ executor: executor.port, authoring: draftAuthoring(workspace) })

    const declared = host.registry
      .list(HUMAN)
      .find((declaration) => declaration.id === AUTHORING_DRAFT_WRITE_FUNCTION_ID)

    expect(declared?.bindingStatus).toBe('bound')
    // The id follows the registry's dot taxonomy, with no underscore for the chat projection.
    expect(declared?.id).toMatch(/^[a-z]+(?:\.[a-z]+)+$/)
    expect(declared?.id).not.toContain('_')
    expect(Object.keys(declared ?? {})).not.toContain('requiredScopes')
  })

  it('serves a run+read caller exactly as a full caller — no test-write scope is read', async () => {
    const executor = fixtureExecutor(agentQaRoot)
    const model = scriptedModel()
    const host = compose({
      executor: executor.port,
      authoring: draftAuthoring(workspace),
      model: model.capability,
    })

    const result = (await invokeFunction(
      host.registry,
      AUTHORING_DRAFT_WRITE_FUNCTION_ID,
      { intent: INTENT, scope: SCOPE },
      RUN_AND_READ_ONLY,
    )) as AuthoringDraftWriteOutput

    expect(AuthoringDraftWriteOutputSchema.safeParse(result).success).toBe(true)
    expect(result.outcome).toBe('drafted')

    // The same caller reaches the evaluator too, as it always did.
    const stillAllowed = await invokeFunction(
      host.registry,
      AUTHORING_DRAFT_VERIFY_FUNCTION_ID,
      { draftPath: 'tests/nothing-is-here.yaml' },
      RUN_AND_READ_ONLY,
    ).then(() => undefined, (error: unknown) => error as Error)
    expect(stillAllowed?.name).toBe('DraftFileNotFoundError')
  })

  it('refuses BY NAME on a host that cannot author — never an empty brief', async () => {
    const executor = fixtureExecutor(agentQaRoot)
    const host = compose({ executor: executor.port })

    const declared = host.registry
      .list(HUMAN)
      .find((declaration) => declaration.id === AUTHORING_DRAFT_WRITE_FUNCTION_ID)
    expect(declared?.bindingStatus).toBe('unbound')

    await expect(invokeFunction(
      host.registry,
      AUTHORING_DRAFT_WRITE_FUNCTION_ID,
      { intent: INTENT, scope: SCOPE },
      HUMAN,
    )).rejects.toBeInstanceOf(FunctionNotBoundError)
    expect(executor.startInputs).toHaveLength(0)
  })

  it('refuses an unparsable compiled draft and leaves the shelf empty', async () => {
    const executor = fixtureExecutor(agentQaRoot)
    const host = compose({
      executor: executor.port,
      authoring: draftAuthoring(workspace),
      model: scriptedModel('Sure! Here is your test:\n```yaml\nname: [unclosed\n').capability,
    })

    const failure = await invokeFunction(
      host.registry,
      AUTHORING_DRAFT_WRITE_FUNCTION_ID,
      { intent: INTENT, scope: SCOPE },
      HUMAN,
    ).then(() => undefined, (error: unknown) => error as Error)

    expect(failure?.name).toBe('AuthoringDraftUnparsableError')
    // NEVER A PARTIAL WRITE: the shelf directory was never created, so there is nothing for a
    // later run — or a later reader — to mistake for a draft.
    expect(readdirSync(workspace)).toEqual([])
    expect(executor.startInputs).toHaveLength(0)
  })

  it('authors from a ZERO-exemplar brief with the prompt as its only schema', async () => {
    const model = formatFollowingModel()
    // The draft's own name is what the generator derived from the intent, so the gate runs join on
    // a name this cell did not choose — a fixed identity would have papered over a generator that
    // ignored the Intent block entirely.
    const executor = fixtureExecutor(agentQaRoot, () => ({
      testName: INTENT,
      elementName: 'local form',
    }))
    const host = compose({
      executor: executor.port,
      authoring: draftAuthoring(workspace),
      model: model.capability,
    })

    const result = (await invokeFunction(
      host.registry,
      AUTHORING_DRAFT_WRITE_FUNCTION_ID,
      { intent: INTENT, scope: SCOPE },
      HUMAN,
    )) as AuthoringDraftWriteOutput

    // THE CONDITION, PRODUCED: this host's knowledge root is empty, so the compile prompt's
    // exemplar block carries the empty answer. Every prior proof of stage 3 in this file ran a
    // generator that already held a valid document; this one had only the prompt.
    expect(model.requests[0]?.prompt).toContain('No exemplar tests were served for this scope.')

    expect(result.outcome).toBe('drafted')
    expect(result.receipt).toBeDefined()
    expect(result.receipt?.draftRef.contentDigest).toBe(result.draftRef?.contentDigest)

    // The shelf holds the keys the block teaches, with values from the Intent and Scope blocks.
    const staged = readdirSync(join(workspace, SHELF_DIR))
    expect(staged).toHaveLength(1)
    const document = parseYaml(
      readFileSync(join(workspace, SHELF_DIR, staged[0] as string), 'utf8'),
    ) as Record<string, unknown>
    expect(Object.keys(document).sort()).toEqual(['context', 'name', 'steps', 'target', 'test-id'])
    expect(document['name']).toBe(INTENT)
    expect(document['target']).toBe(SCOPE.key)
  })

  it('emits the optional `context` key the format block teaches', async () => {
    // Claims the prompt channel only; the shipped parser's `context` is the CLI's own cell.
    const model = formatFollowingModel()
    const executor = fixtureExecutor(agentQaRoot, () => ({
      testName: INTENT,
      elementName: 'local form',
    }))
    const host = compose({
      executor: executor.port,
      authoring: draftAuthoring(workspace),
      model: model.capability,
    })

    const result = (await invokeFunction(
      host.registry,
      AUTHORING_DRAFT_WRITE_FUNCTION_ID,
      { intent: INTENT, scope: SCOPE },
      HUMAN,
    )) as AuthoringDraftWriteOutput

    expect(result.outcome).toBe('drafted')

    // THE RULE IS IN THE PROMPT — the condition, produced off the request the loop actually built
    // rather than assumed from the constant's source.
    const format = promptBlockBody(model.requests[0]?.system ?? '', FORMAT_BLOCK_TITLE)
    expect(format).toBeDefined()
    expect(CONTEXT_OPTIONAL_RULE.test(format ?? '')).toBe(true)

    // `context` is an `EDITABLE_POINTER_ROOTS` member, so the key must reach the staged bytes.
    const staged = readdirSync(join(workspace, SHELF_DIR))
    expect(staged).toHaveLength(1)
    const document = parseYaml(
      readFileSync(join(workspace, SHELF_DIR, staged[0] as string), 'utf8'),
    ) as Record<string, unknown>
    expect(document['context']).toContain(INTENT)
  })

  it('chooses `target` from the served vocabulary when product ≠ target name', async () => {
    // THE HARD BRANCH, THROUGH THE COMPOSED OP. This host declares `storefront-web` with
    // `product: storefront`, so the scope an intent-only call would be authored at is
    // `product:storefront` — which is not a configured target. `compileDraft` renders only
    // `${tier}:${key}` and nothing validates `target` before `runs.start`, so a stage that read the
    // scope key as a target would stage a test this project cannot run, with `target` outside
    // `EDITABLE_POINTER_ROOTS` and therefore beyond repair.
    const scope = { tier: 'product', key: 'storefront' } as const
    const model = formatFollowingModel()
    const executor = fixtureExecutor(agentQaRoot, () => ({
      testName: INTENT,
      elementName: 'storefront',
    }))
    const host = compose({
      executor: executor.port,
      authoring: draftAuthoring(workspace, [], TWO_CONFIGURED_TARGETS),
      model: model.capability,
    })

    const result = (await invokeFunction(
      host.registry,
      AUTHORING_DRAFT_WRITE_FUNCTION_ID,
      { intent: INTENT, scope },
      HUMAN,
    )) as AuthoringDraftWriteOutput

    expect(result.outcome).toBe('drafted')

    // ① THE VOCABULARY REACHED THE PROMPT, in the CONTEXT tier beside Scope — target names are
    // per-project facts, and the stable tier's shared byte prefix must stay project-independent.
    const servedBlock = promptBlockBody(model.requests[0]?.prompt ?? '', TARGETS_BLOCK_TITLE)
    expect(servedBlock?.split('\n').map((line) => line.trim()).sort())
      .toEqual([...TWO_CONFIGURED_TARGETS].sort())

    // ② AND THE STAGED TARGET IS A MEMBER OF IT — not equal to a name this cell chose, which would
    // pin the generator's preference heuristic rather than the property under test.
    const staged = readdirSync(join(workspace, SHELF_DIR))
    expect(staged).toHaveLength(1)
    const document = parseYaml(
      readFileSync(join(workspace, SHELF_DIR, staged[0] as string), 'utf8'),
    ) as Record<string, unknown>
    expect(TWO_CONFIGURED_TARGETS).toContain(document['target'])

    // ③ THE CONTROL: it is not the scope key. Every prior fixture in this file had product ==
    // target name, so no cell here could tell a served vocabulary from a scope-key slice.
    expect(document['target']).not.toBe(scope.key)
  })

  it('REFUSES an off-vocabulary `target` before the first gate run', async () => {
    // Refused before the run: an unknown target costs real child runs, and no patch edits `target`.
    const model = exampleTargetCopyingModel()
    const executor = fixtureExecutor(agentQaRoot, () => ({
      testName: INTENT,
      elementName: 'local form',
    }))
    const host = compose({
      executor: executor.port,
      // The EASY-branch vocabulary, deliberately: one name, `local-form`, and the emitted value is
      // not it. A two-target host would leave a reader wondering which name the guard compared.
      authoring: draftAuthoring(workspace, [], CONFIGURED_TARGETS),
      model: model.capability,
    })

    const failure = await invokeFunction(
      host.registry,
      AUTHORING_DRAFT_WRITE_FUNCTION_ID,
      { intent: INTENT, scope: SCOPE },
      HUMAN,
    ).then(() => undefined, (error: unknown) => error as Error)

    // ① THE EMISSION IS PRODUCED, NOT ASSERTED. The generator really did emit an off-vocabulary
    // target, and the vocabulary the loop served really did exclude it — both read off the
    // invocation rather than restated from this file's constants.
    expect(model.documents[0]).toContain('target: sign-in')
    const servedBlock = promptBlockBody(model.requests[0]?.prompt ?? '', TARGETS_BLOCK_TITLE)
    expect(servedBlock?.split('\n').map((line) => line.trim()).filter((line) => line !== ''))
      .toEqual([...CONFIGURED_TARGETS])

    // ② THE REFUSAL IS TYPED AND NAMES BOTH SIDES — what was emitted and what was configured, so a
    // person reading it can see the whole comparison rather than being told one half of it.
    expect(failure?.name).toBe('AuthoringDraftUnconfiguredTargetError')
    expect(failure?.message).toContain('sign-in')
    expect(failure?.message).toContain('local-form')

    // ③ AND NOTHING RAN. This is the claim the guard exists for: the cost is one refusal, not nine
    // child processes. `startInputs` is the executor's own ledger of gate runs.
    expect(executor.startInputs).toEqual([])
  })

  it('will not invent a target: the generator throws when no vocabulary is served', () => {
    // Non-vacuity: a generator falling back to the scope key would pass the cell above.
    const model = formatFollowingModel().capability()

    expect(() => model.generate({
      system: 'Agent context: authoring.draft.write — compile a whole test document\n\n'
        + `## ${FORMAT_BLOCK_TITLE}\n\n${FORMAT_EXAMPLE_MARKER}\n\nname: x\ntest-id: y\n`
        + 'target: z\nsteps:\n  - do a thing\n',
      prompt: '## Intent\n\nanything\n\n## Scope\n\nproduct:local-form',
    })).toThrow(TARGETS_BLOCK_TITLE)
  })

  it('has no schema of its own: the generator throws when the format block is absent', () => {
    // Non-vacuity: a generator falling back to a held document would pass the cell above.
    const model = formatFollowingModel().capability()

    expect(() => model.generate({
      system: 'Agent context: authoring.draft.write — compile a whole test document\n\n## Role\n\n'
        + 'You author agent-qa test documents.',
      prompt: '## Intent\n\nanything\n\n## Scope\n\nproduct:local-form',
    })).toThrow(FORMAT_BLOCK_TITLE)
  })

  it('refuses a near-duplicate intent BEFORE any model call, naming what it matched', async () => {
    const executor = fixtureExecutor(agentQaRoot)
    const model = scriptedModel()
    const host = compose({
      executor: executor.port,
      // TWO suite members, and the refusal must name the right one. A cell whose corpus held a
      // single test would pass for a lane that named whatever it was handed.
      authoring: draftAuthoring(workspace, [NEAR_DUPLICATE_SUITE_TEST, DISTANT_SUITE_TEST]),
      model: model.capability,
    })

    const result = (await invokeFunction(
      host.registry,
      AUTHORING_DRAFT_WRITE_FUNCTION_ID,
      { intent: INTENT, scope: SCOPE },
      HUMAN,
    )) as AuthoringDraftWriteOutput

    expect(AuthoringDraftWriteOutputSchema.safeParse(result).success).toBe(true)
    expect(result.outcome).toBe('refused')

    // THE ASSERTION THAT MAKES "before a model token is spent" A MEASURED CLAIM rather than a
    // description of the code's shape. Zero, not "fewer than one" -- the loop reaches the model
    // exactly once when it authors, so a dedup that ran after compile would read 1 here.
    expect(model.requests).toHaveLength(0)
    // And nothing was written, started, or half-done either: no shelf, no gate-run.
    expect(readdirSync(workspace)).toEqual([])
    expect(executor.startInputs).toHaveLength(0)
    expect(result.draftRef).toBeUndefined()
    expect(result.receipt).toBeUndefined()

    // The refusal names its evidence, not merely that it refused.
    expect(result.refusal?.filePath).toBe(NEAR_DUPLICATE_SUITE_TEST.filePath)
    expect(result.refusal?.testName).toBe(NEAR_DUPLICATE_SUITE_TEST.testName)
    expect(result.refusal?.matchedRef)
      .toBe(`${NEAR_DUPLICATE_SUITE_TEST.filePath}::${NEAR_DUPLICATE_SUITE_TEST.testName}`)
    expect(result.refusal?.score).toBeCloseTo(0.9, 10)
    expect(result.refusal?.threshold).toBe(0.45)
    expect(result.refusal?.sharedTokens).toBe(9)
    // The universe is the whole suite, not the higher-scoring half of it.
    expect(result.refusal?.comparedTests).toBe(2)
    expect(result.refusal?.continuations).toEqual([...AUTHORING_DEDUP_CONTINUATIONS])
  })

  it('still AUTHORS when the same suite holds only a distant test', async () => {
    // The admit leg beside the refuse leg, over a NON-EMPTY corpus. Every other cell in this file
    // screens against an empty suite, so without this one "the lane admits" would be untested on
    // the only input where refusing is possible at all.
    const executor = fixtureExecutor(agentQaRoot)
    const model = scriptedModel()
    const host = compose({
      executor: executor.port,
      authoring: draftAuthoring(workspace, [DISTANT_SUITE_TEST]),
      model: model.capability,
    })

    const result = (await invokeFunction(
      host.registry,
      AUTHORING_DRAFT_WRITE_FUNCTION_ID,
      { intent: INTENT, scope: SCOPE },
      HUMAN,
    )) as AuthoringDraftWriteOutput

    expect(result.outcome).toBe('drafted')
    expect(result.refusal).toBeUndefined()
    // The compile and the one refinement round.
    expect(model.requests).toHaveLength(2)
  })

  // ---- dispatch asks nobody; the fan-out bound stays one function ---------------------

  it('dispatches without asking — a supplied old confirm port is never invoked', async () => {
    const executor = fixtureExecutor(agentQaRoot)
    const model = scriptedModel()
    const confirm = recordingConfirm(true)
    const host = compose({
      executor: executor.port,
      authoring: draftAuthoring(workspace),
      model: model.capability,
      confirm: confirm.port,
    })

    const result = (await invokeFunction(
      host.registry,
      AUTHORING_DRAFT_WRITE_FUNCTION_ID,
      { intent: INTENT, scope: SCOPE },
      HUMAN,
    )) as AuthoringDraftWriteOutput

    expect(result.outcome).toBe('drafted')
    expect(confirm.actions).toEqual([])
    expect(executor.startInputs).toHaveLength(DRAFT_STABILITY_RUNS_N)
  })

  it('the DRAFT-MODE bound is smaller, and neither bound is put to anybody as a question', async () => {
    const executor = fixtureExecutor(agentQaRoot)
    const confirm = recordingConfirm(true)
    const host = compose({
      executor: executor.port,
      authoring: draftAuthoring(workspace),
      confirm: confirm.port,
    })

    await invokeFunction(
      host.registry,
      AUTHORING_DRAFT_WRITE_FUNCTION_ID,
      { intent: INTENT, scope: SCOPE, draftMode: true },
      HUMAN,
    )

    const draftBound = authoringFanOutBound({ draftMode: true })
    expect(draftBound.initialN).toBe(1)
    expect(draftBound.finalN).toBe(DRAFT_STABILITY_RUNS_N)
    expect(draftBound.total).toBeLessThan(authoringFanOutBound({}).total)
    expect(renderFanOutPreview(draftBound)).toContain(`up to ${draftBound.total} runs`)
    expect(confirm.actions).toEqual([])
  })

  it('a DECLINING old port declines nothing — the loop runs and drafts', async () => {
    const executor = fixtureExecutor(agentQaRoot)
    const model = scriptedModel()
    const confirm = recordingConfirm(false)
    const host = compose({
      executor: executor.port,
      authoring: draftAuthoring(workspace),
      model: model.capability,
      confirm: confirm.port,
    })

    const result = (await invokeFunction(
      host.registry,
      AUTHORING_DRAFT_WRITE_FUNCTION_ID,
      { intent: INTENT, scope: SCOPE },
      HUMAN,
    )) as AuthoringDraftWriteOutput

    expect(result.outcome).toBe('drafted')
    expect(confirm.actions).toEqual([])
    expect(executor.startInputs).toHaveLength(DRAFT_STABILITY_RUNS_N)
  })

  it('AUTHORS in a headless context — there is no ask tier left to deny it', async () => {
    setActiveExecutionContextResolver(() => 'local-headless')
    const executor = fixtureExecutor(agentQaRoot)
    const confirm = recordingConfirm(true)
    const host = compose({
      executor: executor.port,
      authoring: draftAuthoring(workspace),
      confirm: confirm.port,
    })

    const result = (await invokeFunction(
      host.registry,
      AUTHORING_DRAFT_WRITE_FUNCTION_ID,
      { intent: INTENT, scope: SCOPE },
      HUMAN,
    )) as AuthoringDraftWriteOutput

    expect(result.outcome).toBe('drafted')
    expect(confirm.actions).toEqual([])
    expect(executor.startInputs).toHaveLength(DRAFT_STABILITY_RUNS_N)
  })

  it('refuses an empty intent at the contract, before a model is ever asked', async () => {
    const executor = fixtureExecutor(agentQaRoot)
    const model = scriptedModel()
    const host = compose({
      executor: executor.port,
      authoring: draftAuthoring(workspace),
      model: model.capability,
    })

    await expect(invokeFunction(
      host.registry,
      AUTHORING_DRAFT_WRITE_FUNCTION_ID,
      { intent: '', scope: SCOPE },
      HUMAN,
    )).rejects.toThrow()
    expect(model.requests).toHaveLength(0)
  })

  // ---- the drafted outcome is a written file, read back off disk and the stores ----------

  /** A model that answers a DIFFERENT valid document per call, so each draft is its own digest. */
  function varyingModel(): { capability: () => JobModelCapability; count: () => number } {
    let calls = 0
    return {
      count: () => calls,
      capability: () => ({
        modelId: 'fixture:authoring-corpus',
        generate: () => {
          calls += 1
          return Promise.resolve({
            // `target` is required, as the shipped parser requires it, so each document has one.
            text: `name: ${DRAFT_TEST_NAME} ${calls}\n`
              + `target: ${CONFIGURED_TARGETS[0] as string}\n`
              + 'steps:\n'
              + '  - Open the local account form\n'
              + `  - Verify the page heading says "Local account ${calls}"\n`,
          })
        },
      }),
    }
  }

  it('files no proposal for a drafted outcome; the written file is the answer', async () => {
    const executor = fixtureExecutor(agentQaRoot)
    const host = compose({
      executor: executor.port,
      authoring: draftAuthoring(workspace),
      model: scriptedModel().capability,
    })

    const result = (await invokeFunction(
      host.registry,
      AUTHORING_DRAFT_WRITE_FUNCTION_ID,
      { intent: INTENT, scope: SCOPE },
      HUMAN,
    )) as AuthoringDraftWriteOutput

    expect(result.outcome).toBe('drafted')
    expect(filedProposals(agentQaRoot)).toEqual([])
    // The written bytes join the receipt the same invocation answered with: one artifact.
    const target = 'tests/confirm-the-local-account-form-page-heading.yaml'
    const written = readFileSync(join(workspace, target))
    expect(createHash('sha256').update(written).digest('hex'))
      .toBe(result.receipt?.draftRef.contentDigest)
    expect(result.fanOut.consumedTotal).toBe(DRAFT_STABILITY_RUNS_N)
  })

  it("the digest mints no test-draft proposal row for a written draft", async () => {
    const executor = fixtureExecutor(agentQaRoot)
    const host = compose({
      executor: executor.port,
      authoring: draftAuthoring(workspace),
      model: scriptedModel().capability,
    })

    const result = (await invokeFunction(
      host.registry,
      AUTHORING_DRAFT_WRITE_FUNCTION_ID,
      { intent: INTENT, scope: SCOPE },
      HUMAN,
    )) as AuthoringDraftWriteOutput
    const runId = result.receipt?.gateRuns.at(-1)?.runId

    const digest = (await invokeFunction(
      host.registry,
      RUNS_DIGEST_FUNCTION_ID,
      { runId },
      HUMAN,
    )) as RunDigest

    expect(digest).not.toHaveProperty('proposalsMintedThisRun')
    expect(digest).not.toHaveProperty('pendingProposalCount')
    expect(JSON.stringify(digest)).not.toMatch(/proposal/i)
    expect(existsSync(join(workspace, 'tests/confirm-the-local-account-form-page-heading.yaml')))
      .toBe(true)
  })

  it('twelve drafts are twelve written files, and none waits to be accepted', async () => {
    // The gate-run fixture reports on whichever draft the run was actually handed, read off the
    // staged bytes — so twelve distinct drafts are twelve distinct members and twelve distinct
    // novel elements, and gate 3 is being asked a real question rather than a rigged one.
    const executor = fixtureExecutor(agentQaRoot, (filePath) => {
      const staged = parseYaml(readFileSync(join(workspace, filePath), 'utf8')) as { name: string }
      return { testName: staged.name, elementName: `heading ${staged.name}` }
    })
    const model = varyingModel()
    const host = compose({
      executor: executor.port,
      authoring: draftAuthoring(workspace),
      model: model.capability,
    })

    const written: string[] = []
    for (let index = 0; index < 12; index += 1) {
      const result = (await invokeFunction(
        host.registry,
        AUTHORING_DRAFT_WRITE_FUNCTION_ID,
        // A letter suffix, because a number would be a stated value.
        { intent: `${INTENT} (${String.fromCharCode(97 + index)})`, scope: SCOPE },
        HUMAN,
      )) as AuthoringDraftWriteOutput
      expect(result.outcome).toBe('drafted')
      expect(writtenOf(result)).toMatchObject({ file: { kind: 'written' } })
      written.push((writtenOf(result) as { file: { filePath: string } }).file.filePath)
    }

    expect(new Set(written).size).toBe(12)
    for (const path of written) expect(existsSync(join(workspace, path))).toBe(true)
    expect(filedProposals(agentQaRoot)).toEqual([])

    const funnel = (await invokeFunction(
      host.registry,
      AUTHORING_FUNNEL_GET_FUNCTION_ID,
      { window: { scope: 'all-time' } },
      HUMAN,
    )) as AuthoringFunnelGetOutput

    // `writeEligible` counts receipts the loop writes, so a full corpus fires the flag.
    expect(funnel.stages.built).toBe(12)
    expect(funnel.stages.writeEligible).toBe(written.length)
    expect(funnel.acceptanceFailure).toBe(true)
  })

  it('refuses to author at all on a host that cannot WRITE what it authors', async () => {
    // The composition binds the writer with the loop's two halves, so this is the same
    // conditional-spread absence every other optional capability answers with — and it is checked
    // BEFORE any run is spent, which the executor's empty record is the evidence for.
    const executor = fixtureExecutor(agentQaRoot)
    const host = compose({ executor: executor.port, model: scriptedModel().capability })

    const failure = await invokeFunction(
      host.registry,
      AUTHORING_DRAFT_WRITE_FUNCTION_ID,
      { intent: INTENT, scope: SCOPE },
      HUMAN,
    ).then(() => undefined, (error: unknown) => error as FunctionNotBoundError)

    expect(failure).toBeInstanceOf(FunctionNotBoundError)
    expect(executor.startInputs).toHaveLength(0)
    expect(filedProposals(agentQaRoot)).toEqual([])
    expect(readdirSync(workspace)).toEqual([])
  })

  // Driven through `authoring.draft.verify`, because the composed outcomes port is private.
  it('names the TARGET suite\'s flaky neighbours through the COMPOSED outcomes binding', async () => {
    const knowledgeRoot = join(root, 'agent-qa-knowledge')
    mkdirSync(knowledgeRoot, { recursive: true })
    // TWO BUILDS, because a flip is a fact about two of them. The projection keeps one
    // `{buildOrdinal, passed}` entry per build, so a single fold — however it read — could only
    // ever produce a one-valued history, which `assessSuiteStability` calls stable.
    foldRunOutcomes({
      knowledgeRoot,
      handoff: neighbourSuiteHandoff('RUN-SUITE-1', 1, 'passed'),
      extractAnchors: exercisedAnchors,
    })
    foldRunOutcomes({
      knowledgeRoot,
      handoff: neighbourSuiteHandoff('RUN-SUITE-2', 2, 'failed'),
      extractAnchors: exercisedAnchors,
    })

    // The draft on its one-test shelf, written to the real workspace so the composed parse reads
    // it back off disk exactly as it does for a loop-authored one.
    const draftPath = `${SHELF_DIR}/composed-stability.yaml`
    const absolute = join(workspace, draftPath)
    mkdirSync(dirname(absolute), { recursive: true })
    writeFileSync(absolute, MODEL_DOCUMENT, 'utf8')

    // The gate-2 flip (pass, then fail) is the only state from which the consultation is reachable.
    const executor = fixtureExecutor(agentQaRoot, () => FIXED_RUN_IDENTITY, ['passed', 'failed'])
    const host = compose({ executor: executor.port, authoring: draftAuthoring(workspace) })

    const receipt = (await invokeFunction(
      host.registry,
      AUTHORING_DRAFT_VERIFY_FUNCTION_ID,
      { draftPath, targetSuitePath: JOIN_TARGET },
      HUMAN,
    )) as DraftReceipt

    expect(receipt.gates.stableVerdict.pass).toBe(false)
    expect(receipt.gates.stableVerdict.reason).toContain('the verdict flipped across runs')
    // THE EVIDENCE THE BINDING SERVED THE READ. This name exists in exactly one place on this
    // host — the rows the fold wrote — and it can only have reached a receipt through the bound
    // `outcomes` port. Deleting that binding degrades the same reason to the no-history line.
    expect(receipt.gates.stableVerdict.reason).toContain('Your app is unstable')
    expect(receipt.gates.stableVerdict.reason).toContain(`${JOIN_TARGET}::${FLAKY_NEIGHBOUR}`)
    // …and not the neighbour whose history did not move: a message naming everything names
    // nothing, and would also pass over a port that answered a constant.
    expect(receipt.gates.stableVerdict.reason).not.toContain(STABLE_NEIGHBOUR)
  })
})
