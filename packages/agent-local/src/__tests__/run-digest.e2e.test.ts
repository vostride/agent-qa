// `runs.digest` over the REAL composition — the projection's behaviour (Phase 391, PROP-04).
//
// What this file measures that a unit test could not: that the digest a person can actually
// reach is composed from the SAME four read paths the rest of the system serves from. Every hop
// goes through `composeLocalAgent()` and `invokeFunction`, so the op is registered, the deps are
// bound at the one root, the gate lets a read through, and the answer is parsed against the
// declared output contract before this file ever sees it.
//
// TWO RUNS, ALWAYS. A single-run fixture is structurally incapable of noticing a run-scoping
// defect — every change belongs to the only run there is, so a filter that did nothing would
// pass — and that exact blind spot shipped a cross-instance attribution bug in phase 388 that
// roughly thirty-five differentials did not see. So the ledger carries applied fixes under two run
// ids, and the absence claim is asserted in BOTH directions.
//
// 2026-09-30, 432-09 (D-04/D-05/D-22/D-25): RE-SPELLED IN PLACE. The digest reads the fixes a run's
// marks applied from that run's own ledger (through the read-only feedback port), and never reads
// the proposals inbox. Proposals are still minted below through the shipped propose ops, against
// real published records, precisely so every cell can assert they appear in NO digest: a digest
// that still listed or counted them would red here, and a sealed legacy tree changes nothing.

import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  ANALYSIS_GET_FUNCTION_ID,
  invokeFunction,
  RUNS_DIGEST_FUNCTION_ID,
} from '@vostride/agent-qa-agent'
import type { JobModelCapability } from '@vostride/agent-qa-agent'
import { publishBundleForTest } from '@vostride/agent-qa-knowledge-local'
import type { BundleStoreConfig } from '@vostride/agent-qa-knowledge-local'
import { HANDOFF_FILE, RUNS_SUBDIR, slugBranch } from '@vostride/agent-qa-runner-local'
import {
  MARK_RECEIPT_SCHEMA_VERSION,
  asRunId,
  CURRENT_HANDOFF_SCHEMA_VERSION,
  MarkReceiptSchema,
  MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
} from '@vostride/agent-qa-schema'
import type {
  AnalysisGetOutput,
  Anchor,
  CompletedRunHandoff,
  FeedbackReadsPort,
  FunctionCaller,
  MarkDisposition,
  MarkReceipt,
  MaskedResolvedConfig,
  RunDigest,
  Verdict,
} from '@vostride/agent-qa-schema'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { composeLocalAgent } from '../composition/compose-local-agent.js'
import type { LocalAgentHost } from '../composition/compose-local-agent.js'
import { filePre432KnowledgeProposal } from './pre-432-knowledge-proposal.js'

const MINT_IDENTITY = (filePath: string): string => filePath

/**
 * The three propose ops' WIRE ids, spelled as a caller spells them (391-03's fixture precedent).
 *
 * Not imported from the agent barrel: that barrel exports an op id only where a production
 * SURFACE has to name one, and a fixture is not one. What is exercised here is the dispatch a
 * caller performs BY NAME, so naming it is the point.
 */
// 432-12: the retired propose verbs, named by the verb a pre-432 record carries.
const FORGET_PROPOSE_ID = 'forget'
const ACCEPT_PROPOSE_ID = 'accept'
const REJECT_PROPOSE_ID = 'reject'

const RUN_A = 'run-391-digest-a'
const RUN_B = 'run-391-digest-b'
/** A third run with nothing attributed to it — the empty arm (edge PROP-04/empty). */
const RUN_EMPTY = 'run-391-digest-empty'

const ANCHOR: Anchor = { t: 'el', role: 'Button', name: 'Checkout' }

const MASKED_CONFIG: MaskedResolvedConfig = {
  schemaVersion: MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
  configPath: '/fixture/agent-qa.config.yaml',
  entries: [],
}

const MODEL: JobModelCapability = {
  modelId: 'fixture:run-digest',
  generate: () => Promise.resolve({ text: 'unused' }),
}

/** A person holding every scope, so nothing below can be refused for the wrong reason. */
const HUMAN: FunctionCaller = {
  surface: 'test',
  origin: 'human',
}

function failingVerdict(perTest: number): Verdict {
  return {
    class: 'app_bug',
    producer: 'deterministic-classifier',
    confidence: 0.9,
    evidence: {
      citedSteps: [0],
      citedAnchors: [],
      citedArtifacts: [],
      rationale: 'the submit control is gone from the checkout DOM',
    },
    memoryMisdirectionRuledOut: true,
    perTest,
  } as Verdict
}

const markIdOf = (ordinal: number) => `mark_${ordinal.toString(16).padStart(12, '0')}`
const KNOWLEDGE_FIX = (recordIds: string[]): MarkDisposition =>
  ({ kind: 'applied', fix: 'fact', change: { kind: 'knowledge', changeId: 'prop_0123456789ab', recordIds } })
const TEST_FIX: MarkDisposition = { kind: 'applied', fix: 'test-edit',
  change: { kind: 'test-file', filePath: 'tests/checkout.yaml', contentDigest: 'b'.repeat(64) } }

/** One ledger receipt as the mark writer stores it, validated against its own schema. */
function receipt(runId: string, ordinal: number, disposition: MarkDisposition, stepIndex?: number): MarkReceipt {
  return MarkReceiptSchema.parse({
    schemaVersion: MARK_RECEIPT_SCHEMA_VERSION, markId: markIdOf(ordinal), runId, runSlug: slugBranch(runId), testIndex: 0,
    ...(stepIndex === undefined ? {} : { stepIndex }),
    kind: disposition.kind === 'confirmed-bug' ? 'confirmed-bug' : 'false-fail', origin: 'user', ordinal,
    markedAt: 1_000 + ordinal, disposition, evidence: { confirmed: 0, overturned: 0 },
  })
}

/** The read-only history port over hand-built ledgers, keyed by run, as a host binds it. */
function ledgerReads(byRun: Record<string, readonly MarkReceipt[]>): FeedbackReadsPort {
  return {
    history: async (runId) => ({ kind: 'history', entries: (byRun[runId] ?? []).map((value) => ({ receipt: value })) }),
  }
}

/**
 * A completed run with TWO failing members, so the analysis floor resolves two verdicts and the
 * cluster fold has something to fold. A zero-failure handoff would have made the verdict-section
 * assertions below vacuous — an empty list deep-equals an empty list.
 */
function fixtureHandoff(runId: string): CompletedRunHandoff {
  return {
    schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION,
    runId: asRunId(runId),
    scope: { tier: 'product', key: 'digest-storefront' },
    buildOrdinal: 3,
    executionContext: 'local-headless',
    aggregateVerdict: 'failed',
    configDigests: { suiteConfigDigest: 'suite-digest', testConfigDigest: 'test-digest' },
    startedAt: 1,
    endedAt: 2,
    tests: [
      {
        testId: 'TST-101',
        testName: 'checks out',
        filePath: 'tests/checkout.yaml',
        testIndex: 0,
        outcome: 'failed',
        steps: [],
        rootCause: failingVerdict(0),
      },
      {
        testId: 'TST-102',
        testName: 'checks out with a coupon',
        filePath: 'tests/coupon.yaml',
        testIndex: 1,
        outcome: 'failed',
        steps: [],
        rootCause: failingVerdict(1),
      },
    ],
  } as unknown as CompletedRunHandoff
}

describe('the per-run digest, over the composed host (PROP-04 / D-16 / D-18)', () => {
  let root: string
  let agentQaRoot: string
  let knowledgeRoot: string
  let host: LocalAgentHost
  const hosts: LocalAgentHost[] = []
  let ordinal = 10

  // Two runs' ledgers: A applied a knowledge fix and a test edit around a confirmed bug; B one fix.
  const LEDGERS = {
    [RUN_A]: [
      receipt(RUN_A, 1, KNOWLEDGE_FIX(['mem_a1', 'mem_a2'])),
      receipt(RUN_A, 2, { kind: 'confirmed-bug', confirmedRecords: 1 }),
      receipt(RUN_A, 3, TEST_FIX, 0),
    ],
    [RUN_B]: [receipt(RUN_B, 1, KNOWLEDGE_FIX(['mem_b1']))],
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'run-digest-e2e-'))
    agentQaRoot = join(root, '.agent-qa')
    knowledgeRoot = join(root, 'agent-qa-knowledge')
    mkdirSync(agentQaRoot, { recursive: true })
    for (const runId of [RUN_A, RUN_B, RUN_EMPTY]) writeHandoff(runId)
    host = compose(ledgerReads(LEDGERS))
    ordinal = 10
  })

  afterEach(async () => {
    for (const composed of hosts.splice(0)) await composed.close()
    rmSync(root, { recursive: true, force: true })
  })

  function writeHandoff(runId: string): void {
    const runDir = join(agentQaRoot, RUNS_SUBDIR, slugBranch(runId))
    mkdirSync(runDir, { recursive: true })
    writeFileSync(join(runDir, HANDOFF_FILE), `${JSON.stringify(fixtureHandoff(runId))}\n`, 'utf8')
  }

  function compose(feedbackReads?: FeedbackReadsPort): LocalAgentHost {
    const composed = composeLocalAgent({
      mask: (text) => text,
      mintQuarantineIdentityPath: MINT_IDENTITY,
      agentQaRoot,
      config: { getMasked: () => Promise.resolve(MASKED_CONFIG) },
      knowledgeRoot: () => knowledgeRoot,
      model: () => MODEL,
      ...(feedbackReads === undefined ? {} : { feedbackReads }),
    })
    hosts.push(composed)
    return composed
  }

  function storeConfig(): BundleStoreConfig {
    return {
      knowledgeRoot,
      productKey: 'Digest E2E Product',
    }
  }

  /** A real published record, so a proposal below has something real to be about. */
  function publish(summary: string): string {
    ordinal += 1
    const outcome = publishBundleForTest(storeConfig(), {
      draft: {
        kind: 'fact',
        subtype: 'selector',
        anchors: [ANCHOR],
        scope: { tier: 'product', key: 'digest-e2e' },
        summary,
        body: `Selecting ${summary} advances to the payment page.`,
        distilledEvidenceRef: { id: `digest-${summary}`, sha: 'a'.repeat(64) },
        originStage: 'run-curation',
      },
      discriminant: {
        kind: 'fact',
        subtype: 'selector',
        elementRef: { role: 'Button', name: summary },
      },
      originClass: 'agent-verified',
      createdAtOrdinal: ordinal,
      screenStates: [],
      initialEvents: [],
      relations: [],
      provenance: { mode: 'run-linked', runId: 'digest-e2e', testId: 't', stepIndex: 0 },
      artifacts: [],
    })
    if (outcome.kind !== 'published') throw new Error(`fixture publish failed: ${outcome.kind}`)
    return outcome.id
  }

  /**
   * Mint ONE proposal attributed to a run, through the PRODUCTION path.
   *
   * The op's input contract carries the caller's run, and that is how production mints one.
   */
  async function mintForRun(
    runId: string | undefined,
    summary: string,
    proposeId: 'accept' | 'reject' | 'forget' = FORGET_PROPOSE_ID,
    extraInput: { reason?: string } = {},
  ): Promise<{ proposalId: string; recordId: string }> {
    const recordId = publish(summary)
    // 432-12: nothing files a knowledge proposal any more; this is a pre-432 record on disk,
    // attributed to the run as the retired propose ops attributed it.
    const proposalId = await filePre432KnowledgeProposal({
      agentQaRoot, knowledgeRoot, verb: proposeId, target: { grain: 'record', recordId },
      ...(extraInput.reason === undefined ? {} : { reason: extraInput.reason }),
      ...(runId === undefined ? {} : { runId }),
    })
    return { proposalId, recordId }
  }

  async function proposeForRun(runId: string | undefined, summary: string): Promise<string> {
    return (await mintForRun(runId, summary)).proposalId
  }

  async function digest(runId: string, on: LocalAgentHost = host): Promise<RunDigest> {
    return (await invokeFunction(
      on.registry,
      RUNS_DIGEST_FUNCTION_ID,
      { runId },
      HUMAN,
    )) as RunDigest
  }

  // RE-SPELLED 432-09 from 'lists exactly the proposals attributed to the run, and the OTHER run's
  // in its own digest': the run's section is now the fixes its marks applied.
  it('lists exactly the fixes the run\'s marks applied, and the OTHER run\'s in its own digest',
    async () => {
      const minted = await proposeForRun(RUN_A, 'checkout button')

      const digestA = await digest(RUN_A)
      const digestB = await digest(RUN_B)

      // Direction one: A's digest carries exactly A's two applied fixes, in ledger order.
      expect(digestA.markChanges).toEqual([
        { markId: markIdOf(1), ordinal: 1, fix: 'fact', change: { kind: 'knowledge', changeId: 'prop_0123456789ab', recordIds: ['mem_a1', 'mem_a2'] } },
        { markId: markIdOf(3), ordinal: 3, fix: 'test-edit', change: { kind: 'test-file', filePath: 'tests/checkout.yaml', contentDigest: 'b'.repeat(64) } },
      ])
      // Direction two: B's one fix is in B's digest and not in A's, from the same port.
      expect(digestB.markChanges?.map((row) => row.change)).toEqual([{ kind: 'knowledge', changeId: 'prop_0123456789ab', recordIds: ['mem_b1'] }])
      expect(JSON.stringify(digestA)).not.toContain('mem_b1')
      // …and the rendered lines say the same thing the sections do.
      expect(digestA.lines).toEqual(expect.arrayContaining([
        'marks — 2 changes applied:',
        `  ${markIdOf(1)}  fact: 2 records changed`,
        `  ${markIdOf(3)}  test-edit: wrote tests/checkout.yaml`,
      ]))
      expect(digestB.lines).toContain('marks — 1 change applied:')
      // A minted proposal is in NO digest: nothing is listed, counted or owed a decision.
      for (const rendered of [JSON.stringify(digestA), JSON.stringify(digestB)]) {
        expect(rendered).not.toContain(minted)
        expect(rendered).not.toMatch(/proposal/i)
      }
    })

  it('renders a run whose marks changed nothing as "no changes applied", not as an error (edge PROP-04/empty)',
    async () => {
      // Proposals exist in the store, both belonging to another run: they change nothing here.
      await proposeForRun(RUN_A, 'checkout button')
      await proposeForRun(RUN_A, 'payment button')

      const empty = await digest(RUN_EMPTY)

      expect(empty.runId).toBe(RUN_EMPTY)
      expect(empty.markChanges).toEqual([])
      expect(empty.candidates).toEqual({ curated: 0, deprecated: 0 })
      expect(empty.quarantine).toEqual({ quarantined: 0, expired: 0, refs: [] })
      expect(empty.lines).toContain('marks — no changes applied')
    })

  it('lists no proposal from any of the three propose ops under any run (432-09 D-05)',
    async () => {
      const forgotten = (await mintForRun(RUN_A, 'checkout button', FORGET_PROPOSE_ID)).proposalId
      const accepted = (await mintForRun(RUN_A, 'payment button', ACCEPT_PROPOSE_ID)).proposalId
      const rejected = (await mintForRun(
        RUN_A, 'coupon field', REJECT_PROPOSE_ID, { reason: 'superseded' },
      )).proposalId
      const foreign = (await mintForRun(RUN_B, 'shipping field', ACCEPT_PROPOSE_ID)).proposalId

      for (const runId of [RUN_A, RUN_B, RUN_EMPTY]) {
        const rendered = JSON.stringify(await digest(runId))
        for (const id of [forgotten, accepted, rejected, foreign]) expect(rendered, runId).not.toContain(id)
      }
      expect((await digest(RUN_A)).markChanges?.map((row) => row.markId)).toEqual([markIdOf(1), markIdOf(3)])
    })

  it('says the ledger was NOT READ, rather than "no changes", on a host that binds no feedback reads',
    async () => {
      // Without the read port the digest cannot measure anything about the ledger, and an
      // affirmative "no changes applied" would be a claim it cannot make.
      await proposeForRun(undefined, 'legacy button')
      const unbound = compose()

      const digestA = await digest(RUN_A, unbound)

      expect(digestA).not.toHaveProperty('markChanges')
      expect(digestA.lines).toContain('marks — ledger not read here')
      expect(digestA.lines.some((line) => line.includes('no changes applied'))).toBe(false)
    })

  it('still says "no changes applied" on a read ledger with nothing applied, where the claim is measurable and true',
    async () => {
      const confirmedOnly = compose(ledgerReads({ [RUN_EMPTY]: [receipt(RUN_EMPTY, 1, { kind: 'confirmed-bug', confirmedRecords: 0 })] }))
      const empty = await digest(RUN_EMPTY, confirmedOnly)

      expect(empty.markChanges).toEqual([])
      expect(empty.lines).toContain('marks — no changes applied')
    })

  it('C432-READS-INBOX-UNREAD: a decided, pending or sealed legacy proposal tree changes nothing in any digest',
    async () => {
      const declined = await proposeForRun(RUN_A, 'checkout button')
      await proposeForRun(RUN_A, 'payment button')
      // 2026-10-01 (432-17): `proposals.reject` is deleted, so the decided record is planted as the
      // bytes the retired reject left: the same wrapped record with its status moved to `rejected`.
      const proposals = join(agentQaRoot, 'proposals')
      const declinedPath = join(proposals, `${declined}.json`)
      const record = JSON.parse(readFileSync(declinedPath, 'utf8')) as {
        payload: Record<string, unknown>
      }
      record.payload = { ...record.payload, status: 'rejected', reason: 'not this one', decidedAt: 1_700_000_000_001 }
      writeFileSync(declinedPath, `${JSON.stringify(record, undefined, 2)}\n`, 'utf8')
      const expected = await digest(RUN_A)

      const before = readdirSync(proposals).sort()
      chmodSync(proposals, 0o000)
      try {
        expect(await digest(RUN_A)).toEqual(expected)
        expect(await digest(RUN_B)).toMatchObject({ markChanges: [{ markId: markIdOf(1) }] })
      } finally { chmodSync(proposals, 0o700) }
      expect(readdirSync(proposals).sort()).toEqual(before)
    })

  it('counts no proposal, attributed or not (432-09 D-25)',
    async () => {
      await proposeForRun(undefined, 'legacy button')
      await proposeForRun(RUN_A, 'checkout button')

      for (const runId of [RUN_A, RUN_B]) {
        const value = await digest(runId)
        expect(value).not.toHaveProperty('pendingProposalCount')
        expect(value).not.toHaveProperty('proposalsMintedThisRun')
        expect(value).not.toHaveProperty('runAttributionAvailable')
      }
    })

  it('orders the applied fixes by ledger ordinal, stably across renders (edge PROP-04/ordering)',
    async () => {
      const once = await digest(RUN_A)
      const twice = await digest(RUN_A)
      // Stable across renders — a table a person is reading must not reshuffle under them.
      expect(twice.markChanges).toEqual(once.markChanges)
      expect(once.markChanges?.map((row) => row.ordinal)).toEqual([1, 3])
    })

  it('carries the analysis op\'s OWN cluster views, sentence bytes included (D-18 / 389 D-05)',
    async () => {
      await proposeForRun(RUN_A, 'checkout button')

      const analysis = (await invokeFunction(
        host.registry,
        ANALYSIS_GET_FUNCTION_ID,
        { runId: RUN_A },
        HUMAN,
      )) as AnalysisGetOutput
      const digestA = await digest(RUN_A)

      // NON-VACUITY FIRST. Two failing members resolve through the D-10 accessor and the floor
      // renderer, so there is something to compare; without this line an empty-equals-empty
      // pass would certify nothing.
      expect(analysis.clusters.length).toBeGreaterThan(0)
      expect(analysis.clusters.every((cluster) => cluster.representative.sentence !== ''))
        .toBe(true)

      // The bytes are compared against the RENDERER'S ACTUAL OUTPUT for this run — obtained by
      // invoking the one producer through the same registry — never against a sentence this
      // file re-spelled. A check that restates a constant inside its own package binds nothing
      // to reality; this one goes red the moment the digest composes anything of its own.
      expect(digestA.verdictClusters).toEqual(analysis.clusters)
      for (const cluster of analysis.clusters) {
        expect(digestA.lines.join('\n')).toContain(cluster.representative.sentence)
      }
    })

  it('composes the chain section from the chip vocabulary, and persists NOTHING (D-16)',
    async () => {
      await proposeForRun(RUN_A, 'checkout button')
      const before = readdirSync(join(agentQaRoot, 'proposals')).sort()

      const digestA = await digest(RUN_A)

      // Nothing was enqueued for this run, so the chips read exactly what a chain nobody
      // started reads — the `runs.postprocessing` words, not a synonym.
      expect(digestA.chain).toEqual({
        analysis: 'pending',
        curation: 'pending',
      })
      expect(digestA.chain.outcome).toBeUndefined()
      expect(digestA.lines.some((line) =>
        line === 'chain — analysis: pending · curation: pending')).toBe(true)

      // The projection wrote nothing. Rendering the same digest twice cannot change the store,
      // which is the whole of "nothing new persisted, nothing to drift".
      await digest(RUN_A)
      expect(readdirSync(join(agentQaRoot, 'proposals')).sort()).toEqual(before)
    })

  it('refuses a run this host has never recorded, rather than answering a page of zeros',
    async () => {
      await expect(digest('run-that-never-happened')).rejects.toMatchObject({
        name: 'RunNotFoundError',
      })
    })

  // RE-SPELLED 432-09 from 'carries refs and counts and NO receipt bytes, on a forget proposal that
  // has them (D-18)': the refs are now an applied fix's record ids and written path.
  it('carries refs and counts and NO record content for an applied fix (D-18)',
    async () => {
      const { recordId } = await mintForRun(RUN_A, 'checkout button')
      const withContent = compose(ledgerReads({ [RUN_A]: [receipt(RUN_A, 1, KNOWLEDGE_FIX([recordId]))] }))
      const digestA = await digest(RUN_A, withContent)

      expect(digestA.markChanges).toEqual([{ markId: markIdOf(1), ordinal: 1, fix: 'fact',
        change: { kind: 'knowledge', changeId: 'prop_0123456789ab', recordIds: [recordId] } }])
      expect(digestA.lines).toContain(`  ${markIdOf(1)}  fact: 1 record changed`)
      const rendered = JSON.stringify(digestA)
      // The record's body and provenance never cross: a digest names the id, never the content.
      expect(rendered).not.toContain('advances to the payment page')
      expect(rendered).not.toContain('digest-e2e')
    })
})
