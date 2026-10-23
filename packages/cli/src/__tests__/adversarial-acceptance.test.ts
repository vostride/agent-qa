/**
 * 422-24-T2 — the phase's integrated acceptance cells, on production entrypoints and fakes only.
 *
 * WHAT THIS FILE IS FOR. Every prior plan in this phase proved one seam. This file asks the
 * questions that only exist once all of them are on the tree at the same time: does the
 * documented operator surface match the registered command tree, and does the whole stage →
 * review → admit loop move the committed digest and nothing else.
 *
 * WHAT IT IS NOT. It is not a re-proof of the legs their owning plans already pin. The
 * acceptance INSTRUMENT (`scripts/422-acceptance.mjs`) requires those suites by name rather than
 * letting this file re-spell them; a second spelling of a pinned leg is a second opinion about
 * what it means, which is the failure mode the 421 final-checks runner exists to avoid.
 *
 * NO PROVIDER REACHES ANYTHING HERE. `createModel` and `fetch` are trapped in `beforeEach` and
 * asserted un-called in `afterEach`, on every path. Nothing below establishes empirical model
 * quality, and nothing below claims demo admission.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Command } from 'commander'

import * as model from '@vostride/agent-qa-model'
import {
  ADVERSARIAL_MUTATORS,
  NO_PROBE_MODEL_REASONS,
  REPLAY_REFUSAL_REASONS,
  buildEvalReport,
  computeGateVerdict,
  extractRunCassettes,
  foldNoiseFloorArtefact,
  projectBaselinePointer,
  projectCorpusEntry,
  projectDecisionVectorsDocument,
  projectSilverLabelRecord,
  type ComputeGateVerdictInput,
  type DecisionCorrectnessVector,
  type EvalBatchReport,
  type LeafCassette,
  type SeedingPlan,
} from '@vostride/agent-qa-eval'
import {
  computeBriefDigest,
  type LosslessServedBriefProofV1,
  SERVED_BRIEF_PROOF_SCHEMA_VERSION,
} from '@vostride/agent-qa-schema'
import {
  FsRunArtifactSource,
  refreshAdversarialSplit,
  seedCommittedCorpus,
} from '@vostride/agent-qa-eval-local'
import { openCorpusReader } from '@vostride/agent-qa-eval-local/reader'

import { markFixture } from '../gates/__tests__/feedback-fixture.js'
import {
  adversarialHostOptions,
  resolveEvalSession,
  runAdversarialVerb,
  type AdversarialVerbOptions,
} from '../eval-session-composition.js'

const ACCEPTANCE_SCRIPT = new URL('../../../../scripts/422-acceptance.mjs', import.meta.url)

const NO_DECLARED_SECRETS = (text: string) => text
const roots: string[] = []

beforeEach(() => {
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

// ---------------------------------------------------------------------------
// The seed corpus: one proof-backed natural leaf, the D-07 population, minimal.
// ---------------------------------------------------------------------------

function proof(): LosslessServedBriefProofV1 {
  return {
    schemaVersion: SERVED_BRIEF_PROOF_SCHEMA_VERSION,
    completeness: 'lossless',
    recordCap: 8,
    combinedBudget: 2048,
    admissionEvents: [
      {
        ordinal: 0,
        turnOrdinal: 0,
        surface: 'caution',
        id: 'adversarial-acceptance-record' as never,
        sourceId: 'adversarial-acceptance-record',
        clusterKey: '{"role":"button","name":"continue"}',
        renderedCost: 24,
        chargeRepeated: false,
      },
    ],
    promptTurns: [
      {
        ordinal: 0,
        turnOrdinal: 0,
        runDate: '2026-09-12',
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
  const seeded = seedCommittedCorpus({
    plan,
    cassettes: [{ cassette: seed, blobs: extracted.blobs }],
    committedRoot,
    mask: NO_DECLARED_SECRETS,
  })
  expect(seeded.refusals).toEqual([])
  expect(seeded.seededCount).toBe(1)
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

async function stage(
  f: ReturnType<typeof fixture>,
  over: Partial<AdversarialVerbOptions> = {},
) {
  const s = await session(f)
  return runAdversarialVerb(s, { ...adversarialHostOptions(s), product: 'default', ...over })
}

// ---------------------------------------------------------------------------
// The release-gate fixture: two comparable reports over one profile.
// ---------------------------------------------------------------------------

function vector(i: number): DecisionCorrectnessVector {
  return {
    key: `acceptance-cassette-${i}#-#0`,
    cassetteId: `acceptance-cassette-${i}`,
    decisionOrdinal: 0,
    product: 'example-web',
    briefSource: 'proof',
    axes: {
      headline: i < 41 ? 'correct' : 'incorrect',
      elementIdentity: 'correct',
      value: 'correct',
      opClass: 'correct',
      sideEffect: 'correct',
      loop: 'not-applicable',
    },
  }
}

/**
 * `ComputeGateVerdictInput.baseline` is optional on the contract — a gate run with no designated
 * baseline is legal and is exactly what `missing-baseline` reports. This fixture always supplies
 * one, so its return type says so: without the narrowing every cell below would have to
 * non-null-assert a field the fixture guarantees, and a `!` is how a real absence gets silenced.
 */
type GateFixture = ComputeGateVerdictInput & {
  baseline: NonNullable<ComputeGateVerdictInput['baseline']> & { report: EvalBatchReport }
}

function gateFixture(): GateFixture {
  const baselineReport = buildEvalReport([], undefined, undefined, { declaredSeed: 11 })
  const currentReport = buildEvalReport([], undefined, undefined, { declaredSeed: 29 })
  baselineReport.batchKey = 'acceptance-baseline'
  currentReport.batchKey = 'acceptance-current'
  baselineReport.briefSourceCounts = { proof: 24, empty: 24, rendered: 0 }
  currentReport.briefSourceCounts = { proof: 24, empty: 24, rendered: 0 }
  const pointer = projectBaselinePointer({
    plannerModelId: 'acceptance-planner',
    fingerprint: 'acceptance-fingerprint',
    corpusDigest: 'acceptance-corpus',
    matcherVersion: baselineReport.matcherVersion,
    batchKey: baselineReport.batchKey,
  })
  const vectors = Array.from({ length: 48 }, (_, i) => vector(i))
  const floor = foldNoiseFloorArtefact({
    profile: {
      profileKey: pointer.profileKey,
      fingerprint: pointer.fingerprint,
      plannerModelId: pointer.plannerModelId,
      matcherVersion: pointer.matcherVersion,
    },
    corpusDigest: pointer.corpusDigest,
    partitionVersion: 1,
    seeds: [11, 29],
    repeats: 3,
    bootstrapSeed: 17,
    runs: [11, 11, 11, 29].map((seed, index) => ({
      index, seed, report: baselineReport, vectors, wallClockMs: 0,
    })),
    splitByCassetteId: new Map(),
    censusByProduct: { 'example-web': { natural: 48, heldOutShared: 0, heldOutPrivate: 0 } },
  })
  return {
    expectedProfileKey: pointer.profileKey,
    pointer: { kind: 'current' as const, pointer },
    floor,
    baseline: {
      report: baselineReport,
      vectors: projectDecisionVectorsDocument({
        batchKey: baselineReport.batchKey,
        matcherVersion: baselineReport.matcherVersion,
        vectors,
      }),
    },
    current: {
      report: currentReport,
      vectors: structuredClone(vectors),
      fingerprint: pointer.fingerprint,
      corpusDigest: pointer.corpusDigest,
    },
  }
}

// ---------------------------------------------------------------------------

describe('422 acceptance — the documented surface, the whole loop, and the refusal law', () => {
  it('(A2) staging leaves the committed root byte-identical and admission moves the corpus digest', async () => {
    const f = fixture()
    const before = tree(f.committedRoot)

    const staged = await stage(f)
    expect(staged.kind).toBe('staged')
    expect(staged.staged.length).toBeGreaterThan(0)
    expect(staged.refusals).toEqual([])
    // Every declared family accounted for exactly once: derived, or explained.
    expect(
      [...staged.staged.map(row => row.mutator), ...staged.skips.map(row => row.mutator)].sort(),
    ).toEqual([...ADVERSARIAL_MUTATORS].sort())
    // Proposing moved nothing a reader can see (D-01), and staled no receipt.
    expect(tree(f.committedRoot)).toEqual(before)
    expect(staged.staleReceipts).toEqual([])
    expect(staged.spend.modelCalls).toBe(0)

    const batch = staged.batchDigest!
    const admitted = await stage(f, { admit: true, batch })
    expect(admitted.kind).toBe('admitted')
    expect(admitted.remaining).toEqual([])
    expect(admitted.nextCorpusDigest).not.toBe(admitted.previousCorpusDigest)
    expect(admitted.admitted.length).toBe(staged.staged.length)

    const splits = openCorpusReader(f.committedRoot)
      .listEntries('default')
      .map(entry => entry.split)
      .sort()
    expect(splits.filter(split => split === 'adversarial')).toHaveLength(admitted.admitted.length)
    expect(splits).toContain('natural')
    // The reviewed batch is retired only because every member landed.
    expect(existsSync(join(f.agentQaRoot, 'eval/adversarial/default', batch))).toBe(false)
  })

  it('(A3) an interrupted admission reports a partial batch and never folds remaining into admitted', async () => {
    const f = fixture()
    const staged = await stage(f)
    expect(staged.staged.length).toBeGreaterThan(1)
    const s = await session(f)

    // The production admission function, interrupted at its own documented seam after the first
    // case landed. `partial` exists precisely so a half-written batch cannot read as a whole one.
    let committed = 0
    const partial = refreshAdversarialSplit({
      agentQaRoot: adversarialHostOptions(s).agentQaRoot,
      committedRoot: f.committedRoot,
      product: 'default',
      batchDigest: staged.batchDigest!,
      afterCaseCommitted: () => {
        committed += 1
        if (committed === 1) throw new Error('acceptance interruption')
      },
      mask: NO_DECLARED_SECRETS,
    })

    expect(partial.kind).toBe('partial')
    expect(partial.reason).toBe('admission-interrupted')
    expect(partial.admitted).toHaveLength(1)
    expect(partial.remaining.length).toBe(staged.staged.length - 1)
    const admittedIds = new Set(partial.admitted.map(row => row.cassetteId))
    // Disjoint, not merely different lengths: a remaining case must never appear as admitted.
    expect(partial.remaining.every(row => !admittedIds.has(row.cassetteId))).toBe(true)
    // The batch stays on disk so the operator resumes THAT manifest.
    expect(existsSync(join(f.agentQaRoot, 'eval/adversarial/default', staged.batchDigest!))).toBe(true)
  })

  it('(A4) a batch altered after review refuses staging-integrity without starting a write', async () => {
    const f = fixture()
    const staged = await stage(f)
    const batch = staged.batchDigest!
    const before = tree(f.committedRoot)

    const caseFile = join(f.agentQaRoot, 'eval/adversarial/default', batch, 'case-0000', 'entry.json')
    const entry = JSON.parse(readFileSync(caseFile, 'utf8')) as Record<string, unknown>
    entry.product = 'smuggled'
    writeFileSync(caseFile, JSON.stringify(entry))

    const refused = await stage(f, { admit: true, batch })
    expect(refused).toMatchObject({ kind: 'refused', reason: 'staging-integrity' })
    expect(refused.admitted).toEqual([])
    expect(refused.writesStarted).toBe(false)
    expect(tree(f.committedRoot)).toEqual(before)
  })

  it('(A6) identical refusal populations do not report refusal-population-differs', () => {
    const input = gateFixture()
    // The control this phase owes itself: the cell above must not be able to pass by asserting
    // a reason the gate raises unconditionally.
    for (const reason of REPLAY_REFUSAL_REASONS) {
      input.baseline.report.honesty.refusalCounts[reason] = 2
      input.current.report.honesty.refusalCounts[reason] = 2
    }
    const verdict = computeGateVerdict(input)
    expect(verdict.inconclusive.map(row => row.reason)).not.toContain('refusal-population-differs')
    expect(verdict.regressions).toEqual([])
    expect(verdict.exit).toBe(0)
  })

  it('(A9) a probe capability gap is typed, costs nothing, and leaves the deterministic families alone', async () => {
    const f = fixture()
    const result = await stage(f, {
      probeCapability: { kind: 'no-probe-model', reason: 'single-family-host', entries: [] } as never,
    })
    expect(result.noProbeModel).toEqual({ kind: 'no-probe-model', reason: 'single-family-host' })
    expect(NO_PROBE_MODEL_REASONS).toContain(result.noProbeModel!.reason)
    expect(result.spend).toMatchObject({ modelCalls: 0, promptTokens: 0, completionTokens: 0 })
    expect(result.authoringModel).toBeUndefined()
    // The gap is not a stop: the deterministic half ran and produced a reviewable batch.
    expect(result.kind).toBe('staged')
    expect(result.staged.length).toBeGreaterThan(0)
    expect(result.staged.every(row => row.mutator !== undefined)).toBe(true)
  })

  it('(A10) the acceptance instrument refuses incomplete fixture evidence', async () => {
    const { validateFixtureEvidence, REQUIRED_FIXTURE_LEGS } = await import(ACCEPTANCE_SCRIPT.href)
    expect(Array.isArray(REQUIRED_FIXTURE_LEGS)).toBe(true)
    expect(REQUIRED_FIXTURE_LEGS).toContain('release-exit-2')
    expect(REQUIRED_FIXTURE_LEGS).toContain('production-path')

    const complete = Object.fromEntries(
      REQUIRED_FIXTURE_LEGS.map((leg: string) => [leg, { ran: true, ok: true }]),
    )
    expect(validateFixtureEvidence(complete)).toEqual([])

    // A leg that never ran, a leg that ran and failed, and no evidence at all must each refuse.
    for (const leg of REQUIRED_FIXTURE_LEGS) {
      expect(validateFixtureEvidence({ ...complete, [leg]: { ran: false, ok: false } }).length)
        .toBeGreaterThan(0)
      expect(validateFixtureEvidence({ ...complete, [leg]: { ran: true, ok: false } }).length)
        .toBeGreaterThan(0)
      const missing = { ...complete }
      delete missing[leg]
      expect(validateFixtureEvidence(missing).length).toBeGreaterThan(0)
    }
    expect(validateFixtureEvidence({}).length).toBe(REQUIRED_FIXTURE_LEGS.length)
  })

  it('(A11) the read-only and staging demo modes cannot admit', async () => {
    const source = readFileSync(ACCEPTANCE_SCRIPT, 'utf8')
    const { DEMO_MODES, READ_ONLY_MODES, isBatchDigest, demoArgv } =
      await import(ACCEPTANCE_SCRIPT.href)
    expect(DEMO_MODES).toEqual(['--inspect-demo', '--stage-demo', '--check-staged', '--verify-admitted'])
    expect(READ_ONLY_MODES).toEqual(['--inspect-demo', '--stage-demo', '--check-staged'])

    // STRUCTURAL, over the argv the instrument actually builds — not a taboo on a spelling,
    // which is evaded by respelling it. The only mode that invokes anything is `--stage-demo`,
    // and what it invokes is the staging branch of the verb; every other mode builds no argv at
    // all, so there is nothing for an admission flag to ride on.
    const staging: string[] = demoArgv('--stage-demo', '/tmp/agent-qa.config.yaml', { product: 'default' })
    expect(staging.slice(-5)).toEqual(['eval', 'adversarial', '--product', 'default', '--json'])
    expect(staging.slice(1, 3)).toEqual(['--config', '/tmp/agent-qa.config.yaml'])
    expect(staging.some(token => token.startsWith('--adm'))).toBe(false)
    expect(staging.some(token => token === '--batch')).toBe(false)
    for (const mode of READ_ONLY_MODES.filter((row: string) => row !== '--stage-demo')) {
      expect(demoArgv(mode, '/tmp/agent-qa.config.yaml')).toBeUndefined()
    }
    expect(demoArgv('--verify-admitted', '/tmp/agent-qa.config.yaml')).toBeUndefined()
    expect(() => demoArgv('--not-a-mode', '/tmp/agent-qa.config.yaml')).toThrow()

    // The committer is never named, so no branch can reach it however the argv is built.
    expect(source).not.toContain('refreshAdversarialSplit')

    // A batch is named by digest, never by a path a generated manifest could supply.
    expect(isBatchDigest('a'.repeat(64))).toBe(true)
    expect(isBatchDigest('A'.repeat(64))).toBe(false)
    expect(isBatchDigest('../../etc/passwd')).toBe(false)
    expect(isBatchDigest(join('a'.repeat(64), 'manifest.json'))).toBe(false)
    expect(isBatchDigest('a'.repeat(63))).toBe(false)
    expect(isBatchDigest(undefined)).toBe(false)
  })
})

// Keep a reference so an unused-import lint never drops the directory helper.
void mkdirSync
void Command
