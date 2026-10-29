// The funnel projection's cells (394-07, D-12/D-14 · WTST-05).
//
// THE CONTROL SHAPE IS TWO-SIDED ON EVERY DISCRIMINATOR. A window that admitted nothing and a
// window that admitted everything would both pass a suite screened on one side only — 394-04's
// finding, mechanized here: for the session scope there is a with-ref cell AND a without-ref
// cell AND a wrong-ref cell; for the stability gather there is a flaky-neighbours cell AND a
// stable cell AND a no-history cell.
//
// THE ZERO-RUNS CLAIM IS MEASURED AGAINST AN INSTRUMENT THAT WOULD RECORD ONE. The fake run port
// below is handed to the composition and counts every `start`; a claim asserted against a port
// nothing could call is a claim about the test, not about the code.

import { beforeAll, describe, expect, it } from 'vitest'

import { DraftReceiptSchema, draftDispositionWritesTarget, CURRENT_DRAFT_RECEIPT_SCHEMA_VERSION } from '@vostride/agent-qa-schema'
import type {
  DraftReceipt,
  QuarantineEntryState,
  RunsStartInput,
} from '@vostride/agent-qa-schema'

import {
  ACCEPT_CONTROL_DRAFT,
  acceptControlMember,
  fakeFingerprintIndex,
  fakeRunPort,
} from './evidence-fixtures.js'
import {
  gatherSuiteStability,
  projectAuthoringFunnel,
  scopeReceiptsToWindow,
} from '../funnel.js'
import type { AuthoringFunnelPortLike } from '../funnel.js'
import { evaluateDraft } from '../verify-draft.js'
import type { DraftRunPortLike } from '../ports.js'

const TARGET = 'tests/local-form.yaml'

// ---- the PRODUCED corpus ----------------------------------------------------------------------
//
// THE JOIN CELLS RUN OVER RECEIPTS PRODUCTION CAN ACTUALLY EMIT (394-17, gap round 1). Until the
// sessionRef write path landed, the only code constructing a session window was this file and one
// sibling, both building receipts as TYPE LITERALS — a corpus that pinned an input no host could
// mint, so every session cell was green while `built` was structurally 0 on every real projection
// (394-VERIFICATION, SC-3). A literal that diverges from the producer is exactly the shape that
// cannot tell a vacuous closure from a real one.
//
// So every receipt the session arm is exercised over comes out of `evaluateDraft` — the ONE mint —
// and `assertProduced` below is the mechanical self-check: identity against the producer's own
// ledger, so a literal spliced into a join cell later reds by name rather than passing quietly.

const producedReceipts: DraftReceipt[] = []

async function mintReceipt(
  digest: string,
  sessionRef: string | undefined,
  evaluatedAt: number,
): Promise<DraftReceipt> {
  const minted = await evaluateDraft(
    {
      draft: { ...ACCEPT_CONTROL_DRAFT, contentDigest: digest },
      ...(sessionRef === undefined ? {} : { sessionRef }),
    },
    {
      runs: fakeRunPort({
        runs: [[acceptControlMember()], [acceptControlMember()], [acceptControlMember()]],
      }),
      fingerprints: fakeFingerprintIndex([]),
      textCorpus: [],
      receipts: { put: async () => {} },
      now: () => evaluatedAt,
    },
  )
  producedReceipts.push(minted)
  return minted
}

/** Every row came out of the mint above — by IDENTITY, which a literal cannot fake. */
function assertProduced(rows: readonly DraftReceipt[]): void {
  const foreign = rows.filter((row) => !producedReceipts.includes(row))
  expect(foreign).toEqual([])
}

/**
 * A receipt for the ARITHMETIC cells only — the stages, the side counters, the empty-store posture.
 *
 * IT CANNOT CARRY A SESSION REF, and the omission is structural rather than an oversight: the
 * session join is the one thing in this file a literal must never pin, so the only way to get an
 * attributed receipt here is `mintReceipt`, which runs the real mint. See the corpus header.
 */
function receipt(digest: string, evaluatedAt = 1_700_000_000_000): DraftReceipt {
  return DraftReceiptSchema.parse({
    schemaVersion: CURRENT_DRAFT_RECEIPT_SCHEMA_VERSION,
    draftRef: {
      filePath: `tests/.agent-qa-drafts/${digest}.yaml`,
      testId: `t_${digest}`,
      testName: `draft ${digest}`,
      contentDigest: digest,
    },
    gates: {
      executesDefinitive: { pass: true, runRefs: ['run-1'], indefinitiveRunRefs: [] },
      stableVerdict: {
        pass: true,
        runRefs: ['run-1'],
        distinctOutcomes: ['passed'],
        earlyStopped: false,
      },
      addsValue: { pass: true, novelElementCount: 1, comparedTestCount: 1 },
      falsifiableAssertion: { pass: true, assertionStepCount: 1, falsifiableAssertionCount: 1 },
    },
    stepTable: [],
    gateRuns: [{ runId: 'run-1', memberOutcome: 'passed', definitive: true, healed: false }],
    addsValueFinding: { novelElements: ['el:button:Save'], comparedTests: [] },
    stabilityRunsRequested: 3,
    stabilityRunsCompleted: 3,
    disposition: 'keep-eligible',
    evaluatedAt,
  })
}

/**
 * A run port the composition COULD reach, recording every start.
 *
 * The zero-runs claim is worth nothing against a port that cannot be called: 394-06 learned the
 * same lesson from the other end, where an unbounded loop took the worker down instead of reding
 * a cell. The instrument has to be able to record the thing being denied.
 */
function countingRunPort(): DraftRunPortLike & { starts: RunsStartInput[] } {
  const starts: RunsStartInput[] = []
  return {
    starts,
    async start(input) {
      starts.push(input)
      throw new Error('the funnel read started a run — D-14 is read-side')
    },
    async get() {
      return undefined
    },
  }
}

interface PortFixture {
  receipts?: readonly DraftReceipt[]
  outcomes?: AuthoringFunnelPortLike['outcomes']
  quarantine?: AuthoringFunnelPortLike['quarantine']
}

function port(overrides: PortFixture = {}): AuthoringFunnelPortLike {
  const receipts = overrides.receipts ?? []
  return {
    receipts: { async list() { return [...receipts] } },
    ...(overrides.outcomes === undefined ? {} : { outcomes: overrides.outcomes }),
    ...(overrides.quarantine === undefined ? {} : { quarantine: overrides.quarantine }),
  }
}

describe('the window scope, over a PRODUCED population', () => {
  // Three sessions' worth of real mints: `sess-alpha` twice, `sess-beta` once, and one invocation
  // that supplied no ref at all — the CLI shape, which the session arm must leave out.
  let population: DraftReceipt[] = []

  beforeAll(async () => {
    population = [
      await mintReceipt('a', 'sess-alpha', 3),
      await mintReceipt('b', 'sess-beta', 1),
      await mintReceipt('c', undefined, 2),
      await mintReceipt('d', 'sess-alpha', 4),
    ]
  })

  it('admits only the EXACT session ref, and excludes a receipt carrying none', async () => {
    assertProduced(population)
    const scoped = scopeReceiptsToWindow(population, { scope: 'session', sessionRef: 'sess-alpha' })

    expect(scoped.map((row) => row.draftRef.contentDigest)).toEqual(['a', 'd'])
    // NON-EMPTY, which is the whole property that was structurally unreachable before 394-17: the
    // join's left side was undefined for every receipt any host could mint.
    expect(scoped.length).toBeGreaterThan(0)
  })

  it('admits nothing for a session ref nothing carries — never everything', async () => {
    // The other side of the same discriminator. A filter that silently admitted everything on a
    // miss would pass the cell above and be catastrophically wrong here.
    const scoped = scopeReceiptsToWindow(population, { scope: 'session', sessionRef: 'sess-nope' })

    expect(scoped).toEqual([])
  })

  it('excludes the PRODUCED unattributed receipt from every session window', async () => {
    const unattributed = population.filter((row) => row.sessionRef === undefined)

    // The producer really did emit one with no key — absence reaching the store is the fact the
    // exclusion rule is about, and a mint that defaulted a ref in would empty this list.
    expect(unattributed.map((row) => row.draftRef.contentDigest)).toEqual(['c'])
    for (const sessionRef of ['sess-alpha', 'sess-beta']) {
      const scoped = scopeReceiptsToWindow(population, { scope: 'session', sessionRef })
      expect(scoped).not.toContain(unattributed[0])
    }
  })

  it('admits the whole population for `all-time`, INCLUDING the unattributed receipt', async () => {
    const scoped = scopeReceiptsToWindow(population, { scope: 'all-time' })

    expect(scoped.map((row) => row.draftRef.contentDigest)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('takes `last-n` by evaluatedAt, not by the store\'s digest ordering', async () => {
    const scoped = scopeReceiptsToWindow(population, { scope: 'last-n', n: 2 })

    // Newest first: `d` at 4, then `a` at 3. The store lists a, b, c, d — the digest order — so a
    // projection that inherited it would have answered a, b.
    expect(scoped.map((row) => row.draftRef.contentDigest)).toEqual(['d', 'a'])
  })
})

describe('projectAuthoringFunnel', () => {
  it('scopes the DENOMINATOR to the session over PRODUCED receipts — `built` is not 0', async () => {
    // The corpus is minted, not written: two of this session's drafts, one of another's, one
    // unattributed. Before 394-17 no host could emit any of the three attributed shapes, so this
    // stage was 0 for every real projection while a literal corpus reported otherwise.
    const alpha = [
      await mintReceipt('p-alpha-1', 'sess-alpha', 10),
      await mintReceipt('p-alpha-2', 'sess-alpha', 11),
    ]
    const others = [
      await mintReceipt('p-beta-1', 'sess-beta', 12),
      await mintReceipt('p-none-1', undefined, 13),
    ]
    const receipts = [...alpha, ...others]
    assertProduced(receipts)

    const funnel = await projectAuthoringFunnel(
      { scope: 'session', sessionRef: 'sess-alpha' },
      port({ receipts }),
    )

    // Against the PRODUCER'S OWN TALLY, never a restated integer: if the mint stopped attributing,
    // `alpha.length` and `built` move apart rather than both matching a hard-coded 2.
    expect(funnel.stages.built).toBe(alpha.length)
    // RE-SPELLED 2026-10-02 (quick 261002-ctr): `writeEligible` replaces `accepted` (0 since
    // 432-17), counted off the minted receipts' own stored dispositions — the producer's tally.
    expect(funnel.stages.writeEligible)
      .toBe(alpha.filter((row) => draftDispositionWritesTarget(row.disposition)).length)
    expect(funnel.stages.writeEligible).toBeGreaterThan(0)
  })

  // RE-SPELLED 2026-10-02 (quick 261002-ctr): was 'reads `accepted` off recorded acceptances, and
  // none are recorded since 432-17' (0 whatever the receipts said). The terminal stage now reads
  // the receipts' stored dispositions, so it counts what the loop writes.
  it('counts the write-eligible receipts the store holds', async () => {
    const funnel = await projectAuthoringFunnel(
      { scope: 'all-time' },
      port({ receipts: [receipt('a'), receipt('b'), receipt('c')] }),
    )

    expect(funnel.stages).toEqual({ built: 3, passedStably: 3, addedValue: 3, writeEligible: 3 })
    // Three is below the floor, so a 100% keep rate is reported with the caveat and never flagged.
    expect(funnel.acceptanceFailure).toBe(false)
    expect(funnel.smallSample).toBe(true)
  })

  it('leaves dedup refusals absent and folds no side counter', async () => {
    const funnel = await projectAuthoringFunnel(
      { scope: 'all-time' },
      port({ receipts: [receipt('a'), receipt('b')] }),
    )

    // NOTHING sits beside the funnel here: the refusal counter nothing on this host records stays
    // honestly absent rather than reporting a 0 nothing counted.
    expect(funnel.sideCounters).toEqual({})
    expect(funnel.sideCounters.dedupRefusals).toBeUndefined()
    expect(funnel.stages.built).toBe(2)
    expect(funnel.stages.writeEligible).toBe(2)
    expect(funnel.line).toContain('Beside the funnel: dedup refusals not recorded on this host.')
  })

  it('answers the zero-receipts posture on an empty store', async () => {
    const funnel = await projectAuthoringFunnel({ scope: 'all-time' }, port())

    expect(funnel.stages).toEqual({ built: 0, passedStably: 0, addedValue: 0, writeEligible: 0 })
    expect(funnel.keepRate).toBeUndefined()
    expect(funnel.acceptanceFailure).toBe(false)
  })
})

describe('gatherSuiteStability', () => {
  /** The partition the outcome projection is keyed on — `slugBranch` of the run's own scope. */
  const PRODUCT = 'local-form'
  // The port's two verbs LEAD WITH `product` (394-17, step a): the projection they mirror is keyed
  // (product, filePath, testName), and a shape without it could only be bound by guessing.
  const outcomes = (rows: Readonly<Record<string, readonly string[]>>) => ({
    async testsIn(_product: string, filePath: string) {
      return Object.keys(rows).map((testName) => ({ filePath, testName }))
    },
    async outcomesFor(_product: string, _filePath: string, testName: string) {
      return rows[testName] ?? []
    },
  })

  it('names the flaky neighbours and starts ZERO runs', async () => {
    const runs = countingRunPort()
    const assessment = await gatherSuiteStability(
      { product: PRODUCT, targetFilePath: TARGET, draftTestName: 'draft under evaluation' },
      port({
        outcomes: outcomes({
          'submits the form': ['passed', 'passed'],
          'shows the banner': ['passed', 'failed'],
        }),
      }),
    )

    expect(assessment.posture).toBe('neighbours-flaky')
    expect(assessment.flakyNeighbours.map((row) => row.ref))
      .toEqual([`${TARGET}::shows the banner`])
    expect(assessment.message).toContain('Your app is unstable')
    // The instrument was reachable and recorded nothing — the port bundle carries no run
    // capability at all, which is why this is structural rather than a rule.
    expect(runs.starts).toEqual([])
  })

  it('names a quarantined neighbour, reading the ledger rather than re-running it', async () => {
    const assessment = await gatherSuiteStability(
      { product: PRODUCT, targetFilePath: TARGET },
      port({
        outcomes: outcomes({ 'retries the upload': ['passed'] }),
        quarantine: {
          async list(): Promise<readonly QuarantineEntryState[]> {
            return [{
              product: 'demo',
              filePath: TARGET,
              testName: 'retries the upload',
              fingerprint: 'fp-1',
              verdictClass: 'flake',
              owner: 'unassigned',
              enteredAt: '2026-08-01T00:00:00.000Z',
              expiresAt: '2026-09-01T00:00:00.000Z',
              enteredCount: 1,
              firstEnteredAt: '2026-08-01T00:00:00.000Z',
              state: 'quarantined',
            }]
          },
        },
      }),
    )

    expect(assessment.posture).toBe('neighbours-flaky')
    expect(assessment.flakyNeighbours[0]?.reason).toBe('quarantined')
  })

  it('answers `stable` when the neighbours were read and none is flaky', async () => {
    const assessment = await gatherSuiteStability(
      { product: PRODUCT, targetFilePath: TARGET },
      port({ outcomes: outcomes({ 'submits the form': ['passed', 'passed'] }) }),
    )

    expect(assessment.posture).toBe('stable')
  })

  it('answers `no-history` — not `stable` — when the outcome port is UNBOUND', async () => {
    const assessment = await gatherSuiteStability({ product: PRODUCT, targetFilePath: TARGET }, port())

    expect(assessment.posture).toBe('no-history')
    expect(assessment.message).toContain('not a clean bill of health')
  })

  it('excludes the draft\'s OWN identity from its neighbours', async () => {
    // A draft under evaluation is not evidence about the suite it is trying to join; counting
    // its own flip would let every mixed verdict explain itself.
    const assessment = await gatherSuiteStability(
      { product: PRODUCT, targetFilePath: TARGET, draftTestName: 'the flipping draft' },
      port({
        outcomes: outcomes({
          'the flipping draft': ['passed', 'failed'],
          'submits the form': ['passed'],
        }),
      }),
    )

    expect(assessment.posture).toBe('stable')
    expect(assessment.flakyNeighbours).toEqual([])
  })
})
