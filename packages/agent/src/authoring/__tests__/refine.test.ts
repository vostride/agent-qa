// The one unconditional refinement round.
//
// THE MUTATION THIS FILE MUST GO RED ON: gating the round behind a condition — the obvious one
// being "skip the round when the first retrieval already returned facts". That is the trigger
// heuristic D-18 rules out, and a suite that only ever drives a draft whose first brief was EMPTY
// would stay green under it while the round silently stopped running for every real invocation.
// So the always-runs cell drives a draft whose first brief is DELIBERATELY populated, which is the
// input the mutation is designed to skip. The mutation is named here and nowhere in `refine.ts`'s
// own comments: a source comment describing the forbidden edit teaches the next reader how to make
// it look intentional.
//
// THE SUBJECT IS IMPORTED LAZILY, INSIDE EACH CELL. A static import fails at module load, so vitest
// reports ONE file-level error and collects no cells at all — which reads identically to a suite
// that was never written. With the lazy form every row is named and every row fails against a
// module that does not exist, which is what makes a RED receipt a denominator (394-03's finding,
// re-applied).

import { asRecordId } from '@vostride/agent-qa-schema'
import type { AuthoringBrief, ScopeKey, TestEditPatchSet } from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'

import { ACCEPT_CONTROL_DRAFT } from './evidence-fixtures.js'
import type { JobModelRequest } from '../../jobs/record-llm-authorship.js'
import type { RefinementOutcome } from '../refine.js'
import type {
  AuthoringReadPortLike,
  DraftShelfPortLike,
  ParsedDraftLike,
  SuiteTextCorpusEntryLike,
} from '../ports.js'

const SCOPE: ScopeKey = { tier: 'product', key: 'local-form' }

/**
 * The draft the round is given, with a vocabulary DISJOINT from the intent's.
 *
 * Load-bearing rather than decorative: the claim is that the second retrieval is keyed on the
 * DRAFT and not on the intent, and a fixture whose steps re-used the intent's words could not tell
 * the two apart — the query would contain the intent's vocabulary either way, and a round that had
 * silently re-asked the intent would pass.
 */
const DRAFT: ParsedDraftLike = {
  ...ACCEPT_CONTROL_DRAFT,
  testName: 'Submit the account form and see the confirmation banner',
  steps: [
    'Open the account form',
    'Type the account name into the name field',
    'Click Submit',
    'Verify the confirmation banner is visible',
  ],
}

/** Nothing in this sentence appears in the draft above. See {@link DRAFT}. */
const INTENT = 'Prove that discounted invoices reconcile against the quarterly ledger'

const POPULATED_BRIEF: AuthoringBrief = {
  exemplars: [],
  procedures: [],
  facts: [
    {
      id: asRecordId('mem:account-form-posts'),
      kind: 'fact',
      summary: 'The account form posts to /accounts and echoes a receipt id',
      trust: 0.8,
      status: 'active',
      servedAsCanary: false,
      tier: 'full',
    },
  ],
  cautions: [],
  coverage: {},
  truncation: 'none',
  admissions: [],
}

interface Harness {
  readonly deps: { read: AuthoringReadPortLike; shelf: DraftShelfPortLike }
  readonly briefQueries: string[]
  readonly prompts: JobModelRequest[]
  readonly applied: TestEditPatchSet[]
  readonly wholeDocumentWrites: string[]
}

interface HarnessOptions {
  /** What the refinement model emits. A string is used verbatim, so a non-JSON case is expressible. */
  readonly emission: string
  /** How the shelf answers `applyPatches`; the default stages a patched draft. */
  readonly apply?: DraftShelfPortLike['applyPatches']
}

function harness(options: HarnessOptions): Harness {
  const briefQueries: string[] = []
  const prompts: JobModelRequest[] = []
  const applied: TestEditPatchSet[] = []
  const wholeDocumentWrites: string[] = []

  const read: AuthoringReadPortLike = {
    // the `target` vocabulary. The refinement round is the subject here and it
    // carries no format block, so this is read by the compile call alone.
    configuredTargetNames: (): Promise<readonly string[]> => Promise.resolve(['local-form']),
    getAuthoringBrief(query: string): Promise<AuthoringBrief> {
      briefQueries.push(query)
      return Promise.resolve(POPULATED_BRIEF)
    },
    suiteTextCorpus(): Promise<readonly SuiteTextCorpusEntryLike[]> {
      return Promise.resolve([])
    },
  }

  const shelf: DraftShelfPortLike = {
    model: () => Promise.resolve({
      modelId: 'fixture:refine',
      generate(request) {
        prompts.push(request)
        return Promise.resolve({ text: options.emission })
      },
    }),
    write(contents: string) {
      wholeDocumentWrites.push(contents)
      return Promise.resolve({ kind: 'staged' as const, draft: DRAFT })
    },
    applyPatches: options.apply ?? ((_draft, patchSet) => {
      applied.push(patchSet)
      return Promise.resolve({
        kind: 'staged' as const,
        draft: { ...DRAFT, contentDigest: 'refined-digest', steps: [...DRAFT.steps, 'Verify the receipt id is shown'] },
      })
    }),
    runs: {
      start: () => Promise.reject(new Error('the refinement round starts no runs')),
      get: () => Promise.resolve(undefined),
    },
    verifyDraft: () => Promise.reject(new Error('the refinement round verifies nothing')),
    publish: () => Promise.reject(new Error('the refinement round writes no test file')),
  }

  return { deps: { read, shelf }, briefQueries, prompts, applied, wholeDocumentWrites }
}

function patchSetEmission(patches: TestEditPatchSet['patches'], thoughts = 'considered'): string {
  return JSON.stringify({ thoughts, patches })
}

async function runRound(harnessed: Harness, intent: string = INTENT): Promise<RefinementOutcome> {
  const { refineDraft } = await import('../refine.js')
  return await refineDraft(DRAFT, { scope: SCOPE, intent }, harnessed.deps)
}

describe('the refinement round is unconditional', () => {
  it('runs even when the FIRST retrieval already returned facts — the case a trigger would skip', async () => {
    const bench = harness({
      emission: patchSetEmission([
        { op: 'replace', path: '/steps/3', value: 'Verify the confirmation banner names the account' },
      ]),
    })

    const outcome = await runRound(bench)

    // The brief handed to this round is POPULATED (see POPULATED_BRIEF) — the exact input a
    // "refine only when retrieval was thin" gate is written to skip. The round ran anyway: a
    // second retrieval was taken and a model was called.
    expect(POPULATED_BRIEF.facts).not.toHaveLength(0)
    expect(bench.briefQueries).toHaveLength(1)
    expect(bench.prompts).toHaveLength(1)
    expect(outcome.kind).toBe('refined')
  })

  it('is pinned at exactly one round, so the loop shape stays deterministic', async () => {
    const { REFINEMENT_ROUNDS } = await import('../refine.js')

    // The constant AND the behaviour, because either alone is satisfiable by the other being
    // wrong: a `REFINEMENT_ROUNDS` of 1 beside a body that loops twice, or a body that runs once
    // beside a constant nobody reads.
    expect(REFINEMENT_ROUNDS).toBe(1)

    const bench = harness({ emission: patchSetEmission([]) })
    await runRound(bench)
    expect(bench.prompts).toHaveLength(1)
    expect(bench.briefQueries).toHaveLength(1)
  })
})

describe('the round re-retrieves on the DRAFT, not on the intent', () => {
  it('keys the second retrieval on the draft own steps and name', async () => {
    const bench = harness({ emission: patchSetEmission([]) })

    await runRound(bench)

    const query = bench.briefQueries[0] ?? ''
    // Every step, by its own text. Sequence rather than presence: a query built out of the draft
    // is the claim, and one that carried only the test name would satisfy a `toContain` on the
    // name alone.
    for (const step of DRAFT.steps) expect(query).toContain(step)
    expect(query).toContain(DRAFT.testName)
    // …and NOT the intent. The two vocabularies are disjoint by construction, so this line fails
    // for a round that re-asked the question stage 1 already asked.
    expect(query).not.toContain('quarterly ledger')
    expect(query).not.toContain(INTENT)
  })

  it('shows the model the draft it is refining, not a fresh authoring brief alone', async () => {
    const bench = harness({ emission: patchSetEmission([]) })

    await runRound(bench)

    const { AUTHORING_REFINE_AGENT_CONTEXT } = await import('../refine.js')
    const request = bench.prompts[0]
    // The pinned context line, so the compile call and the refine call are distinguishable at the
    // one place a provider prompt cache keys on.
    expect(request?.system).toContain(AUTHORING_REFINE_AGENT_CONTEXT)
    for (const step of DRAFT.steps) expect(request?.prompt).toContain(step)
  })

  it('exports the query builder so the claim is checkable without reconstructing a prompt', async () => {
    const { draftRetrievalQuery } = await import('../refine.js')

    const query = draftRetrievalQuery(DRAFT)

    expect(query).toBe([DRAFT.testName, ...DRAFT.steps].join('\n'))
    // The addresses this host minted are deliberately absent: they name no fact about an
    // application, and a retrieval keyed partly on a digest would answer differently for two
    // drafts that say the same thing.
    expect(query).not.toContain(DRAFT.contentDigest)
    expect(query).not.toContain(DRAFT.filePath)
  })
})

describe('the refinement is applied as patches, through the one applier', () => {
  it('hands the parsed patch set to the CST applier port and continues with what it staged', async () => {
    const patches: TestEditPatchSet['patches'] = [
      { op: 'add', path: '/steps/4', value: 'Verify the receipt id is shown' },
    ]
    const bench = harness({ emission: patchSetEmission(patches, 'the brief names a receipt id') })

    const outcome = await runRound(bench)

    // THE APPLIER, not a second whole-document write. A round that re-emitted the document would
    // have gone through `write`, which is the path D-02 reserves for creation.
    expect(bench.applied).toEqual([{ thoughts: 'the brief names a receipt id', patches }])
    expect(bench.wholeDocumentWrites).toEqual([])
    expect(outcome.kind).toBe('refined')
    if (outcome.kind !== 'refined') throw new Error('unreachable')
    expect(outcome.patchCount).toBe(1)
    expect(outcome.draft.contentDigest).toBe('refined-digest')
    expect(outcome.thoughts).toBe('the brief names a receipt id')
  })

  it('accepts an EMPTY patch array as a valid outcome, and stages nothing for it', async () => {
    const bench = harness({ emission: patchSetEmission([], 'the brief adds nothing') })

    const outcome = await runRound(bench)

    // Not an error, and not a re-stage either. The applier is never reached, so "this round
    // changed nothing" is distinguishable on disk from "this round rewrote the same bytes".
    expect(outcome.kind).toBe('no-op')
    expect(bench.applied).toEqual([])
    expect(bench.wholeDocumentWrites).toEqual([])
    expect(outcome.draft).toBe(DRAFT)
  })
})

describe('a refinement that cannot be used leaves the compiled draft standing', () => {
  it('keeps the draft when the emission is not JSON at all', async () => {
    const bench = harness({ emission: 'I think the draft looks fine, no changes needed.' })

    const outcome = await runRound(bench)

    expect(outcome.kind).toBe('not-applied')
    if (outcome.kind !== 'not-applied') throw new Error('unreachable')
    expect(outcome.reason).toContain('not JSON')
    expect(outcome.draft).toBe(DRAFT)
    expect(bench.applied).toEqual([])
  })

  it('keeps the draft when the emission is JSON that is not a patch set', async () => {
    const bench = harness({ emission: JSON.stringify({ thoughts: 'ok', patches: [{ op: 'move', path: '/steps/0', valueFrom: '/steps/1' }] }) })

    const outcome = await runRound(bench)

    expect(outcome.kind).toBe('not-applied')
    if (outcome.kind !== 'not-applied') throw new Error('unreachable')
    expect(outcome.reason).toContain('not a patch set')
    expect(outcome.draft).toBe(DRAFT)
  })

  it('keeps the draft when the applier REFUSES the patch set — the region fence reaching this round', async () => {
    const bench = harness({
      emission: patchSetEmission([{ op: 'replace', path: '/target', value: 'someone-elses-app' }]),
      apply: () => Promise.reject(
        new Error('PatchPointerOutsideEditableRegionError: /target is outside the editable region'),
      ),
    })

    const outcome = await runRound(bench)

    // The refusal REACHES the caller as a reason rather than as a thrown invocation failure: a
    // fenced refinement is a fact about the refinement, and the compiled draft it was refining is
    // still a perfectly good draft.
    expect(outcome.kind).toBe('not-applied')
    if (outcome.kind !== 'not-applied') throw new Error('unreachable')
    expect(outcome.reason).toContain('outside the editable region')
    expect(outcome.draft).toBe(DRAFT)
  })

  it('keeps the draft when the patched document no longer parses', async () => {
    const bench = harness({
      emission: patchSetEmission([{ op: 'remove', path: '/steps/0' }]),
      apply: () => Promise.resolve({ kind: 'unparsable' as const, reason: 'steps must have at least one entry' }),
    })

    const outcome = await runRound(bench)

    expect(outcome.kind).toBe('not-applied')
    if (outcome.kind !== 'not-applied') throw new Error('unreachable')
    expect(outcome.reason).toBe('steps must have at least one entry')
    expect(outcome.draft).toBe(DRAFT)
  })
})

describe('the refine prompt carries the request', () => {
  it('the refine prompt carries the request as its first context block', async () => {
    const bench = harness({ emission: patchSetEmission([]) })

    await runRound(bench)

    const prompt = bench.prompts[0]?.prompt ?? ''
    expect(prompt.startsWith(`## Intent\n\n${INTENT}\n\n`)).toBe(true)
    expect(prompt.indexOf('## Intent')).toBeLessThan(prompt.indexOf('## The draft as it stands'))
  })

  it("the refine retrieval query is still the draft's words, not the request", async () => {
    const { draftRetrievalQuery } = await import('../refine.js')
    const bench = harness({ emission: patchSetEmission([]) })

    await runRound(bench)

    expect(bench.briefQueries).toEqual([draftRetrievalQuery(DRAFT)])
    expect(bench.briefQueries[0]).not.toContain(INTENT)
  })
})

describe('the refine prompt over project knowledge', () => {
  it('the refine prompt puts the request over project knowledge', async () => {
    const { REQUEST_WINS_INSTRUCTION } = await import('../brief-blocks.js')
    const bench = harness({ emission: patchSetEmission([]) })

    await runRound(bench)

    expect(bench.prompts[0]?.system).toContain(REQUEST_WINS_INSTRUCTION)
  })
})

describe('stated values checked on a refine patch', () => {
  const STATED = 'check the banner says "confirmation banner"'
  const LOSING_STEP = 'Verify the success notice is visible'
  const losingPatch = patchSetEmission([{ op: 'replace', path: '/steps/3', value: LOSING_STEP }])

  function stagesStep3(step: string): DraftShelfPortLike['applyPatches'] {
    return () =>
      Promise.resolve({
        kind: 'staged' as const,
        draft: {
          ...DRAFT,
          contentDigest: 'refined-digest',
          steps: [...DRAFT.steps.slice(0, 3), step],
        },
      })
  }

  it('a refine patch that loses a stated value is not applied and the compiled draft goes on', async () => {
    const { statedValuesMissingReason } = await import('../stated-values.js')
    const bench = harness({ emission: losingPatch, apply: stagesStep3(LOSING_STEP) })

    const outcome = await runRound(bench, STATED)

    expect(outcome.kind).toBe('not-applied')
    if (outcome.kind !== 'not-applied') throw new Error('unreachable')
    expect(outcome.reason).toBe(statedValuesMissingReason(['confirmation banner']))
    expect(outcome.draft).toBe(DRAFT)
    expect(bench.prompts).toHaveLength(1)
  })

  it('a refine patch that keeps every stated value is applied', async () => {
    const bench = harness({
      emission: patchSetEmission([
        { op: 'add', path: '/steps/4', value: 'Verify the receipt id is shown' },
      ]),
    })

    const outcome = await runRound(bench, STATED)

    expect(outcome.kind).toBe('refined')
    expect(outcome.draft.contentDigest).toBe('refined-digest')
    expect(outcome.draft.steps).toContain('Verify the confirmation banner is visible')
    expect(bench.prompts).toHaveLength(1)
  })

  it('a case change in a refine patch is not applied', async () => {
    const bench = harness({
      emission: patchSetEmission([
        { op: 'replace', path: '/steps/3', value: 'Verify the Confirmation banner is visible' },
      ]),
      apply: stagesStep3('Verify the Confirmation banner is visible'),
    })

    const outcome = await runRound(bench, STATED)

    expect(outcome.kind).toBe('not-applied')
    expect(outcome.draft).toBe(DRAFT)
    expect(bench.prompts).toHaveLength(1)
  })

  it('a vague request never drops a refine patch', async () => {
    const bench = harness({ emission: losingPatch, apply: stagesStep3(LOSING_STEP) })

    const outcome = await runRound(bench, INTENT)

    expect(outcome.kind).toBe('refined')
    expect(outcome.draft.steps).toContain(LOSING_STEP)
    expect(bench.prompts).toHaveLength(1)
  })

  it('a no-op round makes no change and needs no check', async () => {
    const bench = harness({ emission: patchSetEmission([]) })

    const outcome = await runRound(bench, STATED)

    expect(outcome.kind).toBe('no-op')
    expect(outcome.draft).toBe(DRAFT)
    expect(bench.applied).toEqual([])
    expect(bench.prompts).toHaveLength(1)
  })

  it('the check adds no model call', async () => {
    const dropped = harness({ emission: losingPatch, apply: stagesStep3(LOSING_STEP) })
    const kept = harness({
      emission: patchSetEmission([
        { op: 'add', path: '/steps/4', value: 'Verify the receipt id is shown' },
      ]),
    })

    await runRound(dropped, STATED)
    await runRound(kept, STATED)

    expect(dropped.prompts).toHaveLength(1)
    expect(kept.prompts).toHaveLength(1)
  })
})
