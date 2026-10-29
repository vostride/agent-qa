import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { generateRunId, generateSuiteId, generateTestId } from '@vostride/agent-qa-ids'
import { SecretRedactor, SecretStore, makeScreenState } from '@vostride/agent-qa-runner'
import type { MemberRunConfig, StepModelScope, StepModelObservation } from '@vostride/agent-qa-runner'
import { createRunInvocationCore } from '@vostride/agent-qa-agent-local'
import type { RunEventEnvelope } from '@vostride/agent-qa-schema'
import { asRunId } from '@vostride/agent-qa-schema'
import { produceDirectRunMembers, produceSuiteRunMembers } from '../commands/run.js'
import type { RunInvocationInputs, SuiteRunMemberProductionInput } from '../commands/run.js'
import { assembleCliRun } from '../composition/run-assembly.js'
import { runInProcessCliRun } from '../composition/in-process-run-execution.js'
import { closeTestRunRecords, testRunRecord } from '../composition/__tests__/in-process-run-fixture.js'

// Every drive call carries a record; each cell closes the ones it opened.
afterEach(() => { closeTestRunRecords() })

const boundary = vi.hoisted(() => ({
  configs: [] as MemberRunConfig[],
  scopes: [] as StepModelScope[],
  observations: [] as StepModelObservation[],
  omitCache: false,
  retry: false,
  assertion: false,
  safety: vi.fn(),
  transport: vi.fn(),
}))

vi.mock('@vostride/agent-qa-model', async importOriginal => {
  const real = await importOriginal<typeof import('@vostride/agent-qa-model')>()
  return { ...real, createModel: (...args: Parameters<typeof real.createModel>) => {
    if (args[4]?.onCall) boundary.observations.push(args[4] as StepModelObservation)
    return real.createModel(...args)
  } }
})

// Keep the real member loop, model registry, middleware, SDK and raw-report parser.
// The runner spy only retains the scopes that production composition supplies.
vi.mock('@vostride/agent-qa-runner', async importOriginal => {
  const real = await importOriginal<typeof import('@vostride/agent-qa-runner')>()
  return { ...real, runMemberTest: (...args: Parameters<typeof real.runMemberTest>) => {
    const [member, config] = args
    boundary.configs.push(config)
    const binding = config.stepModelScope
    return real.runMemberTest(member, binding ? { ...config, stepModelScope: {
      ...binding, create: key => {
        const scope = binding.create(key)
        boundary.scopes.push(scope)
        return scope
      },
    } } : config)
  } }
})
vi.mock('@vostride/agent-qa-safety', async importOriginal => {
  const real = await importOriginal<typeof import('@vostride/agent-qa-safety')>()
  return { ...real, createMaskingMiddleware: (...args: Parameters<typeof real.createMaskingMiddleware>) => {
    const middleware = real.createMaskingMiddleware(...args)
    const transform = middleware.transformParams!
    return { ...middleware, transformParams: (...params: Parameters<typeof transform>) => {
      boundary.safety()
      return transform(...params)
    } }
  } }
})
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
    async observe() { return makeScreenState() }
    async execute() { return { success: true } }
  },
}))

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agent-qa-423-scope-'))
  boundary.configs.length = 0
  boundary.scopes.length = 0
  boundary.observations.length = 0
  boundary.omitCache = false
  boundary.retry = false
  boundary.assertion = false
  vi.clearAllMocks()
  vi.stubEnv('AGENT_QA_LLM_MODEL', '')
  vi.stubEnv('AGENT_QA_LLM_PROVIDER', '')
  vi.stubEnv('AGENT_QA_RUN_ID', '')
  delete process.env.AGENT_QA_RUN_ID
  vi.stubGlobal('fetch', boundary.transport.mockImplementation(async (_url: unknown, init: RequestInit) => {
    const request = JSON.parse(String(init.body))
    if (boundary.retry) {
      boundary.retry = false
      return new Response(JSON.stringify({ error: { message: 'Synthetic transient failure' } }),
        { status: 503, headers: { 'content-type': 'application/json', 'retry-after-ms': '0' } })
    }
    const planning = Array.isArray(request.tools) && request.tools.some((tool: { function: { name: string } }) => tool.function.name === 'web_click')
    const extracting = request.response_format?.json_schema?.name === 'extraction_result'
    const judging = request.response_format?.json_schema?.name === 'ai_judgment'
    return new Response(JSON.stringify({
      id: 'chat-synthetic-423', created: 1, model: planning ? 'reported-planner' : 'reported-verifier',
      choices: [{ index: 0, finish_reason: planning ? 'tool_calls' : 'stop', message: planning
        ? { role: 'assistant', content: null, tool_calls: [{ id: 'call-synthetic-423', type: 'function', function: {
            name: boundary.assertion ? 'common_assertAI' : 'web_click',
            arguments: JSON.stringify({ ...(boundary.assertion ? { claim: 'The Log in button is visible' } : { ref: 'e2' }),
              reasoning: 'Click the button', confidence: 1,
              stepComplete: true, doesActionAdvanceUsTowardsGoal: true }),
          } }] }
        : { role: 'assistant', content: JSON.stringify(extracting
            ? { value: 'captured', reasoning: 'Read from the screen' }
            : judging ? { verdict: true, rationale: 'The button is visible' }
            : { conditions: [{ quote: 'Click Log in', verdict: 'met', needs: 'none', controlRef: '',
                file: { name: '', match: 'none', text: '' },
                citations: [{ source: 'action', quote: '→ success' }], reasoning: 'Button clicked' }],
              dialogs: [], isAppError: false, reasoning: 'Button clicked' }) } }],
      usage: { prompt_tokens: 100, completion_tokens: 7,
        ...(boundary.omitCache ? {} : { prompt_tokens_details: { cached_tokens: 30 } }) },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }))
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

async function executePath(path: 'DIRECT' | 'SUITE' | 'COMPOSED', options: { missingRunId?: true; twoSteps?: true } = {}) {
  const project = mkdtempSync(join(root, 'run-'))
  const runId = asRunId(generateRunId())
  const testId = generateTestId()
  const filePath = join(project, 'one.yaml')
  const suiteFile = join(project, 'one.suite.yaml')
  const configFilePath = join(project, 'agent-qa.config.yaml')
  const step = { step: 'Click Log in', capture: { variable: 'name', method: 'ai' } }
  const test = { 'test-id': testId, name: 'Observed click', target: 'fixture', steps: options.twoSteps ? [step, step] : [step] }
  const fileContent = JSON.stringify(test)
  writeFileSync(filePath, fileContent)
  writeFileSync(suiteFile, 'name: Observed suite\n')
  const config = {
    workspace: { testMatch: ['one.yaml'], suiteMatch: ['*.suite.yaml'], testPathIgnore: [] },
    registry: {
      llms: [{ name: 'fixture', provider: 'openai-compatible', model: 'gpt-4o', baseURL: 'https://usage-fixture.invalid/v1' }],
      targets: { fixture: { platform: 'web', product: 'usage-fixture', environment: 'local' } },
    },
    use: { llm: 'fixture', cache: false, logCapture: { console: false, network: false }, timeout: { step: 5000, test: 10000 } },
    services: { logging: { level: 'silent' } }, knowledge: { dir: 'knowledge' },
  } as unknown as RunInvocationInputs['config']
  const configContent = JSON.stringify(config)
  writeFileSync(configFilePath, configContent)
  const secretStore = SecretStore.fromEnvContent('')
  const secretRedactor = new SecretRedactor(secretStore)
  const inputs = {
    config, configDir: project, configFilePath, configContent,
    runtimeSecrets: { secretStore, secretRedactor, secretsFileMetadata: { path: null, status: 'missing' } },
    envFileVars: {}, inlineVars: {}, cliVars: {}, userRunAttributes: {}, effectiveLogLevel: 'silent',
    resolvedHooks: new Map(), rawEnvFileContent: null, resolvedEnvFilePath: null,
    discovered: { tests: [filePath], suites: [] }, loadPlugins: async () => {},
  } as unknown as RunInvocationInputs
  const events: RunEventEnvelope[] = []
  if (path === 'COMPOSED') {
    const outcome = await runInProcessCliRun({
      runRecord: testRunRecord(),
      configPath: configFilePath, agentQaRoot: join(project, '.agent-qa'), executionContext: 'ci', inputs,
      onSession: session => { session.subscribe(1, event => { events.push(event) }) },
    }, { runId, patterns: [filePath] })
    expect(outcome.exitCode).toBe(0)
  } else {
    const opts = { disableCache: true, reporter: ['console'] }
    const produced = path === 'DIRECT'
      ? await produceDirectRunMembers({ inputs, bindings: [{ test, filePath, fileContent }] as never, opts })
      : await produceSuiteRunMembers({
          config, configDir: project, configFilePath, configContent, runId, opts,
          effectiveLogLevel: 'silent', suiteFiles: [suiteFile], loadPlugins: async () => {},
          preflight: {
            definitions: new Map([[suiteFile, { 'suite-id': generateSuiteId(), name: 'Observed suite', target: 'fixture', tests: [{ test: 'one.yaml', id: testId }] }]]),
            preloadedTests: new Map([[filePath, { fileContent, parseResult: { tests: [test], errors: [] } }]]), product: 'usage-fixture',
          },
          variableContext: { envFileVars: {}, inlineVars: {}, cliVars: {}, userRunAttributes: {}, secretStore, secretRedactor },
        } as SuiteRunMemberProductionInput)
    const core = createRunInvocationCore({
      configPath: configFilePath, agentQaRoot: join(project, '.agent-qa'), executionContext: 'ci',
      mintRunId: () => runId, isMintedRunId: () => true,
      assembleRun: async context => {
        const assembly = await assembleCliRun({ ...context, knowledgeRoot: produced.knowledgeRoot,
          secretRedactor: produced.secretRedactor,
          members: produced.members,
          executor: options.missingRunId ? (member, ctx) => produced.executor(member, { ...ctx, runId: undefined }) : produced.executor,
          configDigests: produced.configDigests,
          product: produced.product, warn: () => {} })
        produced.applyAssembly(assembly)
        produced.bindKnowledge?.(assembly.buildOrdinal)
        return assembly.config
      },
      onSession: session => { produced.bindSession(session); session.subscribe(1, event => { events.push(event) }) },
    })
    await core.execute({})
    await produced.finalize?.()
    if (!options.missingRunId) expect(produced.takeFrameworkError()).toBeUndefined()
  }
  if (!options.missingRunId) {
    expect(events.filter(event => event.type === 'stepFinalized').map(event => event.payload))
      .toMatchObject(Array.from({ length: options.twoSteps ? 2 : 1 }, () => ({ status: 'passed' })))
    expect(boundary.transport).toHaveBeenCalled()
  }
  return runId
}

for (const path of ['DIRECT', 'SUITE', 'COMPOSED'] as const) {
  it(`USAGE-${path}-PATH: actual CLI transport binds every dispatched model call to the canonical step`, async () => {
    const runId = await executePath(path)
    expect(boundary.configs).toHaveLength(1)
    expect(boundary.configs[0]?.stepModelScope, 'production member must carry an observed scope').toBeDefined()
    expect(boundary.scopes).toHaveLength(1)
    const snapshot = boundary.scopes[0]!.snapshot()
    expect(snapshot).toMatchObject({ runId, testIndex: 0, stepIndex: 0,
      started: 3, succeeded: 3, failed: 0, inputTokens: 300, outputTokens: 21, cachedInputTokens: 90 })
    expect(snapshot.roles.planner.respondingModelIds).toEqual(['reported-planner'])
    expect(snapshot.roles.verifier.respondingModelIds).toEqual(['reported-verifier'])
    expect(Object.keys(snapshot.roles).sort()).toEqual(['planner', 'verifier'])
    expect(snapshot.attempts.map(attempt => attempt.role)).toEqual(['planner', 'verifier', 'verifier'])
    expect(boundary.safety).toHaveBeenCalledTimes(boundary.transport.mock.calls.length)
  })
}

it('USAGE-CROSS-RUN: interleaved shell identities, steps and late observers stay isolated', async () => {
  const runIds = await Promise.all([executePath('DIRECT', { twoSteps: true }), executePath('SUITE')])
  expect(new Set(runIds).size).toBe(2)
  const snapshots = boundary.scopes.map(scope => scope.snapshot())
  expect(snapshots).toHaveLength(3)
  expect(snapshots.filter(snapshot => snapshot.runId === runIds[0]).map(snapshot => snapshot.stepIndex)).toEqual([0, 1])
  expect(snapshots.filter(snapshot => snapshot.runId === runIds[1]).map(snapshot => snapshot.stepIndex)).toEqual([0])
  for (const snapshot of snapshots) expect(snapshot).toMatchObject({ testIndex: 0, started: 3,
    succeeded: 3, failed: 0, inputTokens: 300, cachedInputTokens: 90 })
  expect(boundary.observations).toHaveLength(9)
  expect(new Set(boundary.observations).size).toBe(9)
  // Simulate a transport delivering late callbacks after each real scope finalized.
  for (const observer of boundary.observations) {
    observer.onCall({ kind: 'start' })
    observer.onCall({ kind: 'success', report: { inputTokens: 999, respondingModelId: 'late-model' } })
  }
  expect(boundary.scopes.map(scope => scope.snapshot())).toEqual(snapshots)
  expect(boundary.safety).toHaveBeenCalledTimes(9)
  expect(boundary.transport).toHaveBeenCalledTimes(9)
})

it('USAGE-RAW-ABSENCE: normalized SDK cache zero cannot certify all-call cache coverage', async () => {
  boundary.omitCache = true
  await executePath('DIRECT')
  const snapshot = boundary.scopes[0]!.snapshot()
  expect(snapshot).toMatchObject({ started: 3, succeeded: 3, inputTokens: 300, outputTokens: 21 })
  expect(snapshot).not.toHaveProperty('cachedInputTokens')
})

it('USAGE-ASSERTION-ROLE: actual AI assertion and late extraction share the selected verifier role', async () => {
  boundary.assertion = true
  await executePath('COMPOSED')
  const snapshot = boundary.scopes[0]!.snapshot()
  expect(snapshot).toMatchObject({ started: 4, succeeded: 4, failed: 0, inputTokens: 400, cachedInputTokens: 120 })
  expect(snapshot.attempts.map(attempt => attempt.role)).toEqual(['planner', 'verifier', 'verifier', 'verifier'])
  const requests = boundary.transport.mock.calls.map(([, init]) => JSON.parse(String(init.body)))
  expect(requests[1].response_format.json_schema.name).toBe('ai_judgment')
  // The step verifier confirms a passing assertAI before the late extraction.
  expect(requests[2].response_format.json_schema.name).toBe('verification_result')
  expect(requests[3].response_format.json_schema.name).toBe('extraction_result')
  expect(boundary.safety).toHaveBeenCalledTimes(4)
})

it('USAGE-TRANSPORT-RETRY: raw failure and retry count once without double safety middleware', async () => {
  boundary.retry = true
  await executePath('DIRECT')
  const snapshot = boundary.scopes[0]!.snapshot()
  expect(snapshot).toMatchObject({ started: 4, succeeded: 3, failed: 1 })
  expect(snapshot).not.toHaveProperty('cachedInputTokens')
  expect(boundary.transport).toHaveBeenCalledTimes(4)
  expect(boundary.safety).toHaveBeenCalledTimes(4)
})

it('USAGE-MISSING-BINDING: a producer without canonical shell identity dispatches no certifiable calls', async () => {
  await executePath('DIRECT', { missingRunId: true })
  expect(boundary.configs).toHaveLength(0)
  expect(boundary.scopes).toHaveLength(0)
  expect(boundary.transport).not.toHaveBeenCalled()
})
