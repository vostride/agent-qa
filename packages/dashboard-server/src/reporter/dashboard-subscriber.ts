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

/**
 * `createDashboardRunIngest` — the dashboard's DB ingestion (RESEARCH Pitfall 1's
 * "unnamed fifth consumer") rewired from the deleted `DashboardReporter` into a bus
 * subscriber (Open Q-1 resolved as option (a): one envelope vocabulary, D-16 precedent).
 *
 * The bus deliberately does not carry the resolved config/source snapshots or the run's
 * own id; those ride construction. Envelopes drive lifecycle/status.
 * The `runs` + `run_artifacts` rows this writes stay shape-compatible with what
 * `GET /api/runs/:id/artifact` and the queue read today — the spawn must survive
 * until M5 (Pitfall 1's hard requirement). This module implements no Reporter
 * interface — pure envelope consumption.
 *
 * NOTE: Plan 06 (363-06) relocated the `RunArtifact*` payload family from core to
 * @vostride/agent-qa-schema (D-08); these imports now point at their canonical home.
 *
 * 2026-08-27 (Phase 405 plan 01, D-01/D-17/D-18): THE PROJECTION IS REBUILT ON THE BUS'S OWN
 * SHAPE. Until this date every step landed in the v1 wide `steps` row through `insertStep`, which
 * kept five of `StepFinalizedPayload`'s fields and dropped the rest — because the local `*Like`
 * interfaces this module declared only named five. There was no `subActionRecorded` arm at all, so
 * the sub-action timeline, the screenshots and the screen-state hashes reached no reader.
 *
 * What replaced them: the real schema payload types (so a field added to a payload is a compile
 * error here rather than a silent drop), `run_members` per handle from `testStarted`/`testFinished`
 * (D-18: a thin member whose stream begins with a terminal event still gets a row), `run_steps`
 * carrying the WHOLE `stepFinalized` payload with `status` stored as the payload's own word, and
 * `run_sub_actions` carrying the whole `subActionRecorded` payload with its nested objects
 * stringified verbatim (no field is re-interpreted on the way in). The run row stores the verdict's
 * own word too.
 *
 * `testRetryScheduled` now drops only THAT HANDLE's rows (D-17). It used to call the v1
 * whole-run step delete, which wiped every step of the RUN — so in a suite, one member's
 * abandoned attempt deleted the completed history of every member before it.
 *
 * THE NON-DARKENING `try {} catch {}` AROUND EVERY PROJECTION INSERT IS UNCHANGED and is
 * load-bearing: a projection row that fails to write must never darken the `runs` row. A dropped
 * step is visible as an absent step; a darkened run is a wrong verdict.
 *
 * 2026-08-28 (Phase 405 plan 13, D-21): phase 405 removed tables, columns, routes and fields from
 * around this module and deliberately kept others. Check the repository history before restoring
 * anything that looks missing here.
 */

type SourceSnapshot =
  | RunArtifactTestSourceSnapshot
  | RunArtifactSuiteSourceSnapshot
  | RunArtifactTestsSourceSnapshot
  | ArtifactRecord

type ConfigSnapshot = RunArtifactConfigSnapshot | ArtifactRecord

/**
 * A run's loaded test/suite and config snapshot, handed over by the producer that resolved them
 * (433-29, G-433-5). It arrives out-of-band, like `finalize()`'s runtime: the bus carries no snapshots.
 */
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
  // 2026-10-17 (444-02, D-07, D-44): the run row's name and ids come from these, once, at the claim.
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
  /**
   * Stage a loaded snapshot onto this run's own artifact (433-29, F-433-15). A section is written
   * only where it is absent or still the queue's `loadStatus: 'queued'` placeholder, so the first
   * snapshot wins and a finalized artifact is never touched. A call before `runStarted` is held.
   * A run of several members outside one suite instead files each snapshot under its member
   * (444-03, D-07).
   */
  stageSnapshots(input: DashboardRunIngestSnapshots): void
  finalize(extra?: DashboardRunIngestFinalizeExtra): Promise<void>
}

// 405-01 (D-01): the six `*Like` interfaces that stood here are GONE. They were the mechanism of
// the drop this plan closes — `StepFinalizedLike` named five of the payload's eleven fields, so the
// other six could not be written even in principle, and nothing could tell you that by reading the
// arm. The arms below take the SCHEMA'S OWN payload types, so a payload that grows a field is a
// compile error here rather than a silent hole in the page.

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
  // 2026-10-17 (444-03, D-07, D-08): several members outside one suite own their sources; a
  // single-test or one-suite run keeps the first-wins source (433-29).
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

  // 2026-10-17 (443-04, D-07, D-12): the run's own row is claimed, never rewritten; a refused
  // claim leaves `runId` unset, so nothing below writes under another process's row.
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

  // 2026-08-24 (Phase 402 plan 09, D-11): `insertRetryChild` AND `insertSuiteChild` ARE DELETED.
  //
  // ~40 lines stood here minting run rows carrying the parent-link column — one per retry attempt,
  // one per suite member. This module was the LIVE producer of new parent/child run records; the queue's
  // fan-out and the routes' parent-kind mints were only its accessories. D-11: a parallel suite is
  // ONE run row with member handles (402-04's per-member handle addressing), no child runs, no
  // parent kind.
  //
  // The retry half was already unreachable once 401-07 (D-12) retired the queue re-spawn. The
  // suite half was live and is a deliberate cost — a dashboard suite run's per-member rows are
  // replaced by handle addressing when 405 rebuilds the run detail.

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

  // 2026-10-17 (444-02, D-06): a member writes only its own member row; the run row's identity is
  // the claim's.
  function handleTestStarted(payload: TestStartedPayload): void {
    // 405 D-01: the member row, keyed by the handle. This is the per-member split 402-09
    // deleted with the child run rows, restored from 402-04's handles rather than from a second
    // `runs` row — the identity half; `testFinished` supplies the outcome half.
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

  // 402-09 (D-11): every member's step/hook/status rows land on the ONE run row. The per-member
  // split they used to get came from the child rows this plan deleted; 405 restores it from
  // 402-04's handles rather than from a second run row.
  function targetForTest(_payload: { testIndex?: number }): string | undefined {
    return runId
  }

  function handleTestFinished(payload: TestFinishedPayload): void {
    const id = targetForTest(payload)
    if (!id) return
    // 405 D-18: THE MEMBER ROW IS WRITTEN FROM `testFinished` ALONE if that is all there was. A
    // member whose stream begins with a terminal event — skipped by fail-fast, budget exhausted —
    // still has an outcome and a reason, and the page must show it with an explicit "did not run"
    // state rather than omitting it. The upsert coalesces, so this cannot blank the identity
    // fields `testStarted` wrote when both arrived.
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
    // 2026-10-17 (444-02, D-06): no status and no end time; the row reads `running` until the
    // verdict.
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

  /**
   * 405 D-01: the WHOLE `StepFinalizedPayload`, passed through verbatim.
   *
   * `status` IS THE PAYLOAD'S OWN WORD. A step that healed is
   * `healed` on its row; collapsing it to `passed` here is precisely the re-interpretation D-01
   * forbids, and the reason the v1 row could not tell a reader that a step self-healed.
   *
   * `stepText` comes from the `stepStarted` cache and is genuinely ABSENT when no `stepStarted`
   * was seen — the v1 arm substituted `Step N`, which is a label nobody wrote pretending to be an
   * instruction somebody did.
   */
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
        // 2026-08-27 (405 plan 04, D-05/D-06): the producer landed this plan, so the three token
        // columns 405-01 declared stop being always-NULL. Spread-when-defined, like every other
        // optional above it — the DB layer writes NULL for all three when the key is absent, and
        // a NULL row is what makes `runs.detail` able to say "M of K steps unmeasured" instead of
        // reporting a zero nobody measured.
        ...(payload.tokenUsage === undefined ? {} : { tokenUsage: payload.tokenUsage }),
        ...(payload.modelUsage === undefined ? {} : { modelUsage: payload.modelUsage }),
        ...(payload.evidence === undefined ? {} : { evidence: payload.evidence }),
        ...(payload.variableSnapshot === undefined ? {} : { variableSnapshot: payload.variableSnapshot }),
      })
    } catch {
      // Step rows are progress detail — a projection row that will not write must not
      // darken the run row (Pitfall 1 protects runs/run_artifacts, not steps).
    }
  }

  /**
   * 405 D-01 / D-14: THE ARM THAT DID NOT EXIST. Every `subActionRecorded` envelope becomes a row
   * keyed by `(run_id, test_index, step_index, sub_action_index)`, carrying the payload's nested
   * objects as JSON verbatim — including the `artifactRefs` the bus fold now populates from the
   * decision screenshot the runner already minted. This is the whole of "screenshots and the
   * sub-action timeline render populated": before it, nothing persisted them at all.
   */
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
    // `skipped` hooks carry no output and the execution_logs CHECK only admits
    // passed|failed — the deleted DashboardReporter had the same contract.
    if (payload.status !== 'passed' && payload.status !== 'failed') return
    const id = targetForTest(payload) ?? runId
    if (!id) return
    const kind = payload.kind
    const hookExecutionId = readString(payload.hookExecutionId) ?? `hook-${now()}-${String(idlessHookRows++)}`
    try {
      // The run is part of the key because `execution_logs.id` is unique across every run in the
      // database, and producers mint the same hook id in every run (433-41, CR-01).
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
        // 405 D-01: where in the run tree this hook ran. Absent stays NULL — a run-scoped hook
        // is a real state, and inventing handle 0 for it would put a setup hook inside a test.
        ...(payload.testIndex === undefined ? {} : { testIndex: payload.testIndex }),
        ...(payload.stepIndex === undefined ? {} : { stepIndex: payload.stepIndex }),
      })
    } catch {
      // Hook rows are progress detail — same non-darkening rule as step rows.
    }
  }

  /**
   * 405 D-17: drop only THIS HANDLE's abandoned-attempt rows, and raise its attempt ordinal.
   *
   * The v1 arm called the store's whole-run step delete, which removed every step of the RUN.
   * Under the one-run-row model that is every member's history: a suite where test 3 retried lost the
   * completed step trees of tests 0-2, and the page rendered them as members that ran nothing.
   * Only the final attempt emits the authoritative `testFinished`, so the abandoned attempt's
   * rows must go — but only the abandoned attempt's.
   */
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
    // The aggregate verdict is authoritative at the run level, and the run's runtime is staged
    // once here (444-02). The PRIMARY run_artifact is deliberately left open — finalize() lands
    // any out-of-band runtime section and finalizes last (Pitfall 6 flush idiom).
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
          // Terminal aggregate; runFinished performs the finalize sweep.
          // 402-09: the suite carve-out went with the suite mode. There is one run row, and the
          // aggregate verdict is its status; `runFinished` re-states it and performs the sweep.
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
