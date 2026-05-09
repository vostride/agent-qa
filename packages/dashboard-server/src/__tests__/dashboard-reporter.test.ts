import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { isCanonicalRunId } from '@vostride/agent-qa-ids'
import { join } from 'node:path'
import { DashboardReporter } from '../reporter/dashboard-reporter.js'
import { DashboardDatabase } from '../db/database.js'
import { generateFailureSummary, SecretRedactor, SecretStore } from '@vostride/agent-qa-core'
import type { SuiteDefinition, TestDefinition, StepResult, TestResult, RunSummary } from '@vostride/agent-qa-core'

vi.mock('node:fs/promises', () => ({
  copyFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
}))

let db: DashboardDatabase
let reporter: DashboardReporter
const reporterEnvKeys = [
  'AGENT_QA_SUITE_QUEUE_ID',
  'AGENT_QA_PARENT_RUN_ID',
  'AGENT_QA_ATTEMPT_NUMBER',
  'AGENT_QA_MAX_RETRIES',
  'AGENT_QA_RUN_ATTRIBUTES_JSON',
  'AGENT_QA_RUN_ID',
  'AGENT_QA_LLM_MODEL',
  'AGENT_QA_LLM_PROVIDER',
] as const
const reporterEnvDefaults = Object.fromEntries(reporterEnvKeys.map((key) => [key, process.env[key]])) as Record<(typeof reporterEnvKeys)[number], string | undefined>
const HOOK_ID = 'h_amber-birch-coral-delta-ember-falcon-garden-harbor-island-jungle'
const PHASE_222_RAW_SECRET = 'phase222-raw-secret-SHOULD-NOT-PERSIST-4f03b7'

function makeTest(name = 'Login Test'): TestDefinition {
  return {
    name,
    steps: ['Click login', 'Enter username'],
  } as TestDefinition
}

function makeStepResult(overrides: Partial<StepResult> = {}): StepResult {
  return {
    name: 'Click login button',
    status: 'passed',
    duration: 1200,
    action: { type: 'click', ref: '[1]' },
    ...overrides,
  }
}

function makeTestResult(overrides: Partial<TestResult> = {}): TestResult {
  return {
    name: 'Login Test',
    filePath: 'tests/login.yaml',
    status: 'passed',
    steps: [makeStepResult()],
    duration: 5000,
    ...overrides,
  }
}

function makeSummary(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    results: [makeTestResult()],
    duration: 10000,
    passed: 1,
    failed: 0,
    skipped: 0,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  db = new DashboardDatabase({ dbPath: ':memory:' })
  reporter = new DashboardReporter({ db })
})

afterEach(() => {
  for (const key of reporterEnvKeys) {
    const value = reporterEnvDefaults[key]
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
  db.close()
})

function expectRunIdContract(id: string): void {
  expect(isCanonicalRunId(id)).toBe(true)
}

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1
}

describe('DashboardReporter', () => {
  it('implements all Reporter lifecycle methods', () => {
    expect(typeof reporter.onRunStart).toBe('function')
    expect(typeof reporter.onTestStart).toBe('function')
    expect(typeof reporter.onStepEnd).toBe('function')
    expect(typeof reporter.onTestEnd).toBe('function')
    expect(typeof reporter.onRunEnd).toBe('function')
  })

  it('onRunStart stores run start time', () => {
    const tests = [makeTest('Test A'), makeTest('Test B')]
    reporter.onRunStart(tests)
    // onRunStart no longer creates groups (groups removed in schema v3)
  })

  it('onTestEnd inserts run and steps', async () => {
    reporter.onRunStart([makeTest()])
    reporter.onTestStart!(makeTest(), 'tests/login.yaml')

    const step1 = makeStepResult({ name: 'Step 1' })
    const step2 = makeStepResult({ name: 'Step 2', status: 'healed' })
    await reporter.onStepEnd!(step1, 'Login Test')
    await reporter.onStepEnd!(step2, 'Login Test')

    await reporter.onTestEnd!(makeTestResult({
      steps: [step1, step2],
    }))

    const runs = db.getRuns()
    expect(runs).toHaveLength(1)
    expect(runs[0].name).toBe('Login Test')
    expect(runs[0].status).toBe('passed')

    const steps = db.getSteps(runs[0].id)
    expect(steps).toHaveLength(2)
    expect(steps[0].name).toBe('Step 1')
    expect(steps[1].name).toBe('Step 2')
    expect(steps[1].status).toBe('healed')
  })

  it('uses result metadata attributes for onTestEnd-only fallback rows and artifacts', async () => {
    const attributes = {
      'agent-qa.trigger': 'api',
      'agent-qa.runner': 'browserstack',
      'git.branch': 'phase247-review',
    }

    await reporter.onTestEnd!(makeTestResult({
      metadata: { attributes, platform: 'web' },
    } as Partial<TestResult>))

    const run = db.getRuns()[0]
    expect(run.attributes).toEqual(attributes)
    expect(db.getRunArtifact(run.id)?.payload.metadata?.attributes).toEqual(attributes)
  })

  it('stores canonical-root video paths relative to artifactsDir/videos', async () => {
    reporter = new DashboardReporter({ db, artifactsDir: '/workspace/.agent-qa/artifacts' })
    reporter.onRunStart([makeTest()])
    await reporter.onTestStart!(makeTest(), 'tests/login.yaml')

    const runId = db.getRuns()[0].id
    await reporter.onTestEnd!(makeTestResult({
      videoPath: join('/workspace/.agent-qa/artifacts', 'videos', runId, 'recording.webm'),
    }))

    const storedRun = db.getRuns()[0]
    expect(storedRun.videoPath).toBe(`${runId}/recording.webm`)
  })

  it('materializes flat canonical-root videos into the run-id directory', async () => {
    const { mkdir: mkdirMock, rename: renameMock } = await import('node:fs/promises')
    reporter = new DashboardReporter({ db, artifactsDir: '/workspace/.agent-qa/artifacts' })
    reporter.onRunStart([makeTest()])
    await reporter.onTestStart!(makeTest(), 'tests/login.yaml')

    const runId = db.getRuns()[0].id
    const sourcePath = join('/workspace/.agent-qa/artifacts', 'videos', 'recording.webm')
    await reporter.onTestEnd!(makeTestResult({
      videoPath: sourcePath,
    }))

    const storedRun = db.getRuns()[0]
    expect(storedRun.videoPath).toBe(`${runId}/recording.webm`)
    expect(mkdirMock).toHaveBeenCalledWith(
      join('/workspace/.agent-qa/artifacts', 'videos', runId),
      { recursive: true },
    )
    expect(renameMock).toHaveBeenCalledWith(
      sourcePath,
      join('/workspace/.agent-qa/artifacts', 'videos', runId, 'recording.webm'),
    )
  })

  it('preserves absolute video paths outside artifactsDir/videos', async () => {
    const { rename: renameMock } = await import('node:fs/promises')
    reporter = new DashboardReporter({ db, artifactsDir: '/workspace/.agent-qa/artifacts' })
    reporter.onRunStart([makeTest()])
    await reporter.onTestStart!(makeTest(), 'tests/login.yaml')

    const externalPath = '/tmp/agent-qa-external-video/recording.webm'
    await reporter.onTestEnd!(makeTestResult({
      videoPath: externalPath,
    }))

    const storedRun = db.getRuns()[0]
    expect(storedRun.videoPath).toBe(externalPath)
    expect(renameMock).not.toHaveBeenCalled()
  })

  it('onRunEnd completes without error', async () => {
    reporter.onRunStart([makeTest()])
    reporter.onTestStart!(makeTest(), 'tests/login.yaml')
    await reporter.onTestEnd!(makeTestResult())

    reporter.onRunEnd!(makeSummary({
      passed: 3,
      failed: 1,
      skipped: 1,
      duration: 20000,
      results: [makeTestResult(), makeTestResult(), makeTestResult(), makeTestResult({ status: 'failed' }), makeTestResult({ status: 'skipped' })],
    }))
    // onRunEnd no longer updates groups (groups removed in schema v3)
  })

  it('saves screenshot buffer to disk', async () => {
    const { mkdir: mkdirMock, writeFile: writeFileMock } = await import('node:fs/promises')

    reporter.onRunStart([makeTest()])
    reporter.onTestStart!(makeTest(), 'tests/login.yaml')

    const screenshotBuffer = Buffer.from('fake-png-data')
    await reporter.onStepEnd!(makeStepResult({
      name: 'Verify page',
      screenshot: screenshotBuffer,
    }), 'Login Test')

    await reporter.onTestEnd!(makeTestResult({
      steps: [makeStepResult({ name: 'Verify page', screenshot: screenshotBuffer })],
    }))

    expect(mkdirMock).toHaveBeenCalled()
    expect(writeFileMock).toHaveBeenCalledWith(
      expect.stringContaining('0-Verify_page.png'),
      screenshotBuffer,
    )

    const runs = db.getRuns()
    const steps = db.getSteps(runs[0].id)
    expect(steps[0].screenshotPath).toContain('0-Verify_page.png')
  })

  it('preserves step order', async () => {
    reporter.onRunStart([makeTest()])
    reporter.onTestStart!(makeTest(), 'tests/login.yaml')

    await reporter.onStepEnd!(makeStepResult({ name: 'Step A' }), 'Login Test')
    await reporter.onStepEnd!(makeStepResult({ name: 'Step B' }), 'Login Test')
    await reporter.onStepEnd!(makeStepResult({ name: 'Step C' }), 'Login Test')

    await reporter.onTestEnd!(makeTestResult({
      steps: [
        makeStepResult({ name: 'Step A' }),
        makeStepResult({ name: 'Step B' }),
        makeStepResult({ name: 'Step C' }),
      ],
    }))

    const runs = db.getRuns()
    const steps = db.getSteps(runs[0].id)
    expect(steps[0].stepOrder).toBe(0)
    expect(steps[1].stepOrder).toBe(1)
    expect(steps[2].stepOrder).toBe(2)
    expect(steps.map(s => s.name)).toEqual(['Step A', 'Step B', 'Step C'])
  })

  it('handles multiple tests in one run', async () => {
    const test1 = makeTest('Test 1')
    const test2 = makeTest('Test 2')
    reporter.onRunStart([test1, test2])

    reporter.onTestStart!(test1, 'tests/test1.yaml')
    await reporter.onStepEnd!(makeStepResult({ name: 'Click 1' }), 'Test 1')
    await reporter.onTestEnd!(makeTestResult({ name: 'Test 1', filePath: 'tests/test1.yaml' }))

    reporter.onTestStart!(test2, 'tests/test2.yaml')
    await reporter.onStepEnd!(makeStepResult({ name: 'Click 2' }), 'Test 2')
    await reporter.onTestEnd!(makeTestResult({ name: 'Test 2', filePath: 'tests/test2.yaml' }))

    const runs = db.getRuns()
    expect(runs).toHaveLength(2)
  })

  it('keeps same name tests with different files as distinct run artifacts', async () => {
    const testA = { ...makeTest('Duplicate Name'), 'test-id': 't_duplicate-a' } as TestDefinition
    const testB = { ...makeTest('Duplicate Name'), 'test-id': 't_duplicate-b' } as TestDefinition

    await reporter.onTestStart!(testA, 'tests/duplicate-a.yaml')
    await reporter.onTestStart!(testB, 'tests/duplicate-b.yaml')
    await reporter.onTestEnd!(makeTestResult({ name: 'Duplicate Name', filePath: 'tests/duplicate-a.yaml' }))
    await reporter.onTestEnd!(makeTestResult({ name: 'Duplicate Name', filePath: 'tests/duplicate-b.yaml' }))

    const runs = db.getRuns()
    expect(runs).toHaveLength(2)
    expect(runs.map((run) => run.filePath).sort()).toEqual(['tests/duplicate-a.yaml', 'tests/duplicate-b.yaml'])
    for (const run of runs) {
      const artifact = db.getRunArtifact(run.id)
      expect(artifact?.kind).toBe('test')
      expect((artifact?.payload.source as Record<string, unknown>).name).toBe('Duplicate Name')
    }
  })

  it('persists rich memory log deltas into the run artifact at run end', async () => {
    await reporter.onTestStart!(makeTest('Memory Test'), 'tests/memory.yaml')
    const result = makeTestResult({ name: 'Memory Test', filePath: 'tests/memory.yaml' })
    await reporter.onTestEnd!(result)
    ;(result as any).memoryLog = {
      added: 0,
      confirmed: 1,
      deprecated: 0,
      deleted: 0,
      errors: [],
      curatorDuration: 5,
      deltas: [{
        action: 'confirm',
        tier: 'products',
        scope: 'demo',
        observationId: 'obs_1',
        reasoning: 'Still true',
        before: { id: 'obs_1', title: 'Old', content: 'old content', trust: 0.5, created: '2026-01-01', last_confirmed: '2026-01-01', confirmed_count: 0, contradicted_count: 0, source_test: 't_memory' },
        after: { id: 'obs_1', title: 'Old', content: 'new content', trust: 0.52, created: '2026-01-01', last_confirmed: '2026-05-01', confirmed_count: 1, contradicted_count: 0, source_test: 't_memory' },
      }],
    }

    reporter.onRunEnd!(makeSummary({ results: [result] }))

    const run = db.getRuns()[0]
    const artifact = db.getRunArtifact(run.id)
    expect(artifact?.finalizedAt).toBeTruthy()
    expect((artifact?.payload.memory as any).log.deltas[0].before.content).toBe('old content')
    expect((artifact?.payload.memory as any).log.deltas[0].after.content).toBe('new content')
  })

  it('creates r_ ids for suite parent runs and suite child runs', async () => {
    reporter.onSuiteStart({
      name: 'Smoke Suite',
      target: 'web',
      tests: [{ test: 'tests/test-a.yaml', id: 't_test-a' }],
      ['suite-id']: 'suite-smoke',
    } as unknown as SuiteDefinition)

    const suiteRuns = db.getRuns()
    expect(suiteRuns).toHaveLength(1)
    expectRunIdContract(suiteRuns[0].id)

    await reporter.onTestStart!(makeTest('Test A'), 'tests/test-a.yaml')
    const childRuns = db.getRunsByParent(suiteRuns[0].id)
    expect(childRuns).toHaveLength(1)
    expectRunIdContract(childRuns[0].id)
  })

  it('uses explicit context run ID for standalone test rows', async () => {
    const runId = 'r_able-baker-charlie-delta-echo-foxtrot-golf-hotel-india-juliet'

    await reporter.onTestStart!(makeTest('Context Test'), 'tests/context.yaml', { runId })

    const runs = db.getRuns()
    expect(runs).toHaveLength(1)
    expect(runs[0].id).toBe(runId)
  })

  it('persists runtime artifact platform for new mobile test rows', async () => {
    await reporter.onTestStart!(makeTest('iOS runtime'), 'tests/mobile/ios.yaml', {
      artifact: { runtime: { platform: 'ios' } },
    } as any)

    const run = db.getRuns()[0]
    expect(run.platform).toBe('ios')
    expect(db.getRunArtifact(run.id)?.payload.runtime?.platform).toBe('ios')
  })

  it('prefers resolvedPlatform over runtime artifact platform', async () => {
    const test = makeTest('Resolved platform mobile')
    ;(test as any).resolvedPlatform = 'android'

    await reporter.onTestStart!(test, 'tests/mobile/android.yaml', {
      artifact: { runtime: { platform: 'ios' } },
    } as any)

    const run = db.getRuns()[0]
    expect(run.platform).toBe('android')
    expect(db.getRunArtifact(run.id)?.payload.runtime?.platform).toBe('ios')
  })

  it('uses explicit context run ID for suite parent rows', () => {
    const runId = 'r_harbor-iris-jade-kilo-lima-maple-nova-orbit-pearl-quartz'

    reporter.onSuiteStart({
      name: 'Context Suite',
      target: 'web',
      tests: [{ test: 'tests/test-a.yaml', id: 't_test-a' }],
      ['suite-id']: 'suite-context',
    } as unknown as SuiteDefinition, { runId })

    const runs = db.getRuns()
    expect(runs).toHaveLength(1)
    expect(runs[0].id).toBe(runId)
    expect(runs[0].suiteId).toBe('suite-context')
    expect(runs[0].attributes).toMatchObject({
      'agent-qa.trigger': 'cli',
      'agent-qa.runner': 'local',
    })
  })

  it('preserves queued run attributes when updating an existing row', async () => {
    const runId = 'r_queue-attrs-alpha-bravo-charlie-delta-echo-foxtrot-golf-hotel-india'
    const attributes = {
      'agent-qa.trigger': 'api',
      'agent-qa.runner': 'local',
      'git.branch': 'phase223-main',
    }
    db.insertPendingRun({ id: runId, name: 'Queued attrs', attributes })

    await reporter.onTestStart!(makeTest(), 'tests/login.yaml', {
      runId,
      artifact: { metadata: { attributes } },
    } as any)
    await reporter.onTestEnd!(makeTestResult({ runId }))

    expect(db.getRun(runId)!.attributes).toEqual(attributes)
    expect(db.getRunArtifact(runId)?.payload.metadata?.attributes).toEqual(attributes)
  })

  it('updates queued run platform from runtime artifact context', async () => {
    const runId = 'r_queue-mobile-alpha-bravo-charlie-delta-echo-foxtrot-golf-hotel-india'
    db.insertPendingRun({ id: runId, name: 'Queued mobile' })

    await reporter.onTestStart!(makeTest('Queued mobile'), 'tests/mobile/ios.yaml', {
      runId,
      artifact: { runtime: { platform: 'ios' } },
    } as any)

    expect(db.getRun(runId)!.platform).toBe('ios')
    expect(db.getRunArtifact(runId)?.payload.runtime?.platform).toBe('ios')
  })

  it('inherits suite parent attributes for child rows and artifacts', async () => {
    const parentRunId = 'r_suite-attrs-alpha-bravo-charlie-delta-echo-foxtrot-golf-hotel-india'
    const childRunId = 'r_suite-child-alpha-bravo-charlie-delta-echo-foxtrot-golf-hotel-india'
    const attributes = {
      'agent-qa.trigger': 'cli',
      'agent-qa.runner': 'local',
      'git.branch': 'phase223-main',
    }

    reporter.onSuiteStart({
      name: 'Attribute Suite',
      target: 'web',
      tests: [{ test: 'tests/test-a.yaml', id: 't_test-a' }],
      ['suite-id']: 'suite-attrs',
    } as unknown as SuiteDefinition, {
      runId: parentRunId,
      artifact: { metadata: { attributes } },
    } as any)
    await reporter.onTestStart!(makeTest('Child A'), 'tests/test-a.yaml', {
      runId: childRunId,
      parentRunId,
      artifact: { metadata: {} },
    } as any)

    expect(db.getRun(parentRunId)!.attributes).toEqual(attributes)
    expect(db.getRun(childRunId)!.attributes).toEqual(attributes)
    expect(db.getRunArtifact(childRunId)?.payload.metadata?.attributes).toEqual(attributes)
  })

  it('uses explicit context run ID for suite child rows', async () => {
    const parentRunId = 'r_parent-alpha-bravo-charlie-delta-echo-foxtrot-golf-hotel-india'
    const childRunId = 'r_child-alpha-bravo-charlie-delta-echo-foxtrot-golf-hotel-india'

    reporter.onSuiteStart({
      name: 'Context Suite',
      target: 'web',
      tests: [{ test: 'tests/test-a.yaml', id: 't_test-a' }],
      ['suite-id']: 'suite-context',
    } as unknown as SuiteDefinition, { runId: parentRunId })
    await reporter.onTestStart!(makeTest('Context Child'), 'tests/test-a.yaml', {
      runId: childRunId,
      parentRunId,
      artifact: { kind: 'suite-child', suiteIndex: 0 },
    })

    const children = db.getRunsByParent(parentRunId)
    expect(children).toHaveLength(1)
    expect(children[0].id).toBe(childRunId)
  })

  it('persists suite parent full manifest, childRunId links, and skipped members', async () => {
    reporter.onSuiteStart({
      name: 'Smoke Suite',
      target: 'web',
      tests: [
        { test: 'tests/test-a.yaml', id: 't_test-a' },
        { test: 'tests/test-b.yaml', id: 't_test-b' },
      ],
      ['suite-id']: 'suite-smoke',
    } as unknown as SuiteDefinition, {
      artifact: {
        kind: 'suite-parent',
        source: {
          kind: 'suite',
          suiteId: 'suite-smoke',
          name: 'Smoke Suite',
          rawYaml: 'name: Smoke Suite',
          members: [
            { index: 0, ref: { test: 'tests/test-a.yaml', id: 't_test-a' }, filePath: 'tests/test-a.yaml', name: 'Test A', loadStatus: 'loaded' },
            { index: 1, ref: { test: 'tests/test-b.yaml', id: 't_test-b' }, filePath: 'tests/test-b.yaml', name: 'Test B', loadStatus: 'loaded' },
          ],
        },
      },
    } as any)

    await reporter.onTestStart!(makeTest('Test A'), 'tests/test-a.yaml', {
      artifact: {
        kind: 'suite-child',
        suiteIndex: 0,
        source: { kind: 'test', testId: 't_test-a', name: 'Test A', loadStatus: 'loaded' },
      },
    } as any)
    await reporter.onTestEnd!(makeTestResult({ name: 'Test A', filePath: 'tests/test-a.yaml' }))
    await reporter.onSuiteEnd!({
      name: 'Smoke Suite',
      status: 'failed',
      tests: [
        makeTestResult({ name: 'Test A', filePath: 'tests/test-a.yaml' }),
        makeTestResult({
          name: 'Test B',
          filePath: 'tests/test-b.yaml',
          status: 'skipped',
          metadata: { skipReason: 'Skipped: previous test "Test A" failed (fail-fast)' },
        }),
      ],
      duration: 1000,
      passed: 1,
      failed: 1,
      skipped: 1,
    })

    const parent = db.getRuns()[0]
    const children = db.getRunsByParent(parent.id)
    const parentArtifact = db.getRunArtifact(parent.id)
    const childArtifact = db.getRunArtifact(children[0].id)
    const members = (parentArtifact?.payload.source as any).members

    expect(parentArtifact?.kind).toBe('suite-parent')
    expect(parentArtifact?.finalizedAt).toBeTruthy()
    expect(childArtifact?.kind).toBe('suite-child')
    expect(members[0].childRunId).toBe(children[0].id)
    expect(members[1].loadStatus).toBe('skipped')
    expect(members[1].skipReason).toContain('fail-fast')
  })

  it('creates r_ ids for retry-created child runs', async () => {
    const attributes = {
      'agent-qa.trigger': 'dashboard',
      'agent-qa.runner': 'local',
      'git.branch': 'phase247-review',
    }
    const parentRunId = db.insertRun({
      name: 'Parent Run',
      status: 'failed',
      duration: 1000,
      startedAt: '2026-03-01T10:00:00Z',
      endedAt: '2026-03-01T10:00:01Z',
      attributes,
    })
    process.env.AGENT_QA_PARENT_RUN_ID = parentRunId
    process.env.AGENT_QA_ATTEMPT_NUMBER = '2'
    process.env.AGENT_QA_MAX_RETRIES = '3'

    await reporter.onTestStart!(makeTest('Retry Test'), 'tests/retry.yaml')

    const childRuns = db.getRunsByParent(parentRunId)
    expect(childRuns).toHaveLength(1)
    expect(childRuns[0].attemptNumber).toBe(2)
    expect(childRuns[0].maxRetries).toBe(3)
    expect(childRuns[0].parentRunId).toBe(parentRunId)
    expect(childRuns[0].attributes).toEqual(attributes)
    expect(db.getRunArtifact(childRuns[0].id)?.payload.metadata?.attributes).toEqual(attributes)
    expectRunIdContract(childRuns[0].id)
  })

  it('handles missing trace gracefully', async () => {
    reporter.onRunStart([makeTest()])
    reporter.onTestStart!(makeTest(), 'tests/login.yaml')

    await reporter.onStepEnd!(makeStepResult({
      name: 'Simple step',
      observation: 'direct observation',
    }), 'Login Test')

    await reporter.onTestEnd!(makeTestResult({
      steps: [makeStepResult({ name: 'Simple step', observation: 'direct observation' })],
    }))

    const runs = db.getRuns()
    const steps = db.getSteps(runs[0].id)
    expect(steps[0].observation).toBe('direct observation')
    expect(steps[0].reasoning).toBeNull()
    expect(steps[0].plannedAction).toBeNull()
  })

  it('stores trace data when present', async () => {
    reporter.onRunStart([makeTest()])
    reporter.onTestStart!(makeTest(), 'tests/login.yaml')

    const step = makeStepResult({
      name: 'Click login',
      trace: {
        observation: 'Login button visible',
        reasoning: 'Need to click login to proceed',
        plannedAction: { type: 'click', ref: '[1]' },
        result: 'success',
        screenStateBefore: 'landing page',
        screenStateAfter: 'login form',
      },
    })
    await reporter.onStepEnd!(step, 'Login Test')
    await reporter.onTestEnd!(makeTestResult({ steps: [step] }))

    const runs = db.getRuns()
    const steps = db.getSteps(runs[0].id)
    expect(steps[0].observation).toBe('Login button visible')
    expect(steps[0].reasoning).toBe('Need to click login to proceed')
    expect(steps[0].plannedAction).toEqual({ type: 'click', ref: '[1]' })
    expect(steps[0].result).toBe('success')
  })

  it('works without calling onTestStart', async () => {
    reporter.onRunStart([makeTest()])

    await reporter.onTestEnd!(makeTestResult())

    const runs = db.getRuns()
    expect(runs).toHaveLength(1)
    expect(runs[0].name).toBe('Login Test')
  })

  describe('cancellation resilience', () => {
    it('onTestStart inserts run with status running', () => {
      reporter.onRunStart([makeTest()])
      reporter.onTestStart!(makeTest(), 'tests/login.yaml')

      const runs = db.getRuns()
      expect(runs).toHaveLength(1)
      expect(runs[0].status).toBe('running')
      expect(runs[0].name).toBe('Login Test')
    })

    it('onTestEnd updates existing run to final status', async () => {
      reporter.onRunStart([makeTest()])
      reporter.onTestStart!(makeTest(), 'tests/login.yaml')

      // Run is 'running' after onTestStart
      expect(db.getRuns()[0].status).toBe('running')

      await reporter.onTestEnd!(makeTestResult({ status: 'passed', duration: 8000 }))

      // Run is now 'passed' after onTestEnd
      const runs = db.getRuns()
      expect(runs).toHaveLength(1)
      expect(runs[0].status).toBe('passed')
      expect(runs[0].duration).toBe(8000)
    })

    it('onStepEnd persists steps immediately to survive process kill', async () => {
      reporter.onRunStart([makeTest()])
      reporter.onTestStart!(makeTest(), 'tests/login.yaml')

      const runId = db.getRuns()[0].id

      // Persist step 1
      await reporter.onStepEnd!(makeStepResult({ name: 'Step 1' }), 'Login Test')
      expect(db.getSteps(runId)).toHaveLength(1)

      // Persist step 2
      await reporter.onStepEnd!(makeStepResult({ name: 'Step 2' }), 'Login Test')
      expect(db.getSteps(runId)).toHaveLength(2)

      // Steps are in DB even without onTestEnd being called
      const steps = db.getSteps(runId)
      expect(steps[0].name).toBe('Step 1')
      expect(steps[0].stepOrder).toBe(0)
      expect(steps[1].name).toBe('Step 2')
      expect(steps[1].stepOrder).toBe(1)
    })

    it('simulates cancellation: steps survive without onTestEnd', async () => {
      reporter.onRunStart([makeTest()])
      reporter.onTestStart!(makeTest(), 'tests/login.yaml')

      // Two steps complete
      await reporter.onStepEnd!(makeStepResult({ name: 'Open page' }), 'Login Test')
      await reporter.onStepEnd!(makeStepResult({ name: 'Click login' }), 'Login Test')

      // Process killed here — onTestEnd never called

      // Verify run exists with status='running'
      const runs = db.getRuns()
      expect(runs).toHaveLength(1)
      expect(runs[0].status).toBe('running')

      // Verify both steps are persisted
      const steps = db.getSteps(runs[0].id)
      expect(steps).toHaveLength(2)
      expect(steps[0].name).toBe('Open page')
      expect(steps[1].name).toBe('Click login')
    })

    it('simulates cancellation with DB update: run marked cancelled with duration', async () => {
      reporter.onRunStart([makeTest()])
      reporter.onTestStart!(makeTest(), 'tests/login.yaml')

      await reporter.onStepEnd!(makeStepResult({ name: 'Step 1' }), 'Login Test')

      // Process killed — but cancel endpoint updates DB directly
      const run = db.getRuns()[0]
      db.updateRun(run.id, {
        status: 'cancelled',
        duration: 15000,
        endedAt: '2026-03-01T10:00:15Z',
        failureSummary: 'Test cancelled by user',
      })

      const updated = db.getRun(run.id)
      expect(updated!.status).toBe('cancelled')
      expect(updated!.duration).toBe(15000)
      expect(updated!.failureSummary).toBe('Test cancelled by user')

      // Step is still there
      expect(db.getSteps(run.id)).toHaveLength(1)
    })

    it('onTestEnd with cancelled status updates run correctly', async () => {
      reporter.onRunStart([makeTest()])
      reporter.onTestStart!(makeTest(), 'tests/login.yaml')

      await reporter.onStepEnd!(makeStepResult({ name: 'Step 1' }), 'Login Test')

      await reporter.onTestEnd!(makeTestResult({
        status: 'cancelled',
        duration: 7500,
        failureSummary: 'Test cancelled after 1 step(s)',
      }))

      const runs = db.getRuns()
      expect(runs).toHaveLength(1)
      expect(runs[0].status).toBe('cancelled')
      expect(runs[0].duration).toBe(7500)
      expect(runs[0].failureSummary).toBe('Test cancelled after 1 step(s)')
    })

    it('persists cancelled steps without violating dashboard step status constraints', async () => {
      reporter.onRunStart([makeTest()])
      await reporter.onTestStart!(makeTest(), 'tests/login.yaml')

      await reporter.onStepEnd!(makeStepResult({
        name: 'Cancelled planner call',
        status: 'cancelled',
        error: 'Step cancelled by user',
      }), 'Login Test')
      await reporter.onTestEnd!(makeTestResult({
        status: 'cancelled',
        steps: [makeStepResult({
          name: 'Cancelled planner call',
          status: 'cancelled',
          error: 'Step cancelled by user',
        })],
        failureSummary: 'Test cancelled after 1 step(s)',
      }))

      const run = db.getRuns()[0]
      const steps = db.getSteps(run.id)
      expect(run.status).toBe('cancelled')
      expect(steps).toHaveLength(1)
      expect(steps[0].status).toBe('cancelled')
      expect(steps[0].error).toBe('Step cancelled by user')
    })

    it('persists failed runtime summaries, error log, and artifact runtime', async () => {
      reporter.onRunStart([makeTest('Runtime Failure')])
      await reporter.onTestStart!(makeTest('Runtime Failure'), 'tests/runtime-failure.yaml')

      const failedStep = makeStepResult({
        name: 'Call local model',
        status: 'failed',
        error: 'Provider rejected request',
      })
      await reporter.onStepEnd!(failedStep, 'Runtime Failure')
      await reporter.onTestEnd!(makeTestResult({
        name: 'Runtime Failure',
        filePath: 'tests/runtime-failure.yaml',
        status: 'failed',
        steps: [failedStep],
        failureSummary: 'Framework error: provider rejected request',
      }))

      const run = db.getRuns()[0]
      const artifact = db.getRunArtifact(run.id)
      expect(run.status).toBe('failed')
      expect(run.failureSummary).toBe('Framework error: provider rejected request')
      expect(run.errorLog).toContain('Provider rejected request')
      expect(artifact?.payload.runtime).toMatchObject({
        status: 'failed',
        failureSummary: 'Framework error: provider rejected request',
      })
      expect((artifact?.payload.runtime as Record<string, unknown>).errorLog).toContain('Provider rejected request')
    })

    it('persists deduped assertion failure summaries', async () => {
      const assertionReason = 'The current page URL is https://www.iana.org/help/example-domains, which does not match https://www.iana.org/example-domains.'
      const failedStep = makeStepResult({
        name: 'Verify the page url is "https://www.iana.org/example-domains"',
        status: 'failed',
        error: `Step failed: ${assertionReason}`,
        trace: {
          observation: 'Example Domain page',
          reasoning: assertionReason,
          plannedAction: { type: 'assert', condition: 'URL equals expected value' },
          result: 'failure',
          error: `Step failed: ${assertionReason}`,
          screenStateBefore: 'Example Domain page',
        },
      })
      const failureSummary = generateFailureSummary([failedStep])

      reporter.onRunStart([makeTest('Example failing test')])
      await reporter.onTestStart!(makeTest('Example failing test'), 'tests/example-failing.yaml')
      await reporter.onStepEnd!(failedStep, 'Example failing test')
      await reporter.onTestEnd!(makeTestResult({
        name: 'Example failing test',
        filePath: 'tests/example-failing.yaml',
        status: 'failed',
        steps: [failedStep],
        failureSummary,
      }))

      const run = db.getRuns()[0]
      const storedSummary = run.failureSummary ?? ''
      expect(storedSummary).toContain('Step 1/1 "Verify the page url is "https://www.iana.org/example-domains"" failed:')
      expect(countOccurrences(storedSummary, assertionReason)).toBe(1)
      expect(storedSummary).toContain('Attempted action: assert')
      expect(storedSummary).not.toContain('Agent reasoning:')
    })

    it('redacts phase 222 secrets before dashboard persistence boundaries', async () => {
      const redactor = new SecretRedactor(new SecretStore({ loginPassword: PHASE_222_RAW_SECRET }))
      reporter = new DashboardReporter({ db, redactor })
      const secretTest = makeTest('Secret Boundary Test')
      secretTest.steps = ['Fill password with {{secret:loginPassword}}']
      ;(secretTest as any).meta = { note: `metadata ${PHASE_222_RAW_SECRET}` }

      reporter.onRunStart([secretTest])
      await reporter.onTestStart!(secretTest, 'tests/secret.yaml', {
        artifact: {
          config: {
            secretsFile: {
              path: '.secrets.local',
              status: 'loaded',
              count: 1,
              variables: { loginPassword: PHASE_222_RAW_SECRET },
              content: `loginPassword=${PHASE_222_RAW_SECRET}`,
            },
          },
          source: {
            kind: 'test',
            name: 'Secret Boundary Test',
            rawYaml: `steps:\n  - Fill ${PHASE_222_RAW_SECRET} via {{secret:loginPassword}}`,
            resolvedDefinition: {
              steps: [`Fill ${PHASE_222_RAW_SECRET}`],
            },
          },
        },
      })
      const runId = db.getRuns()[0].id

      await reporter.onStepEnd!(makeStepResult({
        name: 'Fill password with {{secret:loginPassword}}',
        action: { type: 'fill', ref: '[password]', value: PHASE_222_RAW_SECRET } as any,
        error: `step error ${PHASE_222_RAW_SECRET}`,
        trace: {
          observation: `observed ${PHASE_222_RAW_SECRET}`,
          reasoning: 'use {{secret:loginPassword}}',
          plannedAction: { type: 'fill', ref: '[password]', value: PHASE_222_RAW_SECRET },
          result: 'success',
          error: `trace error ${PHASE_222_RAW_SECRET}`,
          screenStateBefore: `before ${PHASE_222_RAW_SECRET}`,
          screenStateAfter: `after ${PHASE_222_RAW_SECRET}`,
          subActions: [{
            index: 0,
            observation: `sub ${PHASE_222_RAW_SECRET}`,
            reasoning: 'subaction',
            plannedAction: { type: 'fill', ref: '[password]', value: PHASE_222_RAW_SECRET },
            result: 'success',
            screenStateBefore: `sub before ${PHASE_222_RAW_SECRET}`,
            cached: false,
          }],
        },
        consoleLogs: [{ level: 'error', text: `console ${PHASE_222_RAW_SECRET}`, timestamp: 1 }],
        networkLogs: [{
          url: `https://example.test/${PHASE_222_RAW_SECRET}`,
          method: 'POST',
          status: 200,
          requestHeaders: { authorization: PHASE_222_RAW_SECRET },
          responseHeaders: {},
          requestBody: PHASE_222_RAW_SECRET,
          startTime: 1,
          endTime: 2,
        }],
        variableSnapshot: {
          PASSWORD_HINT: { value: PHASE_222_RAW_SECRET, source: 'env' },
        },
      }), 'Secret Boundary Test')

      reporter.onHookEnd!({
        hookName: 'seed-secret',
        phase: 'setup',
        hookExecutionId: 'hook-secret',
        runId,
        status: 'failed',
        duration: 5,
        stdout: `stdout ${PHASE_222_RAW_SECRET}`,
        stderr: `stderr ${PHASE_222_RAW_SECRET}`,
        variables: { LEAK: PHASE_222_RAW_SECRET },
        error: `hook ${PHASE_222_RAW_SECRET}`,
      })

      await reporter.onTestEnd!(makeTestResult({
        name: 'Secret Boundary Test',
        filePath: 'tests/secret.yaml',
        status: 'failed',
        failureSummary: `failure ${PHASE_222_RAW_SECRET}`,
        metadata: { note: `result ${PHASE_222_RAW_SECRET}` },
        steps: [makeStepResult({ error: `summary ${PHASE_222_RAW_SECRET}` })],
      }))

      const persisted = {
        run: db.getRuns()[0],
        artifact: db.getRunArtifact(runId),
        steps: db.getSteps(runId),
        logs: db.getExecutionLogs({ runId }),
        reasoning: db.getReasoningTrace(runId, 0),
      }
      const serialized = JSON.stringify(persisted)

      expect(serialized).not.toContain(PHASE_222_RAW_SECRET)
      expect(serialized).toContain('[secret]')
      expect(serialized).toContain('[secret:loginPassword]')
      expect(serialized).not.toContain('loginPassword=')
      expect(serialized).not.toContain('"loginPassword"')
      expect((persisted.artifact?.payload.config as any).secretsFile).toEqual({
        path: '.secrets.local',
        status: 'loaded',
        count: 1,
      })
    })

    it('onStepEnd saves screenshots for each step immediately', async () => {
      const { writeFile: writeFileMock } = await import('node:fs/promises')

      reporter.onRunStart([makeTest()])
      reporter.onTestStart!(makeTest(), 'tests/login.yaml')

      const screenshot = Buffer.from('png-data')
      await reporter.onStepEnd!(makeStepResult({
        name: 'With screenshot',
        screenshot,
      }), 'Login Test')

      expect(writeFileMock).toHaveBeenCalledWith(
        expect.stringContaining('0-With_screenshot.png'),
        screenshot,
      )

      const runId = db.getRuns()[0].id
      const steps = db.getSteps(runId)
      expect(steps[0].screenshotPath).toContain('0-With_screenshot.png')
    })
  })

  it('saves screenshot paths as relative (no absolute prefix)', async () => {
    reporter.onRunStart([makeTest()])
    reporter.onTestStart!(makeTest(), 'tests/login.yaml')

    const screenshotBuffer = Buffer.from('png-data')
    await reporter.onStepEnd!(makeStepResult({
      name: 'Check page',
      screenshot: screenshotBuffer,
    }), 'Login Test')

    await reporter.onTestEnd!(makeTestResult({
      steps: [makeStepResult({ name: 'Check page', screenshot: screenshotBuffer })],
    }))

    const runs = db.getRuns()
    const steps = db.getSteps(runs[0].id)
    const path = steps[0].screenshotPath!
    expect(path).not.toMatch(/^\//)
    expect(path).not.toMatch(/^[A-Z]:\\/)
    expect(path).toMatch(/^[^/\\]+\/0-Check_page\.png$/)
  })

  it('saves screenshotBefore paths as relative', async () => {
    reporter.onRunStart([makeTest()])
    reporter.onTestStart!(makeTest(), 'tests/login.yaml')

    const beforeBuf = Buffer.from('before-data')
    await reporter.onStepEnd!(makeStepResult({
      name: 'Step with before',
      screenshotBefore: beforeBuf,
    }), 'Login Test')

    await reporter.onTestEnd!(makeTestResult({
      steps: [makeStepResult({ name: 'Step with before', screenshotBefore: beforeBuf })],
    }))

    const runs = db.getRuns()
    const steps = db.getSteps(runs[0].id)
    const path = steps[0].screenshotBeforePath!
    expect(path).not.toMatch(/^\//)
    expect(path).toMatch(/^[^/\\]+\/0-Step_with_before-before\.png$/)
  })

  it('saves healing screenshot paths as relative in JSON', async () => {
    reporter.onRunStart([makeTest()])
    reporter.onTestStart!(makeTest(), 'tests/login.yaml')

    const healBuf = Buffer.from('heal-data')
    await reporter.onStepEnd!(makeStepResult({
      name: 'Healed step',
      status: 'healed',
      healingScreenshots: [healBuf],
    }), 'Login Test')

    await reporter.onTestEnd!(makeTestResult({
      steps: [makeStepResult({ name: 'Healed step', status: 'healed', healingScreenshots: [healBuf] })],
    }))

    const runs = db.getRuns()
    const steps = db.getSteps(runs[0].id)
    const paths = steps[0].healingScreenshotPaths!
    expect(paths).toHaveLength(1)
    expect(paths[0]).not.toMatch(/^\//)
    expect(paths[0]).toMatch(/^[^/\\]+\/0-healing-0\.png$/)
  })

  it('saves sub-action screenshot paths as relative in JSON', async () => {
    reporter.onRunStart([makeTest()])
    reporter.onTestStart!(makeTest(), 'tests/login.yaml')

    const subBefore = Buffer.from('sub-before')
    const subAfter = Buffer.from('sub-after')
    await reporter.onStepEnd!(makeStepResult({
      name: 'Multi-action step',
      trace: {
        observation: 'page loaded',
        reasoning: 'need to click',
        plannedAction: { type: 'click', ref: '[1]' },
        result: 'success',
        screenStateBefore: 'before',
        subActions: [{
          index: 0,
          observation: 'sub obs',
          reasoning: 'sub reason',
          plannedAction: { type: 'click', ref: '[2]' },
          result: 'success',
          screenStateBefore: 'sub before',
          cached: false,
          screenshotBefore: subBefore,
          screenshotAfter: subAfter,
        }],
      },
    }), 'Login Test')

    await reporter.onTestEnd!(makeTestResult({
      steps: [makeStepResult({ name: 'Multi-action step' })],
    }))

    const runs = db.getRuns()
    const steps = db.getSteps(runs[0].id)
    const subActions = steps[0].subActionsData as Array<Record<string, unknown>>
    expect(subActions).toHaveLength(1)
    const beforePath = subActions[0].screenshotBeforePath as string
    const afterPath = subActions[0].screenshotAfterPath as string
    expect(beforePath).not.toMatch(/^\//)
    expect(beforePath).toMatch(/^[^/\\]+\/0-sub-0-before\.png$/)
    expect(afterPath).not.toMatch(/^\//)
    expect(afterPath).toMatch(/^[^/\\]+\/0-sub-0-after\.png$/)
  })

  describe('onHookEnd', () => {
    it('records to execution_logs when runId is on event', async () => {
      reporter.onRunStart([makeTest()])
      await reporter.onTestStart!(makeTest(), 'tests/login.yaml')
      const runId = db.getRuns()[0].id

      reporter.onHookEnd!({
        hookId: HOOK_ID,
        hookName: 'seed-db',
        phase: 'setup',
        hookExecutionId: 'hook-1',
        runId,
        status: 'passed',
        duration: 500,
        stdout: 'seeded',
        stderr: '',
        variables: { DB_URL: 'postgres://localhost' },
      })

      const logs = db.getExecutionLogs({ runId })
      expect(logs).toHaveLength(1)
      expect(logs[0].name).toBe('seed-db')
      expect((logs[0] as any).hookId).toBe(HOOK_ID)
      expect(logs[0].phase).toBe('setup')
      expect(logs[0].status).toBe('passed')
      expect(logs[0].variables).toEqual({ DB_URL: 'postgres://localhost' })
    })

    it('drops record when no runId available', () => {
      reporter.onHookEnd!({
        hookName: 'orphan-hook',
        phase: 'setup',
        hookExecutionId: 'hook-2',
        status: 'passed',
        duration: 100,
        stdout: '',
        stderr: '',
        variables: {},
      })

      const logs = db.getExecutionLogs({})
      expect(logs).toHaveLength(0)
    })

    it('records setup hook with stepId null', async () => {
      reporter.onRunStart([makeTest()])
      await reporter.onTestStart!(makeTest(), 'tests/login.yaml')
      const runId = db.getRuns()[0].id

      reporter.onHookEnd!({
        hookId: HOOK_ID,
        hookName: 'setup-env',
        phase: 'setup',
        hookExecutionId: 'hook-3',
        runId,
        status: 'passed',
        duration: 200,
        stdout: '',
        stderr: '',
        variables: {},
      })

      const logs = db.getExecutionLogs({ runId })
      expect(logs).toHaveLength(1)
      expect(logs[0].stepId).toBeNull()
      expect((logs[0] as any).hookId).toBe(HOOK_ID)
    })

    it('onTestStart is idempotent -- second call does not create duplicate run', async () => {
      reporter.onRunStart([makeTest()])
      await reporter.onTestStart!(makeTest(), 'tests/login.yaml')
      await reporter.onTestStart!(makeTest(), 'tests/login.yaml')

      const runs = db.getRuns()
      expect(runs).toHaveLength(1)
    })
  })

  it('stores healing attempts and captured variables', async () => {
    reporter.onRunStart([makeTest()])
    reporter.onTestStart!(makeTest(), 'tests/login.yaml')

    const step = makeStepResult({
      name: 'Healed step',
      status: 'healed',
      healingAttempts: [
        { action: { type: 'click', ref: '[1]' }, observationBefore: 'before', success: false },
      ],
      capturedVariables: { token: 'abc123' },
      retryCount: 2,
    })
    await reporter.onStepEnd!(step, 'Login Test')
    await reporter.onTestEnd!(makeTestResult({ steps: [step] }))

    const runs = db.getRuns()
    const steps = db.getSteps(runs[0].id)
    expect(steps[0].healingAttempts).toHaveLength(1)
    expect(steps[0].capturedVariables).toEqual({ token: 'abc123' })
    expect(steps[0].retryCount).toBe(2)
  })
})
