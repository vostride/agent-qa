// 2026-10-14 (441-03, D-10): repair and `authoring.draft.edit` refuse a draft that would type a
// literal [secret:NAME], as the loop does. Pitfall 5: the repair-evidence and fixture-reality cells
// this file carried for the deleted credential screen stay here. The fake shelf remints `filePath`
// on every apply, as the host does, which is what makes the candidate's path measurable.

import { TestEditPatchSetSchema, CURRENT_DRAFT_RECEIPT_SCHEMA_VERSION } from '@vostride/agent-qa-schema'
import type {
  CompletedRunHandoff,
  DraftReceipt,
  DraftRef,
  RunsStartInput,
  TestEditPatchSet,
} from '@vostride/agent-qa-schema'
import { literalSecretMarkerRefusal } from '@vostride/agent-qa-runner'
import { describe, expect, it } from 'vitest'

import { memberOutcome, runDocument } from './evidence-fixtures.js'
import type { MemberFixture } from './evidence-fixtures.js'
import { DraftSecretMarkerRefusedError } from '../loop.js'
import { REPAIR_ITERATION_CAP, repairDraft } from '../repair.js'
import { routeRepairOrStop } from '../router.js'
import type { RepairRoute } from '../router.js'
import type { DraftRunPortLike, DraftStageOutcome, ParsedDraftLike } from '../ports.js'
import {
  AUTHORING_DRAFT_EDIT_FUNCTION_ID,
  authoringDraftEditSpec,
} from '../../functions/ops/authoring-draft-edit.js'
import type { DraftEvaluationPort, FunctionDeps } from '../../functions/spec.js'

const PLANTED_MARKER = '[secret:PW]'
const MARKER_SENTENCE =
  'This action contains the masked placeholder [secret:PW]; it would type the placeholder text. '
  + 'Use {{secret:PW}} to type the secret.'

const SHELF_DIR = 'tests/.agent-qa-drafts'

const DRAFT: ParsedDraftLike = {
  testId: 't_repair-screen-fixture',
  filePath: `${SHELF_DIR}/repair-screen-fixture.yaml`,
  testName: 'Submit the local account form',
  target: 'local-form',
  steps: [
    'Open the local account form',
    'Type "alice" into the Username field',
    'Click the Submit button',
    'Verify the confirmation banner says "Saved"',
  ],
  contentDigest: 'digest-repair-screen-0',
}

const DRAFT_REF: DraftRef = {
  filePath: DRAFT.filePath,
  testId: DRAFT.testId,
  testName: DRAFT.testName,
  contentDigest: DRAFT.contentDigest,
}

/** Steps 0 and 1 passed; step 2 could not be carried out. The router's repair input. */
const BEST_PRIOR_MEMBER: MemberFixture = {
  filePath: DRAFT.filePath,
  testName: DRAFT.testName,
  outcome: 'failed',
  steps: [
    [{ type: 'navigate', url: 'http://127.0.0.1:8931/form.html' }],
    [{ type: 'fill', ref: 'e1', role: 'textbox', name: 'username' }],
    [{ type: 'click', ref: 'e9', role: 'button', name: 'submit', success: false }],
  ],
  failedSteps: [2],
  infeasibleSteps: [2],
}

const BEST_PRIOR_RUN: CompletedRunHandoff = runDocument('r_best-prior', [BEST_PRIOR_MEMBER])

function repairRoute(): RepairRoute {
  const route = routeRepairOrStop(DRAFT_REF, BEST_PRIOR_RUN)
  if (route.kind !== 'repair') {
    throw new Error(`the fixture must route to repair, and it routed to ${route.kind}`)
  }
  return route
}

// ---- the patch corpus, produced through the shipped schema --------------------------------------

/** A patch planting the placeholder into an UNPROTECTED step — the fence has no answer to it. */
const MARKER_PATCH: TestEditPatchSet = TestEditPatchSetSchema.parse({
  thoughts: 'the submit control needs the key',
  patches: [{ op: 'replace', path: '/steps/3', value: `Verify the banner shows ${PLANTED_MARKER}` }],
})

const CONTEXT_MARKER_PATCH: TestEditPatchSet = TestEditPatchSetSchema.parse({
  thoughts: 'record the operator password',
  patches: [
    { op: 'replace', path: '/context', value: `Sign in as the operator using ${PLANTED_MARKER}` },
  ],
})

/** The same shape carrying no placeholder — this file's admit direction. */
const CLEAN_PATCH: TestEditPatchSet = TestEditPatchSetSchema.parse({
  thoughts: 'wait for the banner',
  patches: [{ op: 'replace', path: '/steps/3', value: 'Verify the confirmation banner is visible' }],
})

const emit = (set: TestEditPatchSet): string => JSON.stringify(set)

// ---- the harness --------------------------------------------------------------------------------

interface Harness {
  readonly deps: Parameters<typeof repairDraft>[1]
  readonly prompts: string[]
  readonly startInputs: RunsStartInput[]
  readonly verifiedPaths: string[]
  readonly stagedDrafts: ParsedDraftLike[]
}

const FINAL_RECEIPT = {
  schemaVersion: CURRENT_DRAFT_RECEIPT_SCHEMA_VERSION,
  draftRef: DRAFT_REF,
  gates: {
    executesDefinitive: { pass: true, runRefs: [], indefinitiveRunRefs: [] },
    stableVerdict: { pass: true, runRefs: [], distinctOutcomes: ['passed'], earlyStopped: false },
    addsValue: { pass: true, novelElementCount: 1, comparedTestCount: 1 },
    falsifiableAssertion: { pass: true, assertionStepCount: 1, falsifiableAssertionCount: 1 },
  },
  stepTable: [],
  gateRuns: [],
  addsValueFinding: { novelElements: [], comparedTests: [] },
  stabilityRunsRequested: 3,
  stabilityRunsCompleted: 3,
  disposition: 'keep-eligible',
  evaluatedAt: 1,
} as unknown as DraftReceipt

/**
 * The applier, faithful to the HOST on the one axis this file turns on: the path is minted from
 * the digest, so a patched candidate never lives where the run that produced the handoff ran.
 */
function applyToSteps(draft: ParsedDraftLike, set: TestEditPatchSet): ParsedDraftLike {
  const steps = [...draft.steps]
  let context = draft.context
  for (const op of set.patches) {
    const segments = op.path.split('/').slice(1)
    if (segments[0] === 'context' && op.op !== 'remove') context = op.value as string
    if (segments[0] !== 'steps') continue
    const index = Number(segments[1])
    if (!Number.isInteger(index)) continue
    if (op.op === 'replace') steps[index] = op.value as string
    if (op.op === 'add') steps.splice(index, 0, op.value as string)
    if (op.op === 'remove') steps.splice(index, 1)
  }
  const contentDigest = `${draft.contentDigest}+${set.patches.length}`
  return {
    ...draft,
    steps,
    ...(context === undefined ? {} : { context }),
    contentDigest,
    filePath: `${SHELF_DIR}/${contentDigest}.yaml`,
  }
}

/** How the scripted probe answers: the member either still fails at step 2, or passes. */
type ProbeVerdict = 'still-failing' | 'passing'

function harness(emissions: readonly string[], probes: readonly ProbeVerdict[]): Harness {
  const prompts: string[] = []
  const startInputs: RunsStartInput[] = []
  const verifiedPaths: string[] = []
  const stagedDrafts: ParsedDraftLike[] = []
  const documents = new Map<string, CompletedRunHandoff>()
  let emitted = 0

  const runs: DraftRunPortLike = {
    start(input: RunsStartInput) {
      const index = startInputs.length
      startInputs.push(input)
      const runId = `r_probe-${index}`
      // The probe runs over the STAGED path, so its member is recorded there — which is what the
      // real runner does and what makes the prefix re-check joinable at all.
      const filePath = input.patterns?.[0] ?? DRAFT.filePath
      const verdict = probes[index] ?? 'still-failing'
      documents.set(runId, runDocument(runId, [{
        ...BEST_PRIOR_MEMBER,
        filePath,
        ...(verdict === 'passing'
          ? { outcome: 'passed' as const, failedSteps: [], infeasibleSteps: [] }
          : {}),
      }]))
      return Promise.resolve({
        runId,
        scope: { tier: 'product', key: 'local-form' },
        executionContext: 'local-headless',
        buildOrdinal: 1,
        startedAt: 0,
        testCount: 1,
        gateRun: true,
        excludedFromOutcomes: true,
      } as never)
    },
    get(runId: string) {
      return Promise.resolve(documents.get(runId))
    },
  }

  const shelf = {
    runs,
    model: () => Promise.resolve({
      modelId: 'fixture:repair-screen',
      generate(request: { prompt: string }) {
        if (prompts.length >= REPAIR_ITERATION_CAP + 1) {
          throw new Error(`the repair loop asked for patch ${prompts.length + 1}: K did not bound it`)
        }
        prompts.push(request.prompt)
        const text = emissions[emitted] ?? emissions.at(-1) ?? '{}'
        emitted += 1
        return Promise.resolve({ text })
      },
    }),
    write: () => Promise.resolve({ kind: 'unparsable', reason: 'unused' } as DraftStageOutcome),
    applyPatches(draft: ParsedDraftLike, set: TestEditPatchSet): Promise<DraftStageOutcome> {
      const staged = applyToSteps(draft, set)
      stagedDrafts.push(staged)
      return Promise.resolve({ kind: 'staged', draft: staged })
    },
    verifyDraft(input: { draftPath: string }): Promise<DraftReceipt> {
      verifiedPaths.push(input.draftPath)
      return Promise.resolve(FINAL_RECEIPT)
    },
    // Repair returns a repaired draft; the loop, not repair, writes it. Never reached here.
    publish: () => Promise.reject(new Error('repair writes no test file')),
  }

  return {
    deps: {
      draft: DRAFT,
      handoff: BEST_PRIOR_RUN,
      shelf,
      runs,
      statedValues: [],
    } as Parameters<typeof repairDraft>[1],
    prompts,
    startInputs,
    verifiedPaths,
    stagedDrafts,
  }
}

/** The body of one `## Title` block of a rendered prompt, or `undefined`. */
function blockBody(prompt: string, titlePrefix: string): string | undefined {
  const blocks = prompt.split('\n\n## ')
  const found = blocks
    .map((block) => (block.startsWith('## ') ? block.slice(3) : block))
    .find((block) => block.startsWith(titlePrefix))
  if (found === undefined) return undefined
  const separator = found.indexOf('\n\n')
  return separator === -1 ? '' : found.slice(separator + 2)
}

// ---- integrity cells: these never depend on the fix and stay GREEN in the RED record ------------

describe('the fixtures this file measures with are real', () => {
  it('the planted placeholder is a literal secret marker', () => {
    expect(literalSecretMarkerRefusal(PLANTED_MARKER)).toBe(MARKER_SENTENCE)
  })

  it('every patch in the corpus is one the shipped schema accepts', () => {
    for (const [name, set] of [['marker', MARKER_PATCH], ['clean', CLEAN_PATCH]] as const) {
      expect(TestEditPatchSetSchema.safeParse(set).success, name).toBe(true)
    }
  })

  it('the fixture routes to the repair arm through the shipped router', () => {
    expect(repairRoute().kind).toBe('repair')
    expect(repairRoute().failingStepIndex).toBe(2)
  })

  it('the best prior run passes two steps and fails the third', () => {
    const member = memberOutcome(BEST_PRIOR_MEMBER)
    expect(member.steps.map((step) => step.verifierVerdict.pass)).toEqual([true, true, false])
  })

  it('the fake applier remints the path the way the host does', () => {
    const staged = applyToSteps(DRAFT, CLEAN_PATCH)
    expect(staged.filePath).not.toBe(DRAFT.filePath)
    expect(staged.filePath).toBe(`${SHELF_DIR}/${staged.contentDigest}.yaml`)
  })
})

const RUN_BLOCK_TITLE = 'What happened in run r_best-prior'
const CANDIDATE_BLOCK_TITLE = 'The draft as it stands'
const REFUSAL_BLOCK_TITLE = 'Why the previous attempt was not kept'

const EDIT_TARGET: ParsedDraftLike = {
  testId: 't_committed-checkout',
  filePath: 'tests/checkout.yaml',
  testName: 'Checkout with a coupon',
  target: 'checkout',
  steps: ['Open the cart', 'Verify the total is 0.00'],
  contentDigest: 'digest-committed',
}

async function editThrough(
  patches: readonly { op: 'replace'; path: string; value: string }[],
): Promise<{ readonly settled: unknown; readonly published: string[] }> {
  const published: string[] = []
  let staged: ParsedDraftLike = {
    ...EDIT_TARGET,
    filePath: `${SHELF_DIR}/digest-edited.yaml`,
    contentDigest: 'digest-edited',
  }
  const shelf = {
    model: () => Promise.resolve({
      modelId: 'fixture:edit',
      generate: () => Promise.resolve({
        text: JSON.stringify({ thoughts: 'apply the request', patches }),
      }),
    }),
    write: () => Promise.reject(new Error('an edit never emits a whole document')),
    applyPatches: (_draft: ParsedDraftLike, set: TestEditPatchSet) => {
      staged = applyToSteps({ ...staged, steps: EDIT_TARGET.steps }, set)
      return Promise.resolve({ kind: 'staged' as const, draft: staged })
    },
    runs: {
      start: () => { throw new Error('authoring.draft.edit must start ZERO runs') },
      get: () => { throw new Error('authoring.draft.edit reads no runs') },
    },
    verifyDraft: () => { throw new Error('authoring.draft.edit re-runs no gates') },
    publish: (request: { targetPath: string }) => {
      published.push(request.targetPath)
      return Promise.resolve({
        kind: 'written' as const,
        filePath: request.targetPath,
        contentDigest: staged.contentDigest,
      })
    },
  }
  const draftEvaluation: DraftEvaluationPort = {
    resolveDraft: () => Promise.resolve({ kind: 'parsed' as const, draft: EDIT_TARGET }),
    openEvaluation: () => Promise.reject(new Error('an edit opens no evaluation')),
  }
  const deps = {
    entities: {
      resolve: () => Promise.resolve({ kind: 'none' as const, reason: 'no-match' as const }),
      get: () => Promise.resolve(undefined),
    },
    draftShelf: shelf,
    draftEvaluation,
  } as unknown as FunctionDeps

  const settled = await authoringDraftEditSpec
    .invoke(
      { testRef: `${EDIT_TARGET.filePath}::${EDIT_TARGET.testName}`, intent: 'apply the request' },
      deps,
    )
    .then((output) => output, (error: unknown) => error)
  return { settled, published }
}

describe('masked placeholders in a repair patch', () => {
  it('a repair patch that writes a masked placeholder spends the iteration and starts no probe', async () => {
    const bench = harness([emit(MARKER_PATCH), emit(CLEAN_PATCH)], ['passing'])

    const outcome = await repairDraft(repairRoute(), bench.deps)

    // One probe: the clean patch of iteration 2. The placeholder patch of iteration 1 started none.
    expect(bench.startInputs).toHaveLength(1)
    expect(outcome.kind).toBe('repaired')
    expect(outcome.iterations).toBe(2)
    expect(blockBody(bench.prompts[1] ?? '', REFUSAL_BLOCK_TITLE))
      .toBe(`step 4: ${MARKER_SENTENCE}`)
    // The candidate did not advance: iteration 2 patched the original draft, at a path minted from
    // the original digest, and its candidate block holds no placeholder.
    expect(blockBody(bench.prompts[1] ?? '', CANDIDATE_BLOCK_TITLE)).not.toContain(PLANTED_MARKER)
    expect(bench.stagedDrafts[1]?.contentDigest).toBe(`${DRAFT.contentDigest}+1`)
    expect(bench.verifiedPaths).toEqual([bench.stagedDrafts[1]?.filePath])
  })

  it('a repair loop of placeholder patches exits through the exhausted arm with no receipt', async () => {
    const bench = harness([emit(MARKER_PATCH)], ['passing', 'passing', 'passing'])

    const outcome = await repairDraft(repairRoute(), bench.deps)

    expect(bench.startInputs).toEqual([])
    expect(outcome.kind).toBe('abandoned')
    if (outcome.kind !== 'abandoned') throw new Error('unreachable')
    expect(outcome.abandonment.kind).toBe('exhausted')
    expect(outcome.abandonment.error.message).toContain(MARKER_SENTENCE)
    expect(outcome.iterations).toBe(REPAIR_ITERATION_CAP)
    expect(bench.prompts).toHaveLength(REPAIR_ITERATION_CAP)
    expect(outcome.probeRunIds).toEqual([])
    expect(bench.verifiedPaths).toEqual([])
    for (const prompt of bench.prompts) {
      expect(blockBody(prompt, CANDIDATE_BLOCK_TITLE)).not.toContain(PLANTED_MARKER)
    }
  })

  it('a clean repair patch stays on its path', async () => {
    const bench = harness([emit(CLEAN_PATCH)], ['passing'])

    const outcome = await repairDraft(repairRoute(), bench.deps)

    expect(outcome.kind).toBe('repaired')
    expect(bench.startInputs).toHaveLength(1)
    expect(bench.verifiedPaths).toEqual([bench.stagedDrafts[0]?.filePath])
    expect(outcome.iterations).toBe(1)
  })

  it('the context root is checked at repair and through authoring.draft.edit', async () => {
    const bench = harness([emit(CONTEXT_MARKER_PATCH), emit(CLEAN_PATCH)], ['passing'])

    const outcome = await repairDraft(repairRoute(), bench.deps)

    expect(outcome.kind).toBe('repaired')
    expect(bench.startInputs).toHaveLength(1)
    expect(blockBody(bench.prompts[1] ?? '', REFUSAL_BLOCK_TITLE))
      .toBe(`the test context: ${MARKER_SENTENCE}`)

    const edit = await editThrough([
      { op: 'replace', path: '/context', value: `key ${PLANTED_MARKER}` },
    ])

    expect(AUTHORING_DRAFT_EDIT_FUNCTION_ID).toBe('authoring.draft.edit')
    expect(edit.settled).toBeInstanceOf(DraftSecretMarkerRefusedError)
    expect((edit.settled as DraftSecretMarkerRefusedError).location).toBe('the test context')
    expect((edit.settled as DraftSecretMarkerRefusedError).stepIndex).toBeUndefined()
    expect((edit.settled as Error).message).toBe(`the test context: ${MARKER_SENTENCE}`)
    expect(edit.published).toEqual([])
  })

  it('authoring.draft.edit accepts the template form and a card number', async () => {
    for (const value of [
      'Type {{secret:PW}} into Password',
      'Type "4242 4242 4242 4242" into the Card number field',
    ]) {
      const edit = await editThrough([{ op: 'replace', path: '/steps/1', value }])

      expect(edit.settled, value).not.toBeInstanceOf(Error)
      expect(edit.published, value).toEqual([EDIT_TARGET.filePath])
    }
  })
})

// ---- the evidence a repair iteration past the first is shown -------------------------------------

describe('every repair iteration is shown the trace and the a11y coordinates', () => {
  it('iteration-2-evidence carries the trace and the a11y coordinates at the failure point', async () => {
    // Iteration 1 probes and fails, so iteration 2 exists. The candidate has by then moved to a
    // digest-minted path, which is precisely when the handoff join used to return `undefined`.
    const bench = harness([emit(CLEAN_PATCH)], ['still-failing', 'still-failing', 'still-failing'])

    await repairDraft(repairRoute(), bench.deps)

    expect(bench.prompts).toHaveLength(REPAIR_ITERATION_CAP)
    const second = blockBody(bench.prompts[1] ?? '', RUN_BLOCK_TITLE)
    expect(second).toBeDefined()
    // CONCRETE fixture values, never non-emptiness: the mechanics-signals stub is non-empty too,
    // and asserting presence alone is how the collapse stayed invisible.
    expect(second).toContain('step 2: step 2 <- FAILED HERE')
    expect(second).toContain('verdict: fail — fixture: step 2 did not show what the test claims')
    expect(second).toContain('plan: plan click')
    expect(second).toContain('a11y state-before: step 2 sub-action 0')
  })

  it('iteration-2-evidence carries the same failure body as iteration 1', async () => {
    // THE COUNTER-DIRECTION. The handoff cannot change within one repair entry, so the evidence
    // must not either — a join that drifted to some OTHER member would pass the cell above while
    // showing the model a different run's trace every iteration.
    const bench = harness([emit(CLEAN_PATCH)], ['still-failing', 'still-failing', 'still-failing'])

    await repairDraft(repairRoute(), bench.deps)

    const first = blockBody(bench.prompts[0] ?? '', RUN_BLOCK_TITLE)
    const second = blockBody(bench.prompts[1] ?? '', RUN_BLOCK_TITLE)
    const third = blockBody(bench.prompts[2] ?? '', RUN_BLOCK_TITLE)
    expect(first).toBeDefined()
    expect(second).toBe(first)
    expect(third).toBe(first)
  })

  it('iteration-2-evidence labels which draft each numbering belongs to', async () => {
    const bench = harness([emit(CLEAN_PATCH)], ['still-failing', 'still-failing', 'still-failing'])

    await repairDraft(repairRoute(), bench.deps)

    const prompt = bench.prompts[1] ?? ''
    expect(prompt).toContain(`## ${CANDIDATE_BLOCK_TITLE} (numbered against the current candidate)`)
    expect(prompt).toContain(`## ${RUN_BLOCK_TITLE} (steps numbered against the draft that run executed)`)
    // …and the as-it-stands block really is the CURRENT candidate, not the original.
    const asItStands = blockBody(prompt, CANDIDATE_BLOCK_TITLE)
    expect(asItStands).toContain('3: Verify the confirmation banner is visible')
  })
})
