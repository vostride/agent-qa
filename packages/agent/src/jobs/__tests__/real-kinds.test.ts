// The pin: analyze-run declares exactly what it produces, and it is `['curate-memory']`.
//
// Three claims, one list, asserted separately because they are made in different places and
// can drift apart silently. The DECLARATION's allowedSuccessors is one literal list. The
// INSTANCES a successful analysis returns are that same list. The INSTANCES a permanently
// failed analysis hands on — the fallback's — are that same list again. The no-capabilities
// stand-in control asserts it a fourth time from the scripted path.
//
// The failure this file exists to catch is the asymmetric one: a success path narrowed to
// curate-memory while the PERMANENT-FAILURE fallback still maps over a wider declared list.
// That build enqueues, precisely on the runs whose analysis died, a successor no live run
// ever produces — and the chain-terminal arithmetic then waits on a job nothing else knows
// about. Asserting all three sides by literal list is what makes that drift RED by name.
//
// Unit-level on purpose: these are claims about what the registry RETURNS, and proving them
// through a store and a pump would make the assertion depend on everything between.

import { CURRENT_HANDOFF_SCHEMA_VERSION, canonicalJson, sha256hex, CURATION_SNAPSHOT_SCHEMA_VERSION } from '@vostride/agent-qa-schema'
import type {
  ChainedJobRequest,
  CompletedRunHandoff,
  Job,
  JobHandlerOutcome,
} from '@vostride/agent-qa-schema'
import { asRunId } from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'

import {
  createRealJobKindRegistry,
  REAL_JOB_KIND_DECLARATIONS,
} from '../kinds.js'
import type { PostRunJobCapabilities } from '../kinds.js'
import type { JobHandlerContext } from '../kind-registry.js'

const RUN_ID = 'run-388-real-kinds'
const ANALYZE_JOB_ID = 'job_analyze_fixture'

const HANDOFF: CompletedRunHandoff = {
  schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION,
  runId: asRunId(RUN_ID),
  scope: { tier: 'product', key: 'real-kinds' },
  buildOrdinal: 1,
  executionContext: 'local-headless',
  aggregateVerdict: 'failed',
  configDigests: { suiteConfigDigest: 'suite', testConfigDigest: 'test' },
  startedAt: 1,
  endedAt: 2,
  tests: [
    {
      testId: 't_failed',
      testName: 'a member that failed',
      filePath: 'tests/failed.yaml',
      testIndex: 0,
      outcome: 'failed',
      steps: [],
    },
  ],
}

const CAPABILITIES: PostRunJobCapabilities = {
  loadCompletedRunHandoff: () => HANDOFF,
  // Never invoked by the analyze-run cases below; `complete: true` is the shape the widened
  // contract requires, not a claim any assertion here turns on.
  curateRun: async () => ({ curated: 0, deprecated: 0, complete: true }),
  // The 389 artifact write is order-pinned in analyze-run-artifact.test.ts; here it only has
  // to exist so the contract typechecks, exactly like `curateRun` above.
  persistAnalysis: () => {},
}

/** A scripted context: the handler's two capabilities, recorded rather than performed. */
function contextFor(payload: unknown): {
  readonly context: JobHandlerContext
  readonly published: { checkpointId: string; value: unknown }[]
} {
  const published: { checkpointId: string; value: unknown }[] = []
  const job = {
    id: ANALYZE_JOB_ID,
    kind: 'analyze-run',
    status: 'queued',
    summary: 'fixture',
    attempts: 1,
    createdAt: '2026-02-02T00:00:00.000Z',
    updatedAt: '2026-02-02T00:00:00.000Z',
  } as unknown as Job
  return {
    published,
    context: {
      job,
      payload,
      publishCheckpoint: async (checkpointId: string, value: unknown) => {
        published.push({ checkpointId, value })
      },
      // 389's analyze-run authors through the primitive, so the scripted context carries a
      // faithful miss-path stand-in: invoke the author once, record what it returned, hand it
      // back. The resume path and the ordering contract are pinned in
      // analyze-run-artifact.test.ts; nothing here reads a recorded value.
      recordLlmAuthorship: (async (checkpointId: string, author: (model: unknown) => Promise<unknown>) => {
        const value = await author({ modelId: 'stub', generate: async () => ({ text: '' }) })
        published.push({ checkpointId, value })
        return value
      }) as unknown as JobHandlerContext['recordLlmAuthorship'],
    },
  }
}

function analyzeRunDeclaration(): (typeof REAL_JOB_KIND_DECLARATIONS)[number] {
  const declaration = REAL_JOB_KIND_DECLARATIONS.find((entry) => entry.kind === 'analyze-run')
  if (declaration === undefined) throw new Error('analyze-run is not declared')
  return declaration
}

function successorKinds(requests: readonly ChainedJobRequest[]): string[] {
  return requests.map((request) => request.kind)
}

describe('the real post-run kinds', () => {
  it('declares curate-memory as the one allowed successor of analyze-run', () => {
    // The topology half — declared equals produced, and the list is asserted literally rather
    // than counted so the diff says WHAT returned. A second declared successor REDs here by
    // name, and the engine's successor validation would then admit an instance no handler in
    // this file ever produces.
    expect([...analyzeRunDeclaration().allowedSuccessors].sort()).toEqual(['curate-memory'])
  })

  it('returns exactly one curate-memory instance from a successful analysis', async () => {
    const { context, published } = contextFor({
      runId: RUN_ID,
      handoffDigest: sha256hex(canonicalJson(HANDOFF)),
      handoffSchemaVersion: HANDOFF.schemaVersion,
      executionContext: 'local-headless',
    })

    const outcome: JobHandlerOutcome = await createRealJobKindRegistry(CAPABILITIES)
      .require('analyze-run')
      .handler(context)

    expect(published.map((entry) => entry.checkpointId)).toEqual(['verdicts-authored'])
    if (outcome.status !== 'complete') throw new Error(`expected complete, got ${outcome.status}`)
    expect(successorKinds(outcome.next)).toEqual(['curate-memory'])
    expect(outcome.next[0]).toMatchObject({
      idempotencyKey: `${ANALYZE_JOB_ID}->curate-memory`,
      payload: {
        runId: RUN_ID,
        executionContext: 'local-headless',
        verdictSummary: { total: 1, byClass: { unknown: 1 } },
      },
    })
  })

  it('returns exactly one curate-memory continuation from a permanently failed analysis', () => {
    const declaration = analyzeRunDeclaration()
    if (declaration.onPermanentFailure === 'halt-chain') {
      throw new Error('analyze-run must not halt its chain (D-20)')
    }

    const continuations = declaration.onPermanentFailure({
      job: contextFor({}).context.job,
      payload: { runId: RUN_ID, handoffDigest: 'x', handoffSchemaVersion: 5, executionContext: 'ci' },
      reason: 'the handoff could not be read',
    })

    // THE asymmetry this file exists for. Success and failure must produce the same instance
    // set, or a dead analysis is exactly the case that enqueues the job D-04 forbids.
    expect(successorKinds(continuations)).toEqual(['curate-memory'])
    expect(continuations[0]).toMatchObject({
      idempotencyKey: `${ANALYZE_JOB_ID}->curate-memory`,
      payload: {
        // Pitfall 6 / 386 D-09: without these two the daemon-claimed successor resolves a
        // drain-scoped posture and curation cannot find the run it is meant to fold.
        runId: RUN_ID,
        executionContext: 'ci',
        verdicts: 'unknown',
        failureReason: 'the handoff could not be read',
      },
    })
  })

  // WR-03. The fold answers `complete: false` for candidate refusals, a cap exceeded,
  // unresolved canaries, a failed outcome projection and requeues — and in every one of them it
  // writes NO receipt. A handler that published `bundle-committed` anyway would name a
  // checkpoint for an event that did not happen, and the chain terminal built from that
  // checkpoint is the durable record three surfaces render.
  it('reports an incomplete fold as retryable and publishes no bundle-committed', async () => {
    const { context, published } = contextFor({ runId: RUN_ID, executionContext: 'local-headless' })
    const outcome = await createRealJobKindRegistry({
      loadCompletedRunHandoff: () => HANDOFF,
      curateRun: async () => ({ curated: 0, deprecated: 0, complete: false }),
      persistAnalysis: () => {},
    }).require('curate-memory').handler(context)

    if (outcome.status !== 'retryable') {
      throw new Error(`expected retryable, got ${outcome.status}`)
    }
    expect(outcome.reason).toBe(
      'the curation fold did not complete and wrote no receipt; the stage will retry under its '
        + 'declared bound',
    )
    // The POSITIVE half of the absence claim: the handler really did run far enough to publish
    // its first checkpoint, so "no bundle-committed" is a fact about the gate rather than about
    // an empty recorder or a handler that returned before doing anything at all.
    expect(published.map((entry) => entry.checkpointId)).toEqual(['candidates-authored'])
  })

  it('publishes bundle-committed with the counts when the fold completed', async () => {
    // The ACCEPT half, unchanged from before the gate: a complete fold still lands the job
    // `complete` with its counts on the checkpoint the chain terminal reads, and nothing follows.
    const { context, published } = contextFor({ runId: RUN_ID, executionContext: 'local-headless' })
    const outcome = await createRealJobKindRegistry({
      loadCompletedRunHandoff: () => HANDOFF,
      curateRun: async () => ({ curated: 4, deprecated: 2, complete: true }),
      persistAnalysis: () => {},
    }).require('curate-memory').handler(context)

    if (outcome.status !== 'complete') throw new Error(`expected complete, got ${outcome.status}`)
    expect(outcome.next).toEqual([])
    expect(published).toEqual([
      { checkpointId: 'candidates-authored', value: { runId: RUN_ID } },
      { checkpointId: 'bundle-committed', value: { runId: RUN_ID, curated: 4, deprecated: 2 } },
    ])
  })

  it('CURATE-SNAPSHOT-DEGRADES publishes the committed counts without a malformed snapshot and completes', async () => {
    const malformed = {
      schemaVersion: CURATION_SNAPSHOT_SCHEMA_VERSION,
      rows: [],
      breakdown: { added: 5, confirmed: 0, superseded: 0, deprecated: 0, proposed: 0 },
    }
    const { context, published } = contextForKind('curate-memory', 'job_curate_degraded', {
      runId: RUN_ID,
      executionContext: 'local-headless',
    })
    const handled = createRealJobKindRegistry({
      loadCompletedRunHandoff: () => HANDOFF,
      curateRun: async () => ({ curated: 2, deprecated: 1, complete: true, snapshot: malformed as never }),
      persistAnalysis: () => {},
    }).require('curate-memory').handler(context)

    await expect(handled).resolves.toMatchObject({ status: 'complete' })
    const outcome = await handled
    if (outcome.status !== 'complete') throw new Error(`expected complete, got ${outcome.status}`)
    expect(published).toEqual([
      { checkpointId: 'candidates-authored', value: { runId: RUN_ID } },
      { checkpointId: 'bundle-committed', value: { runId: RUN_ID, curated: 2, deprecated: 1 } },
    ])
    expect(outcome.next).toEqual([])
  })

  it('keeps the scripted stand-ins when no capabilities are bound', async () => {
    // NEGATIVE CONTROL for the two cases above: the assertions there would be satisfied just
    // as well by a build that had replaced the stand-ins outright, which would break every
    // registry-driven suite that scripts these kinds by payload. This is the case that must
    // still behave the OLD way.
    const { context } = contextFor({ chain: true })
    const outcome = await createRealJobKindRegistry().require('analyze-run').handler(context)

    if (outcome.status !== 'complete') throw new Error(`expected complete, got ${outcome.status}`)
    expect(successorKinds(outcome.next)).toEqual(['curate-memory'])
  })
})

// curate-memory is the chain's terminal: it declares no successor and produces none, including
// for a fold that curated nothing.

function declarationFor(kind: string): (typeof REAL_JOB_KIND_DECLARATIONS)[number] {
  const declaration = REAL_JOB_KIND_DECLARATIONS.find((entry) => entry.kind === kind)
  if (declaration === undefined) throw new Error(`${kind} is not declared`)
  return declaration
}

/** A scripted context for a kind other than analyze-run, keeping the fixture's one shape. */
function contextForKind(kind: string, jobId: string, payload: unknown): {
  readonly context: JobHandlerContext
  readonly published: { checkpointId: string; value: unknown }[]
} {
  const built = contextFor(payload)
  return {
    published: built.published,
    context: {
      ...built.context,
      job: { ...(built.context.job as unknown as Record<string, unknown>), id: jobId, kind } as unknown as Job,
    },
  }
}

describe('curate-memory ends the post-run chain', () => {
  it('declares no successor and halts the chain on permanent failure', () => {
    expect([...declarationFor('curate-memory').allowedSuccessors]).toEqual([])
    expect(declarationFor('curate-memory').onPermanentFailure).toBe('halt-chain')
  })

  it('completes a fold that curated nothing with no successor', async () => {
    const { context, published } = contextForKind('curate-memory', 'job_curate_zero', {
      runId: RUN_ID,
      executionContext: 'local-headless',
    })

    const outcome = await createRealJobKindRegistry({
      loadCompletedRunHandoff: () => HANDOFF,
      curateRun: async () => ({ curated: 0, deprecated: 0, complete: true }),
      persistAnalysis: () => {},
    }).require('curate-memory').handler(context)

    expect(outcome).toEqual({ status: 'complete', next: [] })
    expect(published.map((entry) => entry.checkpointId))
      .toEqual(['candidates-authored', 'bundle-committed'])
  })
})

describe('a curation run handed back to its own project', () => {
  // a hand-back is the existing retryable outcome carrying its reason.
  it('a curate-memory fold that hands its run back is retryable with its reason', async () => {
    const reason =
      'Run run-388-real-kinds keeps its knowledge in /tmp/other-root; it is left for a run of its own project.'
    const handedBack = { curated: 0, deprecated: 0, complete: false, reason }
    const { context, published } = contextFor({ runId: RUN_ID, executionContext: 'local-headless' })
    const outcome = await createRealJobKindRegistry({
      loadCompletedRunHandoff: () => HANDOFF,
      curateRun: async () => handedBack,
      persistAnalysis: () => {},
    }).require('curate-memory').handler(context)

    expect(outcome).toEqual({ status: 'retryable', reason })
    expect(published.map((entry) => entry.checkpointId)).toEqual(['candidates-authored'])

    const silent = await createRealJobKindRegistry({
      loadCompletedRunHandoff: () => HANDOFF,
      curateRun: async () => ({ curated: 0, deprecated: 0, complete: false }),
      persistAnalysis: () => {},
    }).require('curate-memory').handler(contextFor({ runId: RUN_ID }).context)
    expect(silent).toEqual({
      status: 'retryable',
      reason: 'the curation fold did not complete and wrote no receipt; the stage will retry '
        + 'under its declared bound',
    })
  })
})
