import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { generateRunId, generateSuiteId, generateTestId } from '@vostride/agent-qa-ids'
import { SecretRedactor, SecretStore, createRunEventBus, createMemberEventSink, executeStep, makeScreenState, scriptedVerification } from '@vostride/agent-qa-runner'
import type { EvidenceArtifactStorePort } from '@vostride/agent-qa-runner'
import { createRunInvocationCore } from '@vostride/agent-qa-agent-local'
import { FsEvidenceArtifactStore, slugBranch } from '@vostride/agent-qa-runner-local'
import { DashboardDatabase, createDashboardRunDetailReader, createDashboardRunIngest } from '@vostride/agent-qa-dashboard'
import {
  asRunId,
  AriaEvidenceDocumentSchema,
  ConsoleEvidenceDocumentSchema,
  screenStateHash,
  RUN_EVIDENCE_DOCUMENT_SCHEMA_VERSION,
} from '@vostride/agent-qa-schema'
import { RunDetailProjectionSchema } from '@vostride/agent-qa-schema'
import { createFunctionRegistry, invokeFunction, RUNS_DETAIL_FUNCTION_ID, type FunctionDeps } from '@vostride/agent-qa-agent'
import type { RunEventEnvelope, StepFinalizedPayload } from '@vostride/agent-qa-schema'
import { produceDirectRunMembers, produceSuiteRunMembers } from '../commands/run.js'
import type { RunInvocationInputs, SuiteRunMemberProductionInput } from '../commands/run.js'
import { assembleCliRun } from '../composition/run-assembly.js'
import type { LoopPorts, StepResult } from '@vostride/agent-qa-runner'
import type { ScreenState, SubActionRecordedPayload } from '@vostride/agent-qa-schema'

const boundary = vi.hoisted(() => ({
  provider: vi.fn(() => { throw new Error('provider must not be called') }),
  observe: vi.fn(() => { throw new Error('evidence must not add a capture') }),
  execute: vi.fn(async () => ({ success: true })),
  drain: vi.fn(() => [] as Array<{ level: string; text: string; timestamp: number; location?: { url: string; lineNumber: number; columnNumber: number } }>),
  onExecute: () => {},
}))

// Only external model/platform boundaries are doubles. The producers, member runner,
// terminal finalizer, run bus, filesystem store and dashboard subscriber remain real.
vi.mock('@vostride/agent-qa-model', async importOriginal => ({
  ...await importOriginal<typeof import('@vostride/agent-qa-model')>(),
  createModel: () => ({ doGenerate: boundary.provider, doStream: boundary.provider }),
}))
vi.mock('../llm-utils.js', async importOriginal => ({
  ...await importOriginal<typeof import('../llm-utils.js')>(),
  resolveModelAuth: async () => ({ kind: 'unauthenticated', credentialKey: 'fixture', provider: 'openai-compatible', optional: true, message: 'fixture' }),
}))
vi.mock('@vostride/agent-qa-web', () => ({
  WebPlatformAdapter: class {
    platform = 'web' as const
    async setup() {}
    async cleanup() {}
    async navigate() {}
    observe = boundary.observe
    async execute() { boundary.onExecute(); return boundary.execute() }
    drainConsoleLogs = boundary.drain
  },
}))

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agent-qa-423-paths-'))
  vi.clearAllMocks()
  vi.stubEnv('AGENT_QA_LLM_MODEL', '')
  vi.stubEnv('AGENT_QA_LLM_PROVIDER', '')
  vi.stubEnv('AGENT_QA_RUN_ATTRIBUTES_JSON', '')
  vi.stubEnv('AGENT_QA_RUN_ID', '')
  // The production command treats an empty run ID as supplied at some boundaries.
  delete process.env.AGENT_QA_RUN_ID
})
afterEach(() => {
  boundary.onExecute = () => {}
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

for (const path of ['COMPOSED', 'DIRECT'] as const) {
  it(`CONSOLE-${path}-PATH / CONSOLE-REOPEN-READ: real CLI member stores masked bytes and publishes the immutable ref`, async () => {
    const runId = generateRunId()
    const testId = generateTestId()
    const filePath = join(root, 'one.yaml')
    const suiteFile = join(root, 'one.suite.yaml')
    const configFilePath = join(root, 'agent-qa.config.yaml')
    const test = { 'test-id': testId, name: 'Console evidence', target: 'fixture', steps: ['{{appium: mobile: scroll, direction: down}}'] }
    const fileContent = JSON.stringify(test)
    writeFileSync(filePath, fileContent)
    writeFileSync(suiteFile, 'name: Console suite\n')
    const config = {
      workspace: { testMatch: ['*.yaml'], suiteMatch: ['*.suite.yaml'], testPathIgnore: [] },
      registry: {
        llms: [{ name: 'fixture', provider: 'openai-compatible', model: 'gpt-4o', baseURL: 'http://127.0.0.1:1/v1' }],
        targets: { fixture: { platform: 'web', product: 'console-fixture' } },
      },
      use: { llm: 'fixture', cache: false, logCapture: { console: true, network: false }, timeout: { step: 1000, test: 5000 } },
      services: { logging: { level: 'silent' } },
      knowledge: { dir: 'knowledge' },
    } as unknown as RunInvocationInputs['config']
    const configContent = JSON.stringify(config)
    writeFileSync(configFilePath, configContent)
    const lateSecret = 'synthetic-late-console-token'
    const secretStore = SecretStore.fromEnvContent(`LATE_CONSOLE=${lateSecret}`)
    const secretRedactor = new SecretRedactor(secretStore)
    const records = [
      { level: 'warn', text: `first ${lateSecret}`, timestamp: 23, location: { url: `https://example.invalid/${lateSecret}`, lineNumber: 2, columnNumber: 4 } },
      { level: 'error', text: `second ${lateSecret}`, timestamp: 11 },
    ]
    boundary.drain.mockImplementation(() => records)
    const opts = { disableCache: true, reporter: ['console'] }
    const inputs = {
      config, configDir: root, configFilePath, configContent,
      runtimeSecrets: { secretStore, secretRedactor, secretsFileMetadata: { path: null, status: 'missing' } },
      envFileVars: {}, inlineVars: {}, cliVars: {}, userRunAttributes: {},
      effectiveLogLevel: 'silent', resolvedHooks: new Map(),
      rawEnvFileContent: null, resolvedEnvFilePath: null,
    } as RunInvocationInputs
    const produced = path === 'DIRECT'
      ? await produceDirectRunMembers({ inputs, bindings: [{ test, filePath, fileContent }] as never, opts })
      : await produceSuiteRunMembers({
          config, configDir: root, configFilePath, configContent, runId, opts,
          effectiveLogLevel: 'silent', suiteFiles: [suiteFile], loadPlugins: async () => {},
          preflight: {
            definitions: new Map([[suiteFile, { 'suite-id': generateSuiteId(), name: 'Console suite', target: 'fixture', tests: [{ test: 'one.yaml', id: testId }] }]]),
            preloadedTests: new Map([[filePath, { fileContent, parseResult: { tests: [test], errors: [] } }]]),
            product: 'console-fixture',
          },
          variableContext: { envFileVars: {}, inlineVars: {}, cliVars: {}, userRunAttributes: {}, secretStore, secretRedactor },
        } as SuiteRunMemberProductionInput)
    const dbPath = join(root, 'dashboard.db')
    const db = new DashboardDatabase({ dbPath })
    const ingest = createDashboardRunIngest({ db, runId })
    const events: RunEventEnvelope[] = []
    let store: EvidenceArtifactStorePort | undefined
    let bytesAtPublication: Uint8Array | undefined
    const core = createRunInvocationCore({
      configPath: configFilePath, agentQaRoot: join(root, '.agent-qa'), executionContext: 'ci',
      mintRunId: () => runId, isMintedRunId: () => true,
      assembleRun: async context => {
        store = context.ports.evidenceArtifacts
        const assembly = await assembleCliRun({
          ...context, knowledgeRoot: produced.knowledgeRoot, secretRedactor: produced.secretRedactor,
          members: produced.members, executor: produced.executor, configDigests: produced.configDigests,
          product: produced.product, warn: () => {},
        })
        produced.applyAssembly(assembly)
        produced.bindKnowledge?.(assembly.buildOrdinal)
        return assembly.config
      },
      onSession: session => {
        produced.bindSession(session)
        session.subscribe(1, event => {
          events.push(event)
          if (event.type === 'stepFinalized') {
            const entry = (event.payload as StepFinalizedPayload).evidence?.console
            if (entry?.state === 'present') bytesAtPublication = store!.getBlob(entry.ref.sha)
          }
          ingest.handler(event)
        })
      },
    })
    try {
      await core.execute({})
      await produced.finalize?.()
      expect(produced.takeFrameworkError()).toBeUndefined()
      const terminals = events.filter(event => event.type === 'stepFinalized')
      expect(terminals).toHaveLength(1)
      const terminal = terminals[0]!.payload as StepFinalizedPayload
      expect(terminal.status).toBe('passed')
      expect(terminal.evidence?.console).toMatchObject({ state: 'present', counts: { total: 2, errors: 1, warnings: 1 } })
      const entry = terminal.evidence!.console
      if (entry.state !== 'present') throw new Error('Expected persisted console evidence')
      const bytes = store!.getBlob(entry.ref.sha)!
      expect(bytesAtPublication).toEqual(bytes)
      const text = Buffer.from(bytes).toString('utf8')
      expect(text).not.toContain(lateSecret)
      expect(ConsoleEvidenceDocumentSchema.parse(JSON.parse(text)).records).toEqual(records.map(record => ({
        ...record, text: secretRedactor.redactString(record.text),
        ...(record.location ? { location: { ...record.location, url: secretRedactor.redactString(record.location.url) } } : {}),
      })))
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(entry.ref.sha)
      expect(entry.ref.id).toBe(`console-evidence:${entry.ref.sha}`)
      const persistedEvents = readFileSync(join(root, '.agent-qa', 'runs', slugBranch(runId), 'events.jsonl'), 'utf8')
        .trim().split('\n').map(line => JSON.parse(line) as RunEventEnvelope)
      expect(persistedEvents.filter(event => event.type === 'stepFinalized')).toEqual(terminals)
      const blobDir = join(root, '.agent-qa', 'runs', slugBranch(runId), 'blobs')
      expect(readdirSync(blobDir)).toEqual([entry.ref.sha])
      expect(readFileSync(join(blobDir, entry.ref.sha))).toEqual(Buffer.from(bytes))
      const reopened = new FsEvidenceArtifactStore({ root: join(root, '.agent-qa'), runId })
      expect(reopened.getBlob(entry.ref.sha)).toEqual(bytes)
      expect(boundary.provider).not.toHaveBeenCalled()
      expect(boundary.observe).not.toHaveBeenCalled()
      expect(boundary.execute).toHaveBeenCalledTimes(1)
      expect(boundary.drain).toHaveBeenCalledTimes(1)
      await ingest.finalize({})
      db.close()
      const coldDb = new DashboardDatabase({ dbPath })
      try {
        const rows = await createDashboardRunDetailReader(coldDb).read(asRunId(runId))
        expect(rows?.steps).toHaveLength(1)
        expect(rows?.steps[0]?.status).toBe('passed')
        expect(rows?.steps[0]?.evidence).toEqual(terminal.evidence)
        const registry = createFunctionRegistry({
          deps: { runDetail: createDashboardRunDetailReader(coldDb) } as FunctionDeps,
          // 2026-10-02 (432-36, D-12): no `resolveExecutionContext` registry option, and the caller
          // carries no `grantedScopes`/`safeMode` (or the cast that carried them); the registry
          // reads neither (432-20).
        })
        const detail = RunDetailProjectionSchema.parse(await invokeFunction(
          registry, RUNS_DETAIL_FUNCTION_ID, { runId: asRunId(runId) },
          { surface: 'cli', origin: 'human' },
        ))
        const coldEntry = detail.steps[0]?.evidence?.console
        expect(coldEntry).toEqual(entry)
        if (coldEntry?.state !== 'present') throw new Error('Expected reopened console ref')
        const coldBytes = reopened.getBlob(coldEntry.ref.sha)!
        expect(coldBytes).toEqual(bytes)
        expect(createHash('sha256').update(coldBytes).digest('hex')).toBe(coldEntry.ref.sha)
        expect(ConsoleEvidenceDocumentSchema.parse(JSON.parse(Buffer.from(coldBytes).toString('utf8'))).records)
          .toEqual(ConsoleEvidenceDocumentSchema.parse(JSON.parse(text)).records)
        expect(Buffer.from(coldBytes).toString('utf8')).not.toContain(lateSecret)
        expect(detail.steps[0]).not.toHaveProperty('variableSnapshot')
      } finally { coldDb.close() }
      expect(reopened.getBlob(entry.ref.sha)).toEqual(bytes)
    } finally {
      db.close()
    }
  })
}

// This slice uses the real runner, sink, subscriber, disk stores and function registry.
// Platform/model are deterministic ports. runs.evidence selection belongs to 423-29/09;
// here runs.detail selects the recorded child and the existing store reads its SHA bytes.
async function ariaReadback(mode: 'two' | 'empty' | 'missing' | 'mobile' | 'childless' | 'historical') {
  const runId = generateRunId()
  const secret = 'synthetic-aria-late-secret'
  const runRedactor = new SecretRedactor(new SecretStore())
  const before = [0, 1].map(index => makeScreenState({
    platform: mode === 'mobile' ? 'android' : 'web',
    tree: mode === 'empty' ? '' : `before child ${index} ${secret}`,
  }))
  const after = [0, 1].map(index => makeScreenState({ tree: `after child ${index} ${secret}` }))
  const screens = [before[0]!, before[0]!, after[0]!, after[0]!, before[1]!, before[1]!, after[1]!, after[1]!]
  let observeIndex = 0
  let current: ScreenState = before[0]!
  let verification = 0
  const storeRoot = join(root, '.agent-qa')
  const store = new FsEvidenceArtifactStore({ root: storeRoot, runId })
  const dbPath = join(root, 'aria.db')
  const db = new DashboardDatabase({ dbPath })
  const ingest = createDashboardRunIngest({ db, runId })
  const bus = createRunEventBus({ runId })
  const events: RunEventEnvelope[] = []
  const publicationBytes = new Map<string, Uint8Array>()
  bus.subscribe(1, event => {
    events.push(event)
    if (event.type === 'subActionRecorded') {
      const child = event.payload as SubActionRecordedPayload
      for (const ref of child.artifactRefs ?? []) {
        const bytes = store.getBlob(ref.sha)
        if (bytes) publicationBytes.set(ref.sha, bytes)
      }
    }
    ingest.handler(event)
  })
  bus.publish('runStarted', {})
  bus.publish('testStarted', { testIndex: 0, testId: generateTestId(), name: 'ARIA member' })
  const sink = createMemberEventSink({ bus, mask: text => runRedactor.redactString(text), testIndex: 0 }).loopEmitFor(0)
  const ports: LoopPorts = {
    adapter: {
      platform: mode === 'mobile' ? 'android' : 'web',
      async setup() {}, async cleanup() {},
      async observe() { current = screens[Math.min(observeIndex++, screens.length - 1)]!; return current },
      async execute() { return { success: true } },
      async screenshot() { return Buffer.from(`decision image ${current.tree}`) },
    },
    planner: { async plan() { return { plan: {
      reasoning: 'record child', action: { type: 'wait' }, confidence: 1,
      stepComplete: true, stepFailed: false,
    } } } },
    verifier: { async verify(step, _before, after, action) { return { verification: scriptedVerification({
      step, after, action, pass: verification++ > 0, reasoning: 'fixture verdict',
    }) } } },
    secretRedactor: new SecretRedactor(new SecretStore({ ARIA_SECRET: secret })),
    evidenceArtifacts: store, events: sink,
  }
  let result: StepResult | undefined
  try {
    if (mode === 'childless' || mode === 'historical') {
      bus.publish('stepFinalized', { testIndex: 0, stepIndex: 0, cacheStatus: 'bypass',
        verifierVerdict: { pass: true, reasoning: 'recorded' }, selfHealOccurred: false,
        briefDigest: 'recorded', status: 'passed' })
      if (mode === 'historical') {
        bus.publish('subActionRecorded', { testIndex: 0, stepIndex: 0, subActionIndex: 0,
          plan: 'historical', plannedAction: { type: 'wait' }, result: { success: true },
          screenStateHash: screenStateHash(before[0]!),
        })
      }
    } else {
      result = await executeStep('Wait for the second state', ports, {
        stepInstruction: 'Wait', testName: 'ARIA member', previousSteps: [],
        plannerModel: {} as never, verifierModel: {} as never,
      })
      expect(result.status).toBe('passed')
    }
    await ingest.finalize({})
  } finally { db.close() }
  const handoffPath = join(root, 'handoff.json')
  writeFileSync(handoffPath, JSON.stringify(result?.evidence ?? { stateBefore: before[0], stateAfter: after[0] }))
  const handoffBytes = readFileSync(handoffPath)
  expect(handoffBytes.toString()).toContain(secret)
  const recordedChildren = events.filter(event => event.type === 'subActionRecorded')
    .map(event => event.payload as SubActionRecordedPayload)
  const lost = mode === 'missing' ? recordedChildren[0]?.ariaEvidence : undefined
  if (lost?.state === 'present') rmSync(join(storeRoot, 'runs', slugBranch(runId), 'blobs', lost.ref.sha))
  const reopened = new FsEvidenceArtifactStore({ root: storeRoot, runId })
  const cold = new DashboardDatabase({ dbPath })
  const forbidden = vi.fn(() => { throw new Error('Historical handoff must not be loaded') })
  const blobRead = vi.fn(() => { throw new Error('runs.detail probes presence only') })
  try {
    const registry = createFunctionRegistry({
      deps: {
        runDetail: createDashboardRunDetailReader(cold), runs: { get: forbidden },
        evidenceBlobs: { read: blobRead, has: async (_runId: unknown, sha: string) => reopened.hasBlob(sha) ? 'found' : 'blob_absent' },
      } as unknown as FunctionDeps,
      // 2026-10-02 (432-36, D-12): no `resolveExecutionContext` registry option, and the caller
      // carries no `grantedScopes`/`safeMode` (or the cast that carried them); the registry reads
      // neither (432-20).
    })
    const detail = RunDetailProjectionSchema.parse(await invokeFunction(
      registry, RUNS_DETAIL_FUNCTION_ID, { runId: asRunId(runId) },
      { surface: 'cli', origin: 'human' },
    ))
    expect(forbidden).not.toHaveBeenCalled()
    expect(blobRead).not.toHaveBeenCalled()
    expect(readFileSync(handoffPath).equals(handoffBytes)).toBe(true)
    expect(detail.steps).toHaveLength(1)
    expect(detail.subActions.map(child => child.subActionIndex)).toEqual(
      mode === 'childless' ? [] : mode === 'historical' ? [0] : [0, 1],
    )
    if (mode === 'childless') {
      expect(detail.steps[0]).not.toHaveProperty('ariaEvidence')
      expect(detail.subActions).toEqual([])
    } else if (mode === 'historical') {
      expect(detail.subActions[0]?.ariaEvidence).toEqual({ kind: 'aria', state: 'absent', reason: 'unavailable' })
      expect(detail.subActions[0]?.artifactRefs).toBeUndefined()
      expect(cold.readRunDetailRows(runId)?.subActions[0]).not.toHaveProperty('ariaEvidence')
    } else {
      for (const [index, child] of detail.subActions.entries()) {
        expect(child.ariaEvidence).toEqual(recordedChildren[index]?.ariaEvidence)
        expect(result?.evidence?.subActions[index]?.stateBefore.tree).toBe(before[index]?.tree)
        // Existing failed-verification semantics replace the first after state with the
        // next settled before state. ARIA must still retain that child's original before.
        expect(result?.evidence?.subActions[index]?.stateAfter?.tree)
          .toBe(index === 0 ? before[1]?.tree : after[1]?.tree)
        const screenshot = child.artifactRefs?.find(ref => ref.id.startsWith('decision-screenshot:'))
        expect(screenshot).toBeDefined()
        const image = Buffer.from(`decision image ${before[index]!.tree}`)
        expect(screenshot?.sha).toBe(createHash('sha256').update(image).digest('hex'))
        expect(Buffer.from(reopened.getBlob(screenshot!.sha)!).equals(image)).toBe(true)
        if (mode === 'empty') {
          expect(child.ariaEvidence).toEqual({ kind: 'aria', state: 'absent', reason: 'empty' })
          expect(child.artifactRefs).toHaveLength(1)
          continue
        }
        expect(child.ariaEvidence?.state).toBe('present')
        if (child.ariaEvidence?.state !== 'present') throw new Error('Missing ARIA producer ref')
        const ref = child.ariaEvidence.ref
        expect(child.artifactRefs?.map(item => item.id)).toEqual([screenshot!.id, ref.id])
        expect(publicationBytes.has(ref.sha)).toBe(true)
        if (mode === 'missing' && index === 0) {
          expect(child.artifactRefs?.[1]).toMatchObject({ ...ref, present: false })
          expect(reopened.getBlob(ref.sha)).toBeUndefined()
          continue
        }
        const bytes = reopened.getBlob(ref.sha)!
        expect(Buffer.from(bytes).equals(Buffer.from(publicationBytes.get(ref.sha)!))).toBe(true)
        expect(createHash('sha256').update(bytes).digest('hex')).toBe(ref.sha)
        const text = Buffer.from(bytes).toString()
        expect(AriaEvidenceDocumentSchema.parse(JSON.parse(text))).toEqual({ schemaVersion: RUN_EVIDENCE_DOCUMENT_SCHEMA_VERSION, kind: 'aria', tree: `before child ${index} [secret:ARIA_SECRET]` })
        expect(text).not.toContain(secret)
        expect(text).not.toContain('after child')
      }
    }
  } finally { cold.close() }
}

it('ARIA-COLD-READBACK / ARIA-SIDE-BEFORE: two children retain distinct before trees and decision screenshots across DB reopen', () => ariaReadback('two'))
it('ARIA-COLD-READBACK: empty before trees retain their own screenshots and empty state', () => ariaReadback('empty'))
it('ARIA-COLD-READBACK: missing blob marks only its cited ref absent without selecting its sibling', () => ariaReadback('missing'))
it('ARIA-COLD-READBACK / EVID-MOBILE-TREE: existing Android before trees survive cold readback', () => ariaReadback('mobile'))
it('EVID-NO-SUBACTION: the current detail read preserves childless selection without fabricating a child', () => ariaReadback('childless'))
it('ARIA-HISTORICAL-NO-BACKFILL: NULL ARIA stays unavailable despite a cleartext handoff', () => ariaReadback('historical'))
