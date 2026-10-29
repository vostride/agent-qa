// `analysis.get` — THE one producer of a run's analysis.
//
// Resolved verdicts, rendered sentences (live recurrence joins applied) and clusters, served
// through one op that every surface calls — plan 07's CLI print, M5's run page, 392's chat.
// Beside it, the `runs.get` rewire: the cheapest read lists class/producer/confidence through
// the SAME accessor and never renders a sentence (the cheapest-read law).
//
// Absence discipline throughout: an unbound analysis port refuses BY NAME; a bound port with
// no artifact on disk answers the handoff floor (honest parts, minted unknowns); a run with
// no failures answers empty lists. None of those is an error, because none of them is a lie.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  asRecordId,
  canonicalJson,
  CURRENT_ANALYSIS_SCHEMA_VERSION,
  errorTextOf,
  exercisedAnchors,
  failingStepOf,
  failureFingerprint,
  resolveRunVerdicts,
  slugBranch,
  MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
} from '@vostride/agent-qa-schema'
import type {
  AnalysisGetOutput,
  EvidenceBlobPresence,
  CompletedRunHandoff,
  FunctionCaller,
  RunAnalysisArtifact,
  RunDetail,
  Verdict,
} from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'

import { clusterVerdicts } from '../../analysis/cluster.js'
import type { RecurrenceProvider, RecurrenceQuery } from '../../analysis/render-sentence.js'
import { buildSyntheticHandoff } from '../../jobs/__tests__/fixtures/synthetic-handoff.js'
import { FunctionNotBoundError, invokeFunction } from '../invoke.js'
import { createFunctionRegistry } from '../registry.js'
import type {
  AnalysisArtifactReaderPort,
  EvidenceBlobReaderPort,
  FunctionDeps,
} from '../spec.js'
import { ANALYSIS_GET_FUNCTION_ID } from '../ops/analysis-get.js'
import { RUNS_GET_FUNCTION_ID } from '../ops/runs-get.js'

// the retired `grantedScopes` and `safeMode` caller fields and the
// retired `resolveExecutionContext` registry option are dropped; nothing read them.
const CALLER: FunctionCaller = {
  surface: 'test',
  origin: 'agent',
}

function upgradedAppBug(perTest: number): Verdict {
  return {
    class: 'app_bug',
    producer: 'analyze-run',
    confidence: 0.9,
    evidence: {
      citedSteps: [0],
      citedAnchors: [],
      citedArtifacts: [],
      rationale: 'the submit button never enabled after the cart update',
    },
    memoryMisdirectionRuledOut: true,
    perTest,
  }
}

function artifactFor(handoff: CompletedRunHandoff): RunAnalysisArtifact {
  return {
    schemaVersion: CURRENT_ANALYSIS_SCHEMA_VERSION,
    runId: String(handoff.runId),
    verdicts: [upgradedAppBug(0)],
    parts: [{
      perTest: 0,
      groundingQuote: { stepIndex: 0, quote: 'Error: element "Submit" not found' },
      discriminator: 'the submit button disappeared after the cart update',
      nextAction: 'file the failure against the application with the quoted evidence',
      links: ['agentqa://memory/MEM-001'],
    }],
  }
}

function deps(overrides: Partial<FunctionDeps> = {}): FunctionDeps {
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
      showRecord: ({ recordId }) =>
        Promise.resolve({ kind: 'not-found', schemaVersion: 2, recordId } as const),
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
    ...overrides,
  }
}

function registryWith(options: {
  handoff?: CompletedRunHandoff
  analysis?: AnalysisArtifactReaderPort
  recurrence?: RecurrenceProvider
  evidenceBlobs?: EvidenceBlobReaderPort
}) {
  const { handoff } = options
  return createFunctionRegistry({
    deps: deps({
      runs: {
        list: () => Promise.resolve(handoff === undefined ? [] : [handoff]),
        get: (runId) => Promise.resolve(
          handoff !== undefined && String(runId) === String(handoff.runId)
            ? handoff
            : undefined,
        ),
        readEvents: () => Promise.resolve([]),
        readStepEvidence: () => Promise.resolve({ kind: 'run-not-recorded' } as const),
      },
      ...(options.analysis === undefined ? {} : { analysis: options.analysis }),
      ...(options.recurrence === undefined ? {} : { recurrence: options.recurrence }),
      ...(options.evidenceBlobs === undefined ? {} : { evidenceBlobs: options.evidenceBlobs }),
    }),
  })
}

function readerOf(artifact: RunAnalysisArtifact | undefined): AnalysisArtifactReaderPort {
  return { getArtifact: () => artifact }
}

async function analysisOf(
  registry: ReturnType<typeof registryWith>,
  runId: string,
): Promise<AnalysisGetOutput> {
  return await invokeFunction(
    registry,
    ANALYSIS_GET_FUNCTION_ID,
    { runId },
    CALLER,
  ) as AnalysisGetOutput
}

describe('analysis.get — binding and refusal', () => {
  it('lists unbound and refuses BY NAME in a composition with no analysis port', async () => {
    const handoff = buildSyntheticHandoff({ failureCount: 1 })
    const registry = registryWith({ handoff })

    expect(registry.list(CALLER).find((entry) => entry.id === ANALYSIS_GET_FUNCTION_ID))
      .toMatchObject({ resultKind: 'unary', bindingStatus: 'unbound' })

    const refusal = analysisOf(registry, String(handoff.runId))
    await expect(refusal).rejects.toBeInstanceOf(FunctionNotBoundError)
    await expect(refusal).rejects.toMatchObject({ functionId: ANALYSIS_GET_FUNCTION_ID })
  })

  it('throws the typed not-found refusal for a run nothing recorded', async () => {
    const registry = registryWith({ analysis: readerOf(undefined) })

    await expect(analysisOf(registry, 'run-never-happened')).rejects.toMatchObject({
      name: 'RunNotFoundError',
    })
  })
})

describe('analysis.get — the handoff floor', () => {
  it('answers a bound port with NO artifact via the floor: minted unknowns, honest parts', async () => {
    const handoff = buildSyntheticHandoff({ failureCount: 2, passedCount: 1 })
    const registry = registryWith({ handoff, analysis: readerOf(undefined) })

    const output = await analysisOf(registry, String(handoff.runId))

    expect(output.runId).toBe(String(handoff.runId))
    // `evidence` is on every verdict, floor included — the minted unknown cites nothing
    // and says so, rather than omitting the key and leaving a reader to guess which it meant.
    expect(output.verdicts).toEqual([
      { perTest: 0, testId: 't_failed_0', class: 'unknown', producer: 'deterministic-classifier', confidence: 0, evidence: { citedSteps: [], citedArtifacts: [] } },
      { perTest: 1, testId: 't_failed_1', class: 'unknown', producer: 'deterministic-classifier', confidence: 0, evidence: { citedSteps: [], citedArtifacts: [] } },
    ])
    expect(output.sentences).toHaveLength(2)
    for (const entry of output.sentences) {
      expect(entry.sentence).toContain('root cause undetermined')
      // No recurrence dep bound: obligation c still renders, as the explicit no-history clause.
      expect(entry.sentence).toContain('no failure history is recorded for this test')
    }
    // One shared anchor, one class: the ANLZ-04 fold, with the representative's sentence.
    expect(output.clusters).toHaveLength(1)
    expect(output.clusters[0]!.count).toBe(2)
    expect(output.clusters[0]!.representative.sentence)
      .toBe(output.sentences.find((entry) => entry.perTest === 0)!.sentence)
  })

  it('answers a zero-failure run with empty sentences and clusters, never an error', async () => {
    const handoff = buildSyntheticHandoff({ failureCount: 0, passedCount: 2 })
    const registry = registryWith({ handoff, analysis: readerOf(undefined) })

    const output = await analysisOf(registry, String(handoff.runId))

    expect(output.verdicts).toEqual([])
    expect(output.sentences).toEqual([])
    expect(output.clusters).toEqual([])
  })
})

describe('analysis.get — the artifact leg and the one accessor', () => {
  it('serves upgraded class/producer through BOTH ops, and sentences through ONE', async () => {
    const handoff = buildSyntheticHandoff({ failureCount: 1 })
    const artifact = artifactFor(handoff)
    const registry = registryWith({ handoff, analysis: readerOf(artifact) })

    const output = await analysisOf(registry, String(handoff.runId))
    expect(output.verdicts).toEqual([
      { perTest: 0, testId: 't_failed_0', class: 'app_bug', producer: 'analyze-run', confidence: 0.9, evidence: { citedSteps: [0], citedArtifacts: [] } },
    ])
    expect(output.sentences[0]!.sentence)
      .toContain('the submit button disappeared after the cart update')
    expect(output.sentences[0]!.sentence).toContain('see: agentqa://memory/MEM-001')

    // The SAME upgrade is visible through runs.get — sourced from the same accessor…
    const detail = await invokeFunction(
      registry,
      RUNS_GET_FUNCTION_ID,
      { runId: String(handoff.runId) },
      CALLER,
    ) as RunDetail
    expect(detail.tests[0]!.rootCause).toMatchObject({
      class: 'app_bug',
      producer: 'analyze-run',
      confidence: 0.9,
    })
    // …and runs.get NEVER renders a sentence: the cheapest read stays the cheapest.
    const serialized = JSON.stringify(detail)
    expect(serialized).not.toContain('"sentence"')
    expect(serialized).not.toContain('observed (step')
  })

  it('joins recurrence LIVE through the optional dep, keyed the projection way', async () => {
    const handoff = buildSyntheticHandoff({ failureCount: 1 })
    const asked: RecurrenceQuery[] = []
    const recurrence: RecurrenceProvider = {
      failureRecurrence(query) {
        asked.push(query)
        return { kth: 3, windowBuilds: 5 }
      },
    }
    const registry = registryWith({
      handoff,
      analysis: readerOf(undefined),
      recurrence,
    })

    const output = await analysisOf(registry, String(handoff.runId))

    expect(output.sentences[0]!.sentence)
      .toContain('failure 3 of this test in the last 5 builds')
    // Identity is (product, filePath, testName) — the projection's own key, never testId —
    // and 390 D-07 adds the FINGERPRINT the recurrence windows are keyed by. Both travel:
    // the ladder join is identity-keyed, the occurrence count is fingerprint-keyed.
    expect(asked).toEqual([{
      product: slugBranch(handoff.scope.key),
      filePath: 'tests/failed-0.yaml',
      testName: 'stepped failure 0',
      fingerprint: failureFingerprint(
        {
          anchors: exercisedAnchors(failingStepOf(handoff.tests[0]!)!),
          errorText: errorTextOf(failingStepOf(handoff.tests[0]!), handoff.tests[0]!),
        },
        'unknown',
      ),
    }])
  })

  it('keys the fingerprint by the RESOLVED class — an upgraded verdict queries a different window', async () => {
    // The recipe folds the class in, so the same anchor failing as `unknown` and as
    // `app_bug` are two windows. The caller must therefore key from the resolved verdict, not
    // from the handoff's floor — which is exactly what the projection's writer does.
    const handoff = buildSyntheticHandoff({ failureCount: 1 })
    const asked: RecurrenceQuery[] = []
    const recurrence: RecurrenceProvider = {
      failureRecurrence(query) {
        asked.push(query)
        return { kth: 1, windowBuilds: 1 }
      },
    }
    const registry = registryWith({
      handoff,
      analysis: readerOf(artifactFor(handoff)),
      recurrence,
    })

    await analysisOf(registry, String(handoff.runId))

    expect(asked[0]!.fingerprint).toBe(
      failureFingerprint(
        {
          anchors: exercisedAnchors(failingStepOf(handoff.tests[0]!)!),
          errorText: errorTextOf(failingStepOf(handoff.tests[0]!), handoff.tests[0]!),
        },
        'app_bug',
      ),
    )
    // The floor's key is a DIFFERENT string — the control that makes the pin above load-bearing.
    expect(asked[0]!.fingerprint).not.toBe(
      failureFingerprint(
        {
          anchors: exercisedAnchors(failingStepOf(handoff.tests[0]!)!),
          errorText: errorTextOf(failingStepOf(handoff.tests[0]!), handoff.tests[0]!),
        },
        'unknown',
      ),
    )
  })

  it('queries a ZERO-STEP failure by identity with the fingerprint ABSENT — no fabricated key', async () => {
    // A member with no recorded steps has no failing step to key from. The query still goes out
    // (identity is enough for the per-test window and for the ladder join); the fingerprint leg
    // is OMITTED rather than filled with a stand-in, so `'fingerprint' in query` is false.
    const handoff = buildSyntheticHandoff({ failureCount: 0, steplessFailureCount: 1 })
    const asked: RecurrenceQuery[] = []
    const recurrence: RecurrenceProvider = {
      failureRecurrence(query) {
        asked.push(query)
        return undefined
      },
    }
    const registry = registryWith({ handoff, analysis: readerOf(undefined), recurrence })

    await analysisOf(registry, String(handoff.runId))

    expect(asked).toHaveLength(1)
    expect(asked[0]!.fingerprint).toBeUndefined()
    expect('fingerprint' in asked[0]!).toBe(false)
    expect(asked[0]).toMatchObject({
      product: slugBranch(handoff.scope.key),
      filePath: 'tests/stepless-0.yaml',
    })
  })

  it('returns clusters byte-identical to the pure fold — no re-derivation, no drift', async () => {
    const handoff = buildSyntheticHandoff({ failureCount: 5 })
    const registry = registryWith({ handoff, analysis: readerOf(undefined) })

    const first = await analysisOf(registry, String(handoff.runId))
    const second = await analysisOf(registry, String(handoff.runId))
    expect(canonicalJson(first)).toBe(canonicalJson(second))

    const pure = clusterVerdicts(resolveRunVerdicts(undefined, handoff), handoff)
    expect(first.clusters.map(({ fingerprint, count, members }) => ({ fingerprint, count, members })))
      .toEqual(pure.map(({ fingerprint, count, members }) => ({ fingerprint, count, members })))
    expect(first.clusters.map((cluster) => cluster.representative.testIndex))
      .toEqual(pure.map((cluster) => cluster.representative.testIndex))
  })
})

// The evidence projection.
//
// A verdict on the wire used to say WHAT it concluded and never WHAT it read. The failure view's
// links are those refs, and re-deriving them in the page would be a second join over the same
// artifact — so the op that already resolved the verdict projects its own evidence, and annotates
// each cited artifact with whether the bytes are still there.
//
// FOUR PORT ARMS AND THEY ARE NOT THREE. `found` is the only `true`; both absences are `false`
// because the bytes are gone either way; and a port with no `has` at all leaves the key ABSENT,
// which is presence UNKNOWN — the one thing that must never render as a claimed absence.

/** A port whose `has` answers one fixed word, recording what it was asked. */
function blobsAnswering(
  word: EvidenceBlobPresence,
  seen?: string[],
): EvidenceBlobReaderPort {
  return {
    read: () => Promise.resolve({ status: 'unknown_run' as const }),
    has: (_runId, sha) => {
      seen?.push(sha)
      return Promise.resolve(word)
    },
  }
}

/** The shape every host bound before 406 — a read and nothing else. */
const BLOBS_WITHOUT_HAS: EvidenceBlobReaderPort = {
  read: () => Promise.resolve({ status: 'unknown_run' as const }),
}

/**
 * A port whose `has` REJECTS for the named shas and answers `found` for the rest.
 *
 * The bundled local implementation is `existsSync` and cannot throw, so this is the shape the
 * PORT is documented for rather than the one it is bound to today: a host that does not hold its
 * blobs locally stats them over a network (`spec.ts` — `EvidenceBlobReaderPort.has`), and a
 * network stat fails. Presence is opportunistic on every surface that reads it, so a failed stat
 * is presence UNKNOWN and never a failed read.
 */
function blobsRejectingFor(shas: readonly string[]): EvidenceBlobReaderPort {
  return {
    read: () => Promise.resolve({ status: 'unknown_run' as const }),
    has: (_runId, sha) => shas.includes(sha)
      ? Promise.reject(new Error('stat failed: connection reset'))
      : Promise.resolve('found' as const),
  }
}

const CITED_SHA = 'a'.repeat(64)

function artifactCiting(
  handoff: CompletedRunHandoff,
  citedArtifacts: Verdict['evidence']['citedArtifacts'],
): RunAnalysisArtifact {
  const base = artifactFor(handoff)
  return {
    ...base,
    verdicts: [{
      ...base.verdicts[0]!,
      evidence: { ...base.verdicts[0]!.evidence, citedSteps: [0], citedArtifacts },
    }],
  }
}

describe('analysis.get — the evidence projection', () => {
  it('carries every verdict\'s own citedSteps and citedArtifacts, floor included', async () => {
    const handoff = buildSyntheticHandoff({ failureCount: 2, passedCount: 1 })
    const registry = registryWith({ handoff, analysis: readerOf(undefined) })

    const output = await analysisOf(registry, String(handoff.runId))

    // The floor's own evidence, not a stand-in: minted unknowns cite nothing, and an empty
    // `citedArtifacts` is the honest projection of that — never an omitted key.
    expect(output.verdicts.map((verdict) => verdict.evidence)).toEqual([
      { citedSteps: [], citedArtifacts: [] },
      { citedSteps: [], citedArtifacts: [] },
    ])
  })

  it('projects the artifact verdict\'s cited steps and artifacts verbatim', async () => {
    const handoff = buildSyntheticHandoff({ failureCount: 1 })
    const artifact = artifactCiting(handoff, [{ id: `decision-screenshot:${CITED_SHA}`, sha: CITED_SHA }])
    const registry = registryWith({ handoff, analysis: readerOf(artifact) })

    const output = await analysisOf(registry, String(handoff.runId))

    expect(output.verdicts[0]!.evidence).toEqual({
      citedSteps: [0],
      citedArtifacts: [{ id: `decision-screenshot:${CITED_SHA}`, sha: CITED_SHA }],
    })
  })

  it('keeps citedAnchors and rationale OFF the serialized wire', async () => {
    const handoff = buildSyntheticHandoff({ failureCount: 1 })
    const registry = registryWith({ handoff, analysis: readerOf(artifactFor(handoff)) })

    const body = JSON.stringify(await analysisOf(registry, String(handoff.runId)))

    // The rationale is the model's own prose about a run; the anchors are an identity vocabulary
    // no surface binds. Neither is refused later — neither is emitted.
    expect(body).not.toContain('citedAnchors')
    expect(body).not.toContain('rationale')
    expect(body).not.toContain('the submit button never enabled after the cart update')
  })
})

describe('analysis.get — read-time presence on cited artifacts', () => {
  async function citedArtifactUnder(
    evidenceBlobs: EvidenceBlobReaderPort | undefined,
    refs: Verdict['evidence']['citedArtifacts'] = [{ id: `decision-screenshot:${CITED_SHA}`, sha: CITED_SHA }],
  ) {
    const handoff = buildSyntheticHandoff({ failureCount: 1 })
    const registry = registryWith({
      handoff,
      analysis: readerOf(artifactCiting(handoff, refs)),
      ...(evidenceBlobs === undefined ? {} : { evidenceBlobs }),
    })
    const output = await analysisOf(registry, String(handoff.runId))
    return output.verdicts[0]!.evidence!.citedArtifacts
  }

  it('answers present: true only for found', async () => {
    expect(await citedArtifactUnder(blobsAnswering('found')))
      .toEqual([{ id: `decision-screenshot:${CITED_SHA}`, sha: CITED_SHA, present: true }])
  })

  it('answers present: false for blob_absent — the bytes are gone', async () => {
    expect(await citedArtifactUnder(blobsAnswering('blob_absent')))
      .toEqual([{ id: `decision-screenshot:${CITED_SHA}`, sha: CITED_SHA, present: false }])
  })

  it('answers present: false for unknown_run too — a vanished run dir is the same absence to a reader', async () => {
    expect(await citedArtifactUnder(blobsAnswering('unknown_run')))
      .toEqual([{ id: `decision-screenshot:${CITED_SHA}`, sha: CITED_SHA, present: false }])
  })

  it('OMITS present entirely for a port that cannot stat — unknown is not an absence', async () => {
    const refs = await citedArtifactUnder(BLOBS_WITHOUT_HAS)
    expect(refs).toEqual([{ id: `decision-screenshot:${CITED_SHA}`, sha: CITED_SHA }])
    expect('present' in refs[0]!).toBe(false)
  })

  it('OMITS present for a composition binding no evidence port at all', async () => {
    const refs = await citedArtifactUnder(undefined)
    expect('present' in refs[0]!).toBe(false)
  })

  it('a REJECTED stat does not fail the read, and leaves the key ABSENT rather than false', async () => {
    // The annotation is opportunistic everywhere it is documented — "a host with no runtime root
    // still serves a complete analysis". A rejected stat that rejected the whole op would make an
    // optional annotation the thing that takes down the failure view.
    const refs = await citedArtifactUnder(blobsRejectingFor([CITED_SHA]))

    // ABSENT, not `present: false`. A stat that never answered is presence UNKNOWN, and `false`
    // here would be a claimed absence built from a failed lookup — the one answer the port's own
    // doc says this field must never give by accident.
    expect('present' in refs[0]!).toBe(false)
    expect(refs).toEqual([{ id: `decision-screenshot:${CITED_SHA}`, sha: CITED_SHA }])
  })

  it('one rejected sha does not erase the presence of the shas that DID answer', async () => {
    const other = 'b'.repeat(64)
    const refs = await citedArtifactUnder(blobsRejectingFor([CITED_SHA]), [
      { id: `decision-screenshot:${CITED_SHA}`, sha: CITED_SHA },
      { id: `decision-screenshot:${other}`, sha: other },
    ])

    expect('present' in refs[0]!).toBe(false)
    expect(refs[1]).toEqual({ id: `decision-screenshot:${other}`, sha: other, present: true })
  })

  it('keeps a producer-flagged evidenceIncomplete ref\'s flag ALONGSIDE present', async () => {
    // Two facts about one ref: the producer knew at emit time that it could not attach the bytes,
    // and the reader knows at read time that they are not there. The page renders one state from
    // either, and collapsing them here would lose which side reported it.
    const refs = await citedArtifactUnder(blobsAnswering('blob_absent'), [
      { id: `decision-screenshot:${CITED_SHA}`, sha: CITED_SHA, evidenceIncomplete: true },
    ])
    expect(refs).toEqual([{
      id: `decision-screenshot:${CITED_SHA}`,
      sha: CITED_SHA,
      evidenceIncomplete: true,
      present: false,
    }])
  })

  it('stats each distinct sha ONCE within the ref list it is handed', async () => {
    // WITHIN one verdict's cited list, which is the scope `annotatePresence` dedups over and the
    // scope this cell measures. The cross-verdict case — 40 members citing one screenshot — is NOT
    // collapsed, because both callers invoke the annotation per member; that residual is recorded
    // on `evidence-presence.ts` rather than mitigated.
    const seen: string[] = []
    const other = 'b'.repeat(64)
    await citedArtifactUnder(blobsAnswering('found', seen), [
      { id: `decision-screenshot:${CITED_SHA}`, sha: CITED_SHA },
      { id: `decision-screenshot:${CITED_SHA}#again`, sha: CITED_SHA },
      { id: `decision-screenshot:${other}`, sha: other },
    ])
    expect(seen.sort()).toEqual([CITED_SHA, other].sort())
  })
})

// D-12 through the op, and the census that keeps it single.
//
// Two claims, and the second is what makes the first durable. The op serves the CLEANED
// sentence — the 399 seeded-red quote read as an escape stream on every surface — and its
// cluster representative is that same string, looked up rather than re-rendered. The census
// then reads the source of every surface package and pins that exactly ONE file spells
// `observed (step`: a second composer would be a second sentence for one verdict, which is
// precisely the drift D-12 exists to forbid.

const ESC = '\u001b'

/** Copied from `demo/acceptance/399/399-analysis-seeded-red.json` — Playwright's raw error. */
const SEEDED_RED_399_QUOTE =
  'locator.click: Timeout 30000ms exceeded.\n'
  + 'Call log:\n'
  + `${ESC}[2m  - waiting for getByRole('button', { name: 'Close ad', exact: true }).first()`
  + `${ESC}[22m\n`

/** The readable form D-12 pins — every non-control word of the "before", in order, on one line. */
const SEEDED_RED_399_READABLE =
  'locator.click: Timeout 30000ms exceeded. '
  + "Call log: - waiting for getByRole('button', { name: 'Close ad', exact: true }).first()"

function seededRed399Artifact(handoff: CompletedRunHandoff): RunAnalysisArtifact {
  return {
    schemaVersion: CURRENT_ANALYSIS_SCHEMA_VERSION,
    runId: String(handoff.runId),
    verdicts: [upgradedAppBug(0)],
    parts: [{
      perTest: 0,
      groundingQuote: { stepIndex: 1, quote: SEEDED_RED_399_QUOTE },
      discriminator: 'root cause undetermined',
      nextAction: 'inspect the run manually — no deterministic signal matched',
      links: [],
    }],
  }
}

/** The repo root, from this file: `__tests__` → functions → src → agent → packages → root. */
const CENSUS_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..')

/** Every package that renders or serves a verdict sentence to a person. */
const CENSUS_PACKAGES = ['agent', 'cli', 'dashboard-ui', 'dashboard-server', 'mcp'] as const

/** Non-test `.ts`/`.tsx` under a package's `src`; a package that is not checked out is skipped. */
function sourceFilesUnder(directory: string): string[] {
  if (!existsSync(directory)) return []
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFilesUnder(path)
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : []
  })
}

/**
 * One file's CODE, with full-line comments dropped.
 *
 * The census asks who COMPOSES the grounding segment, not who mentions it: this house writes
 * header prose that quotes the rendered form, and a cell that counted those would go red for a
 * paragraph — the one way to make a structural pin get deleted rather than obeyed.
 */
function codeOf(path: string): string {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => {
      const trimmed = line.trimStart()
      return !(trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*'))
    })
    .join('\n')
}

describe('analysis.get — the quote leg, through the ONE renderer', () => {
  it('serves the recorded seeded-red quote as readable prose — one renderer, one sentence', async () => {
    const handoff = buildSyntheticHandoff({ failureCount: 1 })
    const registry = registryWith({
      handoff,
      analysis: readerOf(seededRed399Artifact(handoff)),
    })

    const output = await analysisOf(registry, String(handoff.runId))

    expect(output.sentences[0]!.sentence)
      .toContain(`observed (step 1): "${SEEDED_RED_399_READABLE}"`)
    expect(output.sentences[0]!.sentence).not.toContain(ESC)
    expect(output.sentences[0]!.sentence).not.toContain('\n')
    // The cluster LOOKS THE SENTENCE UP rather than re-rendering it, so the cleaned
    // form cannot drift between the per-test list and the cluster header.
    expect(output.clusters[0]!.representative.sentence).toBe(output.sentences[0]!.sentence)
  })

  it('census: exactly ONE source file composes the grounding segment (single code path)', () => {
    const composers = CENSUS_PACKAGES
      .flatMap((name) => sourceFilesUnder(join(CENSUS_ROOT, 'packages', name, 'src')))
      .filter((path) => codeOf(path).includes('observed (step'))
      .map((path) => path.slice(CENSUS_ROOT.length + 1))
      .sort()

    expect(composers).toEqual(['packages/agent/src/analysis/render-sentence.ts'])
  })
})

const CANDIDATE_RECORD = asRecordId('rec_cand_0001')
const CANARY_RECORD = asRecordId('rec_canary_01')

describe('analysis.get — the records a verdict declared on its failing path', () => {
  it('carries the declared memoryOnPath onto the resolved verdict', async () => {
    const handoff = buildSyntheticHandoff({ failureCount: 1 })
    const artifact: RunAnalysisArtifact = {
      ...artifactFor(handoff),
      verdicts: [{
        ...upgradedAppBug(0),
        memoryOnPath: [
          { recordId: CANDIDATE_RECORD, trust: 'candidate' },
          { recordId: CANARY_RECORD, trust: 'candidate' },
        ],
      }],
    }
    const output = await analysisOf(
      registryWith({ handoff, analysis: readerOf(artifact) }),
      String(handoff.runId),
    )

    expect(output.verdicts[0]?.memoryOnPath).toEqual([
      { recordId: CANDIDATE_RECORD, trust: 'candidate' },
      { recordId: CANARY_RECORD, trust: 'candidate' },
    ])
  })

  it('omits the member for a verdict that declared nothing', async () => {
    const handoff = buildSyntheticHandoff({ failureCount: 1 })
    const output = await analysisOf(
      registryWith({ handoff, analysis: readerOf(artifactFor(handoff)) }),
      String(handoff.runId),
    )

    expect(output.verdicts[0], 'the verdict is still served').toBeDefined()
    expect('memoryOnPath' in (output.verdicts[0] as object)).toBe(false)
  })

  it('keeps an empty declaration empty', async () => {
    const handoff = buildSyntheticHandoff({ failureCount: 1 })
    const artifact: RunAnalysisArtifact = {
      ...artifactFor(handoff),
      verdicts: [{ ...upgradedAppBug(0), memoryOnPath: [] }],
    }
    const output = await analysisOf(
      registryWith({ handoff, analysis: readerOf(artifact) }),
      String(handoff.runId),
    )

    expect(output.verdicts[0]?.memoryOnPath).toEqual([])
  })

  it('gives each member its own declaration', async () => {
    const handoff = buildSyntheticHandoff({ failureCount: 2 })
    const artifact: RunAnalysisArtifact = {
      ...artifactFor(handoff),
      verdicts: [
        upgradedAppBug(0),
        { ...upgradedAppBug(1), memoryOnPath: [{ recordId: CANDIDATE_RECORD, trust: 'candidate' }] },
      ],
      parts: [],
    }
    const output = await analysisOf(
      registryWith({ handoff, analysis: readerOf(artifact) }),
      String(handoff.runId),
    )

    const byMember = new Map(output.verdicts.map((entry) => [entry.perTest, entry.memoryOnPath]))
    expect(byMember.get(0)).toBeUndefined()
    expect(byMember.get(1)).toEqual([{ recordId: CANDIDATE_RECORD, trust: 'candidate' }])
  })
})
