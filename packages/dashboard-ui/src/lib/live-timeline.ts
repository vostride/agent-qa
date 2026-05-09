import type {
  ExecutionHookEndEvent,
  ExecutionHookStartEvent,
  ExecutionLogEntry,
  ExecutionRunCompleteEvent,
  ExecutionStepCompleteEvent,
  ExecutionStepPhaseEvent,
  ExecutionStepStartEvent,
  ExecutionTestCompleteEvent,
  ExecutionTestStartEvent,
  RunRow,
  StepAnnotation,
  StepRow,
  SubActionData,
} from "@/lib/api"
import {
  type DisplayStep,
  fromStepRow,
  groupPhasesIntoSubActions,
  withDisplayStepProgress,
} from "@/lib/display-step"
import {
  finalStepStatusForRun,
  normalizeStepStatus,
  type NormalizedStepStatus,
} from "@/lib/status"
import type { LivePhase, LiveStep, LiveTestInfo } from "@/hooks/use-execution-events"

type HookPhase = "setup" | "teardown" | "inline"

interface LiveIdentity {
  eventId?: string
  runId?: string | null
  parentRunId?: string | null
  suiteIndex?: number
  testIndex?: number
  stepIndex?: number
  stepId?: string | null
}

interface LiveStepNode extends LiveIdentity {
  key: string
  name: string
  testName?: string
  status: NormalizedStepStatus
  duration?: number
  error?: string
  screenshot?: string
  screenshotBefore?: string
  observation?: string
  reasoning?: string
  result?: string
  plannedAction?: unknown
  action?: unknown
  annotation?: StepAnnotation | null
  confidence?: number | null
  phases: LivePhase[]
  phaseGroups: Record<number, LivePhase[]>
  display?: DisplayStep
}

export interface FinalArtifactInput {
  run?: RunRow | null
  steps?: StepRow[]
  logs?: ExecutionLogEntry[]
  suiteTests?: RunRow[]
  childRuns?: Array<{
    run: RunRow
    steps: StepRow[]
    logs?: ExecutionLogEntry[]
  }>
}

export interface LiveTimelineState {
  runId: string | null
  testInfo: LiveTestInfo | null
  steps: LiveStep[]
  displaySteps: DisplayStep[]
  setupHooks: ExecutionLogEntry[]
  teardownHooks: ExecutionLogEntry[]
  inlineLogs: ExecutionLogEntry[]
  suiteTests: RunRow[]
  completedSteps: number
  passedSteps: number
  failedSteps: number
  totalSteps: number
  finalStatus?: string
  processedEventIds: string[]
  stepNodes: LiveStepNode[]
}

export type LiveTimelineEvent =
  | ({ type: "run-start"; runId: string; status: string; eventId?: string })
  | (ExecutionTestStartEvent & { eventId?: string })
  | (ExecutionTestCompleteEvent & { eventId?: string })
  | (ExecutionStepStartEvent & { eventId?: string })
  | (ExecutionStepCompleteEvent & { eventId?: string })
  | (ExecutionStepPhaseEvent & { eventId?: string })
  | (ExecutionHookStartEvent & { eventId?: string })
  | (ExecutionHookEndEvent & { eventId?: string })
  | (ExecutionRunCompleteEvent & { eventId?: string })
  | ({ type: "run-error"; runId: string; error: string; eventId?: string })

export function createLiveTimelineState(runId: string | null = null): LiveTimelineState {
  return finalizeState({
    runId,
    testInfo: null,
    steps: [],
    displaySteps: [],
    setupHooks: [],
    teardownHooks: [],
    inlineLogs: [],
    suiteTests: [],
    completedSteps: 0,
    passedSteps: 0,
    failedSteps: 0,
    totalSteps: 0,
    processedEventIds: [],
    stepNodes: [],
  })
}

export function buildLiveStepKey(identity: LiveIdentity & { stepName?: string; testName?: string }): string | null {
  const runId = identity.runId ?? null
  const parentRunId = identity.parentRunId ?? null
  const suiteOrdinal = getSuiteOrdinal(identity)

  if (runId && identity.stepId) return `step:${runId}:${identity.stepId}`
  if (runId && typeof identity.stepIndex === "number") return `step:${runId}:index:${identity.stepIndex}`
  if (parentRunId && suiteOrdinal !== null && identity.stepId) {
    return `step:${parentRunId}:suite:${suiteOrdinal}:step:${identity.stepId}`
  }
  if (parentRunId && suiteOrdinal !== null && typeof identity.stepIndex === "number") {
    return `step:${parentRunId}:suite:${suiteOrdinal}:index:${identity.stepIndex}`
  }
  if (parentRunId && identity.stepId) return `step:${parentRunId}:${identity.stepId}`
  if (parentRunId && typeof identity.stepIndex === "number") return `step:${parentRunId}:index:${identity.stepIndex}`
  return null
}

export function buildLiveSubActionKey(stepKey: string, subActionIndex: number): string {
  return `${stepKey}:subaction:${subActionIndex}`
}

export function buildLiveHookKey(event: Pick<ExecutionHookStartEvent | ExecutionHookEndEvent, "hookExecutionId" | "runId" | "parentRunId">): string {
  const runScope = event.runId ?? event.parentRunId ?? "unknown-run"
  return `hook:${runScope}:${event.hookExecutionId}`
}

export function reduceLiveTimeline(state: LiveTimelineState, event: LiveTimelineEvent): LiveTimelineState {
  if (event.eventId && state.processedEventIds.includes(event.eventId)) return state

  const base = event.eventId
    ? { ...state, processedEventIds: [...state.processedEventIds, event.eventId] }
    : state

  switch (event.type) {
    case "run-start":
      return finalizeState({ ...base, runId: event.runId })
    case "test-start":
      return reduceTestStart(base, event)
    case "test-complete":
      return reduceTestComplete(base, event)
    case "step-start":
      return reduceStepStart(base, event)
    case "step-phase":
      return reduceStepPhase(base, event)
    case "step-complete":
      return reduceStepComplete(base, event)
    case "hook-start":
      return reduceHookStart(base, event)
    case "hook-end":
      return reduceHookEnd(base, event)
    case "run-complete":
      return reduceRunComplete(base, event)
    case "run-error":
      return reduceRunComplete(base, { type: "run-complete", runId: event.runId, status: "failed", duration: 0 })
    default:
      return base
  }
}

export function mergeFinalArtifacts(state: LiveTimelineState, input: FinalArtifactInput): LiveTimelineState {
  let next = { ...state }
  const suiteIndexByRunId = buildSuiteIndexByRunId(input, state.suiteTests)
  const finalParentRunId = input.run?.id ?? state.runId ?? null
  const finalSteps = [
    ...(input.steps ?? []),
    ...(input.childRuns ?? []).flatMap((child) => child.steps),
  ]

  if (input.run) {
    next = {
      ...next,
      runId: next.runId ?? input.run.id,
      finalStatus: input.run.status,
    }
  }

  if (input.suiteTests) {
    next = { ...next, suiteTests: input.suiteTests }
  }

  for (const row of finalSteps) {
    const rowSuiteIndex = suiteIndexByRunId.get(row.runId) ?? null
    const existingIndex = next.stepNodes.findIndex((node) => {
      if (node.runId && node.runId !== row.runId) return false
      if (node.runId === row.runId && node.stepId && node.stepId === row.id) return true
      if (node.runId === row.runId && typeof node.stepIndex === "number" && node.stepIndex === row.stepOrder) return true
      if (
        !node.runId
        && finalParentRunId
        && node.parentRunId === finalParentRunId
        && rowSuiteIndex !== null
        && getSuiteOrdinal(node) === rowSuiteIndex
      ) {
        if (node.stepId && node.stepId === row.id) return true
        if (typeof node.stepIndex === "number" && node.stepIndex === row.stepOrder) return true
      }
      return !node.runId && !node.parentRunId && node.name === row.name && node.status !== "running"
    })
    const existingNode = existingIndex >= 0 ? next.stepNodes[existingIndex] : null
    const display = reconcilePersistedDisplay(fromStepRow(row), existingNode)
    const key = existingIndex >= 0
      ? next.stepNodes[existingIndex].key
      : `step:${row.runId}:index:${row.stepOrder}`
    const node: LiveStepNode = {
      ...(existingIndex >= 0 ? next.stepNodes[existingIndex] : {
        key,
        phases: [],
        phaseGroups: {},
        status: normalizeStepStatus(row.status),
      }),
      key,
      runId: row.runId,
      stepId: row.id,
      stepIndex: row.stepOrder,
      name: row.name,
      status: normalizeStepStatus(row.status),
      duration: row.duration,
      error: row.error ?? undefined,
      display,
    }
    const nodes = [...next.stepNodes]
    if (existingIndex >= 0) nodes[existingIndex] = node
    else nodes.push(node)
    next = { ...next, stepNodes: nodes }
  }

  const finalLogs = [
    ...(input.logs ?? []),
    ...(input.childRuns ?? []).flatMap((child) => child.logs ?? []),
  ]
  if (finalLogs.length > 0) {
    const setupHooks = mergeLogsById(next.setupHooks, finalLogs.filter((log) => log.phase === "setup"))
    const teardownHooks = mergeLogsById(next.teardownHooks, finalLogs.filter((log) => log.phase === "teardown"))
    const inlineLogs = mergeLogsById(next.inlineLogs, finalLogs.filter((log) => log.phase === "inline"))
    next = { ...next, setupHooks, teardownHooks, inlineLogs }
  }

  return finalizeState(next)
}

function reduceTestStart(state: LiveTimelineState, event: ExecutionTestStartEvent): LiveTimelineState {
  const testInfo = {
    name: event.testName,
    filePath: event.filePath,
    totalSteps: event.totalSteps,
  }

  let suiteTests = state.suiteTests
  if (event.parentRunId && typeof event.suiteIndex === "number") {
    const row = createRunRowForLiveTest(event)
    const nextSuiteTests = [...suiteTests]
    nextSuiteTests[event.suiteIndex] = row
    suiteTests = nextSuiteTests.filter(Boolean)
  }

  return finalizeState({
    ...state,
    runId: state.runId ?? event.parentRunId ?? event.runId,
    testInfo,
    suiteTests,
  })
}

function reduceTestComplete(state: LiveTimelineState, event: ExecutionTestCompleteEvent): LiveTimelineState {
  if (!event.parentRunId || typeof event.suiteIndex !== "number") return state
  const suiteTests = [...state.suiteTests]
  const existing = suiteTests[event.suiteIndex]
  if (existing) {
    suiteTests[event.suiteIndex] = {
      ...existing,
      status: event.status,
      duration: event.duration,
      endedAt: new Date().toISOString(),
    }
  }
  return finalizeState({ ...state, suiteTests })
}

function reduceStepStart(state: LiveTimelineState, event: ExecutionStepStartEvent): LiveTimelineState {
  const key = findOrCreateStepKey(state, event)
  const existingIndex = state.stepNodes.findIndex((node) => node.key === key)
  const node: LiveStepNode = {
    ...(existingIndex >= 0 ? state.stepNodes[existingIndex] : {
      key,
      phases: [],
      phaseGroups: {},
    }),
    key,
    runId: event.runId,
    parentRunId: event.parentRunId,
    suiteIndex: event.suiteIndex,
    testIndex: event.testIndex,
    stepIndex: event.stepIndex,
    stepId: event.stepId,
    testName: event.testName,
    name: event.stepName,
    status: "running",
  }
  return finalizeState({ ...state, stepNodes: replaceNode(state.stepNodes, existingIndex, node) })
}

function reduceStepPhase(state: LiveTimelineState, event: ExecutionStepPhaseEvent): LiveTimelineState {
  const index = findStepIndex(state, event)
  if (index < 0) {
    const started = reduceStepStart(state, { ...event, type: "step-start", timestamp: event.timestamp })
    return reduceStepPhase(started, event)
  }

  const node = state.stepNodes[index]
  const phase: LivePhase = {
    phase: event.phase,
    subActionIndex: event.subActionIndex,
    phaseOrdinal: event.phaseOrdinal,
    text: event.text,
    confidence: event.confidence,
    action: event.action,
    success: event.success,
    duration: event.duration,
    timestamp: event.timestamp,
  }
  const phases = [...node.phases, phase]
  const phaseGroups = { ...node.phaseGroups }
  if (typeof event.subActionIndex === "number") {
    phaseGroups[event.subActionIndex] = [...(phaseGroups[event.subActionIndex] ?? []), phase]
  }
  const nextNode = {
    ...node,
    phases,
    phaseGroups,
    observation: event.phase === "observe" ? event.text : node.observation,
    reasoning: event.phase === "plan" ? event.text : node.reasoning,
    plannedAction: event.phase === "execute" ? event.action : node.plannedAction,
    action: event.phase === "execute" ? event.action : node.action,
    confidence: event.phase === "plan" ? event.confidence ?? null : node.confidence,
  }
  return finalizeState({ ...state, stepNodes: replaceNode(state.stepNodes, index, nextNode) })
}

function reduceStepComplete(state: LiveTimelineState, event: ExecutionStepCompleteEvent): LiveTimelineState {
  const index = findStepIndex(state, event)
  const key = index >= 0 ? state.stepNodes[index].key : findOrCreateStepKey(state, event)
  const node: LiveStepNode = {
    ...(index >= 0 ? state.stepNodes[index] : {
      key,
      phases: [],
      phaseGroups: {},
    }),
    key,
    runId: event.runId,
    parentRunId: event.parentRunId,
    suiteIndex: event.suiteIndex,
    testIndex: event.testIndex,
    stepIndex: event.stepIndex,
    stepId: event.stepId,
    name: event.stepName,
    testName: event.testName,
    status: normalizeStepStatus(event.status),
    duration: event.duration,
    error: event.error,
    screenshot: event.screenshot,
    screenshotBefore: event.screenshotBefore,
    observation: event.observation,
    reasoning: event.reasoning,
    plannedAction: event.plannedAction,
    result: event.result,
    annotation: (event.annotation as StepAnnotation | undefined) ?? null,
  }
  return finalizeState({ ...state, stepNodes: replaceNode(state.stepNodes, index, node) })
}

function reduceHookStart(state: LiveTimelineState, event: ExecutionHookStartEvent): LiveTimelineState {
  const log = hookEventToLog(event, "running")
  return finalizeState(upsertHookLog(state, log, event.phase))
}

function reduceHookEnd(state: LiveTimelineState, event: ExecutionHookEndEvent): LiveTimelineState {
  const log = hookEventToLog(event, event.status)
  return finalizeState(upsertHookLog(state, log, event.phase))
}

function reduceRunComplete(state: LiveTimelineState, event: ExecutionRunCompleteEvent): LiveTimelineState {
  const finalStatus = finalStepStatusForRun(event.status)
  return finalizeState({
    ...state,
    finalStatus: event.status,
    stepNodes: state.stepNodes.map((node) =>
      node.status === "running" ? { ...node, status: finalStatus } : node,
    ),
  })
}

function finalizeState(state: LiveTimelineState): LiveTimelineState {
  const displaySteps = withDisplayStepProgress(state.stepNodes.map(nodeToDisplayStep))
  const steps = [
    ...state.setupHooks.map(logToLiveStep),
    ...state.stepNodes.map(nodeToLiveStep),
    ...state.teardownHooks.map(logToLiveStep),
  ]
  const completedSteps = displaySteps.filter((step) => !["pending", "running"].includes(step.status)).length
  const passedSteps = displaySteps.filter((step) => ["passed", "healed", "flaky"].includes(step.status)).length
  const failedSteps = displaySteps.filter((step) => ["failed", "cancelled", "skipped"].includes(step.status)).length
  const totalSteps = state.testInfo?.totalSteps ?? displaySteps.length

  return {
    ...state,
    displaySteps,
    steps,
    completedSteps,
    passedSteps,
    failedSteps,
    totalSteps,
  }
}

function logToLiveStep(log: ExecutionLogEntry): LiveStep {
  return {
    id: log.id,
    kind: "hook",
    hookPhase: log.phase,
    hookExecutionId: log.id,
    name: log.name,
    status: log.status,
    duration: log.duration,
    error: log.stderr ?? undefined,
  }
}

function nodeToLiveStep(node: LiveStepNode): LiveStep {
  return {
    id: node.key,
    kind: "step",
    name: node.name,
    status: node.status,
    duration: node.duration,
    error: node.error,
    screenshot: node.screenshot,
    reasoning: node.reasoning,
    observation: node.observation,
    result: node.result,
    plannedAction: node.plannedAction,
    annotation: node.annotation ?? undefined,
    phases: node.phases,
  }
}

function nodeToDisplayStep(node: LiveStepNode): DisplayStep {
  if (node.display) {
    return {
      ...node.display,
      id: node.key,
      rawRunId: node.display.rawRunId ?? node.runId ?? null,
      runId: node.display.runId ?? node.runId ?? null,
    }
  }

  const subActionsData = buildSubActions(node)
  const fallbackSubAction = subActionsData?.find((subAction) =>
    Boolean(subAction.observation || subAction.reasoning || subAction.plannedAction != null),
  )

  return {
    id: node.key,
    name: node.name,
    status: node.status,
    duration: node.duration ?? 0,
    subActionsData,
    originalStepName: null,
    variableSnapshot: null,
    screenshotPath: toScreenshotDataUrl(node.screenshot),
    screenshotBeforePath: toScreenshotDataUrl(node.screenshotBefore),
    annotationData: node.annotation ?? null,
    observation: node.observation ?? fallbackSubAction?.observation ?? null,
    reasoning: node.reasoning ?? fallbackSubAction?.reasoning ?? null,
    plannedAction: node.plannedAction ?? fallbackSubAction?.plannedAction ?? null,
    action: node.action ?? node.plannedAction ?? fallbackSubAction?.plannedAction ?? null,
    error: node.error ?? null,
    confidence: node.confidence ?? fallbackSubAction?.confidence ?? null,
    runId: node.runId ?? null,
    stepOrder: node.stepIndex ?? 0,
    consoleLogs: null,
    networkLogs: null,
    healingAttempts: null,
    screenContextBefore: null,
    screenContextAfter: null,
    rawRunId: node.runId ?? null,
    rawStepOrder: node.stepIndex ?? 0,
    displayStepOrder: (node.stepIndex ?? 0) + 1,
    displayStepTotal: null,
  }
}

function buildSubActions(node: LiveStepNode): SubActionData[] | null {
  const explicitGroups = Object.entries(node.phaseGroups)
  if (explicitGroups.length === 0) return groupPhasesIntoSubActions(node.phases)

  return explicitGroups
    .sort(([left], [right]) => Number(left) - Number(right))
    .map(([rawIndex, phases]) => phaseGroupToSubAction(Number(rawIndex), phases))
}

function phaseGroupToSubAction(index: number, phases: LivePhase[]): SubActionData {
  const observe = phases.find((phase) => phase.phase === "observe")
  const plan = phases.find((phase) => phase.phase === "plan")
  const execute = phases.find((phase) => phase.phase === "execute")
  const verify = phases.find((phase) => phase.phase === "verify")

  return {
    index,
    observation: observe?.text ?? "",
    reasoning: plan?.text ?? "",
    plannedAction: execute?.action ?? null,
    result: verify ? (verify.success ? "success" : "failure") : "in-progress",
    error: undefined,
    screenStateBefore: "",
    cached: false,
    confidence: plan?.confidence,
    verifierReasoning: verify?.text,
    phaseDurations: {
      observe: observe?.duration,
      plan: plan?.duration,
      execute: execute?.duration,
      verify: verify?.duration,
    },
  }
}

function findStepIndex(state: LiveTimelineState, event: LiveIdentity & { stepName: string; testName?: string }): number {
  const stableKey = buildLiveStepKey(event)
  if (stableKey) {
    const byKey = state.stepNodes.findIndex((node) => node.key === stableKey)
    if (byKey >= 0) return byKey
  }

  if (event.runId && typeof event.stepIndex === "number") {
    const byRunAndIndex = state.stepNodes.findIndex((node) =>
      node.runId === event.runId && node.stepIndex === event.stepIndex,
    )
    if (byRunAndIndex >= 0) return byRunAndIndex
  }

  const bySuiteAndIndex = findSuiteStepIndex(state.stepNodes, event)
  if (bySuiteAndIndex >= 0) return bySuiteAndIndex

  if (event.stepId) {
    const byStepId = state.stepNodes.findIndex((node) =>
      node.stepId === event.stepId && liveIdentitiesCompatible(node, event),
    )
    if (byStepId >= 0) return byStepId
  }

  return state.stepNodes.findIndex((node) =>
    node.name === event.stepName && node.status === "running" && liveIdentitiesCompatible(node, event),
  )
}

function findOrCreateStepKey(state: LiveTimelineState, event: LiveIdentity & { stepName: string; testName?: string }): string {
  const suiteOrdinal = getSuiteOrdinal(event)
  const fallbackScope = event.parentRunId && suiteOrdinal !== null
    ? `${event.parentRunId}:suite:${suiteOrdinal}`
    : event.runId ?? event.parentRunId ?? state.runId ?? "legacy"

  return buildLiveStepKey(event)
    ?? `step:${fallbackScope}:${event.stepName}:${state.stepNodes.length}`
}

function getSuiteOrdinal(identity: Pick<LiveIdentity, "suiteIndex" | "testIndex">): number | null {
  if (typeof identity.suiteIndex === "number") return identity.suiteIndex
  if (typeof identity.testIndex === "number") return identity.testIndex
  return null
}

function findSuiteStepIndex(nodes: LiveStepNode[], identity: LiveIdentity): number {
  const suiteOrdinal = getSuiteOrdinal(identity)
  if (!identity.parentRunId || suiteOrdinal === null || typeof identity.stepIndex !== "number") return -1
  return nodes.findIndex((node) =>
    node.parentRunId === identity.parentRunId
    && getSuiteOrdinal(node) === suiteOrdinal
    && node.stepIndex === identity.stepIndex,
  )
}

function liveIdentitiesCompatible(node: LiveIdentity, event: LiveIdentity): boolean {
  if (event.runId && node.runId && node.runId !== event.runId) return false
  if (event.parentRunId && node.parentRunId && node.parentRunId !== event.parentRunId) return false

  const eventSuiteOrdinal = getSuiteOrdinal(event)
  const nodeSuiteOrdinal = getSuiteOrdinal(node)
  if (eventSuiteOrdinal !== null && nodeSuiteOrdinal !== null && eventSuiteOrdinal !== nodeSuiteOrdinal) {
    return false
  }

  return true
}

function buildSuiteIndexByRunId(input: FinalArtifactInput, existingSuiteTests: RunRow[]): Map<string, number> {
  const suiteIndexByRunId = new Map<string, number>()
  existingSuiteTests.forEach((run, index) => registerSuiteIndex(suiteIndexByRunId, run, index))
  input.suiteTests?.forEach((run, index) => registerSuiteIndex(suiteIndexByRunId, run, index))
  input.childRuns?.forEach((child, index) => registerSuiteIndex(suiteIndexByRunId, child.run, index))
  return suiteIndexByRunId
}

function registerSuiteIndex(map: Map<string, number>, run: RunRow, fallbackIndex: number): void {
  map.set(run.id, readRunSuiteIndex(run) ?? map.get(run.id) ?? fallbackIndex)
}

function readRunSuiteIndex(run: RunRow): number | null {
  const suiteIndex = run.metadata?.suiteIndex
  if (typeof suiteIndex === "number") return suiteIndex
  if (typeof suiteIndex === "string" && suiteIndex.trim() !== "") {
    const parsed = Number(suiteIndex)
    if (Number.isInteger(parsed)) return parsed
  }
  return null
}

function reconcilePersistedDisplay(display: DisplayStep, existingNode: LiveStepNode | null): DisplayStep {
  if (!existingNode || display.subActionsData) return display

  const subActionsData = buildSubActions(existingNode)
  if (!subActionsData) return display

  const fallbackSubAction = subActionsData.find((subAction) =>
    Boolean(subAction.observation || subAction.reasoning || subAction.plannedAction != null),
  )

  return {
    ...display,
    subActionsData,
    observation: display.observation ?? existingNode.observation ?? fallbackSubAction?.observation ?? null,
    reasoning: display.reasoning ?? existingNode.reasoning ?? fallbackSubAction?.reasoning ?? null,
    plannedAction: display.plannedAction ?? existingNode.plannedAction ?? fallbackSubAction?.plannedAction ?? null,
    action: display.action ?? existingNode.action ?? existingNode.plannedAction ?? fallbackSubAction?.plannedAction ?? null,
    confidence: display.confidence ?? existingNode.confidence ?? fallbackSubAction?.confidence ?? null,
  }
}

function replaceNode(nodes: LiveStepNode[], index: number, node: LiveStepNode): LiveStepNode[] {
  const next = [...nodes]
  if (index >= 0) next[index] = node
  else next.push(node)
  return next
}

function hookEventToLog(
  event: ExecutionHookStartEvent | ExecutionHookEndEvent,
  status: ExecutionLogEntry["status"],
): ExecutionLogEntry {
  return {
    id: buildLiveHookKey(event),
    runId: event.runId ?? event.parentRunId ?? "",
    stepId: event.stepId ?? null,
    type: "logType" in event && event.logType ? event.logType : "hook",
    name: event.hookName,
    hookId: event.hookId ?? null,
    phase: event.phase,
    status,
    duration: "duration" in event ? event.duration : 0,
    stdout: "stdout" in event ? event.stdout ?? null : null,
    stderr: "stderr" in event ? event.stderr ?? null : null,
    returnData: null,
    variables: "variables" in event ? event.variables ?? null : null,
    createdAt: event.timestamp,
  }
}

function upsertHookLog(
  state: LiveTimelineState,
  log: ExecutionLogEntry,
  phase: HookPhase,
): LiveTimelineState {
  if (phase === "setup") {
    return { ...state, setupHooks: mergeLogsById(state.setupHooks, [log]) }
  }
  if (phase === "teardown") {
    return { ...state, teardownHooks: mergeLogsById(state.teardownHooks, [log]) }
  }
  return { ...state, inlineLogs: mergeLogsById(state.inlineLogs, [log]) }
}

function mergeLogsById(existing: ExecutionLogEntry[], incoming: ExecutionLogEntry[]): ExecutionLogEntry[] {
  const merged = [...existing]
  for (const log of incoming) {
    const index = merged.findIndex((item) => item.id === log.id || item.id.endsWith(`:${log.id}`))
    if (index >= 0) merged[index] = { ...merged[index], ...log, id: merged[index].id }
    else merged.push(log)
  }
  return merged
}

function toScreenshotDataUrl(value: string | undefined): string | null {
  if (!value) return null
  if (
    value.startsWith("data:image/")
    || value.startsWith("blob:")
    || value.startsWith("http://")
    || value.startsWith("https://")
  ) {
    return value
  }
  return `data:image/png;base64,${value}`
}

function createRunRowForLiveTest(event: ExecutionTestStartEvent): RunRow {
  const createdAt = event.timestamp ?? new Date().toISOString()
  return {
    id: event.runId,
    name: event.testName,
    filePath: event.filePath,
    status: "running",
    duration: 0,
    attributes: {},
    environment: null,
    metadata: { suiteIndex: event.suiteIndex },
    startedAt: createdAt,
    endedAt: null,
    videoPath: null,
    failureSummary: null,
    errorLog: null,
    memoryLog: null,
    testId: null,
    suiteId: event.parentRunId ?? null,
    platform: "unknown",
    testFileContent: null,
    modelName: null,
    llmProvider: null,
    parentRunId: event.parentRunId ?? null,
    attemptNumber: 1,
    retryCount: 0,
    maxRetries: 0,
    createdAt,
  }
}
