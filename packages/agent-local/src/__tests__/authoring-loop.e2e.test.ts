// The authoring loop END TO END, through the REGISTERED op (Phase 394 plan 02, D-01 · WTST-01).
//
// ONE CHECK OF ONE PATH, not a per-layer unit test. Nothing below calls `runAuthoringLoop`
// directly: every case goes through `invokeFunction(registry, AUTHORING_DRAFT_WRITE…)` on a host
// built by `composeLocalAgent()` — the real registry, the real policy gate, the real
// `authoring.draft.verify` op underneath it, the real four gates, a real receipts store on a real
// disk. A composition that forgot a binding, an op that never registered, a dep whose optionality
// left the capability permanently `unbound` would all leave `packages/agent`'s own suites green,
// which is the produced-not-literal law applied to an entry point.
//
// HERMETIC BY CONTRACT. The model is scripted — one fixed, valid test document, returned for
// whatever prompt it is handed — and the run executor writes the run records a real executor would
// have written. The live half (a real model authoring against a real browser) is a later plan's
// lane and proves a different claim.
//
// WHAT IS FAKED, AND EXACTLY HOW FAR. `DraftAuthoringPort` is the one thing `packages/agent` and
// `packages/agent-local` genuinely cannot do: parsing a test file needs
// `@vostride/agent-qa-core`, which the FUNC-02 firewall forbids either from naming, and the CLI's
// real implementation over `parseTestFile` is exercised by that package's own suite. So the fake
// below does the REAL work either side of the parse — it hashes the actual bytes, writes them to a
// real `tests/.agent-qa-drafts/<digest>.yaml`, and reads them back off disk when the verify op
// asks — and uses the real `yaml` parser for the structure in between. The digest join this file
// asserts therefore crosses the filesystem: the shelf writes bytes, and the receipt's
// `contentDigest` is derived from a separate read of those bytes on the way into gate evaluation.

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
// 2026-10-01 (432-19, D-14): safety no longer publishes a confirm port. The shape an old host
// supplied is spelled locally so the C432-INVOKE-DIRECT cells can still smuggle one in and measure
// that nothing calls it.
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


/**
 * Whatever sits under the deleted proposals store's directory. 2026-10-01 (432-17): the store and
 * its listing are deleted, so "nothing was filed" is read off the directory itself.
 */
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

/**
 * The caller 394-01 minted `test-write` to refuse — everything the EVALUATOR needs and nothing
 * more. It reaches `authoring.draft.verify` and must not reach `authoring.draft.write`.
 */
const RUN_AND_READ_ONLY: FunctionCaller = {
  surface: 'test',
  origin: 'human',
}

const INTENT = 'Check that the local account form shows its heading'
const SCOPE = { tier: 'product', key: 'local-form' } as const

const DRAFT_TEST_NAME = 'Confirm the local account form page heading'

/** The one document the scripted model emits — a whole test, per D-02 (creation is not an edit). */
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
/**
 * WHOSE test the gate-run reports on, and which element it exercised.
 *
 * DEFAULTED to the one fixed draft every cell above authors, and overridable for the 394-18 corpus
 * cells, which author TWELVE distinct drafts through the same host. Gate 1 finds the draft's own
 * member by `testName` and gate 3 asks whether the draft touched an element the suite index has
 * never seen, so a fixture that reported one name and one element for every draft would make the
 * second draft onwards fail `addsValue` — measuring the fixture's sameness rather than the loop.
 */
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
  /**
   * What the draft's member DID on this run — `passed` for every cell that predates 394-19.
   *
   * Parameterised so a cell can produce a gate-2 FLIP, which is the only state D-14's stability
   * consultation is reachable from. A fixture that could only pass made the flip arm unreachable
   * from this composed host, which is half of why mutation M3 red nothing.
   */
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

/**
 * The suite the draft PROPOSES TO JOIN, and the two tests already living in it (394-19).
 *
 * Computed through `authoredSuiteTargetPath` rather than spelled, so this fixture names the same
 * file the accept arm would write to — a literal would drift the day the recipe moves, which is
 * exactly when the claim stops being about the right suite.
 */
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

// ---- the zero-exemplar generator: it knows ONLY what the prompt teaches (394-27, WINDOWS 111) ---
//
// `scriptedModel` above returns a hand-written valid document whatever it is asked, which is why
// no cell in this file could ever have caught WINDOWS 111: the schema arrived from the fixture, not
// from the prompt. The generator below has no document of its own. It locates the stable block by
// TITLE, lifts the canonical example out of it, adapts the two values the Intent and Scope blocks
// supply, and returns that — and it THROWS when no such block exists, which is the live model's
// position on a scope that serves no exemplars, stated as a hard failure instead of a bad guess.
//
// LITERALS, NOT IMPORTS. The title and the marker are spelled here as a model reads them. Importing
// the constants would give this generator a channel to the schema that a model does not have.

const FORMAT_BLOCK_TITLE = 'Test document format'
const FORMAT_EXAMPLE_MARKER = 'A complete document looks exactly like this:'
const TARGETS_BLOCK_TITLE = 'Configured targets'

/**
 * The one sentence that makes a fifth key emittable (394-33, WR-06).
 *
 * Matched as a RULE rather than by looking for the key name anywhere in the block: a block that
 * merely MENTIONS `context` — in a rejection sentence, say — is not permission, and a generator
 * that treated it as permission would go green on a prompt that forbade the key.
 */
const CONTEXT_OPTIONAL_RULE = /^`context` is optional:/m

/** What the generator has left when the prompt teaches it nothing: nothing. */
class FormatBlockMissingError extends Error {
  constructor() {
    super(`the prompt carries no "${FORMAT_BLOCK_TITLE}" block, and this generator knows no `
      + 'document schema of its own')
    this.name = 'FormatBlockMissingError'
  }
}

/** The same posture one key over (394-33, WR-07): no served vocabulary, no invented target. */
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

/**
 * The `target` a prompt-driven generator picks: one of the SERVED names, or nothing (394-33, WR-07).
 *
 * The previous form sliced the scope key out of the Scope block. That is a PRODUCT — the host's
 * derivation answers `target.product ?? targetName` — so it named a configured target only on the
 * projects where the two coincide, which was every fixture in this file. The scope survives as a
 * HINT for choosing among served names and never as the source of the value; what the cells assert
 * is membership in the served list, never this heuristic's particular pick.
 */
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

/**
 * The canonical example, lifted verbatim, with ONLY its `name` adapted to the Intent block.
 *
 * The `target` line is deliberately left as the block wrote it. Spelled apart from
 * {@link documentFromPrompt} because the difference between the two IS the model behaviour WR-04
 * is about: a generator that adapts `target` can only ever emit a member of the served list, and a
 * generator that does not is a model reading the same block and skipping one of its bullets.
 */
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

/**
 * THE GENERATOR NEITHER HARD-BRANCH DOUBLE COULD BE (394-37, WR-04).
 *
 * `targetFromVocabulary` draws its answer FROM the served list — `names.find(…) ?? names[0]`, with
 * a throw on the empty list — so every path it can take returns a member of that list, and every
 * cell built on it asserts that the DOUBLE obeyed the block. The off-vocabulary case was
 * unreachable by construction, which is the defect and not the proof.
 *
 * This one reads the SAME block by the same title and skips one of its bullets: it lifts the
 * canonical example, adapts the `name` to the Intent, and copies the example's own `target` line
 * verbatim. That is a real model behaviour — the block's example is the most imitable thing in the
 * prompt — and it emits `target: sign-in` against a host declaring only `local-form`.
 *
 * IT RECORDS WHAT IT EMITTED. The off-vocabulary value has to be a PRODUCED fact for the cell
 * below to be about the product rather than about this function's source, so the document text is
 * kept and asserted rather than restated.
 */
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

/** The written-test receipt on the op's answer (432 D-06), read as data. */
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

/**
 * The HARD branch (394-33, WR-07), borrowed from `cli/src/__tests__/authoring-scope-derivation`'s
 * own fixture class: `storefront-web` declares `product: storefront`, so the scope the host derives
 * for it is `product:storefront` — a value that is NOT a configured target. `local-form` rides
 * along as a distractor so choosing from the list is a real choice.
 */
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
    // `target` is REQUIRED by `TestDefinitionSchema`, so the shipped parser can never answer
    // `staged` without one; this fake mirrors that rather than defaulting, because a fake that
    // supplied a value the document did not carry would make WR-04's guard measure the fake.
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
    // 394-26: present because the port requires it, and THROWING because every case in this file
    // supplies its scope explicitly. A fake that answered a scope would let a cell pass while the
    // op silently derived one — which is exactly the arrangement the op's own control cell exists
    // to forbid.
    deriveDefaultScope(): Promise<never> {
      throw new Error('every case here supplies a scope, so nothing derives one')
    },
    // 394-06: present because the port requires it, and never reached by this file — neither
    // case routes to repair, so no patch is ever applied. A fake answering one it was not asked
    // for would be a second staging path these e2e pins could accidentally observe.
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

    // 432 D-06: the direct writer, over the same real workspace. It keeps the host's two guards —
    // the target must still hold the bytes the caller read (absent for a new test) and the bytes
    // written are the shelf's own — and runs nothing else. The CLI's real writer has its own cells.
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

    // 394-33 · WR-07: the `target` vocabulary. The REAL host reads this off `registry.targets`
    // through `listTargets`; this fake is handed the names, because what these cells measure is
    // that the LOOP serves whatever the host answered — not how the CLI reads a config file, which
    // is that package's own cell.
    configuredTargetNames() {
      return Promise.resolve(targetNames)
    },
  }
}

/**
 * A `ConfirmPort` that RECORDS what it was asked and answers a fixed way (394-08, D-03).
 *
 * The recording is the whole instrument: D-03's claim is that the dispatch confirm happens EXACTLY
 * ONCE, before the loop starts, carrying the fan-out preview — and none of those three is
 * observable from a boolean the gate consumed. `actions` holds the descriptors verbatim, so a cell
 * can compare the rendered figure against `authoringFanOutBound` rather than against a literal.
 */
function recordingConfirm(answer: boolean): {
  readonly port: ConfirmPort
  readonly actions: RiskActionDescriptor[]
} {
  const actions: RiskActionDescriptor[] = []
  return {
    actions,
    port: {
      // A TERMINAL double: every scene in this suite is a CLI dispatch (G-401-17).
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

    // 394-08 D-03: `authoring.draft.write` is ask-tier, so every case below needs a context in
    // which an ask is REACHABLE at all — `requiresFailClosed` is true for everything except
    // `local-interactive`, and a vitest worker resolves `local-headless`. This is production's own
    // `resolveExecutionContext` with only the env/TTY read replaced, by the exact signal pair the
    // detector would hand it at a terminal (the `daemon-host.test.ts` idiom, verbatim).
    //
    // The fail-closed arm is NOT skipped by doing this — it has its own cell below, which pins the
    // headless context back for the duration of one case.
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
      // 2026-10-01 (432-16, D-14): the composition input declares no confirm. A supplied port is
      // smuggled past the type so the C432-INVOKE-DIRECT cells still measure that nothing reads it.
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

    // TWO model calls, and both system blocks lead with the tier law's `Agent context:` line —
    // the ONE builder extended twice through `agent_context`, never a second renderer. The two are
    // stage 3's halves (394-09, D-18): the whole-document compile, then the one unconditional
    // refinement round, whose context line names the round rather than the compile.
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

  // 2026-09-30, 432 D-06: re-spelled in place. It pinned the retired never-auto-keep rule — a
  // keep-eligible draft proposed and left unwritten until a person accepted it. The claim is now the
  // opposite write and it is measured the same way, on disk: the draft's bytes are at the target the
  // loop's own recipe names, the receipt says so with the disposition and all four gate booleans,
  // and nothing was filed for anybody to accept.
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

  // THE MUTATION WITNESS (432 B08). A flip across the stability runs fails gate 2, so the receipt is
  // `rejected`, and a rejected final draft is never written — whatever the loop then does with it.
  // The claim is measured on disk and on the answer, so a loop that let `rejected` into its final
  // write reds here on the target's existence even if something later in the call threw.
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
    // The id passes the dot taxonomy the parity suite enforces off the registry, and carries no
    // underscore for the chat tool-name projection to trip on (T-394-07).
    expect(declared?.id).toMatch(/^[a-z]+(?:\.[a-z]+)+$/)
    expect(declared?.id).not.toContain('_')
    // 432-20 (D-12): the declaration carries no scopes — `test-write` gates nothing any more.
    expect(Object.keys(declared ?? {})).not.toContain('requiredScopes')
  })

  // RE-SPELLED 2026-10-01 (432-20, D-12) from 'refuses a run+read caller BY NAME on the missing
  // test-write scope'. No scope is read: the same caller authors exactly as a full caller does.
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

    // What reached the shelf: the keys the block teaches and nothing else, with the free values
    // taken from the Intent and Scope blocks rather than from anything this file wrote. `context`
    // joined the set in 394-33 (WR-06) — the block now names it optional, so a prompt-driven
    // generator emits it, and a block that went back to four keys reds here.
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
    // WHAT THIS CELL CLAIMS, AND WHAT IT DOES NOT. It claims the PROMPT CHANNEL: a schema-blind
    // generator, driven by nothing but the compile prompt, emits a `context` key and those bytes
    // reach the shelf. It does NOT claim `ParsedDraftLike.context` is populated — this file's
    // `DraftAuthoringPort` is a FAKE whose `describe()` reads `name` and `steps` and would answer
    // `staged` for a document whose `context` it never looked at (WINDOWS 116). That claim is made
    // against the SHIPPED parser in `packages/cli/src/authoring/__tests__/zero-exemplar-format.test.ts`.
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

    // AND THE KEY IS IN THE BYTES. `context` is one of the three `EDITABLE_POINTER_ROOTS`, and
    // until this plan the block forbade it — so no compile could produce one.
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
    // THE CASE THE GUARD REJECTS, AND THE CORPUS DID NOT HAVE ONE. Round 5 served the vocabulary
    // into the compile prompt and compared it against nothing: `configuredTargetNames()` sat in a
    // local variable eight lines above `shelf.write`, and both new "hard branch" doubles picked
    // their target OUT of that served list, so no cell in either file could express a model that
    // ignored the block. This is that model, and it is a REALISTIC one — it copies the block's own
    // canonical example, whose `target: sign-in` this host does not declare.
    //
    // WHY THE REFUSAL BELONGS HERE RATHER THAN AT THE RUN. `runs.start` spawns a real child
    // `agent-qa run`, and `resolveTarget` throws inside it — so an unconfigured target is paid as
    // up to `DRAFT_STABILITY_RUNS_N` real child processes (nine with repair), and no repair patch
    // can correct it, because `target` is outside `EDITABLE_POINTER_ROOTS`.
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
    // THE NON-VACUITY GUARD for the cell above, on the shape `FormatBlockMissingError`'s guard
    // already established: without it, that cell would pass against a generator that quietly fell
    // back to the scope key — which is exactly what this file's generator did until this plan.
    const model = formatFollowingModel().capability()

    expect(() => model.generate({
      system: 'Agent context: authoring.draft.write — compile a whole test document\n\n'
        + `## ${FORMAT_BLOCK_TITLE}\n\n${FORMAT_EXAMPLE_MARKER}\n\nname: x\ntest-id: y\n`
        + 'target: z\nsteps:\n  - do a thing\n',
      prompt: '## Intent\n\nanything\n\n## Scope\n\nproduct:local-form',
    })).toThrow(TARGETS_BLOCK_TITLE)
  })

  it('has no schema of its own: the generator throws when the format block is absent', () => {
    // THE GUARD'S OWN NON-VACUITY. Without this, the cell above could pass against a generator
    // that quietly fell back to a document it was holding — which is exactly what `scriptedModel`
    // does, and exactly why this file was blind to WINDOWS 111 for twenty-six plans.
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

    // THE REFUSAL NAMES ITS EVIDENCE (D-04). Asserting `outcome === 'refused'` alone would pass
    // for a refusal that named the wrong test, or named none at all.
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
    // Two: the compile and D-18's one refinement round. See the first cell for why both are here.
    expect(model.requests).toHaveLength(2)
  })

  // ---- D-03's dispatch confirm, RETIRED (432-13, D-14) --------------------------------------------
  //
  // RE-SPELLED 2026-09-30. `authoring.draft.write` used to ask ONCE at dispatch, carrying the fan-out
  // preview, and a headless host could not author at all. There is no op gate now: a supplied old
  // confirm port is never invoked, a declining one declines nothing, and a headless host authors. The
  // fan-out bound itself is still one function (`authoringFanOutBound`), measured below.

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

  // ---- 394-18, re-spelled 2026-09-30 for 432 D-06: the outcome is a written file ----------------
  //
  // These four cells pinned the proposal a drafted outcome used to file, the digest line that
  // proposal rendered, the funnel's human-acceptance stage and the refusal on a host that could not
  // file one. Nothing waits for acceptance now: the drafted outcome IS the written test, so each cell
  // keeps its subject and measures the direct write instead, still through the production path and
  // still read back off disk and off the stores rather than off the op's answer.

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
            // `target` joined the document in 394-37 (WR-04). It was absent until the fake shelf
            // started requiring it — as the SHIPPED parser always has — so this corpus of twelve
            // was twelve documents `parseTestFile` would have refused outright (WINDOWS 116's
            // class, caught by tightening the fake rather than by a new claim).
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

    // 432-09: the digest lists no proposal of any kind, and counts none.
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
        // 2026-10-12 (440-01, D-03): a letter suffix, because a number would be a stated value.
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

    // `built` is still the receipts this host minted. RE-SPELLED 2026-10-02 (quick 261002-ctr):
    // `accepted` counted human decisions on filed drafts and was 0 here; `writeEligible` counts the
    // receipts whose disposition the loop writes, so it measures the twelve written files, and
    // twelve of twelve above the floor is a loop that did not filter: the flag fires.
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

  // ---- the composed stability read (394-19 · WINDOWS 107) ------------------------------------
  //
  // WHAT WAS UNMEASURED. 394-17 wired D-14's history half — `authoringFunnel.outcomes`, over the
  // run-outcome projection's own read side — and mutation M3 recorded the wire itself as reachable
  // by NO cell: deleting the whole `outcomes:` binding from `compose-local-agent.ts` left the
  // monorepo fully green (0 of ~1576). Both ENDS were pinned; only the line joining them was not,
  // because the bundle lives in a private `WeakMap` and `openEvaluation` is module-private, so
  // nothing could reach the composed port without driving `authoring.draft.verify` end to end.
  //
  // This is that drive. No fake outcomes port is interposed: the rows arrive through
  // `foldRunOutcomes` — knowledge-local's own fold, over ordinary handoffs carrying NEITHER
  // durable marker, which is what a real run writes — and the only way a neighbour's name can
  // reach this receipt is the real binding serving the real read.
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

    // The gate-2 FLIP: run 1 passed, run 2 failed. D-17 early-stops there, and the flip is the
    // only state from which the consultation is reachable at all.
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
