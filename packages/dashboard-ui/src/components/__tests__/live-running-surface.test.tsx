// @vitest-environment jsdom

import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { act, type ReactElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"

import { SuiteTestRow } from "@/components/suite-test-row"
import type { TestStepDetail } from "@/hooks/use-live-editor"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock("@dnd-kit/sortable", () => ({
  useSortable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: () => {},
    transform: null,
    transition: null,
    isDragging: false,
  }),
}))

vi.mock("@dnd-kit/utilities", () => ({
  CSS: { Transform: { toString: () => "" } },
}))

let container: HTMLDivElement | null = null
let root: Root | null = null

function mount(element: ReactElement) {
  container = document.createElement("div")
  document.body.appendChild(container)
  const activeRoot = createRoot(container)
  root = activeRoot
  act(() => {
    activeRoot.render(element)
  })
  return container
}

afterEach(() => {
  if (root) {
    act(() => {
      root?.unmount()
    })
  }
  container?.remove()
  root = null
  container = null
})

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8")
}

function makeLiveStep(): TestStepDetail {
  return {
    id: "step-1",
    draftId: null,
    instruction: "Open the first result",
    status: "running",
    duration: undefined,
    error: undefined,
    phases: [],
    executionHistory: [],
    capturedVariables: {},
    consoleLogs: [],
    networkLogs: [],
    variableSnapshot: null,
    originalStepName: null,
    subActionsData: null,
    executionLogs: [],
    executionGeneration: 1,
    stepIndex: 0,
  }
}

describe("live running surface contract", () => {
  it("defines a full-border running beam with pointer-safe reduced-motion CSS", () => {
    const css = source("src/styles/globals.css")

    expect(css).toContain(".live-running-surface")
    expect(css).toContain(".live-running-surface::before")
    expect(css).toContain(".live-running-surface::after")
    expect(css).toContain("position: relative")
    expect(css).toContain("overflow: hidden")
    expect(css).toContain("pointer-events: none")
    expect(css).toContain("@media (prefers-reduced-motion: reduce)")
    expect(css).toContain("live-running-border-beam")
    expect(css).toContain("offset-path: rect")
    expect(css).toContain("offset-distance")
    expect(css).toContain("var(--ring)")
    expect(css).toContain("--live-running-beam-duration: 14s")
    expect(css).not.toContain("conic-gradient")
    expect(css).not.toContain("mask-composite")
  })

  it("keeps the shared running class on live run and test editor surfaces", () => {
    const expected = "live-running-surface border-border/60 bg-primary/5"

    expect(source("src/components/run-results-panel.tsx")).toContain(expected)
    expect(source("src/components/step-card-editor.tsx")).toContain(expected)
    expect(source("src/components/editor/editable-step-wrapper.tsx")).toContain(expected)
  })

  it("renders both suite test and nested current-step running surfaces", () => {
    const view = mount(
      <SuiteTestRow
        id="test-0"
        name="Login flow"
        path="web/login.yaml"
        testId="t_login"
        isMissing={false}
        onRemove={() => {}}
        liveMode
        liveStatus="running"
        runningStepIndex={0}
        liveSteps={[makeLiveStep()]}
      />,
    )

    const runningSurfaces = view.querySelectorAll(".live-running-surface")

    expect(runningSurfaces.length).toBeGreaterThanOrEqual(2)
  })

  it("tracks the suite live files that must retain running surface coverage", () => {
    expect(source("src/components/suite-test-row.tsx")).toContain("live-running-surface")
    expect(source("src/components/suite-visual-builder.tsx")).toContain("live-running-surface")
  })
})
