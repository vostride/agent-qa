import { copyFile, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { buildInternalRunAttributes, redactSecretValue, validateTrustedRunAttributes } from '@vostride/agent-qa-core'
import type { Reporter, RunArtifactReporterContext, RunSummary, TestDefinition, StepResult, TestResult, SuiteDefinition, SuiteSummary, HookEvent, HookResultEvent, SecretRedactor } from '@vostride/agent-qa-core'
import type { RunAttributes } from '@vostride/agent-qa-core'
import type { DashboardDatabase } from '../db/database.js'

function isPathInside(rootDir: string, candidatePath: string): boolean {
  const relativePath = relative(rootDir, candidatePath)
  return Boolean(relativePath) && !relativePath.startsWith('..') && !isAbsolute(relativePath)
}

async function moveArtifactFile(sourcePath: string, targetPath: string): Promise<void> {
  await mkdir(dirname(targetPath), { recursive: true })
  try {
    await rename(sourcePath, targetPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EXDEV') {
      await copyFile(sourcePath, targetPath)
      await unlink(sourcePath)
      return
    }
    throw error
  }
}

async function materializeVideoPath(videoPath: string | undefined, artifactsDir: string, runId: string): Promise<string | undefined> {
  if (!videoPath) return videoPath
  const trimmed = videoPath.trim()
  if (!trimmed) return videoPath

  const videosDir = resolve(artifactsDir, 'videos')
  let relativePath: string
  let sourcePath: string

  if (isAbsolute(trimmed)) {
    sourcePath = resolve(trimmed)
    if (!isPathInside(videosDir, sourcePath)) {
      return trimmed
    }
    relativePath = relative(videosDir, sourcePath)
  } else {
    relativePath = trimmed.replace(/\\/g, '/')
    sourcePath = resolve(videosDir, relativePath)
    if (!isPathInside(videosDir, sourcePath)) {
      return relativePath
    }
  }

  const normalizedRelativePath = relativePath.replace(/\\/g, '/')
  if (normalizedRelativePath.startsWith(`${runId}/`)) {
    return normalizedRelativePath
  }

  const targetRelativePath = `${runId}/${basename(normalizedRelativePath)}`
  const targetPath = resolve(videosDir, targetRelativePath)
  try {
    await moveArtifactFile(sourcePath, targetPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return targetRelativePath
    }
    throw error
  }

  return targetRelativePath
}

function normalizeVideoPath(videoPath: string | undefined, artifactsDir: string): string | undefined {
  if (!videoPath) return videoPath
  const trimmed = videoPath.trim()
  if (!trimmed || !isAbsolute(trimmed)) return trimmed

  const videosDir = resolve(artifactsDir, 'videos')
  const relativePath = relative(videosDir, resolve(trimmed))
  if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) {
    return trimmed
  }
  return relativePath.replace(/\\/g, '/')
}

interface TestState {
  runId: string
  name: string
  startedAt: string
  filePath: string
  stepCount: number
  executionKey: string
  attributes: RunAttributes
}

type ArtifactReporterContext = RunArtifactReporterContext

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readAttributesRecord(value: unknown): RunAttributes | null {
  try {
    const attributes = validateTrustedRunAttributes(value, 'run artifact attributes')
    return Object.keys(attributes).length > 0 ? attributes : null
  } catch {
    return null
  }
}

function readArtifactRuntimePlatform(context?: ArtifactReporterContext): string | undefined {
  const runtime = context?.artifact?.runtime
  if (!isRecord(runtime)) return undefined
  const platform = runtime.platform
  return typeof platform === 'string' && platform.trim() ? platform : undefined
}

function resolveRunPlatform(source: unknown, context?: ArtifactReporterContext): string | undefined {
  if (isRecord(source)) {
    const resolvedPlatform = source.resolvedPlatform
    if (typeof resolvedPlatform === 'string' && resolvedPlatform.trim()) return resolvedPlatform
  }
  return readArtifactRuntimePlatform(context)
}

class FatalReporterError extends Error {
  readonly fatal = true

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'FatalReporterError'
  }
}

export class DashboardReporter implements Reporter {
  private db: DashboardDatabase
  private artifactsDir: string
  private suiteRunId: string | null = null
  private currentSuiteId: string | null = null
  private runIdToState = new Map<string, TestState>()
  private executionKeyToRunId = new Map<string, string>()
  private nameToCurrentRunId = new Map<string, string>()
  private completedResultRunIds = new Map<string, string>()
  private runStartTime: string | null = null
  private onRunCreated?: (runId: string) => void
  private redactor?: SecretRedactor

  constructor({
    db,
    artifactsDir = '.agent-qa/artifacts',
    onRunCreated,
    redactor,
  }: {
    db: DashboardDatabase
    artifactsDir?: string
    onRunCreated?: (runId: string) => void
    redactor?: SecretRedactor
  }) {
    this.db = db
    this.artifactsDir = artifactsDir
    this.onRunCreated = onRunCreated
    this.redactor = redactor
  }

  private redactValue<T>(value: T): T {
    return redactSecretValue(value, this.redactor)
  }

  private redactString(value: string | undefined): string | undefined {
    return value === undefined ? undefined : this.redactValue(value)
  }

  private sanitizeSecretsFileMetadata(value: unknown): unknown {
    if (value === null || value === undefined) return value
    if (!isRecord(value)) return value
    return {
      path: typeof value.path === 'string' || value.path === null ? value.path : null,
      status: typeof value.status === 'string' ? value.status : 'loaded',
      ...(typeof value.count === 'number' ? { count: value.count } : {}),
    }
  }

  private sanitizeArtifactPayload<T extends Record<string, unknown>>(payload: T): T {
    const safePayload = this.redactValue(payload) as Record<string, unknown>
    const config = safePayload.config
    if (isRecord(config) && 'secretsFile' in config) {
      safePayload.config = {
        ...config,
        secretsFile: this.sanitizeSecretsFileMetadata(config.secretsFile),
      }
    }
    return safePayload as T
  }

  private fallbackAttributes(): RunAttributes {
    return buildInternalRunAttributes({ trigger: 'cli', runner: 'local' })
  }

  private readAttributesFromEnv(): RunAttributes | null {
    const raw = process.env.AGENT_QA_RUN_ATTRIBUTES_JSON
    if (!raw) return null
    try {
      return readAttributesRecord(JSON.parse(raw))
    } catch {
      return null
    }
  }

  private resolveAttributes(context?: ArtifactReporterContext, existing?: { attributes?: RunAttributes } | null): RunAttributes {
    const contextAttributes = readAttributesRecord(context?.artifact?.metadata?.attributes)
    if (contextAttributes) return contextAttributes
    const envAttributes = this.readAttributesFromEnv()
    if (envAttributes) return envAttributes
    if (existing?.attributes && Object.keys(existing.attributes).length > 0) return existing.attributes
    if (context?.parentRunId) {
      const parent = this.db.getRun(context.parentRunId)
      if (parent?.attributes && Object.keys(parent.attributes).length > 0) return parent.attributes
    }
    if (this.suiteRunId) {
      const parent = this.db.getRun(this.suiteRunId)
      if (parent?.attributes && Object.keys(parent.attributes).length > 0) return parent.attributes
    }
    return this.fallbackAttributes()
  }

  private withAttributeMetadata<T extends Record<string, unknown>>(payload: T, attributes: RunAttributes): T {
    const metadata = isRecord(payload.metadata) ? payload.metadata : {}
    return {
      ...payload,
      metadata: {
        ...metadata,
        attributes,
      },
    }
  }

  onSuiteStart(suite: SuiteDefinition, context?: ArtifactReporterContext): void {
    const startedAt = new Date().toISOString()
    const suiteId = (suite as any)['suite-id'] ?? null
    const safeSuite = this.redactValue(suite)
    this.currentSuiteId = suiteId
    const requestedRunId = context?.runId ?? process.env.AGENT_QA_SUITE_QUEUE_ID
    const existingSuiteRun = requestedRunId ? this.db.getRun(requestedRunId) : null
    const attributes = this.resolveAttributes(context, existingSuiteRun)
    const platform = resolveRunPlatform(suite, context) ?? 'web'
    if (requestedRunId) {
      this.suiteRunId = requestedRunId
      if (existingSuiteRun) {
        this.db.updateRun(requestedRunId, {
          name: safeSuite.name,
          status: 'running',
          startedAt,
          platform,
          suiteId: suiteId ?? undefined,
          attributes,
        })
      } else {
        this.db.insertRun({
          id: requestedRunId,
          name: safeSuite.name,
          status: 'running',
          duration: 0,
          attributes,
          startedAt,
          endedAt: startedAt,
          platform,
          suiteId: suiteId ?? undefined,
        })
      }
    } else {
      this.suiteRunId = this.db.insertRun({
        name: safeSuite.name,
        status: 'running',
        duration: 0,
        attributes,
        startedAt,
        endedAt: startedAt,
        platform,
        suiteId: suiteId ?? undefined,
      })
    }
    if (this.suiteRunId) {
      this.writeArtifact(() => {
        this.db.insertRunArtifact({
          runId: this.suiteRunId!,
          kind: 'suite-parent',
          payload: this.sanitizeArtifactPayload(this.withAttributeMetadata({
            source: {
              kind: 'suite',
              suiteId,
              name: safeSuite.name,
              resolvedDefinition: safeSuite,
              loadStatus: 'loaded',
            },
            ...(context?.artifact ?? {}),
          }, attributes)),
        })
      })
    }
  }

  onSuiteEnd(summary: SuiteSummary): void {
    if (!this.suiteRunId) return
    const safeSummary = this.redactValue(summary)
    this.db.updateRun(this.suiteRunId, {
      status: safeSummary.status,
      duration: safeSummary.duration,
      endedAt: new Date().toISOString(),
    })
    this.writeArtifact(() => {
      this.stageSuiteSummary(this.suiteRunId!, safeSummary)
      this.db.finalizeRunArtifact(this.suiteRunId!, {
        runtime: {
          status: safeSummary.status,
          duration: safeSummary.duration,
          endedAt: new Date().toISOString(),
        },
      })
    })
    this.suiteRunId = null
    this.currentSuiteId = null
  }

  onRunStart(_tests: TestDefinition[]): void {
    this.runStartTime = new Date().toISOString()
  }

  async onTestStart(test: TestDefinition, filePath: string, context?: ArtifactReporterContext): Promise<void> {
    const startedAt = new Date().toISOString()
    const testId = (test as any)['test-id'] ?? null
    const executionKey = this.createExecutionKey(test, filePath, startedAt)
    const existingStateRunId = this.executionKeyToRunId.get(executionKey)
    if (existingStateRunId && this.runIdToState.has(existingStateRunId)) return

    const modelName = process.env.AGENT_QA_LLM_MODEL ?? undefined
    const llmProvider = process.env.AGENT_QA_LLM_PROVIDER ?? undefined

    // Insert a 'running' row immediately so the run is visible even if the
    // process is killed before onTestEnd fires (e.g. SIGKILL on cancel).
    const platform = resolveRunPlatform(test, context)

    // Snapshot the test file content at run time so we can see exactly what
    // was executed, even if the file is edited later.
    let testFileContent: string | undefined
    try {
      testFileContent = await readFile(filePath, 'utf-8')
    } catch { /* file may not be accessible — non-fatal */ }
    const safeTest = this.redactValue(test)
    const safeTestFileContent = this.redactString(testFileContent)
    const safeTestMeta = this.redactValue(safeTest.meta as Record<string, unknown> | undefined)

    const parentRunId = context?.parentRunId ?? process.env.AGENT_QA_PARENT_RUN_ID
    const existingRunId = context?.runId ?? process.env.AGENT_QA_RUN_ID
    const existingRun = existingRunId ? this.db.getRun(existingRunId) : null
    const attributeContext = parentRunId && context?.parentRunId !== parentRunId
      ? { ...context, parentRunId }
      : context
    const attributes = this.resolveAttributes(attributeContext, existingRun)
    let runId: string

    if (parentRunId) {
      // Retry attempt — always INSERT a new child run linked to the parent
      const attemptNumber = parseInt(process.env.AGENT_QA_ATTEMPT_NUMBER ?? '1', 10)
      const maxRetries = parseInt(process.env.AGENT_QA_MAX_RETRIES ?? '0', 10)
      runId = this.db.insertRun({
        id: existingRunId,
        name: safeTest.name,
        filePath,
        status: 'running',
        duration: 0,
        attributes,
        metadata: safeTestMeta,
        startedAt,
        endedAt: startedAt,
        parentRunId: this.suiteRunId ?? parentRunId,

        platform,
        testFileContent: safeTestFileContent,
        modelName,
        llmProvider,
        attemptNumber,
        maxRetries,
        testId: testId ?? undefined,
        suiteId: this.currentSuiteId ?? undefined,
      })
    } else if (existingRunId) {
      if (existingRun) {
        // Run row already exists from JobQueue.enqueue() — update it instead of inserting
        this.db.updateRun(existingRunId, {
          status: 'running',
          startedAt,
          endedAt: startedAt,
          testId: testId ?? undefined,
          suiteId: this.currentSuiteId ?? undefined,
          attributes,
        })
        // Also update fields that insertPendingRun didn't set
        this.db.updateRunMetadata(existingRunId, {
          metadata: safeTestMeta,
          attributes,
          platform,
          testFileContent: safeTestFileContent,
          modelName,
          llmProvider,
        })
      } else {
        this.db.insertRun({
          id: existingRunId,
          name: safeTest.name,
          filePath,
          status: 'running',
          duration: 0,
          attributes,
          metadata: safeTestMeta,
          startedAt,
          endedAt: startedAt,
          parentRunId: this.suiteRunId ?? undefined,

          platform,
          testFileContent: safeTestFileContent,
          modelName,
          llmProvider,
          testId: testId ?? undefined,
          suiteId: this.currentSuiteId ?? undefined,
        })
      }
      runId = existingRunId
    } else {
      runId = this.db.insertRun({
        name: safeTest.name,
        filePath,
        status: 'running',
        duration: 0,
        attributes,
        metadata: safeTestMeta,
        startedAt,
        endedAt: startedAt,
        parentRunId: this.suiteRunId ?? undefined,

        platform,
        testFileContent: safeTestFileContent,
        modelName,
        llmProvider,
        testId: testId ?? undefined,
        suiteId: this.currentSuiteId ?? undefined,
      })
    }

    this.runIdToState.set(runId, {
      runId,
      name: test.name,
      startedAt,
      filePath,
      stepCount: 0,
      executionKey,
      attributes,
    })
    this.executionKeyToRunId.set(executionKey, runId)
    this.nameToCurrentRunId.set(test.name, runId)

    const artifactKind = context?.artifact?.kind ?? (this.suiteRunId ? 'suite-child' : 'test')
    const fallbackArtifact = {
      source: {
        kind: 'test',
        testId,
        name: safeTest.name,
        filePath,
        rawYaml: safeTestFileContent ?? null,
        resolvedDefinition: safeTest,
        loadStatus: 'loaded',
      },
      runtime: {
        status: 'running',
        startedAt,
        platform,
      },
    }
    this.writeArtifact(() => {
      this.db.insertRunArtifact({
        runId,
        kind: artifactKind,
        payload: this.sanitizeArtifactPayload(this.withAttributeMetadata({
          ...fallbackArtifact,
          ...(context?.artifact ?? {}),
        }, attributes)),
      })
      if (this.suiteRunId && typeof context?.artifact?.suiteIndex === 'number') {
        this.stageSuiteChildLink(this.suiteRunId, context.artifact.suiteIndex, runId)
      }
    })

    this.onRunCreated?.(runId)
  }

  async onStepEnd(result: StepResult, testName: string): Promise<void> {
    const state = this.getStateByTestName(testName)
    if (!state) return

    const runId = state.runId
    const stepOrder = state.stepCount++

    // Persist step immediately so it survives process kill on cancellation
    await this.persistStep(result, runId, stepOrder)
  }

  async onTestEnd(result: TestResult): Promise<void> {
    const state = this.getStateForResult(result)
    const safeResult = this.redactValue(result)
    const endedAt = new Date().toISOString()
    const errorLog = this.buildResultErrorLog(safeResult)
    let fallbackResultAttributes: RunAttributes | undefined

    let runId: string
    if (state) {
      // The run row was already inserted in onTestStart with status='running'.
      // Update it with the final status, duration, and summary.
      runId = state.runId
      const normalizedVideoPath = await materializeVideoPath(safeResult.videoPath, this.artifactsDir, runId)
      this.db.updateRun(runId, {
        name: safeResult.name,
        status: safeResult.status,
        duration: safeResult.duration,
        endedAt,
        failureSummary: safeResult.failureSummary,
        errorLog,
        videoPath: normalizedVideoPath,
      })
      if (safeResult.metadata) {
        this.db.updateRunMetadata(runId, { metadata: safeResult.metadata as Record<string, unknown> })
      }
      if ((safeResult as any).memoryLog) {
        this.db.updateRun(runId, {
          memoryLog: JSON.stringify((safeResult as any).memoryLog),
        })
      }
    } else {
      // Fallback: onTestStart was never called (programmatic usage).
      // Insert the run directly with the final result.
      const modelName = process.env.AGENT_QA_LLM_MODEL ?? undefined
      const llmProvider = process.env.AGENT_QA_LLM_PROVIDER ?? undefined
      const resultMetadata = isRecord(safeResult.metadata) ? safeResult.metadata : undefined
      const resultAttributes = readAttributesRecord(resultMetadata?.attributes)
      const attributes = resultAttributes ?? this.resolveAttributes()
      fallbackResultAttributes = attributes
      const fallbackRunId = process.env.AGENT_QA_RUN_ID || undefined

      let testFileContent: string | undefined
      if (result.filePath) {
        try {
          testFileContent = await readFile(result.filePath, 'utf-8')
        } catch { /* non-fatal */ }
      }

      runId = this.db.insertRun({
        id: fallbackRunId,
        name: safeResult.name,
        filePath: safeResult.filePath,
        status: safeResult.status,
        duration: safeResult.duration,
        attributes,
        metadata: safeResult.metadata,
        startedAt: endedAt,
        endedAt,
        parentRunId: this.suiteRunId ?? undefined,

        videoPath: undefined,
        failureSummary: safeResult.failureSummary,
        platform: (safeResult.metadata as Record<string, unknown> | undefined)?.platform as string | undefined,
        testFileContent: this.redactString(testFileContent),
        modelName,
        llmProvider,
        suiteId: this.currentSuiteId ?? undefined,
      })
      const normalizedVideoPath = await materializeVideoPath(safeResult.videoPath, this.artifactsDir, runId)
      this.db.updateRun(runId, { videoPath: normalizedVideoPath })
      if (errorLog) {
        this.db.updateRun(runId, { errorLog })
      }
      this.writeArtifact(() => {
        this.db.insertRunArtifact({
          runId,
          kind: this.suiteRunId ? 'suite-child' : 'test',
          payload: {
            source: {
              kind: 'test',
              name: safeResult.name,
              filePath: safeResult.filePath,
              rawYaml: this.redactString(testFileContent) ?? null,
              loadStatus: 'runtime-error',
            },
            metadata: { attributes },
          },
        })
      })
    }

    // Steps were already persisted in onStepEnd. If onStepEnd was not called
    // (e.g. programmatic usage without per-step callbacks), persist any remaining.
    if (!state || state.stepCount === 0) {
      for (let i = 0; i < safeResult.steps.length; i++) {
        await this.persistStep(safeResult.steps[i], runId, i)
      }
    }

    const storedVideoPath = this.db.getRun(runId)?.videoPath ?? normalizeVideoPath(safeResult.videoPath, this.artifactsDir)
    const memoryLog = (safeResult as any).memoryLog
    this.writeArtifact(() => {
      const patch: Record<string, unknown> = {
        runtime: {
          status: safeResult.status,
          duration: safeResult.duration,
          endedAt,
          videoPath: storedVideoPath ?? null,
          failureSummary: safeResult.failureSummary ?? null,
          errorLog: errorLog ?? null,
          metadata: safeResult.metadata ?? null,
        },
      }
      if ((safeResult.status === 'failed' || safeResult.status === 'cancelled') && (safeResult.failureSummary || errorLog)) {
        patch.errors = [{
          code: safeResult.status,
          phase: 'test',
          message: safeResult.failureSummary ?? errorLog!,
        }]
      }
      if (memoryLog) {
        patch.memory = { log: memoryLog }
      }
      patch.metadata = { attributes: state?.attributes ?? fallbackResultAttributes ?? this.resolveAttributes() }
      const artifact = this.db.getRunArtifact(runId)
      if (artifact && !artifact.finalizedAt) {
        this.db.stageRunArtifact(runId, patch as any)
      }
    })

    this.completedResultRunIds.set(this.resultKey(result), runId)
    this.deleteState(state, result.name)
  }

  onRunEnd(summary: RunSummary): void {
    for (const result of summary.results) {
      const runId = this.completedResultRunIds.get(this.resultKey(result))
      if (!runId) continue
      this.writeArtifact(() => {
        const artifact = this.db.getRunArtifact(runId)
        if (!artifact || artifact.finalizedAt) return
        const memoryLog = this.redactValue((result as any).memoryLog)
        if (memoryLog) {
          this.db.updateRun(runId, { memoryLog: JSON.stringify(memoryLog) })
          this.db.stageRunArtifact(runId, { memory: { log: memoryLog } as any })
        }
        this.db.finalizeRunArtifact(runId)
      })
      this.completedResultRunIds.delete(this.resultKey(result))
    }
  }

  onHookEnd(event: HookResultEvent): void {
    const safeEvent = this.redactValue(event)
    const runId = safeEvent.runId ?? this.getCurrentRunId() ?? this.suiteRunId
    if (!runId) return

    try {
      this.db.insertExecutionLog({
        id: safeEvent.hookExecutionId,
        runId,
        stepId: safeEvent.stepId ?? null,
        type: safeEvent.type ?? 'hook',
        name: safeEvent.hookName,
        hookId: safeEvent.hookId ?? null,
        phase: safeEvent.phase,
        status: safeEvent.status,
        duration: safeEvent.duration,
        stdout: safeEvent.stdout || null,
        stderr: safeEvent.stderr || null,
        variables: Object.keys(safeEvent.variables).length > 0 ? safeEvent.variables : null,
      })
    } catch {
      // DB write failure should not crash the test
    }
  }

  private getCurrentRunId(): string | null {
    for (const state of this.runIdToState.values()) {
      return state.runId
    }
    return null
  }

  private createExecutionKey(test: TestDefinition, filePath: string, startedAt: string): string {
    const testId = (test as any)['test-id'] as string | undefined
    return `${testId ?? test.name}|${filePath || startedAt}`
  }

  private getStateByTestName(testName: string): TestState | undefined {
    const runId = this.nameToCurrentRunId.get(testName)
    return runId ? this.runIdToState.get(runId) : undefined
  }

  private getStateForResult(result: TestResult): TestState | undefined {
    if (result.runId) {
      const state = this.runIdToState.get(result.runId)
      if (state) return state
    }
    for (const state of this.runIdToState.values()) {
      if (state.name === result.name && (!result.filePath || state.filePath === result.filePath)) {
        return state
      }
    }
    return this.getStateByTestName(result.name)
  }

  private deleteState(state: TestState | undefined, testName: string): void {
    if (!state) return
    this.runIdToState.delete(state.runId)
    this.executionKeyToRunId.delete(state.executionKey)
    if (this.nameToCurrentRunId.get(testName) === state.runId) {
      this.nameToCurrentRunId.delete(testName)
    }
  }

  private resultKey(result: Pick<TestResult, 'name' | 'filePath'>): string {
    return `${result.name}|${result.filePath ?? ''}`
  }

  private buildResultErrorLog(result: TestResult): string | undefined {
    if (result.status !== 'failed' && result.status !== 'cancelled') return undefined
    const lines = [
      result.failureSummary,
      ...result.steps.flatMap((step) => [
        step.error,
        step.trace?.error,
      ]),
    ].filter((line): line is string => typeof line === 'string' && line.trim().length > 0)
    return lines.length > 0 ? [...new Set(lines)].join('\n') : undefined
  }

  private writeArtifact<T>(fn: () => T): T {
    try {
      return fn()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new FatalReporterError(`Artifact persistence failed: ${message}`, { cause: err })
    }
  }

  private stageSuiteChildLink(parentRunId: string, suiteIndex: number, childRunId: string): void {
    const parent = this.db.getRunArtifact(parentRunId)
    const source = parent?.payload.source
    if (!source || typeof source !== 'object' || !('members' in source) || !Array.isArray((source as any).members)) {
      return
    }
    const members = [...(source as any).members]
    const member = members[suiteIndex]
    if (!member || typeof member !== 'object') return
    members[suiteIndex] = { ...member, childRunId }
    this.db.stageRunArtifact(parentRunId, {
      source: {
        members,
      } as any,
    })
  }

  private stageSuiteSummary(parentRunId: string, summary: SuiteSummary): void {
    const parent = this.db.getRunArtifact(parentRunId)
    const source = parent?.payload.source
    if (!source || typeof source !== 'object' || !('members' in source) || !Array.isArray((source as any).members)) {
      return
    }
    const childRuns = this.db.getRunsByParent(parentRunId)
    const members = [...(source as any).members].map((member, index) => {
      if (!member || typeof member !== 'object') return member
      const memberRecord = { ...(member as Record<string, unknown>) }
      const child = childRuns.find((run) =>
        run.filePath === memberRecord.filePath
        || (typeof memberRecord.name === 'string' && run.name === memberRecord.name)
      )
      if (child) memberRecord.childRunId = child.id
      const result = summary.tests[index]
      const skipReason = (result?.metadata as Record<string, unknown> | undefined)?.skipReason
      if (result?.status === 'skipped' && typeof skipReason === 'string') {
        memberRecord.loadStatus = 'skipped'
        memberRecord.skipReason = skipReason
      }
      return memberRecord
    })
    this.db.stageRunArtifact(parentRunId, {
      source: { members } as any,
      memory: { aggregate: this.buildSuiteMemoryAggregate(parentRunId) } as any,
    })
  }

  private buildSuiteMemoryAggregate(parentRunId: string): Record<string, unknown> {
    const children = this.db.getRunsByParent(parentRunId)
    const aggregate = {
      added: 0,
      confirmed: 0,
      deprecated: 0,
      deleted: 0,
      errors: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      childRunIds: [] as string[],
    }
    for (const child of children) {
      let rawLog: unknown = null
      if (child.memoryLog) {
        try {
          rawLog = JSON.parse(child.memoryLog)
        } catch {
          rawLog = null
        }
      }
      if (!rawLog) {
        const childArtifact = this.db.getRunArtifact(child.id)
        const memory = childArtifact?.payload.memory
        rawLog = isRecord(memory) ? memory.log : null
      }
      if (!isRecord(rawLog)) continue
      try {
        const log = rawLog as {
          added?: number
          confirmed?: number
          deprecated?: number
          deleted?: number
          errors?: unknown[]
          tokenUsage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number }
        }
        aggregate.added += log.added ?? 0
        aggregate.confirmed += log.confirmed ?? 0
        aggregate.deprecated += log.deprecated ?? 0
        aggregate.deleted += log.deleted ?? 0
        aggregate.errors += Array.isArray(log.errors) ? log.errors.length : 0
        aggregate.promptTokens += log.tokenUsage?.promptTokens ?? 0
        aggregate.completionTokens += log.tokenUsage?.completionTokens ?? 0
        aggregate.totalTokens += log.tokenUsage?.totalTokens ?? 0
        aggregate.childRunIds.push(child.id)
      } catch { /* skip malformed log */ }
    }
    return aggregate
  }

  private async persistStep(step: StepResult, runId: string, stepOrder: number): Promise<void> {
    const safeStep = this.redactValue(step)
    let screenshotPath: string | undefined
    let screenshotBeforePath: string | undefined

    if (safeStep.screenshotBefore) {
      screenshotBeforePath = await this.saveScreenshot(safeStep.screenshotBefore, runId, stepOrder, safeStep.name, 'before')
    }
    if (safeStep.screenshot) {
      screenshotPath = await this.saveScreenshot(safeStep.screenshot, runId, stepOrder, safeStep.name)
    }

    let healingScreenshotPaths: string[] | undefined
    if (safeStep.healingScreenshots && safeStep.healingScreenshots.length > 0) {
      healingScreenshotPaths = []
      for (let j = 0; j < safeStep.healingScreenshots.length; j++) {
        const healPath = await this.saveHealingScreenshot(safeStep.healingScreenshots[j], runId, stepOrder, j)
        healingScreenshotPaths.push(healPath)
      }
    }

    let subActionsForDb: unknown[] | undefined
    if (safeStep.trace?.subActions && safeStep.trace.subActions.length > 0) {
      subActionsForDb = []
      for (let j = 0; j < safeStep.trace.subActions.length; j++) {
        const sub = safeStep.trace.subActions[j]
        const mapped: Record<string, unknown> = { ...sub }
        delete mapped.screenshotBefore
        delete mapped.screenshotAfter
        if (sub.screenshotBefore) {
          mapped.screenshotBeforePath = await this.saveSubActionScreenshot(sub.screenshotBefore, runId, stepOrder, j, 'before')
        }
        if (sub.screenshotAfter) {
          mapped.screenshotAfterPath = await this.saveSubActionScreenshot(sub.screenshotAfter, runId, stepOrder, j, 'after')
        }
        subActionsForDb.push(mapped)
      }
    }

    const stepId = this.db.insertStep({
      id: safeStep.id,
      runId,
      name: safeStep.name,
      status: safeStep.status,
      duration: safeStep.duration,
      action: safeStep.action,
      observation: safeStep.trace?.observation ?? safeStep.observation,
      reasoning: safeStep.trace?.reasoning,
      plannedAction: safeStep.trace?.plannedAction,
      result: safeStep.trace?.result,
      error: safeStep.error ?? safeStep.trace?.error,
      screenshotPath,
      screenshotBeforePath,
      healingAttempts: safeStep.healingAttempts,
      retryCount: safeStep.retryCount,
      capturedVariables: safeStep.capturedVariables,
      stepOrder,
      annotationData: safeStep.annotation,
      healingScreenshotPaths,
      accessibilityViolations: safeStep.accessibilityViolations,
      confidence: safeStep.trace?.confidence,
      promptTokens: safeStep.trace?.tokenUsage?.promptTokens,
      completionTokens: safeStep.trace?.tokenUsage?.completionTokens,
      totalTokens: safeStep.trace?.tokenUsage?.totalTokens,
      subActionsData: subActionsForDb,
      consoleLogs: safeStep.consoleLogs,
      networkLogs: safeStep.networkLogs,
      variableSnapshot: safeStep.variableSnapshot,
      originalStepName: safeStep.originalStepName,
      screenContextBefore: safeStep.trace?.screenContextBefore,
      screenContextAfter: safeStep.trace?.screenContextAfter,
    })

    if (safeStep.trace?.tokenUsage && (safeStep.trace.tokenUsage.promptTokens > 0 || safeStep.trace.tokenUsage.completionTokens > 0)) {
      const modelName = process.env.AGENT_QA_LLM_MODEL ?? 'unknown'
      this.db.insertTokenEvent({
        modelName,
        promptTokens: safeStep.trace.tokenUsage.promptTokens,
        completionTokens: safeStep.trace.tokenUsage.completionTokens,
        source: 'test-run',
      })
    }

    if (safeStep.trace?.phaseDurations) {
      this.db.insertReasoningTrace({
        stepId,
        observeText: safeStep.trace.observation,
        observeDuration: safeStep.trace.phaseDurations.observe,
        planReasoning: safeStep.trace.reasoning,
        planConfidence: safeStep.trace.confidence,
        planAction: safeStep.trace.plannedAction,
        planDuration: safeStep.trace.phaseDurations.plan,
        executeAction: safeStep.action,
        executeDuration: safeStep.trace.phaseDurations.execute,
        verifyReasoning: safeStep.trace.verifierReasoning,
        verifySuccess: safeStep.trace.result === 'success',
        verifyDuration: safeStep.trace.phaseDurations.verify,
        healAttempts: safeStep.healingAttempts,
        totalDuration: safeStep.duration,
        screenStateBefore: safeStep.trace.screenStateBefore,
        screenStateAfter: safeStep.trace.screenStateAfter,
      })
    }
  }

  private async saveScreenshot(buffer: Buffer, runId: string, stepOrder: number, stepName: string, suffix?: string): Promise<string> {
    const sanitized = stepName.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 50)
    const dir = join(this.artifactsDir, 'screenshots', runId)
    await mkdir(dir, { recursive: true })
    const filename = suffix
      ? `${stepOrder}-${sanitized}-${suffix}.png`
      : `${stepOrder}-${sanitized}.png`
    await writeFile(join(dir, filename), buffer)
    return join(runId, filename)
  }

  private async saveHealingScreenshot(buffer: Buffer, runId: string, stepOrder: number, attemptIndex: number): Promise<string> {
    const dir = join(this.artifactsDir, 'screenshots', runId)
    await mkdir(dir, { recursive: true })
    const filename = `${stepOrder}-healing-${attemptIndex}.png`
    await writeFile(join(dir, filename), buffer)
    return join(runId, filename)
  }

  private async saveSubActionScreenshot(buffer: Buffer, runId: string, stepOrder: number, subIndex: number, suffix: 'before' | 'after'): Promise<string> {
    const dir = join(this.artifactsDir, 'screenshots', runId)
    await mkdir(dir, { recursive: true })
    const filename = `${stepOrder}-sub-${subIndex}-${suffix}.png`
    await writeFile(join(dir, filename), buffer)
    return join(runId, filename)
  }
}
