// The token sum is computed here once, not per host that holds a database.

import {
  RunDetailProjectionSchema,
  RunsDetailInputSchema,
} from '@vostride/agent-qa-schema'
import type {
  MarkReceipt,
  RunDetailMemberMark,
  RunDetailProjection,
  RunDetailStep,
  RecordingEntry,
  RunId,
  RunTokenTotals,
  RunModelSummary,
  RunsDetailInput,
} from '@vostride/agent-qa-schema'

import { FunctionNotBoundError } from '../spec.js'
import type { ClauseVerdict, EvidenceBlobReaderPort, FunctionSpec } from '../spec.js'
import { annotatePresence } from './evidence-presence.js'
import { IN_RUNS_DATABASE, RunNotFoundError } from './runs-get.js'

// The dashboard server may not import this package, so it receives this id as data.
export const RUNS_DETAIL_FUNCTION_ID = 'runs.detail'

// Sums appear only when a step was measured, so an unmeasured run never reads `0 tokens`.
export function projectRunTokenTotals(steps: readonly RunDetailStep[]): RunTokenTotals {
  let measuredSteps = 0
  let promptTokens = 0
  let completionTokens = 0
  let totalTokens = 0
  let cachedInputTokens = 0
  let cachedMeasuredSteps = 0
  let cachedInputMeasuredTokens = 0

  for (const step of steps) {
    const usage = step.tokenUsage
    if (usage === undefined) continue
    measuredSteps += 1
    promptTokens += usage.promptTokens
    completionTokens += usage.completionTokens
    totalTokens += usage.totalTokens
    if (usage.cachedInputTokens !== undefined) {
      cachedInputTokens += usage.cachedInputTokens
      cachedMeasuredSteps += 1
      cachedInputMeasuredTokens += usage.promptTokens
    }
  }

  return {
    measuredSteps,
    unmeasuredSteps: steps.length - measuredSteps,
    ...(measuredSteps === 0 ? {} : { promptTokens, completionTokens, totalTokens }),
    ...(cachedMeasuredSteps === 0 ? {} : {
      cachedInputTokens, cachedMeasuredSteps, cachedInputMeasuredTokens,
    }),
  }
}

/** Fold already-masked persisted identities; calls and configured roles never multiply steps. */
export function projectRunModelSummary(steps: readonly RunDetailStep[]): RunModelSummary | undefined {
  type Identity = { provider?: string; modelId: string }
  const declared = new Map<string, { identity: Identity & { provider: string }; steps: Set<string> }>()
  const responding = new Map<string, { identity: Identity; steps: Set<string> }>()
  function add<T extends Identity>(map: Map<string, { identity: T; steps: Set<string> }>,
    identity: T, step: string) {
    const key = JSON.stringify([identity.provider, identity.modelId])
    const entry = map.get(key) ?? { identity, steps: new Set<string>() }
    entry.steps.add(step)
    map.set(key, entry)
  }
  for (const step of steps) {
    const stepKey = `${step.testIndex}:${step.stepIndex}`
    for (const facts of Object.values(step.modelUsage?.roles ?? {})) {
      if (facts.declared !== undefined) add(declared, facts.declared, stepKey)
      for (const modelId of facts.respondingModelIds ?? []) {
        add(responding, { modelId,
          ...(facts.declared === undefined ? {} : { provider: facts.declared.provider }) }, stepKey)
      }
    }
  }
  if (declared.size === 0 && responding.size === 0) return undefined
  return {
    ...(declared.size === 0 ? {} : { declared: [...declared.values()]
      .map(entry => ({ ...entry.identity, stepCount: entry.steps.size })) }),
    ...(responding.size === 0 ? {} : { responding: [...responding.values()]
      .map(entry => ({ ...entry.identity, stepCount: entry.steps.size })) }),
  }
}

async function projectMemberRecording(
  recording: RecordingEntry | undefined,
  port: EvidenceBlobReaderPort | undefined,
  runId: RunId,
): Promise<RecordingEntry> {
  if (recording === undefined) return { state: 'absent', reason: 'unavailable' }
  if (recording.state !== 'present') return recording
  const [ref] = await annotatePresence(port, runId, [recording.ref])
  return ref?.present === false
    ? { state: 'absent', reason: 'unavailable', evidenceIncomplete: true }
    : recording
}

export const runsDetailSpec: FunctionSpec<RunsDetailInput, RunDetailProjection> = {
  id: RUNS_DETAIL_FUNCTION_ID,
  summary: "Read one run's durable members, steps and sub-actions as the dashboard projected them.",
  resultKind: 'unary',
  // Bound where the composition owns the projection database; otherwise listed `unbound`.
  boundThrough: 'runDetail',
  input: RunsDetailInputSchema,
  output: RunDetailProjectionSchema,
  risk: { name: `fn:${RUNS_DETAIL_FUNCTION_ID}`, recognized: true, readOnly: true },
  // Counts only, not the token sum, so the total has one producer.
  classify(output): ClauseVerdict {
    return {
      status: 'executed',
      outcome: `${String(output.members.length)} member(s), `
        + `${String(output.steps.length)} step(s), `
        + `${String(output.subActions.length)} sub-action(s)`,
    }
  },
  async invoke(input, deps) {
    // Reached with no port only by an in-layer caller; the refusal is the same named error.
    const port = deps.runDetail
    if (port === undefined) {
      throw new FunctionNotBoundError(RUNS_DETAIL_FUNCTION_ID)
    }

    const rows = await port.read(input.runId)
    // REUSED, NEVER RE-MINTED. `runs.get` already owns "no run is recorded under that id" as a
    // caller-facing refusal, and a second not-found class would give one surface two words for one
    // answer — which is how a page ends up rendering "unknown run" and "run not found" from the
    // same door depending on which read it tried first.
    if (rows === undefined) {
      throw new RunNotFoundError(String(input.runId), IN_RUNS_DATABASE)
    }

    // Append-only: the latest ordinal per member and step governs; a reader that throws is broken.
    let members = [...rows.members]
    if (deps.feedback !== undefined) {
      const latest = new Map<string, MarkReceipt>()
      for (const mark of await deps.feedback.marksFor(input.runId)) {
        const address = `${mark.testIndex}:${mark.stepIndex ?? 'run'}`
        const prior = latest.get(address)
        if (prior === undefined || mark.ordinal > prior.ordinal) latest.set(address, mark)
      }
      const byMember = new Map<number, RunDetailMemberMark[]>()
      for (const mark of latest.values()) {
        const marks = byMember.get(mark.testIndex) ?? []
        marks.push({
          markId: mark.markId,
          kind: mark.kind,
          ordinal: mark.ordinal,
          ...(mark.stepIndex === undefined ? {} : { stepIndex: mark.stepIndex }),
          disposition: mark.disposition,
        })
        byMember.set(mark.testIndex, marks)
      }
      members = rows.members.map(member => {
        // Bound-but-unmarked enables the first mark; unbound above still omits the key.
        const marks = byMember.get(member.testIndex) ?? []
        marks.sort((a, b) => (a.stepIndex ?? -1) - (b.stepIndex ?? -1))
        return { ...member, marks }
      })
    }

    members = await Promise.all(members.map(async member => ({
      ...member,
      recording: await projectMemberRecording(member.recording, deps.evidenceBlobs, input.runId),
    })))

    // Presence is optional enrichment; without a runtime root the key is omitted, meaning unknown.
    const subActions = await Promise.all(rows.subActions.map(async (subAction) => {
      const ariaEvidence = subAction.ariaEvidence === undefined ? {
        kind: 'aria' as const, state: 'absent' as const, reason: 'unavailable' as const,
      } : subAction.ariaEvidence
      const refs = subAction.artifactRefs
      if (refs === undefined) return { ...subAction, ariaEvidence }
      const artifactRefs = await annotatePresence(deps.evidenceBlobs, input.runId, refs)
      return { ...subAction, artifactRefs, ariaEvidence }
    }))

    // Only absent persisted fields gain a read-time state. Configuration and handoffs cannot
    // establish what was captured. ARIA stays on real children; a childless step gains none.
    const steps: RunDetailStep[] = rows.steps.map(step => ({
      ...step,
      evidence: step.evidence === undefined ? {
        console: { kind: 'console', state: 'absent', reason: 'unavailable' },
        network: { kind: 'network', state: 'absent', reason: 'unavailable' },
        a11y: { kind: 'a11y', state: 'absent', reason: 'unavailable' },
        variables: { kind: 'variables', state: 'absent', reason: 'unavailable' },
      } : step.evidence,
    }))

    const models = projectRunModelSummary(rows.steps)
    return {
      runId: rows.runId,
      members,
      steps,
      subActions,
      tokens: projectRunTokenTotals(rows.steps),
      ...(models === undefined ? {} : { models }),
    }
  },
}
