// The sessionRef write path.
//
// WHY THIS FILE EXISTS. `DraftReceipt.sessionRef` has had a READER since 394-07 —
// `scopeReceiptsToWindow`'s session arm compares it by exact string equality — and no writer at
// all. `EvaluateDraftInput` carried no such field and the `.strict()` mint literal had no such
// key, so no receipt any host could mint was able to carry one: the session window returned []
// unconditionally and `built` was structurally 0, not merely `accepted` (394-VERIFICATION, SC-3).
//
// THE CORPUS IS PRODUCED, NEVER LITERAL. Every receipt asserted below comes out of `evaluateDraft`
// — the ONE mint — against the fake-run harness. A hand-written `DraftReceiptSchema.parse({...,
// sessionRef})` would satisfy every assertion here while production stayed unable to emit the
// shape, which is the exact anti-pattern 394-VERIFICATION recorded against the funnel's own cells.
//
// BOTH DIRECTIONS, BECAUSE ABSENCE IS EXCLUSION. A supplied ref must reach the persisted bytes
// verbatim AND an unsupplied one must leave the key ABSENT — not empty-string, not defaulted to
// whichever session happens to be asking. A writer that stamped something for every caller would
// pass the first cell and quietly attribute every CLI draft to some session.

import {
  AuthoringDraftWriteInputSchema,
  AuthoringVerifyDraftInputSchema,
} from '@vostride/agent-qa-schema'
import type { CompletedRunHandoff, DraftReceipt } from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'

import {
  ACCEPT_CONTROL_DRAFT,
  acceptControlMember,
  fakeFingerprintIndex,
  fakeRunPort,
  runDocument,
} from './evidence-fixtures.js'
import type { MemberFixture } from './evidence-fixtures.js'
import { evaluateDraft } from '../verify-draft.js'
import { repairDraft } from '../repair.js'
import { routeRepairOrStop } from '../router.js'
import type { RepairRoute } from '../router.js'
import type { DraftRunPortLike, DraftStageOutcome, ParsedDraftLike } from '../ports.js'

function inMemoryStore(): { written: DraftReceipt[]; put(receipt: DraftReceipt): Promise<void> } {
  const written: DraftReceipt[] = []
  return { written, put: async (receipt: DraftReceipt) => void written.push(receipt) }
}

/**
 * One evaluation through the shipped mint. The ONLY producer of a receipt in this file.
 *
 * The suite index is empty, so gate 3 is free — these cells are about ATTRIBUTION, and a gate
 * arrangement that made the disposition interesting would only add a way for them to red for a
 * reason that has nothing to do with the session.
 */
async function mint(
  overrides: { readonly sessionRef?: string; readonly contentDigest?: string } = {},
): Promise<{ readonly receipt: DraftReceipt; readonly persisted: readonly DraftReceipt[] }> {
  const store = inMemoryStore()
  const draft: ParsedDraftLike = {
    ...ACCEPT_CONTROL_DRAFT,
    ...(overrides.contentDigest === undefined ? {} : { contentDigest: overrides.contentDigest }),
  }
  const receipt = await evaluateDraft(
    {
      draft,
      ...(overrides.sessionRef === undefined ? {} : { sessionRef: overrides.sessionRef }),
    },
    {
      runs: fakeRunPort({
        runs: [[acceptControlMember()], [acceptControlMember()], [acceptControlMember()]],
      }),
      fingerprints: fakeFingerprintIndex([]),
      textCorpus: [],
      receipts: store,
      now: () => 1_700_000_000_000,
    },
  )
  return { receipt, persisted: store.written }
}

describe('the sessionRef write path — the mint', () => {
  it('carries the supplied ref VERBATIM onto the receipt it persists', async () => {
    const { receipt, persisted } = await mint({ sessionRef: 'sess-alpha' })

    expect(receipt.sessionRef).toBe('sess-alpha')
    // Persisted as well as returned: the funnel reads the STORE, so a ref that reached the caller
    // and not the bytes would leave the session window exactly as empty as it was before.
    expect(persisted[0]?.sessionRef).toBe('sess-alpha')
  })

  it('leaves the key ABSENT for a CLI-shaped invocation that supplied none', async () => {
    const { receipt, persisted } = await mint()

    expect('sessionRef' in receipt).toBe(false)
    // Through JSON, because that is what the store writes and what a later reader parses: a
    // present-but-undefined property and an absent one are the same bytes on disk and must be the
    // same answer here, and an empty string would be a THIRD spelling the window would compare.
    expect(JSON.parse(JSON.stringify(persisted[0]))).not.toHaveProperty('sessionRef')
  })

  it('never fabricates a ref for a second evaluation that followed an attributed one', async () => {
    // The defect a module-level default or a cached last-seen value would produce. Mint attributed
    // first, then unattributed, and the second must still carry nothing.
    await mint({ sessionRef: 'sess-alpha', contentDigest: 'digest-1' })
    const { receipt } = await mint({ contentDigest: 'digest-2' })

    expect(receipt.sessionRef).toBeUndefined()
  })
})

describe('the sessionRef write path — the two `.strict()` op inputs', () => {
  it('accepts the key on `authoring.draft.verify`', () => {
    const parsed = AuthoringVerifyDraftInputSchema.safeParse({
      draftPath: 'tests/accept-control.yaml',
      sessionRef: 'sess-alpha',
    })

    expect(parsed.success).toBe(true)
  })

  it('accepts the key on `authoring.draft.write`', () => {
    const parsed = AuthoringDraftWriteInputSchema.safeParse({
      intent: 'confirm the page heading',
      scope: { tier: 'product', key: 'local-form' },
      sessionRef: 'sess-alpha',
    })

    expect(parsed.success).toBe(true)
  })

  it('refuses an EMPTY ref rather than treating it as a second spelling of absence', () => {
    // `.min(1)`, the `gateRun` / `excludedFromOutcomes` carrier idiom: a caller may supply a ref or
    // supply nothing, and may not half-express the intent. An empty string admitted here would be
    // a value the window compares — and matches nothing, forever, silently.
    const parsed = AuthoringVerifyDraftInputSchema.safeParse({
      draftPath: 'tests/accept-control.yaml',
      sessionRef: '',
    })

    expect(parsed.success).toBe(false)
  })
})

// ---- the repaired draft ------------------------------------------------------------------------
//
// A repaired draft's receipt is minted by a SECOND `verifyDraft` call, from inside `repairDraft`.
// A thread that stopped at the loop's own stage-4 call would attribute a first-try draft and
// silently unattribute every draft that needed repairing — the population most worth counting.

const REPAIR_DRAFT: ParsedDraftLike = {
  testId: 't_repair-session',
  filePath: 'tests/.agent-qa-drafts/repair-session.yaml',
  testName: 'Submit the local account form',
  target: 'local-form',
  steps: [
    'Open the local account form',
    'Type "alice" into the Username field',
    'Click the Submit button',
  ],
  contentDigest: 'digest-repair-session',
}

const BEST_PRIOR_MEMBER: MemberFixture = {
  filePath: REPAIR_DRAFT.filePath,
  testName: REPAIR_DRAFT.testName,
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
  const route = routeRepairOrStop(
    {
      filePath: REPAIR_DRAFT.filePath,
      testId: REPAIR_DRAFT.testId,
      testName: REPAIR_DRAFT.testName,
      contentDigest: REPAIR_DRAFT.contentDigest,
    },
    BEST_PRIOR_RUN,
  )
  if (route.kind !== 'repair') throw new Error(`the fixture must route to repair, got ${route.kind}`)
  return route
}

/** A probe in which every step passed — the arm that reaches the final stability gate. */
const PASSING_PROBE: readonly MemberFixture[] = [{
  filePath: REPAIR_DRAFT.filePath,
  testName: REPAIR_DRAFT.testName,
  outcome: 'passed',
  steps: BEST_PRIOR_MEMBER.steps,
}]

/**
 * One repair through the shipped arm, reporting WHAT THE FINAL STABILITY GATE WAS ASKED.
 *
 * The verify seat records its input rather than answering from it, because every claim in this
 * describe is about what repair HANDS ON — a receipt literal would be the fixture asserting
 * against itself.
 */
async function repairCarrying(
  carried: { readonly sessionRef?: string; readonly targetSuitePath?: string },
): Promise<{ readonly outcome: { kind: string }; readonly verifyInputs: readonly unknown[] }> {
  const verifyInputs: unknown[] = []
  const documents = new Map<string, CompletedRunHandoff | undefined>()
  const runs: DraftRunPortLike = {
    async start() {
      documents.set('r_probe-0', runDocument('r_probe-0', PASSING_PROBE))
      return {
        runId: 'r_probe-0',
        scope: { tier: 'product', key: 'local-form' },
        executionContext: 'local-headless',
        buildOrdinal: 1,
        startedAt: 0,
        testCount: 1,
        gateRun: true,
        excludedFromOutcomes: true,
      } as never
    },
    async get(runId: string) {
      return documents.get(runId)
    },
  }
  const patch = JSON.stringify({
    thoughts: 'name the submit control the way the page labels it',
    patches: [{ op: 'replace', path: '/steps/2', value: 'Click the "Save account" button' }],
  })
  const { receipt } = await mint({
    ...(carried.sessionRef === undefined ? {} : { sessionRef: carried.sessionRef }),
    contentDigest: 'digest-repaired',
  })

  const outcome = await repairDraft(repairRoute(), {
    draft: REPAIR_DRAFT,
    handoff: BEST_PRIOR_RUN,
    runs,
    statedValues: [],
    ...(carried.sessionRef === undefined ? {} : { sessionRef: carried.sessionRef }),
    ...(carried.targetSuitePath === undefined
      ? {}
      : { targetSuitePath: carried.targetSuitePath }),
    shelf: {
      runs,
      model: () => Promise.resolve({
        modelId: 'fixture:repair',
        generate: () => Promise.resolve({ text: patch }),
      }),
      write: () => Promise.resolve({ kind: 'unparsable', reason: 'unused' } as DraftStageOutcome),
      applyPatches: (draft: ParsedDraftLike) => Promise.resolve({
        kind: 'staged',
        draft: { ...draft, steps: [...draft.steps.slice(0, 2), 'Click the "Save account" button'] },
      } as DraftStageOutcome),
      verifyDraft: (input: unknown) => {
        verifyInputs.push(input)
        return Promise.resolve(receipt)
      },
    },
  } as never)

  return { outcome, verifyInputs }
}

describe('the sessionRef write path — through repair', () => {
  it('attributes the REPAIRED draft\'s receipt to the session the loop was entered with', async () => {
    const { outcome, verifyInputs } = await repairCarrying({ sessionRef: 'sess-alpha' })

    expect(outcome.kind).toBe('repaired')
    // The FINAL stability gate's input, not a receipt literal: what is under test is that the
    // repair arm hands the session on, and only its call carries the answer.
    expect(verifyInputs).toHaveLength(1)
    expect((verifyInputs[0] as { sessionRef?: string }).sessionRef).toBe('sess-alpha')
  })

  it('carries the JOIN TARGET to the final stability gate too', async () => {
    // The same thread, one field over. A repaired candidate is the SAME draft with patched steps,
    // so it joins the same suite — a target that stopped at stage 4 would leave every repaired
    // draft judged against its own one-test shelf file, which is the arm 394-19 exists to close.
    const { outcome, verifyInputs } = await repairCarrying({
      sessionRef: 'sess-alpha',
      targetSuitePath: 'tests/confirm-the-local-account-form-page-heading.yaml',
    })

    expect(outcome.kind).toBe('repaired')
    expect((verifyInputs[0] as { targetSuitePath?: string }).targetSuitePath)
      .toBe('tests/confirm-the-local-account-form-page-heading.yaml')
  })

  it('leaves the target ABSENT when the invocation named none — the standalone fallback', async () => {
    const { verifyInputs } = await repairCarrying({ sessionRef: 'sess-alpha' })

    expect(verifyInputs[0]).not.toHaveProperty('targetSuitePath')
  })
})
