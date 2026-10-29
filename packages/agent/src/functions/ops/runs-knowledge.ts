// Reads the run's handoff only, and invokes sibling ops rather than reimplementing them.

import {
  maskRecordContent,
  NO_KNOWLEDGE_READER_TRUNCATION,
  projectRecordContent,
  RecordedRetrievalRungSchema,
  RunKnowledgeProjectionSchema,
  RunsKnowledgeInputSchema,
} from '@vostride/agent-qa-schema'
import type {
  BriefLine,
  CautionLine,
  CompletedRunHandoff,
  CurationSnapshot,
  KnowledgeRecordShowResult,
  MaskFn,
  PostProcessingStatus,
  ReadTrace,
  RecordChange,
  RecordedRetrievalRung,
  RunKnowledgeCanaryAttribution,
  RunKnowledgePlanSource,
  RunKnowledgeProjection,
  RunKnowledgeStep,
  RunKnowledgeTrace,
  RunsKnowledgeInput,
  StepEvidence,
  StepPlanSource,
} from '@vostride/agent-qa-schema'

import type { ClauseVerdict, FunctionDeps, FunctionSpec, KnowledgeReaderPort } from '../spec.js'
import { knowledgeRecordsDiffSpec } from './knowledge-records-diff.js'
import {
  projectPostProcessingChips,
  projectPostProcessingSkipped,
  runsPostProcessingSpec,
} from './runs-post-processing.js'
import { requireSecretMask } from './secret-mask.js'

// Under `runs.` because it returns a fact about a run.
export const RUNS_KNOWLEDGE_FUNCTION_ID = 'runs.knowledge'

/**
 * The recorded rung, VALIDATED and never cast, because the handoff is bytes another build wrote.
 */
function recordedRungOf(evidence: StepEvidence): RecordedRetrievalRung | undefined {
  if (evidence.retrievalRung === undefined) return undefined
  const parsed = RecordedRetrievalRungSchema.safeParse(evidence.retrievalRung)
  return parsed.success ? parsed.data : undefined
}

/**
 * Why this step's brief said what it said — `mapStepEvidenceToWhy`'s `found` arm, per step.
 *
 * The two arms and the `pre-trace-run` reason are the why-verb's own vocabulary rather than a
 * second spelling of it: the panel and `knowledge.brief.why` answer about the same step with the
 * same word. The lookup arms that verb also carries (`run-not-recorded`, `step-not-found`) cannot
 * arise here — a step reached through the loaded document exists by construction — so the panel's
 * evidence-gone state is the projection's own `evidence-incomplete` arm one level up.
 */
function traceArmOf(evidence: StepEvidence): RunKnowledgeTrace {
  const trace = evidence.retrievalTrace
  if (trace === undefined) {
    return { kind: 'no-trace', reason: 'pre-trace-run' }
  }
  return { kind: 'answered', trace }
}

// Channels pick named fields, so a new serving-contract field cannot silently reach a page.
function briefLine(line: BriefLine): RunKnowledgeStep['served']['channel1'][number] {
  return {
    id: String(line.id),
    kind: line.kind,
    summary: line.summary,
    trust: line.trust,
    status: line.status,
    servedAsCanary: line.servedAsCanary,
    tier: line.tier,
  }
}

function readTrace(entry: ReadTrace): RunKnowledgeStep['served']['channel2'][number] {
  return {
    id: String(entry.id),
    detailLevel: entry.detailLevel,
    bodyDigest: entry.bodyDigest,
  }
}

/** Anchors are deliberately dropped: the panel renders a caution's sentence and nothing else. */
function cautionLine(line: CautionLine): RunKnowledgeStep['served']['channel3'][number] {
  return { id: String(line.id), summary: line.summary }
}

// Picked member by member, because the strict wire arm refuses any undeclared producer field.
function planSourceOf(source: StepPlanSource): RunKnowledgePlanSource {
  if (source.kind === 'procedure-hint') {
    return {
      kind: 'procedure-hint',
      procedureId: String(source.procedureId),
      ...(source.demotion === undefined ? {} : { demotion: source.demotion }),
    }
  }
  const { checksPassed, total, miss, executionFailure, verifierRejection } = source.guard
  const { flow } = source
  return {
    kind: 'procedure-replay',
    procedureId: String(source.procedureId),
    guard: {
      checksPassed,
      total,
      ...(miss === undefined
        ? {}
        : { miss: { procedureStepIndex: miss.procedureStepIndex, reason: miss.reason } }),
      ...(executionFailure === undefined
        ? {}
        : { executionFailure: { procedureStepIndex: executionFailure.procedureStepIndex } }),
      ...(verifierRejection === undefined
        ? {}
        : { verifierRejection: { procedureStepIndex: verifierRejection.procedureStepIndex } }),
    },
    ...(flow === undefined ? {} : { flow: { cursor: flow.cursor, length: flow.length } }),
  }
}

function projectStep(
  testId: string,
  testIndex: number,
  evidence: StepEvidence,
): RunKnowledgeStep {
  const rung = recordedRungOf(evidence)
  return {
    testId,
    testIndex,
    stepIndex: evidence.stepIndex,
    stepText: evidence.stepText,
    served: {
      channel1: evidence.servedBrief.channel1.map(briefLine),
      channel2: evidence.servedBrief.channel2.map(readTrace),
      channel3: evidence.servedBrief.channel3.map(cautionLine),
    },
    trace: traceArmOf(evidence),
    // Picked, not spread: a step that replayed nothing carries no `planSource` key.
    ...(evidence.planSource === undefined
      ? {}
      : { planSource: planSourceOf(evidence.planSource) }),
    ...(rung === undefined ? {} : { retrievalRung: rung }),
  }
}

// Derived from the runner's truncation marker, the only durable trace of an unbound reader.
function knowledgeStoreOf(steps: readonly StepEvidence[]): 'bound' | 'unbound' {
  if (steps.length === 0) return 'bound'
  const everyStepUnserved = steps.every(
    (evidence) => evidence.servedBrief.truncation === NO_KNOWLEDGE_READER_TRUNCATION,
  )
  const noRungRecorded = steps.every((evidence) => recordedRungOf(evidence) === undefined)
  return everyStepUnserved && noRungRecorded ? 'unbound' : 'bound'
}

function stepsOf(document: CompletedRunHandoff): readonly StepEvidence[] {
  return document.tests.flatMap((test) => test.steps)
}

// Matched by `name`, because this storage-neutral layer cannot import the store's error class.
function isScanIncomplete(error: unknown): boolean {
  return error instanceof Error && error.name === 'KnowledgeMaintenanceScanError'
}

type ReadyProjection = Extract<RunKnowledgeProjection, { kind: 'ready' }>
type LearnedChange = ReadyProjection['learned']['changes'][number]
type RecordContent = NonNullable<LearnedChange['recordContent']>
type RecordJoin =
  | { recordContent: RecordContent }
  | { contentAbsence: NonNullable<LearnedChange['contentAbsence']> }

// Trust and status are copied from the maintenance view and named `current*`, never recomputed.
function recordContentOf(
  result: Extract<KnowledgeRecordShowResult, { kind: 'found' }>,
  mask: MaskFn,
): RecordContent {
  return maskRecordContent(projectRecordContent(result), mask)
}

// No per-id `showRecord` fallback, which would scan every bundle per id.
async function joinRecords(
  knowledge: KnowledgeReaderPort,
  recordIds: readonly string[],
  mask: MaskFn,
): Promise<{ joinFor: (recordId: string) => RecordJoin; scanIncomplete: boolean }> {
  const showRecords = knowledge.showRecords
  if (showRecords === undefined) {
    return { joinFor: () => ({ contentAbsence: { reason: 'not-bound' } }), scanIncomplete: false }
  }
  const unique = [...new Set(recordIds)]
  if (unique.length === 0) {
    return { joinFor: () => ({ contentAbsence: { reason: 'not-found' } }), scanIncomplete: false }
  }
  let results: readonly KnowledgeRecordShowResult[]
  try {
    results = await showRecords.call(knowledge, { recordIds: unique })
  } catch (error) {
    if (!isScanIncomplete(error)) throw error
    return {
      joinFor: () => ({ contentAbsence: { reason: 'scan-incomplete' } }),
      scanIncomplete: true,
    }
  }
  const found = new Map<string, RecordContent>()
  for (const result of results) {
    if (result.kind === 'found') found.set(result.record.recordId, recordContentOf(result, mask))
  }
  return {
    joinFor: (recordId) => {
      const content = found.get(recordId)
      return content === undefined
        ? { contentAbsence: { reason: 'not-found' } }
        : { recordContent: content }
    },
    scanIncomplete: false,
  }
}

// Record id alone never matches: a later promotion of a snapshot record is a since-then change.
function recordedBySnapshot(
  change: RecordChange,
  snapshot: CurationSnapshot,
  mask: MaskFn,
): boolean {
  const recordId = mask(change.recordId)
  const byRecordId = change.byRecordId === undefined ? undefined : mask(change.byRecordId)
  const evidenceToken = change.evidenceToken === undefined ? undefined : mask(change.evidenceToken)
  return snapshot.rows.some((row) => row.changes.some(({ change: recorded }) =>
    recorded.recordId === recordId
    && recorded.change === change.change
    && recorded.atOrdinal === change.atOrdinal
    && recorded.byRecordId === byRecordId
    && (recorded.evidenceToken === undefined || evidenceToken === undefined
      || recorded.evidenceToken === evidenceToken)))
}

export const runsKnowledgeSpec: FunctionSpec<RunsKnowledgeInput, RunKnowledgeProjection> = {
  id: RUNS_KNOWLEDGE_FUNCTION_ID,
  summary: "Project one run's used brief channels, serve-time traces, procedure use, recorded "
    + 'retrieval rung and curator deltas from its handoff.',
  resultKind: 'unary',
  // NO OPTIONAL-DEP BINDING KEY IS DECLARED ON THIS SPEC AT ALL, and the absence is a claim about
  // the op's substrate rather than an oversight. Its truth is the RUNS port, and that port is
  // REQUIRED — so, exactly like `knowledge.brief.why`, there is no composition that lists this
  // verb and then cannot run it. The optional deps it consults (`postProcessing` and the reader's
  // `canaryAttributions`) only ENRICH the Learned half; binding
  // this op to any of them would leave a host with no queue database unable to see what its own
  // runs used, which is the majority of this projection. Pinned by a cell, and by the grep in the
  // plan's own acceptance criteria — which is why the declaration keyword is not spelled anywhere
  // in this file, including in this comment.
  input: RunsKnowledgeInputSchema,
  output: RunKnowledgeProjectionSchema,
  risk: { name: `fn:${RUNS_KNOWLEDGE_FUNCTION_ID}`, recognized: true, readOnly: true },
  // Counts only, so no served summary or masked material reaches an audit map.
  classify(output): ClauseVerdict {
    if (output.kind === 'evidence-incomplete') {
      return {
        status: 'executed',
        outcome: `knowledge for ${output.runId} — evidence incomplete`,
      }
    }
    const briefLines = output.steps.reduce(
      (total, step) => total + step.served.channel1.length,
      0,
    )
    return {
      status: 'executed',
      outcome: `knowledge for ${output.runId} — ${String(output.steps.length)} steps, `
        + `${String(briefLines)} brief lines served, `
        + `${String(output.learned.changes.length)} learned change(s)`
        // The suffix keeps a degraded Learned half from reading as a clean empty one.
        + (output.learned.scanIncomplete === true ? ', knowledge store scan incomplete' : ''),
    }
  },
  async invoke(input, deps: FunctionDeps) {
    const runId = String(input.runId)

    const document = await deps.runs.get(input.runId)
    if (document === undefined) {
      // A result: the page renders the evidence-gone state.
      return { kind: 'evidence-incomplete', runId }
    }

    const steps = document.tests.flatMap((test) =>
      test.steps.map((evidence) => projectStep(test.testId, test.testIndex, evidence)))
    const evidence = stepsOf(document)

    // The rung is run-constant, but reading it per step keeps a producer change visible.
    const runRung = evidence.map(recordedRungOf).find((rung) => rung !== undefined)

    // Only the store's named scan error is caught; the walk's `skippedBundles` also sets the flag.
    let scanIncomplete = false
    const status: PostProcessingStatus | undefined = deps.postProcessing === undefined
      ? undefined
      : await runsPostProcessingSpec.invoke({ runId: input.runId }, deps)
    const curationRow = status?.notification?.stages.curation
    // Both counts or neither, so a half-present pair never reports an unmeasured number.
    const countsPresent = curationRow?.curated !== undefined
      && curationRow.deprecated !== undefined

    // Channel 1 only — a `ReadTrace` has no `servedAsCanary` authority (the pin
    // `emit-canary-outcomes.ts` already relies on), and the served line's own id IS the curation
    // candidate id.
    const tuples = document.tests.flatMap((test) =>
      test.steps.flatMap((step) =>
        step.servedBrief.channel1
          .filter((line) => line.servedAsCanary)
          .map((line) => ({
            candidateId: String(line.id),
            testId: test.testId,
            testIndex: test.testIndex,
            stepIndex: step.stepIndex,
          }))))

    const attribute = deps.knowledge.canaryAttributions
    let attributions: Awaited<ReturnType<NonNullable<typeof attribute>>>['rows'] = []
    if (attribute !== undefined && tuples.length > 0) {
      try {
        const attributed = await attribute.call(deps.knowledge, { runId, tuples })
        attributions = attributed.rows
        // Rows stay beside the flag: an unreadable bundle denies nothing to the ones that read.
        if (attributed.skippedBundles > 0) scanIncomplete = true
      } catch (error) {
        if (!isScanIncomplete(error)) throw error
        scanIncomplete = true
        attributions = []
      }
    }
    // Rows appear ONLY for a tuple with a surviving attributed outcome; one still pending is
    // absent here and the panel reads "attribution pending" from the curation word. `flatMap`
    // rather than filter-then-map so the narrowing is PROVED by the control flow instead of
    // re-stated in an assertion the compiler cannot check against a later shape change.
    const canaryAttributions: RunKnowledgeCanaryAttribution[] = attributions.flatMap((row) =>
      row.outcome === undefined
        ? []
        : [{
            testIndex: row.testIndex,
            stepIndex: row.stepIndex,
            recordId: row.candidateId,
            observationId: row.observationId,
            outcome: row.outcome,
          }])

    // A row needs an explicit link to this run; one with neither link is dropped, never guessed.
    const observationIds = new Set(attributions.map((row) => row.observationId))
    let changes: RecordChange[] = []
    let diffChanges: readonly RecordChange[] = []
    try {
      const diff = await knowledgeRecordsDiffSpec.invoke(
        { sinceOrdinal: Math.max(0, document.buildOrdinal - 1) },
        deps,
      )
      diffChanges = diff.changes
      changes = diff.changes.filter((change) =>
        change.sourceRunId === runId
        || (change.observationId !== undefined && observationIds.has(change.observationId)))
    } catch (error) {
      // `diffSince` keeps its maintenance-grade error; the degradation happens only here.
      if (!isScanIncomplete(error)) throw error
      scanIncomplete = true
      changes = []
    }

    const mask = requireSecretMask(deps, RUNS_KNOWLEDGE_FUNCTION_ID)

    // The fixed checkpoint first; the notification carries a copy of the same snapshot.
    const curationSnapshot = status?.curationSnapshot
      ?? status?.notification?.stages.curation.curationSnapshot

    // A snapshot record matched by exact identity counts as this run's attribution.
    if (curationSnapshot !== undefined) {
      const linked = new Set(changes)
      changes = diffChanges.filter((change) =>
        linked.has(change) || recordedBySnapshot(change, curationSnapshot, mask))
    }

    const join = await joinRecords(deps.knowledge, [
      ...steps.flatMap((row) => [
        ...row.served.channel1.map((line) => line.id),
        ...row.served.channel2.map((line) => line.id),
        ...row.served.channel3.map((line) => line.id),
      ]),
      ...changes.map((row) => row.recordId),
    ], mask)
    if (join.scanIncomplete) scanIncomplete = true
    const joinedSteps = steps.map((row) => ({
      ...row,
      served: {
        channel1: row.served.channel1.map((line) => ({ ...line, ...join.joinFor(line.id) })),
        channel2: row.served.channel2.map((line) => ({ ...line, ...join.joinFor(line.id) })),
        channel3: row.served.channel3.map((line) => ({ ...line, ...join.joinFor(line.id) })),
      },
    }))
    const joinedChanges: LearnedChange[] = changes.map((row) => ({
      ...row,
      ...join.joinFor(row.recordId),
    }))

    const skipped = projectPostProcessingSkipped(document)

    const sinceThen = curationSnapshot === undefined
      ? undefined
      : joinedChanges.filter((row) => !recordedBySnapshot(row, curationSnapshot, mask))

    return {
      kind: 'ready',
      runId,
      buildOrdinal: document.buildOrdinal,
      knowledgeStore: knowledgeStoreOf(evidence),
      ...(runRung === undefined ? {} : { retrievalRung: runRung }),
      steps: joinedSteps,
      curation: {
        // `undefined` answers as an empty chain: nothing was enqueued for this run.
        status: status?.chips.curation ?? projectPostProcessingChips(undefined).curation,
        ...(countsPresent && curationRow !== undefined
          ? {
              counts: {
                curated: curationRow.curated as number,
                deprecated: curationRow.deprecated as number,
              },
            }
          : {}),
        // The handoff's own skip reason, so it holds on a host with no queue database.
        ...(skipped === undefined ? {} : { skipped: { reason: skipped.reason } }),
      },
      learned: {
        changes: joinedChanges,
        canaryAttributions,
        ...(curationSnapshot === undefined ? {} : { curationSnapshot }),
        // Withheld by the nested read: the snapshot and sinceThen stay absent, the rows stay served.
        ...(status?.curationSnapshotWithheld === undefined
          ? {}
          : { curationSnapshotWithheld: status.curationSnapshotWithheld }),
        ...(sinceThen === undefined
          ? {}
          : { sinceThen: { changes: sinceThen, count: sinceThen.length } }),
        // Spread-when-true, never zero-filled: an absent key is the clean read, and `false` is a
        // byte this DTO does not have (the layer's own no-null idiom).
        ...(scanIncomplete ? { scanIncomplete: true as const } : {}),
      },
    }
  },
}
