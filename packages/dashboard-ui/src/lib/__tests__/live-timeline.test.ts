import { describe, expect, it } from "vitest"

import {
  createLiveTimelineState,
  deriveLiveProgressSummary,
  mergeFinalArtifacts,
  reduceLiveTimeline,
} from "@/lib/live-timeline"
import type { ExecutionLogEntry, RunRow, StepRow } from "@/lib/api"

const timestamp = "2026-05-02T00:00:00.000Z"
type ReducerEvent = Parameters<typeof reduceLiveTimeline>[1]

function runRow(overrides: Partial<RunRow> = {}): RunRow {
  return {
    id: "run-1",
    name: "Login test",
    filePath: "/tests/login.yaml",
    status: "passed",
    duration: 100,
    attributes: {},
    environment: null,
    metadata: null,
    startedAt: timestamp,
    endedAt: timestamp,
    videoPath: null,
    failureSummary: null,
    errorLog: null,
    memoryLog: null,
    testId: null,
    suiteId: null,
    platform: "web",
    testFileContent: null,
    modelName: null,
    llmProvider: null,
    parentRunId: null,
    attemptNumber: 1,
    retryCount: 0,
    maxRetries: 0,
    createdAt: timestamp,
    ...overrides,
  }
}

function stepRow(overrides: Partial<StepRow> = {}): StepRow {
  return {
    id: "step-row-1",
    runId: "run-1",
    name: "Repeat action",
    status: "passed",
    duration: 50,
    action: null,
    observation: "observed",
    reasoning: "reasoned",
    plannedAction: null,
    result: "success",
    error: null,
    screenshotPath: "after.png",
    screenshotBeforePath: "before.png",
    healingAttempts: null,
    retryCount: 0,
    capturedVariables: null,
    stepOrder: 0,
    annotationData: null,
    healingScreenshotPaths: null,
    accessibilityViolations: null,
    consoleLogs: null,
    networkLogs: null,
    confidence: null,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    subActionsData: null,
    variableSnapshot: null,
    originalStepName: null,
    screenContextBefore: null,
    screenContextAfter: null,
    createdAt: timestamp,
    ...overrides,
  }
}

describe("live timeline reducer", () => {
  it("derives single-test progress labels and clamps completed steps", () => {
    let state = createLiveTimelineState("run-1")
    state = reduceLiveTimeline(state, {
      type: "test-start",
      runId: "run-1",
      testName: "Login test",
      filePath: "/tests/login.yaml",
      totalSteps: 2,
      timestamp,
    })
    state = reduceLiveTimeline(state, {
      type: "step-start",
      runId: "run-1",
      stepName: "Open login",
      testName: "Login test",
      stepIndex: 0,
      timestamp,
    })

    expect(deriveLiveProgressSummary(state)).toEqual(expect.objectContaining({
      mode: "step",
      label: "Step 1 of 2",
      current: 1,
      completed: 0,
      total: 2,
      percent: 0,
    }))

    state = reduceLiveTimeline(state, {
      type: "step-complete",
      runId: "run-1",
      stepName: "Open login",
      stepIndex: 0,
      status: "passed",
      duration: 10,
    })
    state = reduceLiveTimeline(state, {
      type: "step-start",
      runId: "run-1",
      stepName: "Submit login",
      testName: "Login test",
      stepIndex: 1,
      timestamp,
    })
    state = reduceLiveTimeline(state, {
      type: "step-complete",
      runId: "run-1",
      stepName: "Submit login",
      stepIndex: 1,
      status: "passed",
      duration: 12,
    })

    expect(deriveLiveProgressSummary(state)).toEqual(expect.objectContaining({
      mode: "step",
      label: "Step 2 of 2",
      current: 2,
      completed: 2,
      total: 2,
      percent: 100,
    }))
  })

  it("derives suite progress from child tests instead of child steps or hooks", () => {
    let state = createLiveTimelineState("suite-1")
    const suiteTests = [
      runRow({ id: "child-1", name: "One", status: "passed", parentRunId: "suite-1", metadata: { suiteIndex: 0 } }),
      runRow({ id: "child-2", name: "Two", status: "running", parentRunId: "suite-1", metadata: { suiteIndex: 1 } }),
      runRow({ id: "child-3", name: "Three", status: "pending", parentRunId: "suite-1", metadata: { suiteIndex: 2 } }),
      runRow({ id: "child-4", name: "Four", status: "pending", parentRunId: "suite-1", metadata: { suiteIndex: 3 } }),
    ]

    state = mergeFinalArtifacts(state, { suiteTests })
    state = reduceLiveTimeline(state, {
      type: "hook-start",
      runId: "suite-1",
      hookName: "suite setup",
      phase: "setup",
      hookExecutionId: "setup-1",
      timestamp,
    })
    state = reduceLiveTimeline(state, {
      type: "step-start",
      parentRunId: "suite-1",
      suiteIndex: 1,
      stepIndex: 0,
      stepName: "Open billing",
      testName: "Two",
      timestamp,
    } as ReducerEvent)
    state = reduceLiveTimeline(state, {
      type: "step-phase",
      parentRunId: "suite-1",
      suiteIndex: 1,
      stepIndex: 0,
      stepName: "Open billing",
      testName: "Two",
      subActionIndex: 0,
      phase: "verify",
      success: undefined,
      text: "still checking",
      timestamp,
    } as ReducerEvent)
    state = reduceLiveTimeline(state, {
      type: "hook-start",
      runId: "child-2",
      stepId: "0",
      hookName: "inline helper",
      phase: "inline",
      hookExecutionId: "inline-1",
      timestamp,
    } as ReducerEvent)
    for (let index = 1; index <= 5; index += 1) {
      state = reduceLiveTimeline(state, {
        type: "step-complete",
        parentRunId: "suite-1",
        suiteIndex: 1,
        stepIndex: index,
        stepName: `Extra child step ${index}`,
        status: "passed",
        duration: 1,
      } as ReducerEvent)
    }

    const progress = deriveLiveProgressSummary(state)
    expect(progress).toEqual(expect.objectContaining({
      mode: "test",
      label: "Test 2 of 4",
      current: 2,
      completed: 1,
      total: 4,
      percent: 25,
    }))
    expect(progress.percent).toBeLessThanOrEqual(100)
  })

  it("advances suite progress when completion events only carry the child run id", () => {
    let state = createLiveTimelineState("suite-1")
    state = mergeFinalArtifacts(state, {
      suiteTests: [
        runRow({ id: "child-1", name: "One", status: "running", parentRunId: "suite-1", metadata: { suiteIndex: 0 } }),
        runRow({ id: "child-2", name: "Two", status: "pending", parentRunId: "suite-1", metadata: { suiteIndex: 1 } }),
        runRow({ id: "child-3", name: "Three", status: "pending", parentRunId: "suite-1", metadata: { suiteIndex: 2 } }),
      ],
    })

    state = reduceLiveTimeline(state, {
      type: "test-complete",
      runId: "child-1",
      testName: "One",
      status: "passed",
      duration: 120,
    })

    expect(state.suiteTests[0]?.status).toBe("passed")
    expect(deriveLiveProgressSummary(state)).toEqual(expect.objectContaining({
      mode: "test",
      label: "Test 2 of 3",
      current: 2,
      completed: 1,
      total: 3,
      percent: 33,
    }))
  })

  it("keeps suite progress denominator stable before every child test has started", () => {
    let state = createLiveTimelineState("suite-1")

    state = reduceLiveTimeline(state, {
      type: "test-start",
      runId: "child-1",
      parentRunId: "suite-1",
      suiteIndex: 0,
      suiteTotal: 3,
      testName: "One",
      filePath: "/tests/one.yaml",
      totalSteps: 1,
      timestamp,
    })

    expect(deriveLiveProgressSummary(state)).toEqual(expect.objectContaining({
      label: "Test 1 of 3",
      current: 1,
      completed: 0,
      total: 3,
      percent: 0,
    }))

    state = reduceLiveTimeline(state, {
      type: "test-complete",
      runId: "child-1",
      testName: "One",
      status: "passed",
      duration: 120,
    })

    expect(deriveLiveProgressSummary(state)).toEqual(expect.objectContaining({
      label: "Test 2 of 3",
      current: 2,
      completed: 1,
      total: 3,
      percent: 33,
    }))

    state = reduceLiveTimeline(state, {
      type: "test-start",
      runId: "child-2",
      parentRunId: "suite-1",
      suiteIndex: 1,
      suiteTotal: 3,
      testName: "Two",
      filePath: "/tests/two.yaml",
      totalSteps: 1,
      timestamp,
    })

    expect(deriveLiveProgressSummary(state)).toEqual(expect.objectContaining({
      label: "Test 2 of 3",
      current: 2,
      completed: 1,
      total: 3,
      percent: 33,
    }))
  })

  it("reconciles terminal live-only statuses without overriding persisted failed subactions", () => {
    let state = createLiveTimelineState("run-1")
    state = reduceLiveTimeline(state, {
      type: "hook-start",
      runId: "run-1",
      hookName: "setup data",
      phase: "setup",
      hookExecutionId: "setup-1",
      timestamp,
    })
    state = reduceLiveTimeline(state, {
      type: "step-start",
      runId: "run-1",
      stepName: "Submit checkout",
      testName: "Checkout",
      stepIndex: 0,
      timestamp,
    })
    state = reduceLiveTimeline(state, {
      type: "step-phase",
      runId: "run-1",
      stepName: "Submit checkout",
      testName: "Checkout",
      stepIndex: 0,
      subActionIndex: 0,
      phase: "verify",
      success: false,
      text: "stale live verifier failure",
      timestamp,
    })
    state = reduceLiveTimeline(state, {
      type: "hook-start",
      runId: "run-1",
      stepId: "0",
      hookName: "inline helper",
      phase: "inline",
      hookExecutionId: "inline-1",
      timestamp,
    } as ReducerEvent)
    state = reduceLiveTimeline(state, {
      type: "run-complete",
      runId: "run-1",
      status: "passed",
      duration: 100,
    })

    expect(state.setupHooks[0].status).toBe("passed")
    expect(state.inlineLogs[0].status).toBe("passed")
    expect(state.displaySteps[0].status).toBe("passed")
    expect(state.displaySteps[0].subActionsData?.[0]?.result).toBe("success")

    state = mergeFinalArtifacts(state, {
      run: runRow({ status: "passed" }),
      steps: [stepRow({
        status: "passed",
        stepOrder: 0,
        subActionsData: [{
          index: 0,
          observation: "persisted observation",
          reasoning: "persisted reasoning",
          plannedAction: null,
          result: "failure",
          error: "persisted failed verify",
          screenStateBefore: "",
          cached: false,
        }],
      })],
    })

    expect(state.setupHooks[0].status).toBe("passed")
    expect(state.inlineLogs[0].status).toBe("passed")
    expect(state.displaySteps[0].status).toBe("passed")
    expect(state.displaySteps[0].subActionsData?.[0]?.result).toBe("failure")
  })

  it("keeps duplicate step names separate by run ID, stepIndex, and stepId", () => {
    let state = createLiveTimelineState("run-1")

    state = reduceLiveTimeline(state, {
      type: "step-start",
      eventId: "evt-1",
      runId: "run-1",
      stepName: "Repeat action",
      testName: "Login test",
      stepIndex: 0,
      stepId: "step-0",
      timestamp,
    })
    state = reduceLiveTimeline(state, {
      type: "step-start",
      eventId: "evt-2",
      runId: "run-1",
      stepName: "Repeat action",
      testName: "Login test",
      stepIndex: 1,
      stepId: "step-1",
      timestamp,
    })
    state = reduceLiveTimeline(state, {
      type: "step-phase",
      eventId: "evt-3",
      runId: "run-1",
      stepName: "Repeat action",
      testName: "Login test",
      stepIndex: 1,
      stepId: "step-1",
      subActionIndex: 0,
      phase: "plan",
      text: "phase for second repeat",
      timestamp,
    })
    state = reduceLiveTimeline(state, {
      type: "step-complete",
      eventId: "evt-4",
      runId: "run-1",
      stepName: "Repeat action",
      stepIndex: 0,
      stepId: "step-0",
      status: "passed",
      duration: 10,
    })
    state = reduceLiveTimeline(state, {
      type: "step-complete",
      eventId: "evt-5",
      runId: "run-1",
      stepName: "Repeat action",
      stepIndex: 1,
      stepId: "step-1",
      status: "failed",
      duration: 20,
      error: "second failed",
    })

    expect(state.steps.map((step) => `${step.name}:${step.status}`)).toEqual([
      "Repeat action:passed",
      "Repeat action:failed",
    ])
    expect(state.displaySteps[0].subActionsData).toBeNull()
    expect(state.displaySteps[1].subActionsData?.[0]).toEqual(expect.objectContaining({
      index: 0,
      reasoning: "phase for second repeat",
    }))
  })

  it("keeps suite child steps separate when live events only carry parent suite identity", () => {
    let state = createLiveTimelineState("suite-1")

    state = reduceLiveTimeline(state, {
      type: "step-start",
      eventId: "suite-a-start",
      parentRunId: "suite-1",
      suiteIndex: 0,
      stepIndex: 0,
      stepName: "Open admin",
      testName: "Admin test",
      timestamp,
    } as ReducerEvent)
    state = reduceLiveTimeline(state, {
      type: "step-phase",
      eventId: "suite-a-phase",
      parentRunId: "suite-1",
      suiteIndex: 0,
      stepIndex: 0,
      stepName: "Open admin",
      testName: "Admin test",
      subActionIndex: 0,
      phase: "plan",
      text: "plan for admin",
      timestamp,
    } as ReducerEvent)
    state = reduceLiveTimeline(state, {
      type: "step-complete",
      eventId: "suite-a-complete",
      parentRunId: "suite-1",
      suiteIndex: 0,
      stepIndex: 0,
      stepName: "Open admin",
      status: "passed",
      duration: 10,
    } as ReducerEvent)

    state = reduceLiveTimeline(state, {
      type: "step-start",
      eventId: "suite-b-start",
      parentRunId: "suite-1",
      suiteIndex: 1,
      stepIndex: 0,
      stepName: "Open billing",
      testName: "Billing test",
      timestamp,
    } as ReducerEvent)
    state = reduceLiveTimeline(state, {
      type: "step-phase",
      eventId: "suite-b-phase",
      parentRunId: "suite-1",
      suiteIndex: 1,
      stepIndex: 0,
      stepName: "Open billing",
      testName: "Billing test",
      subActionIndex: 0,
      phase: "plan",
      text: "plan for billing",
      timestamp,
    } as ReducerEvent)
    state = reduceLiveTimeline(state, {
      type: "step-complete",
      eventId: "suite-b-complete",
      parentRunId: "suite-1",
      suiteIndex: 1,
      stepIndex: 0,
      stepName: "Open billing",
      status: "passed",
      duration: 12,
    } as ReducerEvent)

    expect(state.displaySteps.map((step) => step.name)).toEqual(["Open admin", "Open billing"])
    expect(state.displaySteps.map((step) => step.subActionsData?.[0]?.reasoning)).toEqual([
      "plan for admin",
      "plan for billing",
    ])
  })

  it("deduplicates replayed SSE event IDs for steps and hooks", () => {
    let state = createLiveTimelineState("run-1")
    const stepEvent = {
      type: "step-start" as const,
      eventId: "evt-step",
      runId: "run-1",
      stepName: "Open page",
      testName: "Login test",
      stepIndex: 0,
      timestamp,
    }
    const hookEvent = {
      type: "hook-start" as const,
      eventId: "evt-hook",
      runId: "run-1",
      hookName: "seed data",
      phase: "setup" as const,
      hookExecutionId: "hook-1",
      timestamp,
    }

    state = reduceLiveTimeline(state, stepEvent)
    state = reduceLiveTimeline(state, stepEvent)
    state = reduceLiveTimeline(state, hookEvent)
    state = reduceLiveTimeline(state, hookEvent)

    expect(state.displaySteps).toHaveLength(1)
    expect(state.setupHooks).toHaveLength(1)
  })

  it("groups streamed phases by explicit subActionIndex and falls back to phase sequence", () => {
    let state = createLiveTimelineState("run-1")
    state = reduceLiveTimeline(state, {
      type: "step-start",
      runId: "run-1",
      stepName: "Complete checkout",
      testName: "Checkout",
      stepIndex: 0,
      timestamp,
    })
    state = reduceLiveTimeline(state, {
      type: "step-phase",
      runId: "run-1",
      stepName: "Complete checkout",
      testName: "Checkout",
      stepIndex: 0,
      subActionIndex: 0,
      phase: "observe",
      text: "cart visible",
      timestamp,
    })
    state = reduceLiveTimeline(state, {
      type: "step-phase",
      runId: "run-1",
      stepName: "Complete checkout",
      testName: "Checkout",
      stepIndex: 0,
      subActionIndex: 1,
      phase: "observe",
      text: "confirmation visible",
      timestamp,
    })

    expect(state.displaySteps[0].subActionsData?.map((sub) => sub.observation)).toEqual([
      "cart visible",
      "confirmation visible",
    ])

    let fallback = createLiveTimelineState("run-2")
    fallback = reduceLiveTimeline(fallback, {
      type: "step-start",
      runId: "run-2",
      stepName: "Fallback grouping",
      testName: "Checkout",
      timestamp,
    })
    for (const phase of [
      { phase: "observe" as const, text: "first observe" },
      { phase: "plan" as const, text: "first plan" },
      { phase: "observe" as const, text: "second observe" },
    ]) {
      fallback = reduceLiveTimeline(fallback, {
        type: "step-phase",
        runId: "run-2",
        stepName: "Fallback grouping",
        testName: "Checkout",
        ...phase,
        timestamp,
      })
    }

    expect(fallback.displaySteps[0].subActionsData?.map((sub) => sub.observation)).toEqual([
      "first observe",
      "second observe",
    ])
  })

  it("patches hook-start rows in place with hook-end details", () => {
    let state = createLiveTimelineState("run-1")

    state = reduceLiveTimeline(state, {
      type: "hook-start",
      runId: "run-1",
      hookName: "seed data",
      phase: "setup",
      hookExecutionId: "hook-1",
      timestamp,
    })
    state = reduceLiveTimeline(state, {
      type: "hook-end",
      runId: "run-1",
      hookName: "seed data",
      phase: "setup",
      hookExecutionId: "hook-1",
      status: "passed",
      duration: 12,
      stdout: "seeded",
      stderr: "",
      variables: { TOKEN: "value" },
      timestamp,
    })

    expect(state.setupHooks).toHaveLength(1)
    expect(state.setupHooks[0]).toEqual(expect.objectContaining({
      status: "passed",
      duration: 12,
      stdout: "seeded",
      variables: { TOKEN: "value" },
    }))
  })

  it("patches running steps to terminal status and merges final rows by run/order", () => {
    let state = createLiveTimelineState("run-1")
    state = reduceLiveTimeline(state, {
      type: "step-start",
      runId: "run-1",
      stepName: "Repeat action",
      testName: "Login test",
      stepIndex: 0,
      timestamp,
    })
    state = reduceLiveTimeline(state, {
      type: "run-complete",
      runId: "run-1",
      status: "timeout",
      duration: 1000,
    })

    expect(state.displaySteps[0].status).toBe("failed")

    const finalLog: ExecutionLogEntry = {
      id: "log-1",
      runId: "run-1",
      stepId: null,
      type: "hook",
      name: "suite setup",
      hookId: "hook-1",
      phase: "setup",
      status: "passed",
      duration: 5,
      stdout: "ready",
      stderr: null,
      returnData: null,
      variables: null,
      createdAt: timestamp,
    }
    state = mergeFinalArtifacts(state, {
      run: runRow({ status: "passed" }),
      steps: [stepRow({ status: "passed", stepOrder: 0, screenshotPath: "final.png" })],
      logs: [finalLog],
    })

    expect(state.displaySteps).toHaveLength(1)
    expect(state.displaySteps[0]).toEqual(expect.objectContaining({
      status: "passed",
      screenshotPath: "final.png",
    }))
    expect(state.setupHooks).toEqual([finalLog])
  })

  it("merges persisted hook logs into existing live hook rows without changing selection keys", () => {
    let state = createLiveTimelineState("run-1")
    state = reduceLiveTimeline(state, {
      type: "hook-start",
      runId: "run-1",
      hookName: "seed data",
      phase: "setup",
      hookExecutionId: "hook-1",
      timestamp,
    })

    state = mergeFinalArtifacts(state, {
      logs: [{
        id: "hook-1",
        runId: "run-1",
        stepId: null,
        type: "hook",
        name: "seed data",
        hookId: "hook-seed",
        phase: "setup",
        status: "passed",
        duration: 11,
        stdout: "ready",
        stderr: null,
        returnData: null,
        variables: { TOKEN: "value" },
        createdAt: timestamp,
      }],
    })

    expect(state.setupHooks).toHaveLength(1)
    expect(state.setupHooks[0]).toEqual(expect.objectContaining({
      id: "hook:run-1:hook-1",
      status: "passed",
      stdout: "ready",
      variables: { TOKEN: "value" },
    }))
  })

  it("reconciles persisted child rows onto parent-scoped live suite steps", () => {
    let state = createLiveTimelineState("suite-1")
    state = reduceLiveTimeline(state, {
      type: "step-start",
      parentRunId: "suite-1",
      suiteIndex: 0,
      stepIndex: 0,
      stepName: "Open admin",
      testName: "Admin test",
      timestamp,
    } as ReducerEvent)
    state = reduceLiveTimeline(state, {
      type: "step-phase",
      parentRunId: "suite-1",
      suiteIndex: 0,
      stepIndex: 0,
      stepName: "Open admin",
      testName: "Admin test",
      subActionIndex: 0,
      phase: "plan",
      text: "live admin plan",
      timestamp,
    } as ReducerEvent)
    state = reduceLiveTimeline(state, {
      type: "step-start",
      parentRunId: "suite-1",
      suiteIndex: 1,
      stepIndex: 0,
      stepName: "Open billing",
      testName: "Billing test",
      timestamp,
    } as ReducerEvent)
    state = reduceLiveTimeline(state, {
      type: "step-phase",
      parentRunId: "suite-1",
      suiteIndex: 1,
      stepIndex: 0,
      stepName: "Open billing",
      testName: "Billing test",
      subActionIndex: 0,
      phase: "plan",
      text: "live billing plan",
      timestamp,
    } as ReducerEvent)

    const childA = runRow({
      id: "child-a",
      name: "Admin test",
      parentRunId: "suite-1",
      metadata: { suiteIndex: 0 },
    })
    const childB = runRow({
      id: "child-b",
      name: "Billing test",
      parentRunId: "suite-1",
      metadata: { suiteIndex: 1 },
    })

    state = mergeFinalArtifacts(state, {
      run: runRow({ id: "suite-1", name: "Admin suite", status: "passed" }),
      suiteTests: [childA, childB],
      childRuns: [
        {
          run: childA,
          steps: [stepRow({
            id: "child-a-step-0",
            runId: "child-a",
            name: "Open admin",
            stepOrder: 0,
            subActionsData: null,
          })],
        },
        {
          run: childB,
          steps: [stepRow({
            id: "child-b-step-0",
            runId: "child-b",
            name: "Open billing",
            stepOrder: 0,
            subActionsData: null,
          })],
        },
      ],
    })

    expect(state.displaySteps).toHaveLength(2)
    expect(state.displaySteps.map((step) => step.rawRunId)).toEqual(["child-a", "child-b"])
    expect(state.displaySteps.map((step) => step.subActionsData?.[0]?.reasoning)).toEqual([
      "live admin plan",
      "live billing plan",
    ])
  })
})
