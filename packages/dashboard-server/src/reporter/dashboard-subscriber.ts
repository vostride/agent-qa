import type { RunAttributes } from '@vostride/agent-qa-core'
import type {
  ArtifactRecord,
  HookFinishedPayload,
  RunArtifactConfigSnapshot,
  RunArtifactKind,
  RunArtifactStageInput,
  RunArtifactSuiteMemberSnapshot,
  RunArtifactSuiteSourceSnapshot,
  RunArtifactTestSourceSnapshot,
  RunArtifactTestsSourceSnapshot,
  RunEventEnvelope,
  RunFinishedPayload,
  RunStatus,
  StepFinalizedPayload,
  StepStartedPayload,
  SubActionRecordedPayload,
  TestFinishedPayload,
  TestRetryScheduledPayload,
  TestStartedPayload,
  VerdictPayload,
} from '@vostride/agent-qa-schema'
import type { DashboardDatabase } from '../db/database.js'
import { runRowIdentity, type RunIdentityMember } from './run-row-identity.js'

// Envelopes drive the rows; a projection write that fails never touches the `runs` row's verdict.

type SourceSnapshot =
  | RunArtifactTestSourceSnapshot
  | RunArtifactSuiteSourceSnapshot
  | RunArtifactTestsSourceSnapshot
  | ArtifactRecord

type ConfigSnapshot = RunArtifactConfigSnapshot | ArtifactRecord

// A run's loaded test or suite and config snapshot, handed over out of band.
export interface DashboardRunIngestSnapshots {
  config?: ConfigSnapshot
  source?: SourceSnapshot
}

export interface DashboardRunIngestDeps {
  db: DashboardDatabase
  runId: string
  /** Resolved config snapshot (RunArtifactPayload-compatible) — the bus never carries it. */
  configSnapshot?: ConfigSnapshot
  /** Resolved test/suite source snapshot — the bus never carries it. */
  sourceSnapshot?: SourceSnapshot
  // The run row's name and ids come from these, once, at the claim.
  members?: readonly RunIdentityMember[]
  /** Trusted run attributes, written to the run row + artifact metadata. */
  attributes?: RunAttributes
  /** Fired once the primary DB row exists (log correlation / live-view wiring). */
  onRunCreated?: (runId: string) => void
  /** Injectable clock for deterministic tests. */
  now?: () => string
}

/**
 * The post-run section the CLI closure supplies to `finalize()` — data the bus never carries,
 * so it arrives out-of-band at flush.
 */
export interface DashboardRunIngestFinalizeExtra {
  runtime?: ArtifactRecord
}

export interface DashboardRunIngest {
  handler(envelope: RunEventEnvelope): void
  // Writes a section only where absent or still queued, so the first snapshot wins.
  stageSnapshots(input: DashboardRunIngestSnapshots): void
  finalize(extra?: DashboardRunIngestFinalizeExtra): Promise<void>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function samePath(memberPath: string, snapshotPath: string | undefined): boolean {
  if (snapshotPath === undefined) return false
  const member = memberPath.replace(/\\/g, '/')
  const snapshot = snapshotPath.replace(/\\/g, '/')
  return member === snapshot || snapshot.endsWith(`/${member}`) || member.endsWith(`/${snapshot}`)
}

export function createDashboardRunIngest(deps: DashboardRunIngestDeps): DashboardRunIngest {
  const { db, onRunCreated } = deps
  const configSnapshot = deps.configSnapshot
  const sourceSnapshot = deps.sourceSnapshot
  const attributes = deps.attributes
  const now = deps.now ?? (() => new Date().toISOString())


  const configRecord = isRecord(configSnapshot) ? configSnapshot : undefined
  const configRuntime = isRecord(configRecord?.runtime) ? (configRecord!.runtime as ArtifactRecord) : undefined

  const runMembers = deps.members ?? []
  const identity = runRowIdentity(runMembers)
  // Several members outside one suite own their sources; other runs keep the first-wins source.
  const membersMode = runMembers.length > 1 && identity.suiteId === undefined
  const platform = readString(configRuntime?.platform) ?? 'web'

  /** The primary DB row id lifecycle status/finalize writes target. */
  let runId: string | undefined
  /** `stepStarted.stepText` cached per `testIndex:stepIndex` for the step-row name. */
  const stepNames = new Map<string, string>()
  // A terminal replay/replacement updates one handle, never adds another attempt's work.
  const memberDurations = new Map<number, number | undefined>()
  let idlessHookRows = 0
  let startedAtMs = 0
  let finalized = false
  const heldSnapshots: DashboardRunIngestSnapshots[] = []

  function baseArtifactPayload(): RunArtifactStageInput {
    if (membersMode) {
      const source: RunArtifactTestsSourceSnapshot = { kind: 'tests', members: [] }
      return { source, ...(attributes ? { metadata: { attributes } } : {}) }
    }
    return {
      ...(sourceSnapshot ? { source: sourceSnapshot as RunArtifactStageInput['source'] } : {}),
      ...(configSnapshot ? { config: configSnapshot as RunArtifactStageInput['config'] } : {}),
      ...(attributes ? { metadata: { attributes } } : {}),
    }
  }

  function insertArtifact(id: string, kind: RunArtifactKind): void {
    db.insertRunArtifact({ runId: id, kind, payload: baseArtifactPayload() })
  }

  // The run's own row is claimed, never rewritten; a refused claim leaves `runId` unset.
  function claimPrimary(): string | undefined {
    const startedAt = now()
    startedAtMs = Date.parse(startedAt) || Date.now()
    const claimed = db.claimRunningRow(deps.runId, {
      ...(deps.members && deps.members.length > 0 ? { name: identity.name } : {}),
      filePath: identity.filePath,
      ...(attributes ? { attributes } : {}),
      startedAt,
      platform,
      testId: identity.testId,
      suiteId: identity.suiteId,
    })
    return claimed ? deps.runId : undefined
  }

  function stageRuntime(id: string, runtime: ArtifactRecord): void {
    const artifact = db.getRunArtifact(id)
    if (artifact && !artifact.finalizedAt) {
      db.stageRunArtifact(id, { runtime: runtime as RunArtifactStageInput['runtime'] })
    }
  }

  function sourceReplaceable(stored: unknown): boolean {
    return stored === undefined || (isRecord(stored) && stored.loadStatus === 'queued')
  }

  function pickMember(
    pool: readonly number[],
    snapshot: { testId?: string; name?: string; filePath?: string },
    taken: ReadonlySet<number>,
  ): number | undefined {
    const byId = pool.filter((index) => {
      const member = runMembers[index]
      if (member === undefined) return false
      return snapshot.testId !== undefined ? member.testId === snapshot.testId : member.testId === snapshot.name
    })
    const byPath = byId.filter((index) => samePath(runMembers[index]!.filePath, snapshot.filePath))
    return (byPath.length > 0 ? byPath : byId).find((index) => !taken.has(index))
  }

  function testMemberEntry(
    source: Record<string, unknown>,
    config: ConfigSnapshot | undefined,
    taken: ReadonlySet<number>,
  ): RunArtifactSuiteMemberSnapshot | undefined {
    const testId = readString(source.testId)
    const filePath = readString(source.filePath)
    const index = pickMember(
      runMembers.map((_, position) => position),
      { testId, name: readString(source.name), filePath },
      taken,
    )
    if (index === undefined) return undefined
    const member = runMembers[index]!
    return {
      index,
      ref: { test: filePath ?? member.filePath, id: testId ?? member.testId },
      filePath: filePath ?? null,
      testId: testId ?? null,
      name: readString(source.name) ?? null,
      rawYaml: readString(source.rawYaml) ?? null,
      resolvedDefinition: source.resolvedDefinition ?? null,
      loadStatus: 'loaded',
      ...(config === undefined ? {} : { config }),
    }
  }

  function suiteMemberEntries(
    source: Record<string, unknown>,
    config: ConfigSnapshot | undefined,
    taken: Set<number>,
  ): RunArtifactSuiteMemberSnapshot[] {
    const suiteId = readString(source.suiteId)
    const pool = runMembers
      .map((_, position) => position)
      .filter((position) => suiteId === undefined || runMembers[position]!.suiteId === suiteId)
    const entries = (Array.isArray(source.members) ? source.members : [])
      .filter((entry): entry is Record<string, unknown> => isRecord(entry))
      .sort((a, b) => (typeof a.index === 'number' ? a.index : 0) - (typeof b.index === 'number' ? b.index : 0))
    const filed: RunArtifactSuiteMemberSnapshot[] = []
    for (const entry of entries) {
      const index = pickMember(
        pool,
        { testId: readString(entry.testId), name: readString(entry.name), filePath: readString(entry.filePath) },
        taken,
      )
      if (index === undefined) continue
      taken.add(index)
      filed.push({
        ...(entry as unknown as RunArtifactSuiteMemberSnapshot),
        index,
        ...(config === undefined ? {} : { config }),
      })
    }
    return filed
  }

  function applyMemberSnapshot(id: string, input: DashboardRunIngestSnapshots): void {
    const artifact = db.getRunArtifact(id)
    if (!artifact || artifact.finalizedAt) return
    const stored = (artifact.payload as unknown as Record<string, unknown>).source
    const entries = (isRecord(stored) && Array.isArray(stored.members) ? stored.members : [])
      .filter((entry): entry is RunArtifactSuiteMemberSnapshot => isRecord(entry) && typeof entry.index === 'number')
    const taken = new Set(entries.map((entry) => entry.index))
    const config = isRecord(input.config) ? input.config : undefined
    const added: RunArtifactSuiteMemberSnapshot[] = []
    if (isRecord(input.source) && input.source.kind === 'test') {
      const entry = testMemberEntry(input.source, config, taken)
      if (entry !== undefined) added.push(entry)
    }
    if (isRecord(input.source) && input.source.kind === 'suite') {
      added.push(...suiteMemberEntries(input.source, config, new Set(taken)))
    }
    if (added.length === 0) return
    const source: RunArtifactTestsSourceSnapshot = {
      kind: 'tests',
      members: [...entries, ...added].sort((a, b) => a.index - b.index),
    }
    db.stageRunArtifact(id, { source })
  }

  function applySnapshots(id: string, input: DashboardRunIngestSnapshots): void {
    if (membersMode) {
      try {
        applyMemberSnapshot(id, input)
      } catch {
        // Non-darkening, as below.
      }
      return
    }
    try {
      const artifact = db.getRunArtifact(id)
      if (!artifact || artifact.finalizedAt) return
      const stored = artifact.payload as unknown as Record<string, unknown>
      const patch: RunArtifactStageInput = {}
      if (isRecord(input.config) && stored.config === undefined) {
        patch.config = input.config as RunArtifactStageInput['config']
      }
      if (isRecord(input.source) && sourceReplaceable(stored.source)) {
        patch.source = input.source as RunArtifactStageInput['source']
      }
      if (patch.config !== undefined || patch.source !== undefined) db.stageRunArtifact(id, patch)
    } catch {
      // Non-darkening: a snapshot that will not write leaves the run row and its verdict alone.
    }
  }

  function handleRunStarted(): void {
    const id = claimPrimary()
    if (id === undefined) return
    runId = id
    onRunCreated?.(id)
    insertArtifact(id, 'test')
    for (const held of heldSnapshots.splice(0)) applySnapshots(id, held)
  }

  // A member writes only its own member row; the run row's identity is the claim's.
  function handleTestStarted(payload: TestStartedPayload): void {
    // The member row, keyed by the handle; `testFinished` supplies the outcome half.
    const id = targetForTest(payload)
    if (!id) return
    try {
      db.upsertRunMember({
        runId: id,
        testIndex: payload.testIndex,
        ...(payload.testId === undefined ? {} : { testId: payload.testId }),
        ...(payload.name === undefined ? {} : { name: payload.name }),
        ...(payload.filePath === undefined ? {} : { filePath: payload.filePath }),
        ...(payload.suiteId === undefined ? {} : { suiteId: payload.suiteId }),
        ...(payload.suiteName === undefined ? {} : { suiteName: payload.suiteName }),
        ...(payload.suiteIndex === undefined ? {} : { suiteIndex: payload.suiteIndex }),
        ...(payload.totalSteps === undefined ? {} : { totalSteps: payload.totalSteps }),
      })
    } catch {
      // Projection rows are progress detail — the non-darkening rule.
    }
  }

  // Every member's step, hook and status rows land on the one run row.
  function targetForTest(_payload: { testIndex?: number }): string | undefined {
    return runId
  }

  function handleTestFinished(payload: TestFinishedPayload): void {
    const id = targetForTest(payload)
    if (!id) return
    // Written from `testFinished` alone if need be, so a member that never ran still shows.
    try {
      db.upsertRunMember({
        runId: id,
        testIndex: payload.testIndex,
        ...(payload.testId === undefined ? {} : { testId: payload.testId }),
        outcome: payload.outcome,
        ...(payload.durationMs === undefined ? {} : { durationMs: payload.durationMs }),
        ...(payload.failureSummary === undefined ? {} : { failureSummary: payload.failureSummary }),
        ...(payload.retryCount === undefined ? {} : { retryCount: payload.retryCount }),
        ...(payload.recording === undefined ? {} : { recording: payload.recording }),
      })
    } catch {
      // Non-darkening: a member row that will not write must not change the run row below.
    }
    memberDurations.set(payload.testIndex, payload.durationMs)
    // No status and no end time; the row reads `running` until the verdict.
    db.updateRun(id, {
      duration: runDuration(),
      ...(readString(payload.failureSummary) ? { failureSummary: payload.failureSummary } : {}),
    })
  }

  function runDuration(): number {
    const measured = [...memberDurations.values()]
    return measured.every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0)
      ? measured.reduce<number>((sum, value) => sum + value!, 0)
      : Date.now() - startedAtMs // Preserve the legacy fallback when execution timing is missing.
  }

  function stepNameKey(testIndex: number, stepIndex: number): string {
    return `${String(testIndex)}:${String(stepIndex)}`
  }

  function handleStepStarted(payload: StepStartedPayload): void {
    const stepText = readString(payload.stepText)
    if (stepText === undefined) return
    stepNames.set(stepNameKey(payload.testIndex, payload.stepIndex), stepText)
  }

  // The payload verbatim; `status` keeps its own word, and `stepText` needs a `stepStarted`.
  function handleStepFinalized(payload: StepFinalizedPayload): void {
    const id = targetForTest(payload)
    if (!id) return
    const stepText = stepNames.get(stepNameKey(payload.testIndex, payload.stepIndex))
    try {
      db.insertRunStep({
        runId: id,
        testIndex: payload.testIndex,
        stepIndex: payload.stepIndex,
        ...(stepText === undefined ? {} : { stepText }),
        cacheStatus: payload.cacheStatus,
        verifierVerdict: payload.verifierVerdict,
        selfHealOccurred: payload.selfHealOccurred,
        briefDigest: payload.briefDigest,
        ...(payload.status === undefined ? {} : { status: payload.status }),
        ...(payload.durationMs === undefined ? {} : { durationMs: payload.durationMs }),
        ...(payload.error === undefined ? {} : { error: payload.error }),
        // Spread when defined, so an unmeasured step stays NULL and `runs.detail` counts it so.
        ...(payload.tokenUsage === undefined ? {} : { tokenUsage: payload.tokenUsage }),
        ...(payload.modelUsage === undefined ? {} : { modelUsage: payload.modelUsage }),
        ...(payload.evidence === undefined ? {} : { evidence: payload.evidence }),
        ...(payload.variableSnapshot === undefined ? {} : { variableSnapshot: payload.variableSnapshot }),
      })
    } catch {
      // A step row is progress detail; one that will not write must not fail the run row.
    }
  }

  // Every `subActionRecorded` envelope becomes a row with its nested objects as JSON verbatim.
  function handleSubActionRecorded(payload: SubActionRecordedPayload): void {
    const id = targetForTest(payload)
    if (!id) return
    try {
      db.insertRunSubAction({
        runId: id,
        testIndex: payload.testIndex,
        stepIndex: payload.stepIndex,
        subActionIndex: payload.subActionIndex,
        plan: payload.plan,
        plannedAction: payload.plannedAction,
        ...(payload.grounding === undefined ? {} : { grounding: payload.grounding }),
        result: payload.result,
        screenStateHash: payload.screenStateHash,
        ...(payload.screenStateHashAfter === undefined
          ? {}
          : { screenStateHashAfter: payload.screenStateHashAfter }),
        ...(payload.artifactRefs === undefined ? {} : { artifactRefs: payload.artifactRefs }),
        ...(payload.ariaEvidence === undefined ? {} : { ariaEvidence: payload.ariaEvidence }),
        ...(payload.recordingOffsetMs === undefined ? {} : { recordingOffsetMs: payload.recordingOffsetMs }),
      })
    } catch {
      // Same non-darkening rule as step rows.
    }
  }

  function handleHookFinished(payload: HookFinishedPayload): void {
    // `skipped` hooks carry no output, and the execution_logs CHECK admits only passed|failed.
    if (payload.status !== 'passed' && payload.status !== 'failed') return
    const id = targetForTest(payload) ?? runId
    if (!id) return
    const kind = payload.kind
    const hookExecutionId = readString(payload.hookExecutionId) ?? `hook-${now()}-${String(idlessHookRows++)}`
    try {
      // The run is in the key: `execution_logs.id` is unique database-wide and hook ids repeat.
      db.insertExecutionLog({
        id: `${id}:${hookExecutionId}`,
        runId: id,
        type: kind === 'appium-script' || kind === 'runjs' ? kind : 'hook',
        name: readString(payload.hookName) ?? 'hook',
        hookId: readString(payload.hookId) ?? null,
        phase: payload.phase === 'setup' || payload.phase === 'teardown' ? payload.phase : 'inline',
        status: payload.status,
        duration: typeof payload.durationMs === 'number' ? payload.durationMs : 0,
        stdout: readString(payload.stdout) ?? null,
        stderr: readString(payload.stderr) ?? null,
        variables: payload.variables ?? null,
        // Absent stays NULL: a run-scoped hook is a real state, not handle 0.
        ...(payload.testIndex === undefined ? {} : { testIndex: payload.testIndex }),
        ...(payload.stepIndex === undefined ? {} : { stepIndex: payload.stepIndex }),
      })
    } catch {
      // Hook rows are progress detail — same non-darkening rule as step rows.
    }
  }

  // Drops only this handle's abandoned-attempt rows; the final attempt's `testFinished` counts.
  function handleTestRetryScheduled(payload: TestRetryScheduledPayload): void {
    const id = targetForTest(payload)
    if (!id) return
    memberDurations.delete(payload.testIndex)
    try {
      db.deleteMemberProjection(id, payload.testIndex)
      db.incrementRunMemberAttempts(id, payload.testIndex)
    } catch {
      // Same non-darkening rule.
    }
    const prefix = `${String(payload.testIndex)}:`
    for (const key of stepNames.keys()) {
      if (key.startsWith(prefix)) stepNames.delete(key)
    }
  }

  function handleRunFinished(aggregateVerdict: RunStatus): void {
    // The run-level verdict is authoritative; the primary artifact stays open until `finalize()`.
    if (!runId) return
    const endedAt = now()
    db.updateRun(runId, { status: aggregateVerdict, endedAt })
    stageRuntime(runId, { status: aggregateVerdict, duration: runDuration(), endedAt })
  }

  return {
    handler(envelope: RunEventEnvelope): void {
      switch (envelope.type) {
        case 'runStarted':
          handleRunStarted()
          break
        case 'testStarted':
          handleTestStarted(envelope.payload as TestStartedPayload)
          break
        case 'testFinished':
          handleTestFinished(envelope.payload as TestFinishedPayload)
          break
        case 'stepStarted':
          handleStepStarted(envelope.payload as StepStartedPayload)
          break
        case 'stepFinalized':
          handleStepFinalized(envelope.payload as StepFinalizedPayload)
          break
        case 'subActionRecorded':
          handleSubActionRecorded(envelope.payload as SubActionRecordedPayload)
          break
        case 'hookFinished':
          handleHookFinished(envelope.payload as HookFinishedPayload)
          break
        case 'testRetryScheduled':
          handleTestRetryScheduled(envelope.payload as TestRetryScheduledPayload)
          break
        case 'verdict':
          // One run row: the verdict is its status, and `runFinished` performs the finalize sweep.
          if (runId) {
            db.updateRun(runId, {
              status: (envelope.payload as VerdictPayload).verdict,
              endedAt: now(),
            })
          }
          break
        case 'runFinished':
          handleRunFinished((envelope.payload as RunFinishedPayload).aggregateVerdict)
          break
        default:
          // Unknown/unhandled envelope types (hookStarted, heartbeats, chips) are ignored.
          break
      }
    },

    stageSnapshots(input: DashboardRunIngestSnapshots): void {
      if (finalized) return
      if (runId === undefined) {
        heldSnapshots.push(input)
        return
      }
      applySnapshots(runId, input)
    },

    async finalize(extra?: DashboardRunIngestFinalizeExtra): Promise<void> {
      if (finalized) return
      finalized = true
      if (!runId) return

      if (extra?.runtime) {
        stageRuntime(runId, extra.runtime)
      }

      const artifact = db.getRunArtifact(runId)
      if (artifact && !artifact.finalizedAt) {
        db.finalizeRunArtifact(runId)
      }
    },
  }
}
