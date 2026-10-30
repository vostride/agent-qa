// Two witnesses: the loop's reported stages and the fakes' own log must match in order.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  DRAFT_STABILITY_RUNS_N,
  MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
  computeDraftDisposition,
  WrittenTestReceiptSchema,
  authoredSuiteTargetPath,
  CURRENT_DRAFT_RECEIPT_SCHEMA_VERSION,
} from '@vostride/agent-qa-schema'
import type {
  AuthoringBrief,
  DraftDisposition,
  DraftGateBooleans,
  DraftReceipt,
  FunctionCaller,
  ScopeKey,
  TestFileWrite,
} from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'

import {
  ACCEPT_CONTROL_DRAFT,
  ACCEPT_CONTROL_SUBACTIONS,
  acceptControlMember,
  expectedElement,
  fakeFingerprintIndex,
  fakeRunPort,
  runDocument,
} from './evidence-fixtures.js'
import {
  AUTHORING_LOOP_STAGES,
  AuthoringLoopUnroutableEvidenceError,
  routeAfterVerify,
  runAuthoringLoop,
} from '../loop.js'
import type { AuthoringLoopStage } from '../loop.js'
import type { JobModelRequest } from '../../jobs/record-llm-authorship.js'
import { AUTHORING_REFINE_AGENT_CONTEXT } from '../refine.js'
import { evaluateDraft } from '../verify-draft.js'
import type {
  AuthoringReadPortLike,
  DraftShelfPortLike,
  SuiteTextCorpusEntryLike,
} from '../ports.js'
import { createFunctionRegistry } from '../../functions/registry.js'
import type { FunctionDeps } from '../../functions/spec.js'

const INTENT = 'Check that the local account form shows its heading'
const SCOPE: ScopeKey = { tier: 'product', key: 'local-form' }

// Neither name is the scope key, so a block that rendered the scope cannot satisfy the pin.
const CONFIGURED_TARGET_NAMES: readonly string[] = ['local-form-web', 'storefront-web']

/** The staged draft's shelf path, as `stageDraft` mints it — digest in, path out. */
const STAGED_PATH = `tests/.agent-qa-drafts/${ACCEPT_CONTROL_DRAFT.contentDigest}.yaml`

// A target this host declares, read off `CONFIGURED_TARGET_NAMES` so the two cannot drift.
const STAGED_DRAFT = {
  ...ACCEPT_CONTROL_DRAFT,
  filePath: STAGED_PATH,
  target: CONFIGURED_TARGET_NAMES[0] as string,
}

const EMPTY_BRIEF: AuthoringBrief = {
  exemplars: [],
  procedures: [],
  facts: [],
  cautions: [],
  coverage: {},
  truncation: 'none',
  admissions: [],
}

const SUITE_TEXT: readonly SuiteTextCorpusEntryLike[] = [
  {
    filePath: 'tests/unrelated.yaml',
    testName: 'Delete an archived invoice from the billing ledger',
    stepsText: ['Open the billing ledger', 'Delete the archived invoice'],
  },
]

/**
 * Fakes that keep an ordered log of the stage each of them belongs to.
 *
 * The `verify` fake runs the REAL `evaluateDraft` over the shared evidence fixtures rather than
 * answering a hand-written receipt, so the value stage 5 routes on is one the evaluator actually
 * produced — a scripted `keep-eligible` would let the routing cell pass over a disposition no gate
 * ever reached.
 */
function observedLoop() {
  const observed: AuthoringLoopStage[] = []

  const refineQueries: string[] = []
  const read: AuthoringReadPortLike = {
    getAuthoringBrief(query: string, scope: ScopeKey): Promise<AuthoringBrief> {
      expect(scope).toEqual(SCOPE)
      // The refinement round also reads the brief, but only the intent read is the `brief` stage.
      if (query === INTENT) {
        observed.push('brief')
      } else {
        refineQueries.push(query)
      }
      return Promise.resolve(EMPTY_BRIEF)
    },
    suiteTextCorpus(): Promise<readonly SuiteTextCorpusEntryLike[]> {
      observed.push('dedup')
      return Promise.resolve(SUITE_TEXT)
    },
    // Two names, neither the scope key, so rendering the scope or a single name fails the pins.
    configuredTargetNames: (): Promise<readonly string[]> =>
      Promise.resolve(CONFIGURED_TARGET_NAMES),
  }

  const modelCalls: string[] = []
  const refineCalls: string[] = []
  const compileRequests: JobModelRequest[] = []
  const written: string[] = []
  const published: string[] = []

  const shelf: DraftShelfPortLike = {
    model: () => Promise.resolve({
      modelId: 'fixture:loop-ordering',
      generate(request) {
        // The two stage-3 calls are told apart by their PINNED agent-context lines rather than by
        // a call counter, so a reordering that put the refinement first would be visible here
        // instead of being absorbed by an index.
        if ((request.system ?? '').includes(AUTHORING_REFINE_AGENT_CONTEXT)) {
          refineCalls.push(request.prompt)
          // Not a patch set: this file pins ORDER, and a refinement that actually patched would
          // make every later assertion depend on an applier fake as well. The round still ran,
          // which is what the counts below assert; `refine.test.ts` owns what it does.
          return Promise.resolve({ text: 'no changes needed' })
        }
        observed.push('compile')
        modelCalls.push(request.prompt)
        compileRequests.push(request)
        return Promise.resolve({ text: 'name: whatever the fixture parses to\nsteps: []\n' })
      },
    }),
    write(contents: string) {
      // NOT its own stage name: the shelf write is the back half of `compile`, and giving it a
      // seventh name would let this pin claim an order over a stage the vocabulary does not have.
      // What it asserts instead is the ORDER WITHIN the stage — a model call has already been
      // observed by the time bytes arrive, which is what "compile then stage" means.
      expect(observed.at(-1)).toBe('compile')
      written.push(contents)
      return Promise.resolve({ kind: 'staged' as const, draft: STAGED_DRAFT })
    },
    // The accept control passes its gates, so stage 5 answers `drafted` without consulting a run —
    // but a shelf that could not run one would be a host that verifies drafts and cannot look at
    // what answered. Bound to the shared fake so the port is real rather than absent.
    runs: fakeRunPort({ runs: [] }),
    // Never reached by this file: the accept control passes its gates, so stage 5 answers
    // `drafted` and the repair arm is not entered. Present because the shelf's contract requires
    // it — a host that can stage a draft can patch one — and a fake that answered a patch it was
    // never asked for would be a second staging path this pin could accidentally observe.
    applyPatches(): Promise<never> {
      throw new Error('the accept control never enters repair, so no patch is ever applied')
    },
    async verifyDraft(input): Promise<DraftReceipt> {
      expect(input.draftPath).toBe(STAGED_PATH)
      observed.push('verify')
      return await evaluateDraft(
        { draft: STAGED_DRAFT },
        {
          runs: fakeRunPort({
            runs: Array.from({ length: DRAFT_STABILITY_RUNS_N }, () => [
              { ...acceptControlMember(), filePath: STAGED_PATH },
            ]),
          }),
          fingerprints: fakeFingerprintIndex([
            {
              filePath: 'demo/init/tests/local-form.yaml',
              testName: 'Sign in on the local account form',
              elements: [expectedElement(ACCEPT_CONTROL_SUBACTIONS[0]![0]!)],
            },
          ]),
          textCorpus: [],
          receipts: { put: () => Promise.resolve() },
          now: () => 1_700_000_000_000,
        },
      )
    },
    // The final write is the tail of `route`, so it happens only after `verify`.
    publish(request) {
      expect(observed.at(-1)).toBe('verify')
      published.push(request.targetPath)
      return Promise.resolve({
        kind: 'written' as const,
        filePath: request.targetPath,
        contentDigest: STAGED_DRAFT.contentDigest,
      })
    },
  }

  return {
    observed,
    modelCalls,
    refineCalls,
    refineQueries,
    compileRequests,
    written,
    published,
    deps: { read, shelf },
  }
}

/** The stages that touch an injected dep — the ones an observer outside the loop can witness. */
const DEP_OBSERVABLE_STAGES: readonly AuthoringLoopStage[] = ['brief', 'dedup', 'compile', 'verify']

describe('the six-stage order is structural, not a habit of the code', () => {
  it('enters every declared stage exactly once, in the declared order', async () => {
    const loop = observedLoop()

    const result = await runAuthoringLoop({ intent: INTENT, scope: SCOPE }, loop.deps)

    // SEQUENCE EQUALITY over the WHOLE vocabulary. Not a subset, not a set, not a count: the
    // stages the loop entered are exactly the stages it declares, in exactly that order.
    expect(result.stages).toEqual([...AUTHORING_LOOP_STAGES])
    // …and the vocabulary really is the six, so the line above cannot be satisfied by a
    // vocabulary that quietly shrank to the stages the loop happens to run.
    expect(AUTHORING_LOOP_STAGES).toEqual([
      'brief',
      'dedup',
      'compile',
      'verify',
      'route',
      'compound',
    ])
    expect(result.outcome.kind).toBe('drafted')
  })

  it('is corroborated by the deps themselves, so the loop cannot mis-report its own order', async () => {
    const loop = observedLoop()

    const result = await runAuthoringLoop({ intent: INTENT, scope: SCOPE }, loop.deps)

    // The independent witness: what the FAKES saw, in the order they saw it. `route` and
    // `compound` touch no dep and cannot appear here — the first is a pure function of the
    // receipt, the second is the recorded fact that the Curator's existing path already fires —
    // so the comparison is against the dep-observable stages, taken from the same vocabulary
    // rather than re-listed.
    expect(loop.observed).toEqual([...DEP_OBSERVABLE_STAGES])
    // The two logs AGREE: the loop's self-report, filtered to the stages a dep can witness, is
    // byte-for-byte what the deps witnessed. This is what makes the first cell's trace evidence
    // rather than an assertion the loop makes about itself.
    expect(result.stages.filter((stage) => DEP_OBSERVABLE_STAGES.includes(stage)))
      .toEqual(loop.observed)
  })

  it('screens the intent exactly once, and does so before anything is authored', async () => {
    const loop = observedLoop()

    const result = await runAuthoringLoop({ intent: INTENT, scope: SCOPE }, loop.deps)

    // ONCE. A second screen would be a second answer to "is this already covered", and the two
    // would be free to disagree about the same intent.
    expect(loop.observed.filter((stage) => stage === 'dedup')).toHaveLength(1)
    // BEFORE. Stated as an index comparison over the observed log rather than as a pair of
    // "was it called" checks, so a dedup that ran after the model call fails here even though
    // both stages ran.
    expect(loop.observed.indexOf('dedup')).toBeLessThan(loop.observed.indexOf('compile'))
    // …and nothing was authored on the way to it: the screen saw a corpus, the model saw one
    // prompt, and the shelf received exactly one document — after both.
    expect(result.dedup.comparedTests).toBe(SUITE_TEXT.length)
    expect(loop.modelCalls).toHaveLength(1)
    expect(loop.written).toHaveLength(1)
  })

  it('reaches verify only after the compiled bytes are on the shelf', async () => {
    const loop = observedLoop()

    await runAuthoringLoop({ intent: INTENT, scope: SCOPE }, loop.deps)

    // The shelf write has no stage name of its own, so its ordering is pinned by the path the
    // verify stage was handed: `STAGED_PATH` is what `write` answered, and the `verifyDraft` fake
    // asserts it received exactly that. A verify reached before the write would have had no path
    // to pass — which is the claim, made structurally.
    expect(loop.observed.indexOf('compile')).toBeLessThan(loop.observed.indexOf('verify'))
    expect(loop.written).toHaveLength(1)
  })

  it('calls the model exactly TWICE — compile, then one refinement round', async () => {
    const loop = observedLoop()

    const result = await runAuthoringLoop({ intent: INTENT, scope: SCOPE }, loop.deps)

    // TWO CALLS AND NO MORE. One to author the whole document, one to refine it. A third would be
    // a retry hidden inside a stage, which would make the fan-out preview's sibling promise — that
    // the loop's cost is the number a person was shown — a promise about model calls nobody counted.
    expect(loop.modelCalls).toHaveLength(1)
    expect(loop.refineCalls).toHaveLength(1)
    // The SECOND call is built from the draft the FIRST produced: the fixture's staged draft is the
    // accept control, and its own step text is in the refinement prompt. Text derived from the
    // draft rather than from the intent is what makes it a second question instead of a retry.
    for (const step of ACCEPT_CONTROL_DRAFT.steps) {
      expect(loop.refineCalls[0]).toContain(step)
    }
    // …and the round's re-retrieval was keyed on the same words, not on the intent.
    expect(loop.refineQueries).toHaveLength(1)
    expect(loop.refineQueries[0]).not.toContain(INTENT)
    for (const step of ACCEPT_CONTROL_DRAFT.steps) {
      expect(loop.refineQueries[0]).toContain(step)
    }
    // The round RAN and is reported, even though this fixture's emission is not a patch set — an
    // invocation that entered stage 3 always carries an arm saying what its refinement did.
    expect(result.refinement?.kind).toBe('not-applied')
  })
})

// Format rules sit in the stable tier, so a brief with no exemplars still carries them.

/** The block title a model reads, spelled as a model reads it: a literal, not an import. */
const FORMAT_BLOCK_TITLE = 'Test document format'
/** The vocabulary block's title, as a MODEL reads it — a literal, never the exported constant. */
const TARGETS_BLOCK_TITLE = 'Configured targets'

interface RenderedBlock {
  readonly title: string
  readonly body: string
}

/** `buildTieredPrompt`'s output read back as blocks — the markdown a model is actually handed. */
function renderedBlocks(text: string): readonly RenderedBlock[] {
  return text.split(/^## /m).slice(1).map((part) => {
    const split = part.indexOf('\n\n')
    return {
      title: part.slice(0, split),
      body: part.slice(split + 2).replace(/\n+$/, ''),
    }
  })
}

describe('the document schema rides the stable tier, not the exemplar block', () => {
  it('names the required keys in a STABLE block, on a brief carrying ZERO exemplars', async () => {
    const loop = observedLoop()

    await runAuthoringLoop({ intent: INTENT, scope: SCOPE }, loop.deps)

    // The condition, stated rather than assumed: this brief serves no exemplars at all.
    expect(EMPTY_BRIEF.exemplars).toHaveLength(0)

    const stable = renderedBlocks(loop.compileRequests[0]?.system ?? '')
    const format = stable.find((block) => block.title === FORMAT_BLOCK_TITLE)
    expect(format).toBeDefined()
    // The three keys the live emission was missing or wrong about, by name.
    expect(format?.body).toContain('test-id')
    expect(format?.body).toContain('target')
    expect(format?.body).toContain('steps')

    // THE NON-VACUITY GUARD. The only other block that could have carried a schema is the exemplar
    // block, and on this brief it carries the empty answer — so the assertions above cannot be
    // satisfied by prose that arrived through memory.
    const served = renderedBlocks(loop.compileRequests[0]?.prompt ?? '')
    const exemplars = served.find((block) => block.title === 'Exemplar tests')
    expect(exemplars?.body).toBe(
      'No exemplar tests were served for this scope. Follow the house YAML test style.',
    )
    expect(exemplars?.body).not.toContain('test-id')
  })

  it('ADDS a block rather than rearranging: every prior block keeps its title and its tier', async () => {
    const loop = observedLoop()

    await runAuthoringLoop({ intent: INTENT, scope: SCOPE }, loop.deps)

    // Ordered title equality per tier, not membership: a fix that demoted the exemplar block, moved
    // Procedures out of stable, or reordered Intent and Scope fails here even though every block
    // still exists somewhere.
    expect(renderedBlocks(loop.compileRequests[0]?.system ?? '').map((block) => block.title))
      .toEqual(['Role', FORMAT_BLOCK_TITLE, 'Procedures'])
    expect(renderedBlocks(loop.compileRequests[0]?.prompt ?? '').map((block) => block.title))
      .toEqual([
        'Intent',
        'Scope',
        TARGETS_BLOCK_TITLE,
        'What this project knows',
        'Exemplar tests',
      ])
  })

  it('serves the configured target names in the CONTEXT tier, beside Scope', async () => {
    const loop = observedLoop()

    await runAuthoringLoop({ intent: INTENT, scope: SCOPE }, loop.deps)

    // THE TIER IS THE DECISION. Target names are PER-PROJECT facts, and the stable tier is the
    // byte prefix a provider's prompt cache keys on — a project-dependent block there would defeat
    // the sharing the tier law exists to enable. So it rides the context tier, which is where the
    // Scope block it corrects already lives.
    const stable = renderedBlocks(loop.compileRequests[0]?.system ?? '')
    expect(stable.find((block) => block.title === TARGETS_BLOCK_TITLE)).toBeUndefined()

    const served = renderedBlocks(loop.compileRequests[0]?.prompt ?? '')
    const targets = served.find((block) => block.title === TARGETS_BLOCK_TITLE)
    expect(targets).toBeDefined()
    // One name per line, verbatim — nothing rendered around them for a model to mistake for a name.
    expect(targets?.body.split('\n')).toEqual([...CONFIGURED_TARGET_NAMES])

    // AND THE FORMAT BLOCK POINTS AT IT. The bullet asking for `target` names the block by title,
    // so the vocabulary is not merely present in the prompt but is what the instruction sends a
    // reader to — the half a served-but-unreferenced block would silently miss.
    const format = stable.find((block) => block.title === FORMAT_BLOCK_TITLE)
    expect(format?.body).toContain(TARGETS_BLOCK_TITLE)

    // THE NON-VACUITY GUARD: the scope key is not one of the served names, so a block that
    // rendered the scope — the shipping derivation's own mistake — cannot satisfy the pin above.
    expect(CONFIGURED_TARGET_NAMES).not.toContain(SCOPE.key)
  })
})

// ---- the second claim: there is exactly ONE public entry to the loop ---------------------------

const LISTING_CALLER: FunctionCaller = {
  surface: 'test',
  origin: 'human',
}

function minimalDeps(): FunctionDeps {
  return {
    runs: {
      list: () => Promise.resolve([]),
      get: () => Promise.resolve(undefined),
      readEvents: () => Promise.resolve([]),
      readStepEvidence: () => Promise.resolve({ kind: 'run-not-recorded' } as const),
    },
    knowledge: {
      listBundles: () => Promise.resolve([]),
      inspectRecords: () => Promise.resolve([]),
      diffSince: () => Promise.resolve([]),
      showRecord: ({ recordId }) => Promise.resolve(
        { kind: 'not-found', schemaVersion: 2, recordId } as const,
      ),
    },
    entities: {
      resolve: () => Promise.resolve({ kind: 'none' as const, reason: 'no-match' as const }),
      get: () => Promise.resolve(undefined),
    },
    config: {
      getMasked: () => Promise.resolve({
        schemaVersion: MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
        configPath: 'agent-qa.config.yaml',
        entries: [],
      }),
    },
  }
}

// One public entry: a loop stage registered as its own op would let a planner reorder the loop.
const EXPECTED_AUTHORING_IDS: readonly string[] = [
  'authoring.draft.edit',
  'authoring.draft.verify',
  'authoring.draft.write',
  'authoring.funnel.get',
]

describe('the loop has exactly one public entry', () => {
  it('registers no authoring op besides the evaluator and the loop', () => {
    const registry = createFunctionRegistry({
      deps: minimalDeps(),
    })

    const authoringIds = registry
      .list(LISTING_CALLER)
      .map((declaration) => declaration.id)
      .filter((id) => id.startsWith('authoring.'))
      .sort()

    // EXACT SET EQUALITY off the registry, which is what makes "no caller can reorder or skip the
    // stages" a structural claim rather than a statement about how `loop.ts` happens to be
    // written today. Promoting any stage — dedup, compile, route — to its own registered op would
    // hand the chat planner, which binds every registered op 1:1, a way to run that stage on its
    // own; this line is what refuses that edit, in the same change that makes it.
    expect(authoringIds).toEqual([...EXPECTED_AUTHORING_IDS])
  })
})

// Stage 5 runs per disposition: which drafts reach the writer, with the receipt unchanged.

const ALL_PASS: DraftGateBooleans = {
  executesDefinitive: true,
  stableVerdict: true,
  addsValue: true,
  falsifiableAssertion: true,
}

const MIXED: DraftGateBooleans = {
  executesDefinitive: true,
  stableVerdict: false,
  addsValue: false,
  falsifiableAssertion: true,
}

function scriptedReceipt(
  disposition: DraftDisposition,
  gates: DraftGateBooleans,
  runs: { readonly requested: number; readonly completed: number },
): DraftReceipt {
  return {
    schemaVersion: CURRENT_DRAFT_RECEIPT_SCHEMA_VERSION,
    draftRef: {
      filePath: STAGED_DRAFT.filePath,
      testId: STAGED_DRAFT.testId,
      testName: STAGED_DRAFT.testName,
      contentDigest: STAGED_DRAFT.contentDigest,
    },
    gates: {
      executesDefinitive: { pass: gates.executesDefinitive, runRefs: [], indefinitiveRunRefs: [] },
      stableVerdict: {
        pass: gates.stableVerdict,
        runRefs: [],
        distinctOutcomes: [],
        earlyStopped: false,
      },
      addsValue: { pass: gates.addsValue, novelElementCount: 0, comparedTestCount: 0 },
      falsifiableAssertion: {
        pass: gates.falsifiableAssertion,
        assertionStepCount: 1,
        falsifiableAssertionCount: gates.falsifiableAssertion ? 1 : 0,
      },
    },
    stepTable: [],
    gateRuns: [],
    addsValueFinding: { novelElements: [], comparedTests: [] },
    stabilityRunsRequested: runs.requested,
    stabilityRunsCompleted: runs.completed,
    disposition,
    evaluatedAt: 1_700_000_000_000,
  }
}

function writerShelf(
  answer?: (targetPath: string) => TestFileWrite,
  runs: DraftShelfPortLike['runs'] = fakeRunPort({ runs: [] }),
) {
  const requests: { draftPath: string; targetPath: string; sourceDigest?: string }[] = []
  const shelf: DraftShelfPortLike = {
    model: () => Promise.reject(new Error('stage 5 calls no model')),
    write: () => Promise.reject(new Error('stage 5 stages nothing')),
    applyPatches: () => Promise.reject(new Error('these receipts never reach repair')),
    runs,
    verifyDraft: () => Promise.reject(new Error('stage 5 is handed its receipt')),
    publish(request) {
      requests.push({ ...request })
      return Promise.resolve(answer?.(request.targetPath) ?? {
        kind: 'written',
        filePath: request.targetPath,
        contentDigest: STAGED_DRAFT.contentDigest,
      })
    },
  }
  const read: AuthoringReadPortLike = {
    getAuthoringBrief: () => Promise.reject(new Error('stage 5 reads no brief')),
    suiteTextCorpus: () => Promise.reject(new Error('stage 5 screens nothing')),
    configuredTargetNames: () => Promise.reject(new Error('stage 5 serves no vocabulary')),
  }
  return { requests, deps: { read, shelf } }
}

const FINAL_TARGET = authoredSuiteTargetPath(STAGED_DRAFT.filePath, STAGED_DRAFT.testName)

describe('exactly the non-rejected final dispositions are written', () => {
  const written: readonly {
    readonly disposition: DraftDisposition
    readonly gates: DraftGateBooleans
    readonly runs: { readonly requested: number; readonly completed: number }
  }[] = [
    { disposition: 'keep-eligible', gates: ALL_PASS, runs: { requested: 3, completed: 3 } },
    { disposition: 'proposal-only', gates: ALL_PASS, runs: { requested: 3, completed: 2 } },
    // Draft mode writes a draft whose gates 1, 3 and 4 passed; a false one rejects it.
    {
      disposition: 'unverified',
      gates: { ...ALL_PASS, stableVerdict: false },
      runs: { requested: 1, completed: 1 },
    },
  ]

  for (const row of written) {
    it(`writes a ${row.disposition} final draft once, as a new file, keeping all four booleans`, async () => {
      const host = writerShelf()
      const receipt = scriptedReceipt(row.disposition, row.gates, row.runs)

      const routed = await routeAfterVerify(STAGED_DRAFT, receipt, host.deps, [])

      expect(routed.outcome.kind).toBe('drafted')
      // One write, of the shelf copy, to the loop's own target recipe, claiming the target absent.
      expect(host.requests).toEqual([{ draftPath: STAGED_PATH, targetPath: FINAL_TARGET }])
      const answer = routed.outcome.kind === 'drafted' ? routed.outcome.written : undefined
      expect(answer).toEqual({
        file: { kind: 'written', filePath: FINAL_TARGET, contentDigest: STAGED_DRAFT.contentDigest },
        disposition: row.disposition,
        gates: row.gates,
      })
      expect(WrittenTestReceiptSchema.safeParse(answer).success).toBe(true)
    })
  }

  it('never hands a rejected final draft to the writer', async () => {
    const host = writerShelf()
    const receipt = scriptedReceipt('rejected', MIXED, { requested: 3, completed: 3 })

    // A rejected receipt ROUTES; with no run evidence the router refuses by name. Either way the
    // writer is never reached.
    const outcome = await routeAfterVerify(STAGED_DRAFT, receipt, host.deps, [])
      .then(() => undefined, (error: unknown) => error)

    expect(outcome).toBeInstanceOf(AuthoringLoopUnroutableEvidenceError)
    expect(host.requests).toEqual([])
  })

  it('reports a write that did not land as not written, keeping the verification facts', async () => {
    for (const reason of ['target-changed', 'outside-workspace', 'write-failed'] as const) {
      const host = writerShelf((targetPath) => ({
        kind: 'not-written',
        targetPath,
        reason,
        ...(reason === 'write-failed' ? { detail: 'EIO' } : {}),
      }))
      const receipt = scriptedReceipt('keep-eligible', ALL_PASS, { requested: 3, completed: 3 })

      const routed = await routeAfterVerify(STAGED_DRAFT, receipt, host.deps, [])

      expect(host.requests).toHaveLength(1)
      const answer = routed.outcome.kind === 'drafted' ? routed.outcome.written : undefined
      expect(answer?.file).toMatchObject({ kind: 'not-written', targetPath: FINAL_TARGET, reason })
      expect(answer?.disposition).toBe('keep-eligible')
      expect(answer?.gates).toEqual(ALL_PASS)
      expect(WrittenTestReceiptSchema.safeParse(answer).success).toBe(true)
    }
  })

  it('writes only after verify, as the tail of route, in a full loop', async () => {
    const loop = observedLoop()

    const result = await runAuthoringLoop({ intent: INTENT, scope: SCOPE }, loop.deps)

    expect(result.stages).toEqual([...AUTHORING_LOOP_STAGES])
    expect(loop.published).toEqual([FINAL_TARGET])
    expect(result.outcome.kind === 'drafted' ? result.outcome.written.file.kind : undefined)
      .toBe('written')
  })
})

// The disposition is computed, so the cell fails on the table, not on a fixture.
describe('a draft-mode draft a keep-gate rejected is not written', () => {
  const ONE_RUN = { requested: 1, completed: 1 } as const

  function draftModeReceipt(gates: DraftGateBooleans, runId?: string): DraftReceipt {
    const receipt = scriptedReceipt(computeDraftDisposition({
      gates,
      stabilityRunsRequested: ONE_RUN.requested,
      stabilityRunsCompleted: ONE_RUN.completed,
    }), gates, ONE_RUN)
    return runId === undefined
      ? receipt
      : {
        ...receipt,
        gateRuns: [{ runId, memberOutcome: 'passed', definitive: true, healed: false }],
      }
  }

  it('a draft-mode draft whose run reached no verdict is never written', async () => {
    const host = writerShelf()
    const receipt = draftModeReceipt({ ...ALL_PASS, executesDefinitive: false })

    const outcome = await routeAfterVerify(STAGED_DRAFT, receipt, host.deps, [])
      .then((routed) => routed, (error: unknown) => error)

    expect(receipt.disposition).toBe('rejected')
    expect(host.requests).toEqual([])
    expect(outcome).toBeInstanceOf(AuthoringLoopUnroutableEvidenceError)
  })

  it('a draft-mode draft that passed but asserts nothing falsifiable answers not written: rejected',
    async () => {
      const runId = 'r_draft-mode-passed'
      const document = runDocument(runId, [{
        filePath: STAGED_DRAFT.filePath,
        testName: STAGED_DRAFT.testName,
        outcome: 'passed',
        steps: ACCEPT_CONTROL_SUBACTIONS,
      }])
      const host = writerShelf(undefined, {
        start: () => Promise.reject(new Error('stage 5 starts no run')),
        get: (id: string) => Promise.resolve(id === runId ? document : undefined),
      })
      const gates = { ...ALL_PASS, falsifiableAssertion: false }
      const receipt = draftModeReceipt(gates, runId)

      const routed = await routeAfterVerify(STAGED_DRAFT, receipt, host.deps, [])

      expect(host.requests).toEqual([])
      expect(routed.outcome.kind).toBe('drafted')
      const answer = routed.outcome.kind === 'drafted' ? routed.outcome.written : undefined
      expect(answer).toEqual({
        file: { kind: 'not-written', targetPath: FINAL_TARGET, reason: 'rejected' },
        disposition: 'rejected',
        gates,
      })
      expect(WrittenTestReceiptSchema.safeParse(answer).success).toBe(true)
    })
})

// The keep check is driven directly; `STAGED_DRAFT`'s steps carry `alice` and `Local Form`.
describe('stated values checked at keep', () => {
  const GATE_RUN_IDS = ['r_keep-gate-0', 'r_keep-gate-1', 'r_keep-gate-2'] as const

  function keepEligibleReceipt(): DraftReceipt {
    return {
      ...scriptedReceipt('keep-eligible', ALL_PASS, { requested: 3, completed: 3 }),
      gateRuns: GATE_RUN_IDS.map((runId) => ({
        runId,
        memberOutcome: 'passed' as const,
        definitive: true,
        healed: false,
      })),
    }
  }

  function unverifiedReceipt(): DraftReceipt {
    return scriptedReceipt(
      'unverified',
      { ...ALL_PASS, stableVerdict: false },
      { requested: 1, completed: 1 },
    )
  }

  it('a keep-eligible draft that lost a stated value is refused at keep and never published',
    async () => {
      const host = writerShelf()
      const receipt = keepEligibleReceipt()

      const routed = await routeAfterVerify(STAGED_DRAFT, receipt, host.deps, ['Sign In'])

      expect(routed.outcome).toEqual({
        kind: 'refused',
        draftRef: {
          filePath: STAGED_DRAFT.filePath,
          testId: STAGED_DRAFT.testId,
          testName: STAGED_DRAFT.testName,
          contentDigest: STAGED_DRAFT.contentDigest,
        },
        receipt,
        statedValueRefusal: { stage: 'keep', missingValues: ['Sign In'] },
      })
      expect(host.requests).toEqual([])
      expect(routed.fanOut.consumedTotal).toBe(receipt.gateRuns.length)
      expect(routed.fanOut.consumedTotal).toBe(GATE_RUN_IDS.length)
    })

  it('a keep-eligible draft that carries every stated value is written', async () => {
    const host = writerShelf()
    const receipt = keepEligibleReceipt()

    const routed = await routeAfterVerify(STAGED_DRAFT, receipt, host.deps, ['Local Form', 'alice'])

    expect(routed.outcome.kind).toBe('drafted')
    expect(host.requests).toEqual([{ draftPath: STAGED_PATH, targetPath: FINAL_TARGET }])
    expect(routed.outcome.kind === 'drafted' ? routed.outcome.written.file.kind : undefined)
      .toBe('written')
  })

  it("draft mode's unverified draft is checked before it is written", async () => {
    const refusedHost = writerShelf()
    const refused = await routeAfterVerify(
      STAGED_DRAFT,
      unverifiedReceipt(),
      refusedHost.deps,
      ['alice', 'Sign In'],
    )
    expect(refused.outcome.kind).toBe('refused')
    expect(refused.outcome.kind === 'refused' ? refused.outcome.statedValueRefusal : undefined)
      .toEqual({ stage: 'keep', missingValues: ['Sign In'] })
    expect(refusedHost.requests).toEqual([])

    const writtenHost = writerShelf()
    const written = await routeAfterVerify(
      STAGED_DRAFT,
      unverifiedReceipt(),
      writtenHost.deps,
      ['alice', 'Local Form'],
    )
    expect(written.outcome.kind).toBe('drafted')
    expect(written.outcome.kind === 'drafted' ? written.outcome.written.disposition : undefined)
      .toBe('unverified')
    expect(writtenHost.requests).toEqual([{ draftPath: STAGED_PATH, targetPath: FINAL_TARGET }])
  })

  it('a case-changed value is refused at keep', async () => {
    const host = writerShelf()

    const routed = await routeAfterVerify(
      STAGED_DRAFT,
      keepEligibleReceipt(),
      host.deps,
      ['local form'],
    )

    expect(routed.outcome.kind === 'refused' ? routed.outcome.statedValueRefusal : undefined)
      .toEqual({ stage: 'keep', missingValues: ['local form'] })
    expect(host.requests).toEqual([])
  })

  it('a rejected draft is never checked and never written', async () => {
    const runId = 'r_keep-rejected-passed'
    const document = runDocument(runId, [{
      filePath: STAGED_DRAFT.filePath,
      testName: STAGED_DRAFT.testName,
      outcome: 'passed',
      steps: ACCEPT_CONTROL_SUBACTIONS,
    }])
    const host = writerShelf(undefined, {
      start: () => Promise.reject(new Error('stage 5 starts no run')),
      get: (id: string) => Promise.resolve(id === runId ? document : undefined),
    })
    const gates = { ...ALL_PASS, falsifiableAssertion: false }
    const ONE_RUN = { requested: 1, completed: 1 } as const
    const receipt: DraftReceipt = {
      ...scriptedReceipt(
        computeDraftDisposition({
          gates,
          stabilityRunsRequested: ONE_RUN.requested,
          stabilityRunsCompleted: ONE_RUN.completed,
        }),
        gates,
        ONE_RUN,
      ),
      gateRuns: [{ runId, memberOutcome: 'passed', definitive: true, healed: false }],
    }

    const routed = await routeAfterVerify(STAGED_DRAFT, receipt, host.deps, ['Sign In'])

    expect(receipt.disposition).toBe('rejected')
    expect(host.requests).toEqual([])
    expect(routed.outcome.kind).toBe('drafted')
    expect(routed.outcome).not.toHaveProperty('statedValueRefusal')
    expect(routed.outcome.kind === 'drafted' ? routed.outcome.written : undefined).toEqual({
      file: { kind: 'not-written', targetPath: FINAL_TARGET, reason: 'rejected' },
      disposition: 'rejected',
      gates,
    })
  })

  it('the keep check is the only door to publishing', () => {
    const lines = readFileSync(fileURLToPath(new URL('../loop.ts', import.meta.url)), 'utf8')
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    const publishLines = lines.flatMap((line, index) => (line.includes('.publish(') ? [index] : []))
    expect(publishLines).toHaveLength(1)

    const start = lines.findIndex((line) => line.startsWith('async function writeFinalDraft('))
    const end = lines.findIndex((line, index) => index > start && line === '}')
    const publishAt = publishLines[0] as number
    expect(start).toBeGreaterThanOrEqual(0)
    expect(publishAt).toBeGreaterThan(start)
    expect(publishAt).toBeLessThan(end)

    const checkAt = lines.findIndex(
      (line, index) => index > start && index < end && line.includes('missingStatedValues('),
    )
    expect(checkAt).toBeGreaterThan(start)
    expect(checkAt).toBeLessThan(publishAt)
  })
})
