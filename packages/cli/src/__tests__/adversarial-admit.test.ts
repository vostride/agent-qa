// 422-03-T2 at the public surface — what an admission OWES the operator afterwards.
//
// Admitting an adversarial batch moves the committed corpus digest. Every standing Gate-1 and
// Gate-2 receipt is pinned to a corpus digest, and the noise floor and any designated baseline
// were measured against one. So the moment the digest moves, some of those are stale — and the
// operator cannot act on that unless the verb says WHICH, computed from the digests that
// actually moved and the receipts actually on disk.
//
// Two things this file insists on. First, the disclosure is DERIVED, never assumed: a run that
// moves nothing names no stale receipt, a Gate-3 receipt carries no corpus digest and is never
// invented stale, and a receipt pinned to some other digest is not swept in. Second, the verb
// REPORTS and does not repair: no floor and no baseline is rewritten by an admission, because
// silently re-pointing a measurement at a corpus the operator just changed destroys the only
// evidence that the change mattered.
//
// The seed cap is here too, at the surface it is actually set from: `--max-seeds` beats
// `eval.adversarial.maxSeedsPerRefresh`, which beats the recorded default, and every refresh
// says which of the three it used.
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as model from '@vostride/agent-qa-model'
import {
  computeBriefDigest,
  type LosslessServedBriefProofV1,
  SERVED_BRIEF_PROOF_SCHEMA_VERSION,
} from '@vostride/agent-qa-schema'
import {
  ADVERSARIAL_DEFAULT_MAX_SEEDS_PER_REFRESH,
  extractRunCassettes,
  projectCorpusEntry,
  projectSilverLabelRecord,
  type LeafCassette,
  type SeedingPlan,
} from '@vostride/agent-qa-eval'
import { FsRunArtifactSource, seedCommittedCorpus } from '@vostride/agent-qa-eval-local'
import { markFixture } from '../gates/__tests__/feedback-fixture.js'
import {
  adversarialHostOptions,
  resolveEvalSession,
  runAdversarialVerb,
} from '../eval-session-composition.js'

const NO_DECLARED_SECRETS = (text: string) => text
const roots: string[] = []

beforeEach(() => {
  // The whole adversarial path is offline; a provider call here would be a defect, not a cost.
  vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
    throw new Error('provider access forbidden')
  })
  vi.spyOn(model, 'createModel').mockImplementation(() => {
    throw new Error('model creation forbidden')
  })
})

afterEach(() => {
  expect(globalThis.fetch).not.toHaveBeenCalled()
  expect(model.createModel).not.toHaveBeenCalled()
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function proof(): LosslessServedBriefProofV1 {
  return {
    schemaVersion: SERVED_BRIEF_PROOF_SCHEMA_VERSION,
    completeness: 'lossless',
    recordCap: 8,
    combinedBudget: 2048,
    admissionEvents: [],
    promptTurns: [
      {
        ordinal: 0,
        turnOrdinal: 0,
        runDate: '2026-09-11',
        policyL0: 'policy',
        learnedL1: 'learned one',
        learnedL2: 'learned two',
        contextTier: 'context',
        volatileTier: 'volatile',
        policyDigest: '1'.repeat(64),
        contextTierDigest: '2'.repeat(64),
        volatileTierDigest: '3'.repeat(64),
      },
    ],
  }
}

function fixture() {
  const f = markFixture()
  roots.push(f.root)
  writeFileSync(join(f.root, '.env.secrets.local'), '')
  const member = f.handoff.tests[0]!
  const brief = member.steps[0]!.servedBrief
  brief.proof = proof()
  brief.briefDigest = computeBriefDigest(brief)
  f.save()

  const committedRoot = join(f.root, 'agent-qa-eval')
  const artifacts = new FsRunArtifactSource({ root: f.agentQaRoot, runId: f.handoff.runId })
  const extraction = extractRunCassettes({ handoff: f.handoff, artifacts })
  const extracted = extraction.cassettes.find(row => row.cassette.granularity === 'leaf')!
  const seed = extracted.cassette as LeafCassette
  const plan: SeedingPlan = {
    product: 'default',
    runId: f.handoff.runId,
    runSlug: member.testId,
    cases: [
      {
        cassetteId: seed.id,
        labelRecord: projectSilverLabelRecord({ cassette: seed, runId: f.handoff.runId }),
        corpusEntry: projectCorpusEntry({
          cassette: seed,
          product: 'default',
          runId: f.handoff.runId,
          assignment: { split: 'natural' },
        }),
      },
    ],
    pairSkips: [],
    silverExclusions: [],
    pairCounts: { total: 0, sameState: 0, differingState: 0 },
    proceduresExcludedCount: 0,
  }
  expect(
    seedCommittedCorpus({
      plan,
      cassettes: [{ cassette: seed, blobs: extracted.blobs }],
      committedRoot,
      mask: NO_DECLARED_SECRETS,
    }).refusals,
  ).toEqual([])
  return { ...f, committedRoot, seed }
}

async function session(f: ReturnType<typeof fixture>) {
  return resolveEvalSession({ configPath: f.configPath, keyOnly: true })
}

/** Every regular file under `root`, content-addressed — the "did anything move" oracle. */
function tree(root: string): Record<string, string> {
  if (!existsSync(root)) return {}
  return Object.fromEntries(
    readdirSync(root, { recursive: true, withFileTypes: true })
      .filter(entry => entry.isFile())
      .map(entry => {
        const path = join(entry.parentPath, entry.name)
        return [relative(root, path), readFileSync(path).toString('base64')]
      }),
  )
}

/** Standing receipts as the local curation capability returns them, without a knowledge root. */
function standingReceipts(pinned: string) {
  return () => [
    { candidateId: 'c-gate1-pinned', gate: 1 as const, verdict: 'pass' as const, corpusDigest: pinned, producedAtOrdinal: 3 },
    { candidateId: 'c-other-corpus', gate: 1 as const, verdict: 'pass' as const, corpusDigest: 'b'.repeat(64), producedAtOrdinal: 5 },
    // Gate 3 is sovereign user feedback: no corpus digest, so it can never be stale.
    { candidateId: 'c-gate3', gate: 3 as const, verdict: 'pass' as const, producedAtOrdinal: 6 },
  ]
}

describe('422 adversarial admit — receipt and floor disclosure', () => {
  it('names exactly the standing receipts the moved digest staled, and rewrites no floor', async () => {
    const f = fixture()
    const s = await session(f)
    const staged = await runAdversarialVerb(s, { ...adversarialHostOptions(s), product: 'default' })
    const batch = staged.batchDigest!
    const previous = staged.previousCorpusDigest!

    // The floor and every designated baseline live under the committed root's reports tree.
    const floorDir = join(f.committedRoot, 'reports')
    const floorBefore = tree(floorDir)

    const admitted = await runAdversarialVerb(s, {
      ...adversarialHostOptions(s),
      product: 'default',
      admit: true,
      batch,
      readStandingGateReceipts: standingReceipts(previous),
      knowledgeRoot: f.knowledgeRoot,
    })

    expect(admitted.kind).toBe('admitted')
    expect(admitted.previousCorpusDigest).toBe(previous)
    expect(admitted.nextCorpusDigest).not.toBe(previous)
    // Derived from the digests that ACTUALLY moved and the receipts ACTUALLY stored: the one
    // pinned to the old digest, and neither the foreign-corpus one nor the digest-less Gate 3.
    expect(admitted.staleReceipts?.map(row => row.candidateId).sort())
      .toEqual(['c-gate1-pinned'])
    // Reported, never repaired: the operator re-measures with this, admission never rewrites it.
    expect(admitted.floorCommand).toContain('eval floor')
    expect(admitted.floorCommand).toContain(f.configPath)
    expect(tree(floorDir)).toEqual(floorBefore)
  })

  it('names no stale receipt when the digest does not move', async () => {
    const f = fixture()
    const s = await session(f)
    const staged = await runAdversarialVerb(s, { ...adversarialHostOptions(s), product: 'default' })
    const previous = staged.previousCorpusDigest!

    const refused = await runAdversarialVerb(s, {
      ...adversarialHostOptions(s),
      product: 'default',
      admit: true,
      batch: 'f'.repeat(64),
      readStandingGateReceipts: standingReceipts(previous),
      knowledgeRoot: f.knowledgeRoot,
    })

    expect(refused).toMatchObject({ kind: 'refused', reason: 'batch-not-found' })
    // An empty list, not null and not the whole roster: nothing moved, so nothing staled.
    expect(refused.staleReceipts).toEqual([])
  })

  it('separates admitted, unchanged, refused and remaining at the verb surface', async () => {
    const f = fixture()
    const s = await session(f)
    const staged = await runAdversarialVerb(s, { ...adversarialHostOptions(s), product: 'default' })
    const batch = staged.batchDigest!

    const first = await runAdversarialVerb(s, {
      ...adversarialHostOptions(s), product: 'default', admit: true, batch,
    })
    expect(first.kind).toBe('admitted')
    expect(first.admitted.length).toBeGreaterThan(0)
    expect(first.unchanged).toEqual([])
    expect(first.remaining).toEqual([])
  })

  it('resolves the seed cap from the flag, then the config, then the recorded default', async () => {
    const f = fixture()
    const s = await session(f)

    const byDefault = await runAdversarialVerb(s, {
      ...adversarialHostOptions(s), product: 'default', dryRun: true,
    })
    expect(byDefault.cap).toEqual({ value: ADVERSARIAL_DEFAULT_MAX_SEEDS_PER_REFRESH, source: 'default' })

    const byFlag = await runAdversarialVerb(s, {
      ...adversarialHostOptions(s), product: 'default', dryRun: true, maxSeeds: 2,
    })
    expect(byFlag.cap).toEqual({ value: 2, source: 'flag' })

    // The config half of the same knob, read from the session's own parsed config.
    writeConfiguredCap(f, 3)
    const configured = await resolveEvalSession({ configPath: f.configPath, keyOnly: true })
    const byConfig = await runAdversarialVerb(configured, {
      ...adversarialHostOptions(configured), product: 'default', dryRun: true,
    })
    expect(byConfig.cap).toEqual({ value: 3, source: 'config' })

    // ...and an explicit flag still wins over a configured cap.
    const overridden = await runAdversarialVerb(configured, {
      ...adversarialHostOptions(configured), product: 'default', dryRun: true, maxSeeds: 1,
    })
    expect(overridden.cap).toEqual({ value: 1, source: 'flag' })
  })
})

/** Append a strict `eval.adversarial.maxSeedsPerRefresh` to the fixture's own config file. */
function writeConfiguredCap(f: ReturnType<typeof fixture>, value: number): void {
  const text = readFileSync(f.configPath, 'utf8')
  writeFileSync(f.configPath, `${text.trimEnd()}\neval:\n  adversarial:\n    maxSeedsPerRefresh: ${value}\n`)
}
