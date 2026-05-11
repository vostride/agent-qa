// @vitest-environment jsdom

import { act, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"

import { ArtifactMemoryTab } from "@/components/run-detail/artifact-memory-tab"
import type { RunArtifactResponse } from "@/lib/api"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock("@/components/ui/collapsible", () => ({
  Collapsible: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CollapsibleTrigger: ({ children }: { children: ReactNode }) => <button type="button">{children}</button>,
  CollapsibleContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))

let container: HTMLDivElement
let root: Root

function mount(response: RunArtifactResponse) {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root.render(<ArtifactMemoryTab response={response} />)
  })
}

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  vi.clearAllMocks()
})

function makeRun(overrides: Partial<RunArtifactResponse["run"]> = {}): RunArtifactResponse["run"] {
  return {
    id: "run-1",
    name: "Artifact memory run",
    filePath: "tests/memory.yaml",
    status: "passed",
    duration: 1200,
    attributes: {},
    environment: null,
    metadata: null,
    startedAt: "2026-04-18T00:00:00.000Z",
    endedAt: "2026-04-18T00:00:01.200Z",
    videoPath: null,
    failureSummary: null,
    errorLog: null,
    memoryLog: null,
    testId: "t_memory",
    suiteId: null,
    platform: "web",
    testFileContent: null,
    modelName: null,
    llmProvider: null,
    parentRunId: null,
    attemptNumber: 1,
    retryCount: 0,
    maxRetries: 0,
    createdAt: "2026-04-18T00:00:00.000Z",
    ...overrides,
  }
}

function observation(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    title: `${id} title`,
    content: `${id} content`,
    trust: 0.4,
    created: "2026-04-18T00:00:00.000Z",
    last_confirmed: "2026-04-18T00:00:00.000Z",
    confirmed_count: 1,
    contradicted_count: 0,
    source_test: "t_memory",
    ...overrides,
  }
}

function responseWithMemory(log: Record<string, unknown>, missingSections: string[] = []): RunArtifactResponse {
  return {
    run: makeRun(),
    artifact: {
      runId: "run-1",
      kind: "test",
      schemaVersion: 1,
      payload: {
        schemaVersion: 1,
        memory: { log },
      },
      finalizedAt: "2026-04-18T00:00:01.200Z",
      createdAt: "2026-04-18T00:00:00.000Z",
      updatedAt: "2026-04-18T00:00:01.200Z",
    },
    children: [],
    missingSections,
  }
}

function suiteResponseWithChildMemory(log: Record<string, unknown>): RunArtifactResponse {
  return {
    run: makeRun({
      id: "suite-run",
      name: "Memory suite",
      filePath: "suites/memory.suite.yaml",
      testId: null,
      suiteId: "s_memory",
    }),
    artifact: {
      runId: "suite-run",
      kind: "suite-parent",
      schemaVersion: 1,
      payload: {
        schemaVersion: 1,
        source: { kind: "suite", members: [{ index: 0, childRunId: "child-run" }] },
      },
      finalizedAt: "2026-04-18T00:00:01.200Z",
      createdAt: "2026-04-18T00:00:00.000Z",
      updatedAt: "2026-04-18T00:00:01.200Z",
    },
    children: [{
      run: makeRun({
        id: "child-run",
        name: "Memory child",
        parentRunId: "suite-run",
        suiteId: "s_memory",
      }),
      artifact: {
        runId: "child-run",
        kind: "suite-child",
        schemaVersion: 1,
        payload: {
          schemaVersion: 1,
          memory: { log },
        },
        finalizedAt: "2026-04-18T00:00:01.200Z",
        createdAt: "2026-04-18T00:00:00.000Z",
        updatedAt: "2026-04-18T00:00:01.200Z",
      },
    }],
    missingSections: ["memory"],
  }
}

describe("ArtifactMemoryTab", () => {
  it("renders grouped deltas with summaries and vertical before/after detail", () => {
    mount(responseWithMemory({
      added: 1,
      confirmed: 1,
      deprecated: 1,
      deleted: 1,
      curatorDuration: 1500,
      tokenUsage: { promptTokens: 1200, completionTokens: 300, totalTokens: 1500 },
      errors: [],
      deltas: [
        {
          action: "add",
          tier: "products",
          scope: "github",
          observationId: "obs-added",
          reasoning: "Added new login behavior.",
          before: null,
          after: observation("obs-added", { title: "Added observation", content: "new content", trust: 0.5 }),
        },
        {
          action: "confirm",
          tier: "tests",
          scope: "t_memory",
          observationId: "obs-updated",
          reasoning: "Confirmed changed checkout behavior.",
          before: observation("obs-updated", { title: "Old checkout", content: "old content", trust: 0.4, confirmed_count: 1 }),
          after: observation("obs-updated", { title: "New checkout", content: "new content", trust: 0.7, confirmed_count: 2 }),
        },
        {
          action: "deprecate",
          tier: "suites",
          scope: "s_memory",
          observationId: "obs-deprecated",
          reasoning: "Deprecated stale suite observation.",
          before: observation("obs-deprecated", { title: "Deprecated observation" }),
          after: observation("obs-deprecated", { title: "Deprecated observation", trust: 0.1 }),
        },
        {
          action: "delete",
          tier: "products",
          scope: "github",
          observationId: "obs-deleted",
          reasoning: "Deleted contradicted behavior.",
          before: observation("obs-deleted", { title: "Deleted observation", content: "last known deleted content" }),
          after: null,
        },
      ],
    }))

    const groups = Array.from(container.querySelectorAll("[data-memory-group]")).map((node) => node.getAttribute("data-memory-group"))
    expect(groups).toEqual(["Added", "Updated/Confirmed", "Deprecated", "Deleted"])
    expect(container.textContent).toContain("Curator duration: 1.5s")
    expect(container.textContent).toContain("Tokens: 1.2K / 300 / 1.5K")
    expect(container.textContent).toContain("Added observation")
    expect(container.textContent).toContain("Updated/Confirmed")
    expect(container.textContent).toContain("trust +0.3")
    expect(container.textContent).toContain("confirmed +1")
    expect(container.textContent).toContain("Changed fields")
    expect(container.textContent).toContain("Before")
    expect(container.textContent).toContain("After")
    expect(container.textContent).toContain("last known deleted content")
  })

  it("renders zero-change summary with curator metadata", () => {
    mount(responseWithMemory({
      added: 0,
      confirmed: 0,
      deprecated: 0,
      deleted: 0,
      curatorDuration: 900,
      tokenUsage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      errors: [],
      deltas: [],
    }))

    expect(container.textContent).toContain("No memory changes")
    expect(container.textContent).toContain("Memory completed without adding, updating, deprecating, or deleting observations.")
    expect(container.textContent).toContain("Curator duration: 900ms")
    expect(container.textContent).toContain("Tokens: 10 / 5 / 15")
  })

  it("renders suite parent memory from child artifact logs", () => {
    mount(suiteResponseWithChildMemory({
      added: 1,
      confirmed: 0,
      deprecated: 0,
      deleted: 0,
      curatorDuration: 700,
      tokenUsage: { promptTokens: 20, completionTokens: 5, totalTokens: 25 },
      errors: [],
      deltas: [{
        action: "add",
        tier: "products",
        scope: "github",
        observationId: "obs-suite-added",
        reasoning: "Child run discovered new product memory.",
        before: null,
        after: observation("obs-suite-added", {
          title: "Suite child product memory",
          content: "suite child generated product memory",
          trust: 0.6,
          source_test: "t_suite_child",
        }),
      }],
    }))

    expect(container.textContent).not.toContain("Memory was not captured for this run.")
    expect(container.textContent).toContain("Suite child product memory")
    expect(container.textContent).toContain("suite child generated product memory")
    expect(container.textContent).toContain("Tokens: 20 / 5 / 25")
  })

  it("renders a quiet missing memory placeholder", () => {
    mount(responseWithMemory({}, ["memory"]))

    expect(container.textContent).toContain("Memory was not captured for this run.")
  })
})
