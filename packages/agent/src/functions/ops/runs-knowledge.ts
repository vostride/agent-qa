// `runs.knowledge` — what ONE run used and learned.
//
// THE PANEL'S ONE READ. D-05's posture is that the Knowledge tab is a thin client over a single
// registry verb, not a page composing N `knowledge.brief.why` calls: the browser, the CLI, MCP
// and chat all ask this one question and get the same bytes. That is the fourth-door law applied
// to a surface that would otherwise have been assembled client-side out of per-step reads whose
// answers could disagree with each other about one run.
//
// THE SUBSTRATE IS THE RUN'S HANDOFF, AND NOTHING ELSE. `deps.runs.get` resolves through
// the same `enumerate()` / `loadCompletedRunHandoff` version guard `readStepEvidence` uses, so
// this op and `knowledge.brief.why` can never disagree about what a run recorded. It is NOT the
// dashboard `run_steps` projection — those rows carry no served brief at all.
//
// IT ANSWERS ABOUT THEN. This op is handed no serving capability: there is no index handle in
// scope, so re-running retrieval to explain a brief is not a temptation it has to resist. A step
// whose trace was never captured answers `no-trace: pre-trace-run` — the honest absence — rather
// than a plausible trace computed against today's index (KREV-02's founding argument).
//
// A PRUNED HANDOFF IS A RESULT, NOT A THROW. `runs.digest` next door raises
// `RunNotFoundError` because a digest NAMES a run and a missing one is a bad question. Here the
// caller is a PAGE, and a page whose evidence has been garbage-collected has a legible state to
// render (406 D-17's `EvidenceIncomplete`); a refusal would make that state indistinguishable
// from a broken read.
//
// THE SIBLING OPS ARE INVOKED, NOT REIMPLEMENTED (391's rule). The curation word is the same word
// `runs.postprocessing` serves and the change list is the same list `knowledge.records.diff`
// serves — by CALLING them with this call's deps rather than by a comment promising not to diverge.
// no pending-proposal count is joined; the tab shows what changed. The
// specs are module-internal, so this is composition inside the layer and not a dispatch path
// around `invokeFunction`: every external caller still arrives through the pipeline. 2026-10-01
// the op declares no `read` scope, and no step of that pipeline checks one.

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

/**
 * Lowercase dot taxonomy: the `runs` domain, one noun.
 *
 * `runs.knowledge` and not `knowledge.run`, for the reason `runs.postprocessing` is not
 * `postprocessing.get` — what this returns is a fact ABOUT A RUN. The literal appears here once;
 * every surface names the exported constant and the parity suite picks the id up from the
 * registry.
 */
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

// The three channel projections PICK named fields rather than spreading the producer's value, so
// a field added to the serving contract cannot silently reach a page (405's display posture).
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

/**
 * The plan source, PICKED member by member for the same reason the channels are.
 *
 * This was the one producer value the op spread verbatim, and the wire arm it spread onto is
 * `.strict()` — so the day `StepPlanSource` grew `flow`, every run that had really replayed a
 * procedure started failing `spec.output.parse` with `unrecognized_keys` and the Knowledge tab
 * rendered a read failure for exactly the runs D-07 exists to explain. A field-pick makes that
 * class of break impossible rather than pending: an undeclared member on disk is DROPPED here,
 * and a member this build wants on the wire has to be named in both places on the same commit.
 *
 * Every optional is spread-when-defined, never zero-filled: an absent `miss` is an absent key.
 */
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
    // PICKED, not spread — see `planSourceOf`. Spread-away absence, never a `null` and
    // never a zero-fill: a step that replayed no procedure carries NO `planSource` key, which is
    // a different byte from one that carries an empty source (the layer's own idiom).
    ...(evidence.planSource === undefined
      ? {}
      : { planSource: planSourceOf(evidence.planSource) }),
    ...(rung === undefined ? {} : { retrievalRung: rung }),
  }
}

/**
 * `unbound` means THIS PROJECT HAS NO KNOWLEDGE STORE, derived from durable bytes.
 *
 * The marker is the `truncation` sentence the runner writes when it serves a step with no reader
 * bound — the one durable fact that distinguishes "nothing was configured" from "retrieval ran
 * and served nothing", and one that cannot be recovered from an empty channel list. Derived from
 * the evidence rather than from the handoff version on purpose: a version says WHEN a run
 * happened, not what was bound to it.
 *
 * A run with zero steps reads `bound`, which is the conservative answer — it says nothing about
 * a store rather than reporting an absence nothing observed. A step carrying a recorded rung
 * reads `bound` even if its brief was empty, because a rung is only ever resolved when a reader
 * existed to resolve it against.
 */
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

/**
 * Is this the knowledge store saying "I could not read all of myself"?
 *
 * READ BY NAME, STRUCTURALLY, ON PURPOSE. `KnowledgeMaintenanceScanError` is declared in
 * `packages/knowledge-local`, and this layer is storage-neutral — it holds a PORT, not a store, so
 * it cannot import that class to test with `instanceof` without acquiring a dependency on one
 * particular substrate (403-03 D-4's rule, and the same reason the op's own test file constructs
 * the error rather than importing it). The class pins its own `name` as a readonly literal, which
 * makes the string the stable part of the contract across the boundary.
 *
 * The narrowness is the safety. Only THIS name folds; every other error still leaves this op the
 * way it arrived, so a bound path's real failure is still a failure.
 */
function isScanIncomplete(error: unknown): boolean {
  return error instanceof Error && error.name === 'KnowledgeMaintenanceScanError'
}

type ReadyProjection = Extract<RunKnowledgeProjection, { kind: 'ready' }>
type LearnedChange = ReadyProjection['learned']['changes'][number]
type RecordContent = NonNullable<LearnedChange['recordContent']>
type RecordJoin =
  | { recordContent: RecordContent }
  | { contentAbsence: NonNullable<LearnedChange['contentAbsence']> }

/**
 * Current record content, picked field by field and masked string by string.
 *
 * Trust and status are copied from the maintenance view (`deriveBundleTrust`'s answer), never
 * recomputed, and are named `current*` so no reader mistakes them for what the row recorded.
 * Record identities are not joined strings: the row's own id stays exactly what it was. The pick
 * and the mask are the schema's shared join, which runs.mark.preview's knowledge records use too.
 */
function recordContentOf(
  result: Extract<KnowledgeRecordShowResult, { kind: 'found' }>,
  mask: MaskFn,
): RecordContent {
  return maskRecordContent(projectRecordContent(result), mask)
}

/**
 * ONE batch read over the union of every learned and used identity.
 *
 * There is deliberately no per-id fallback to `showRecord`: that read scans every bundle per id.
 * A host without the batch capability gets a named `not-bound` absence on every row instead, and
 * a store that could not finish the scan gets `scan-incomplete` — never a row silently dropped
 * and never an incomplete scan dressed as ordinary misses.
 */
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

/**
 * Is this attributed change one the fixed snapshot recorded?
 *
 * Compared on the identity both readers retain — record, change, ordinal and replacement — and
 * on the evidence token only where both carry one: `diffSince` reports a record's appearance without
 * the receipt token curation recorded. The snapshot arrives masked, so the change is compared in
 * the same masked form. Record id alone is never enough: a later promotion of a record the
 * snapshot already names is a since-then change.
 */
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
  /**
   * COUNTS, NOT CONTENT (399.1 D-01 · 391 D-18's rule applied here).
   *
   * A receipt line names how much a run used and learned; the brief summaries, step text and
   * record ids themselves stay in `results[]` where a reader asked for them. Interpolating a
   * served summary here would put producer prose — possibly masked material — into an audit map.
   *
   * `evidence-incomplete` is `executed` and not a refusal, on `knowledge.brief.why`'s reasoning:
   * a pruned handoff is an answer this verb is proud of, not a control declining.
   */
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
        // T-407-29. A degraded Learned half and a genuinely empty one both read `0 learned
        // change(s)`, and an audit map that could not tell them apart would let an incomplete scan
        // pass as a clean result forever. A clean read's line is byte-identical to what it always
        // was — the suffix appears only where the flag does.
        + (output.learned.scanIncomplete === true ? ', knowledge store scan incomplete' : ''),
    }
  },
  async invoke(input, deps: FunctionDeps) {
    const runId = String(input.runId)

    const document = await deps.runs.get(input.runId)
    if (document === undefined) {
      // a RESULT. The page renders the evidence-gone state; it does not catch anything.
      return { kind: 'evidence-incomplete', runId }
    }

    const steps = document.tests.flatMap((test) =>
      test.steps.map((evidence) => projectStep(test.testId, test.testIndex, evidence)))
    const evidence = stepsOf(document)

    // Run-constant by construction: the rung is resolved ONCE at composition and stamped
    // on every step, so the first step carrying one carries the run's. Reading it per step as
    // well is what lets a future producer change stay visible rather than silently averaged.
    const runRung = evidence.map(recordedRungOf).find((rung) => rung !== undefined)

    // TWO DIFFERENT QUESTIONS, ANSWERED TWO DIFFERENT WAYS.
    //
    // PRESENCE is still checked rather than caught: "this host has no queue database" is not the
    // same fact as "the queue read threw" (runs-digest's rule), and a blanket try/catch would
    // erase that difference along with every real failure inside a bound path.
    //
    // What IS caught, and only around the two knowledge-store enrichments, is the store's own
    // named scan error (`isScanIncomplete`). A store that cannot read one bundle is not a store
    // that is absent, and it is not a broken op either — it is a store that can answer PART of
    // this question. Each enrichment folds INDEPENDENTLY to an empty list, and the fold is
    // announced on the wire as `learned.scanIncomplete` rather than hidden inside an emptiness the
    // caller would read as "nothing was learned". Anything not carrying that name propagates
    // exactly as it did before.
    //
    // AND THE FLAG IS RAISED BY CONTRACT, NOT BY COINCIDENCE (407-19, REVIEW WR-03). The
    // attribution walk reports `skippedBundles` on its own answer, so a store it could only
    // half-read raises this flag even when it returns rows and even when the records diff read
    // cleanly. Before that count existed, the only thing raising the flag for a half-read store
    // was `diffSince` happening to throw on the same bundle — an inference that fails the moment
    // the two reads see different stores. A degradation marker belongs to the read that degraded;
    // it is never inferred from a sibling.
    let scanIncomplete = false
    const status: PostProcessingStatus | undefined = deps.postProcessing === undefined
      ? undefined
      : await runsPostProcessingSpec.invoke({ runId: input.runId }, deps)
    const curationRow = status?.notification?.stages.curation
    // BOTH counts or neither. The frozen notification row omits them when curation
    // never committed a bundle, and a half-present pair rendered as `curated 3, deprecated 0`
    // would report a number nobody measured.
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
        // The rows are kept BESIDE the flag rather than dropped by it: a bundle the walk could not
        // load denies nothing to the bundles that read cleanly (407-14's rule), and the flag says
        // the list may be short — not that it is worthless.
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

    // ATTRIBUTION, NOT A WINDOW. The since-ordinal only bounds how much the sibling op
    // reads; what makes a row THIS run's is the explicit link — the bundle provenance run id
    // 407-04 stamps, or an observation id recomputed from this run's own served-canary tuples.
    // A row carrying neither is DROPPED rather than guessed at: "this run deprecated that fact"
    // is a sentence a person acts on, and a neighbouring run's curation must never wear it.
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
      // `diffSince` keeps its MAINTENANCE-grade contract next door: a malformed bundle is an error
      // to a maintainer asking what changed, and this op does not soften it there. The degradation
      // belongs HERE, where the caller is a page (D-06's absence-is-a-result posture applied to the
      // Learned enrichment) — an empty attributed list, and a flag naming why it is empty.
      if (!isScanIncomplete(error)) throw error
      scanIncomplete = true
      changes = []
    }

    const mask = requireSecretMask(deps, RUNS_KNOWLEDGE_FUNCTION_ID)

    // The fixed checkpoint first; the notification carries a copy of the same snapshot.
    const curationSnapshot = status?.curationSnapshot
      ?? status?.notification?.stages.curation.curationSnapshot

    // THE SNAPSHOT'S OWN RECORD IS ALSO AN ATTRIBUTION (427-02, owner decision option-a). A
    // confirmation, deprecation or supersession of a record an earlier run created carries no run
    // link in the store, yet this run's curation recorded it by exact identity. Admitting it here,
    // before the join, is what gives every snapshot row its content; record id alone never admits.
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
        // `undefined` answers exactly as an empty chain does — nothing was enqueued for this run
        // — which is what a host with no queue database can honestly say (388's own note).
        status: status?.chips.curation ?? projectPostProcessingChips(undefined).curation,
        ...(countsPresent && curationRow !== undefined
          ? {
              counts: {
                curated: curationRow.curated as number,
                deprecated: curationRow.deprecated as number,
              },
            }
          : {}),
        // the run's own handoff says why its chain was never enqueued,
        // by the fold runs.postprocessing calls, so it holds on a host with no queue database too.
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
