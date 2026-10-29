// A run with no completed handoff is refused before any projection row is read.

import {
  RUN_OVERVIEW_TEXT_MAX_CODE_POINTS,
  RUN_OVERVIEW_TRUNCATION_INDICATOR,
  RunOverviewProjectionSchema,
  RunsOverviewInputSchema,
} from '@vostride/agent-qa-schema'
import type {
  CompletedRunHandoff,
  EvidenceAbsenceReason,
  EvidenceKind,
  MaskFn,
  RecordedTargets,
  RecordingEntry,
  RunDetailMember,
  RunDetailRows,
  RunDetailStep,
  RunDetailSubAction,
  RunKnowledgeProjection,
  RunKnowledgeStep,
  RunOverviewAria,
  RunOverviewEvidenceAddress,
  RunOverviewLearned,
  RunOverviewProjection,
  RunOverviewRecord,
  RunOverviewRecording,
  RunOverviewScreenshot,
  RunOverviewStep,
  RunOverviewStepEvidence,
  RunOverviewText,
  RunsOverviewInput,
} from '@vostride/agent-qa-schema'

import { FunctionNotBoundError } from '../spec.js'
import type { ClauseVerdict, FunctionDeps, FunctionSpec } from '../spec.js'
import { annotatePresence } from './evidence-presence.js'
import { refuseMissingHandoff, RunNotFoundError } from './runs-get.js'
import { runsKnowledgeSpec } from './runs-knowledge.js'
import { projectPostProcessingSkipped } from './runs-post-processing.js'
import { requireSecretMask } from './secret-mask.js'

export const RUNS_OVERVIEW_FUNCTION_ID = 'runs.overview'

const SCREENSHOT_REF_PREFIX = 'decision-screenshot:'

type ReadyKnowledge = Extract<RunKnowledgeProjection, { kind: 'ready' }>
type Presence = ReadonlyMap<string, boolean>
type NonAriaKind = Exclude<EvidenceKind, 'aria'>
type StoredEvidence = NonNullable<RunDetailStep['evidence']>
type Captured =
  | { state: 'present' }
  | { state: 'absent'; reason: EvidenceAbsenceReason; evidenceIncomplete?: boolean }

/**
 * Mask first, then fold line breaks and cut: either one before masking could change a declared
 * secret so the mask no longer recognises it. Code points, not UTF-16 units, so a cut never lands
 * inside a pair.
 */
export function overviewText(raw: string, mask: MaskFn): RunOverviewText {
  const masked = mask(raw).replace(/\s*[\r\n]+\s*/g, ' ')
  const points = [...masked]
  if (points.length <= RUN_OVERVIEW_TEXT_MAX_CODE_POINTS) return { text: masked }
  return {
    text: points.slice(0, RUN_OVERVIEW_TEXT_MAX_CODE_POINTS).join('')
      + RUN_OVERVIEW_TRUNCATION_INDICATOR,
    truncated: true,
  }
}

const withPresence = (presence: Presence, sha: string) => {
  const answer = presence.get(sha)
  return answer === undefined ? {} : { present: answer }
}

const withIncomplete = (flag: boolean | undefined) =>
  flag === true ? { evidenceIncomplete: true as const } : {}

/** Every ref a whole overview may report presence for, stat'd once per distinct sha. */
async function readPresence(
  deps: FunctionDeps,
  runId: RunsOverviewInput['runId'],
  rows: RunDetailRows | undefined,
): Promise<Presence> {
  if (rows === undefined) return new Map()
  const refs: { sha: string }[] = []
  for (const member of rows.members) {
    if (member.recording?.state === 'present') refs.push(member.recording.ref)
  }
  for (const step of rows.steps) {
    for (const entry of Object.values(step.evidence ?? {})) {
      if (entry.state === 'present' && 'ref' in entry) refs.push(entry.ref)
    }
  }
  for (const child of rows.subActions) {
    for (const ref of child.artifactRefs ?? []) {
      if (ref.id.startsWith(SCREENSHOT_REF_PREFIX)) refs.push(ref)
    }
    if (child.ariaEvidence?.state === 'present') refs.push(child.ariaEvidence.ref)
  }
  const distinct = [...new Map(refs.map((ref) => [ref.sha, { sha: ref.sha }])).values()]
  const annotated = await annotatePresence(deps.evidenceBlobs, runId, distinct)
  const presence = new Map<string, boolean>()
  for (const ref of annotated) {
    if (ref.present !== undefined) presence.set(ref.sha, ref.present)
  }
  return presence
}

function projectRecording(member: RunDetailMember | undefined, runId: string,
  presence: Presence): RunOverviewRecording {
  const recording: RecordingEntry | undefined = member?.recording
  if (recording === undefined) return { state: 'absent', reason: 'unavailable' }
  if (recording.state === 'absent') {
    return { state: 'absent', reason: recording.reason, ...withIncomplete(recording.evidenceIncomplete) }
  }
  return {
    state: 'present',
    address: { runId, sha: recording.ref.sha },
    contentType: recording.contentType,
    byteLength: recording.byteLength,
    ...(recording.durationMs === undefined ? {} : { durationMs: recording.durationMs }),
    ...withPresence(presence, recording.ref.sha),
    ...withIncomplete(recording.ref.evidenceIncomplete),
  }
}

function projectEvidence(
  stored: StoredEvidence | undefined,
  base: Omit<RunOverviewEvidenceAddress, 'kind' | 'subActionIndex'>,
  presence: Presence,
): RunOverviewStepEvidence {
  // A historical row with no persisted entries reads `unavailable`, exactly as runs.detail does.
  const absent = <K extends NonAriaKind>(kind: K, entry: Captured | undefined) => {
    const recorded = entry?.state === 'absent' ? entry : undefined
    return {
      kind,
      state: 'absent' as const,
      reason: recorded?.reason ?? 'unavailable',
      ...withIncomplete(recorded?.evidenceIncomplete),
      address: { ...base, kind },
    }
  }
  const consoleEntry = stored?.console
  const network = stored?.network
  const a11y = stored?.a11y
  const variables = stored?.variables
  return {
    console: consoleEntry?.state === 'present'
      ? { kind: 'console', state: 'present', counts: { ...consoleEntry.counts },
          ...withPresence(presence, consoleEntry.ref.sha), address: { ...base, kind: 'console' } }
      : absent('console', consoleEntry),
    network: network?.state === 'present'
      ? { kind: 'network', state: 'present', counts: { ...network.counts },
          ...withPresence(presence, network.ref.sha), address: { ...base, kind: 'network' } }
      : absent('network', network),
    a11y: a11y?.state === 'present'
      ? { kind: 'a11y', state: 'present', counts: { ...a11y.counts },
          ...withPresence(presence, a11y.ref.sha), address: { ...base, kind: 'a11y' } }
      : absent('a11y', a11y),
    variables: variables?.state === 'present'
      ? { kind: 'variables', state: 'present', counts: { count: variables.counts.count },
          address: { ...base, kind: 'variables' } }
      : absent('variables', variables),
  }
}

function projectAria(child: RunDetailSubAction,
  base: Omit<RunOverviewEvidenceAddress, 'kind' | 'subActionIndex'>,
  presence: Presence): RunOverviewAria {
  const address = { ...base, subActionIndex: child.subActionIndex, kind: 'aria' as const }
  const aria = child.ariaEvidence
  if (aria === undefined || aria.state === 'absent') {
    return {
      subActionIndex: child.subActionIndex,
      state: 'absent',
      reason: aria?.reason ?? 'unavailable',
      ...withIncomplete(aria?.evidenceIncomplete),
      address,
    }
  }
  return {
    subActionIndex: child.subActionIndex,
    state: 'present',
    ...withPresence(presence, aria.ref.sha),
    address,
  }
}

function projectScreenshots(children: readonly RunDetailSubAction[], runId: string,
  presence: Presence): RunOverviewScreenshot[] {
  return children.flatMap((child) => (child.artifactRefs ?? [])
    .filter((ref) => ref.id.startsWith(SCREENSHOT_REF_PREFIX))
    .map((ref) => ({
      subActionIndex: child.subActionIndex,
      sha: ref.sha,
      ...withPresence(presence, ref.sha),
      ...withIncomplete(ref.evidenceIncomplete),
      address: { runId, sha: ref.sha },
    })))
}

type JoinedLine = { recordContent?: { kind: string; summary: string }
  contentAbsence?: { reason: NonNullable<RunOverviewRecord['unavailable']>['reason'] } }

function projectRecord(
  recordId: string,
  channel: RunOverviewRecord['channel'],
  served: { kind?: string; summary?: string },
  joined: JoinedLine,
  mask: MaskFn,
): RunOverviewRecord {
  const kind = served.kind ?? joined.recordContent?.kind
  const summary = served.summary ?? joined.recordContent?.summary
  const missing = kind === undefined || summary === undefined
  return {
    recordId,
    channel,
    ...(kind === undefined ? {} : { kind }),
    ...(summary === undefined ? {} : { summary: overviewText(summary, mask) }),
    ...(missing ? { unavailable: { reason: joined.contentAbsence?.reason ?? 'not-found' } } : {}),
  }
}

function projectRecords(step: RunKnowledgeStep, mask: MaskFn): RunOverviewRecord[] {
  return [
    ...step.served.channel1.map((line) =>
      projectRecord(line.id, 'brief', { kind: line.kind, summary: line.summary }, line, mask)),
    ...step.served.channel2.map((line) => projectRecord(line.id, 'read', {}, line, mask)),
    ...step.served.channel3.map((line) =>
      projectRecord(line.id, 'caution', { summary: line.summary }, line, mask)),
  ]
}

function projectSteps(
  test: CompletedRunHandoff['tests'][number],
  runId: string,
  rows: RunDetailRows | undefined,
  knowledge: ReadyKnowledge,
  presence: Presence,
  mask: MaskFn,
): RunOverviewStep[] {
  const detail = new Map<number, RunDetailStep>()
  for (const step of rows?.steps ?? []) {
    if (step.testIndex === test.testIndex) detail.set(step.stepIndex, step)
  }
  const served = new Map<number, RunKnowledgeStep>()
  for (const step of knowledge.steps) {
    if (step.testIndex === test.testIndex) served.set(step.stepIndex, step)
  }
  const recorded = new Map(test.steps.map((step) => [step.stepIndex, step]))
  const indices = [...new Set([...recorded.keys(), ...detail.keys()])].sort((a, b) => a - b)
  return indices.map((stepIndex): RunOverviewStep => {
    const label = recorded.get(stepIndex)?.stepText ?? detail.get(stepIndex)?.stepText
    const row = detail.get(stepIndex)
    const base = { runId, testIndex: test.testIndex, stepIndex }
    const children = (rows?.subActions ?? [])
      .filter((child) => child.testIndex === test.testIndex && child.stepIndex === stepIndex)
      .sort((left, right) => left.subActionIndex - right.subActionIndex)
    const knowledgeStep = served.get(stepIndex)
    return {
      stepIndex,
      ...(label === undefined ? {} : { label: overviewText(label, mask) }),
      ...(row?.status === undefined ? {} : { status: row.status }),
      capture: row === undefined ? { state: 'unavailable' } : {
        state: 'recorded',
        screenshots: projectScreenshots(children, runId, presence),
        evidence: projectEvidence(row.evidence, base, presence),
        aria: children.map((child) => projectAria(child, base, presence)),
      },
      knowledge: knowledgeStep === undefined ? { state: 'unavailable' } : {
        state: 'recorded',
        records: projectRecords(knowledgeStep, mask),
        brief: {
          address: { runId, testId: test.testId, stepIndex },
          trace: knowledgeStep.trace.kind === 'answered'
            ? { kind: 'answered' }
            : { kind: 'no-trace', reason: knowledgeStep.trace.reason },
        },
      },
    }
  })
}

function projectLearned(knowledge: ReadyKnowledge, document: CompletedRunHandoff): RunOverviewLearned {
  const { learned, curation } = knowledge
  const skipped = projectPostProcessingSkipped(document)
  const snapshot: RunOverviewLearned['snapshot'] = learned.curationSnapshot !== undefined
    ? {
        state: 'recorded',
        breakdown: { ...learned.curationSnapshot.breakdown },
        rows: learned.curationSnapshot.rows.map((row) => ({
          recordId: row.recordId,
          bucket: row.bucket,
          ...(row.byRecordId === undefined ? {} : { byRecordId: row.byRecordId }),
        })),
      }
    : learned.curationSnapshotWithheld !== undefined
      ? { state: 'withheld', reason: learned.curationSnapshotWithheld.reason }
      : { state: 'not-recorded' }
  return {
    knowledgeStore: knowledge.knowledgeStore,
    curation: {
      status: curation.status,
      ...(curation.counts === undefined ? {} : { counts: { ...curation.counts } }),
      // The handoff's own skip reason; an ordinary run carries no key.
      ...(skipped === undefined ? {} : { skipped: { reason: skipped.reason } }),
    },
    snapshot,
    changes: learned.changes.map((change) => ({
      recordId: change.recordId,
      change: change.change,
      atOrdinal: change.atOrdinal,
    })),
    ...(learned.scanIncomplete === true ? { scanIncomplete: true as const } : {}),
  }
}

export const runsOverviewSpec: FunctionSpec<RunsOverviewInput, RunOverviewProjection> = {
  id: RUNS_OVERVIEW_FUNCTION_ID,
  summary: 'Map one completed run: its tests and steps with verdicts, and the address of '
    + 'everything recorded at each, without bodies, traces or bytes.',
  resultKind: 'unary',
  boundThrough: 'runDetail',
  input: RunsOverviewInputSchema,
  output: RunOverviewProjectionSchema,
  risk: { name: `fn:${RUNS_OVERVIEW_FUNCTION_ID}`, recognized: true, readOnly: true },
  classify(output): ClauseVerdict {
    const steps = output.tests.reduce((total, test) => total + test.steps.length, 0)
    return {
      status: 'executed',
      outcome: `overview of ${output.runId} — ${String(output.tests.length)} test(s), `
        + `${String(steps)} step(s)`,
    }
  },
  async invoke(input, deps) {
    const port = deps.runDetail
    if (port === undefined) throw new FunctionNotBoundError(RUNS_OVERVIEW_FUNCTION_ID)

    const document = await deps.runs.get(input.runId)
    if (document === undefined) return refuseMissingHandoff(input.runId, deps)
    const runId = String(document.runId)

    const read = await port.read(input.runId)
    const rows = read?.runId === runId ? read : undefined
    const knowledge = await runsKnowledgeSpec.invoke({ runId: input.runId }, deps)
    // The handoff vanished between the two reads: the same refusal as never having had one.
    if (knowledge.kind !== 'ready') throw new RunNotFoundError(runId)
    const recordedTargets: RecordedTargets = deps.runs.getRecordedTargets === undefined
      ? { status: 'unknown' }
      : await deps.runs.getRecordedTargets(input.runId)
    const presence = await readPresence(deps, input.runId, rows)
    const mask = requireSecretMask(deps, RUNS_OVERVIEW_FUNCTION_ID)

    return {
      runId,
      scope: { tier: document.scope.tier, key: document.scope.key },
      recordedTargets: recordedTargets.status === 'recorded'
        ? { status: 'recorded', names: [...recordedTargets.names] }
        : { status: 'unknown' },
      aggregateVerdict: document.aggregateVerdict,
      buildOrdinal: document.buildOrdinal,
      startedAt: document.startedAt,
      endedAt: document.endedAt,
      tests: [...document.tests]
        .sort((left, right) => left.testIndex - right.testIndex)
        .map((test) => ({
          testIndex: test.testIndex,
          testId: test.testId,
          name: overviewText(test.testName, mask),
          outcome: test.outcome,
          recording: projectRecording(
            rows?.members.find((member) => member.testIndex === test.testIndex), runId, presence),
          steps: projectSteps(test, runId, rows, knowledge, presence, mask),
        })),
      learned: projectLearned(knowledge, document),
    }
  },
}
