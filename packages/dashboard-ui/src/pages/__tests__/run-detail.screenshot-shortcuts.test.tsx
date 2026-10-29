// @vitest-environment jsdom

import { act, type ButtonHTMLAttributes, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, Route, Routes, useLocation } from "react-router"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { DEFAULT_FAVICON_HREF } from "@/hooks/use-run-status-favicon"
import { displayStepsForGroups } from "@/lib/display-step"
import type { RunDetailGroup } from "@/lib/run-detail-view"

import type { RunDetailProjection } from "@vostride/agent-qa-schema"
import { asRef } from "@vostride/agent-qa-schema"

import { routes } from "@/lib/routes"
import { EVIDENCE_INCOMPLETE_LABEL } from "@/lib/run-detail-view"

import RunDetailPage from "@/pages/run-detail"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const {
  fetchRunMock,
  fetchRunDetailMock,
  fetchRunArtifactMock,
  fetchActiveExecutionsMock,
  fetchExecutionLogsMock,
  useKeyboardShortcutsMock,
  latestShortcuts,
} = vi.hoisted(() => {
  let latest: Record<string, (event: KeyboardEvent) => void> | null = null
  return {
    fetchRunMock: vi.fn(),
    fetchRunDetailMock: vi.fn(),
    fetchRunArtifactMock: vi.fn(),
    fetchActiveExecutionsMock: vi.fn(),
    fetchExecutionLogsMock: vi.fn(),
    useKeyboardShortcutsMock: vi.fn((shortcuts: Record<string, (event: KeyboardEvent) => void>) => {
      latest = shortcuts
    }),
    latestShortcuts: () => {
      if (!latest) throw new Error("useKeyboardShortcuts was not called")
      return latest
    },
  }
})

vi.mock("@/lib/api", () => ({
  fetchRun: fetchRunMock,
  fetchRunDetail: fetchRunDetailMock,
  // This mock replaces `@/lib/api`, so an omitted export would kill every cell before it asserts.
  fetchRunAnalysis: () => Promise.resolve({ runId: '', verdicts: [], sentences: [], clusters: [] }),
  fetchRunKnowledge: () => Promise.resolve({ kind: 'evidence-incomplete', runId: '' }),
  fetchRunArtifact: fetchRunArtifactMock,
  fetchActiveExecutions: fetchActiveExecutionsMock,
  fetchExecutionLogs: fetchExecutionLogsMock,
  fetchRunEvidence: () => Promise.resolve({ kind: 'failed', error: 'Evidence read not configured in this fixture' }),
  triggerRun: vi.fn(),
  // A no-op double: the real watcher opens an `EventSource` and polls an unstubbed `fetch`.
  watchPostProcessing: () => () => {},
}))

vi.mock("@/hooks/use-page-title", () => ({
  usePageTitle: (title: string) => {
    document.title = title
  },
}))

vi.mock("@/hooks/use-keyboard-shortcuts", () => ({
  useKeyboardShortcuts: useKeyboardShortcutsMock,
}))

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

vi.mock("@/components/page-skeleton", () => ({
  DetailSkeleton: () => <div>Loading...</div>,
}))

vi.mock("@/components/empty-state", () => ({
  EmptyState: ({ title }: { title: string }) => <div>{title}</div>,
}))

vi.mock("@/components/run-detail/run-navbar", () => ({
  RunNavbar: () => <div data-testid="run-navbar">navbar</div>,
}))

vi.mock("@/components/run-detail/step-tree", () => ({
  // The double flattens through the page's helper, so its ids are the ids the page selects by.
  StepTree: ({
    groups,
    selection,
  }: {
    groups: readonly RunDetailGroup[]
    selection: { type: string; stepId?: string; subIndex?: number } | null
  }) => {
    const selectionLabel = selection
      ? `${selection.type}:${selection.stepId ?? ""}:${selection.subIndex ?? ""}`
      : ""
    return (
      <div data-testid="step-tree" data-selection={selectionLabel}>
        {displayStepsForGroups(groups).map((step) => (
          <div key={step.id} data-step-id={step.id}>
            {step.name}
          </div>
        ))}
      </div>
    )
  },
}))

// Renders the real `img` and failure callback; the real viewer needs a `ResizeObserver`.
vi.mock("@/components/screenshot-viewer", () => ({
  ScreenshotViewer: ({ src, onUnavailable }: { src: string; onUnavailable?: () => void }) => (
    <img data-testid="screenshot-viewer" src={src} onError={() => onUnavailable?.()} />
  ),
}))

vi.mock("@/components/reasoning-pipeline", () => ({
  ReasoningPipeline: () => <div data-testid="reasoning-pipeline" />,
}))

vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

vi.mock("@/components/ui/select", () => ({
  Select: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children }: { children: ReactNode }) => <button type="button">{children}</button>,
  SelectValue: () => <span>suite view</span>,
  SelectContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))

vi.mock("@/components/ui/resizable", () => ({
  ResizablePanelGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ResizablePanel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ResizableHandle: () => <div />,
}))

vi.mock("@/components/ui/collapsible", () => ({
  Collapsible: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CollapsibleTrigger: ({ children }: { children: ReactNode }) => <button type="button">{children}</button>,
  CollapsibleContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))

vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))

vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}))

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: { children: ReactNode } & ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>{children}</button>
  ),
}))

const DECISION_SHA = "a1b2c3d4".repeat(8)

function makeProjection(runId: string, artifactRefs = [
  { id: `decision-screenshot:${DECISION_SHA}`, sha: DECISION_SHA },
]): RunDetailProjection {
  return {
    runId,
    members: [{ testIndex: 0, name: "Screenshot test", attempts: 1 }],
    steps: [
      {
        testIndex: 0,
        stepIndex: 0,
        stepText: "Compare checkout screenshots",
        cacheStatus: "miss",
        verifierVerdict: { pass: true, reasoning: "the checkout screen is up" },
        selfHealOccurred: false,
        briefDigest: "d00",
        status: "passed",
        durationMs: 1000,
      },
    ],
    subActions: [
      {
        testIndex: 0,
        stepIndex: 0,
        subActionIndex: 0,
        plan: "Need to compare screenshots",
        plannedAction: { type: "click", ref: asRef("checkout") },
        result: { success: true },
        screenStateHash: "abcdef0123456789".repeat(4),
        artifactRefs,
      },
    ],
    tokens: { measuredSteps: 0, unmeasuredSteps: 1 },
  }
}

function makeRun(id: string, status = "passed") {
  return {
    id,
    name: "Screenshot run",
    filePath: "tests/screenshots.yaml",
    status,
    duration: 1000,
    tags: null,
    environment: null,
    metadata: null,
    startedAt: "2026-04-18T00:00:00.000Z",
    endedAt: "2026-04-18T00:00:01.000Z",
    source: "dashboard",
    failureSummary: null,
    errorLog: null,
    testId: null,
    suiteId: null,
    platform: "web",
    testFileContent: null,
    modelName: null,
    llmProvider: null,
    parallel: false,
    attemptNumber: 1,
    retryCount: 0,
    maxRetries: 0,
    createdAt: "2026-04-18T00:00:00.000Z",
  }
}

function LocationProbe() {
  const location = useLocation()
  return (
    <div
      data-testid="location"
      data-pathname={location.pathname}
      data-search={location.search}
    />
  )
}

let container: HTMLDivElement | null = null
let root: Root | null = null

function resetFavicon() {
  document.head.innerHTML = `<link rel="icon" type="image/svg+xml" href="${DEFAULT_FAVICON_HREF}">`
}

function getFaviconHref() {
  return document
    .querySelector<HTMLLinkElement>('link[rel="icon"][type="image/svg+xml"]')
    ?.getAttribute("href")
}

function expectDefaultFavicon() {
  expect(getFaviconHref()).toBe(DEFAULT_FAVICON_HREF)
}

function expectStatusFavicon() {
  expect(getFaviconHref()).toMatch(/^data:image\/svg\+xml,/)
}

async function flushRender() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function renderAt(url: string) {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)

  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route
            path="/runs/:id"
            element={
              <>
                <LocationProbe />
                <RunDetailPage />
              </>
            }
          />
        </Routes>
      </MemoryRouter>,
    )
  })

  await flushRender()
  return container
}

function screenshotSrc(view: HTMLElement) {
  return view.querySelector('[data-testid="screenshot-viewer"]')?.getAttribute("src") ?? ""
}

function expectSearchParams(
  location: HTMLElement,
  expected: Record<string, string | null>,
) {
  const params = new URLSearchParams(location.getAttribute("data-search") ?? "")
  for (const [key, value] of Object.entries(expected)) {
    expect(params.get(key)).toBe(value)
  }
}

beforeEach(() => {
  resetFavicon()
  document.title = ""
  fetchRunMock.mockReset()
  fetchRunDetailMock.mockReset()
  fetchRunArtifactMock.mockReset()
  fetchActiveExecutionsMock.mockReset()
  fetchExecutionLogsMock.mockReset()
  useKeyboardShortcutsMock.mockClear()

  fetchActiveExecutionsMock.mockResolvedValue({ executions: [] })
  fetchExecutionLogsMock.mockResolvedValue({ logs: [] })
  fetchRunArtifactMock.mockResolvedValue({ run: makeRun("run-1"), artifact: null, children: [], missingSections: ["artifact"] })
  fetchRunMock.mockImplementation(async (id: string) => ({ run: makeRun(id) }))
  fetchRunDetailMock.mockImplementation(async (id: string) => makeProjection(id))
})

afterEach(() => {
  vi.unstubAllGlobals()
  if (root) {
    act(() => root!.unmount())
  }
  root = null
  if (container) container.remove()
  container = null
  document.head.innerHTML = ""
  vi.clearAllMocks()
})

// The bus records one decision screenshot per sub-action, so there is no side to select and no key.
describe("RunDetailPage decision screenshot", () => {
  it("syncs the default selected step into the URL, by its member-scoped key, without repeated rewrites", async () => {
    const view = await renderAt("/runs/run-1")
    const location = view.querySelector('[data-testid="location"]') as HTMLElement

    expect(location.getAttribute("data-search")).toBe("?step=0%3A0&sub=0")

    await flushRender()

    expect(location.getAttribute("data-search")).toBe("?step=0%3A0&sub=0")
  })

  it("renders the selected sub-action's decision screenshot from its ref, through the one minter", async () => {
    const view = await renderAt("/runs/run-1?step=0:0&sub=0")
    const stepTree = view.querySelector('[data-testid="step-tree"]') as HTMLElement

    expect(stepTree.getAttribute("data-selection")).toBe("subaction:0:0:0")
    expect(view.querySelector('[data-artifact-state="available"]')).not.toBeNull()
    expect(screenshotSrc(view)).toBe(routes.runArtifact("run-1", DECISION_SHA))
  })

  it("renders a visible refusal, and no image, when the blob request fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 404 }))
    const view = await renderAt("/runs/run-1?step=0:0&sub=0")

    const image = view.querySelector("img")
    expect(image).not.toBeNull()

    await act(async () => {
      image!.dispatchEvent(new Event("error"))
    })

    expect(view.querySelector("img")).toBeNull()
    expect(
      view.querySelector('[data-artifact-state="unavailable"] [data-evidence-state="unavailable"][data-evidence-incomplete]'),
    ).not.toBeNull()
    expect(view.textContent).toContain(EVIDENCE_INCOMPLETE_LABEL)
  })

  it("shows no image at all for a turn that recorded no screenshot", async () => {
    fetchRunDetailMock.mockImplementation(async (id: string) => makeProjection(id, []))

    const view = await renderAt("/runs/run-1?step=0:0&sub=0")

    expect(view.querySelector("img")).toBeNull()
    expect(view.querySelector('[data-artifact-state="available"]')).toBeNull()
    expect(view.querySelector('[data-evidence-state="unavailable"][data-evidence-incomplete]')).toBeNull()
    expect(view.textContent).not.toContain(EVIDENCE_INCOMPLETE_LABEL)
  })

  // A retired key must be GONE, not silently rebound. A page that still answered `a` would be
  // doing something a reader has no way to predict.
  it("binds the source toggle without screenshot side-selection keys", async () => {
    await renderAt("/runs/run-1?step=0:0&sub=0")

    const bound = Object.keys(latestShortcuts())
    expect(bound).not.toContain("a")
    expect(bound).not.toContain("b")
    expect(bound).toContain("v")
  })

  it("keeps the selection and the URL untouched when the viewer is on another tab", async () => {
    const view = await renderAt("/runs/run-1?step=0:0&sub=0&tab=network")
    const location = view.querySelector('[data-testid="location"]') as HTMLElement
    const stepTree = view.querySelector('[data-testid="step-tree"]') as HTMLElement

    expectSearchParams(location, { step: "0:0", sub: "0", tab: "network" })
    expect(stepTree.getAttribute("data-selection")).toBe("subaction:0:0:0")
  })
})

describe("RunDetailPage favicon lifecycle", () => {
  it("keeps the default favicon while fetchRun is unresolved", async () => {
    fetchRunMock.mockReturnValue(new Promise(() => {}))

    await renderAt("/runs/run-loading")

    expectDefaultFavicon()
  })

  it.each(["passed", "failed", "cancelled"] as const)(
    "sets a non-default favicon for loaded %s runs",
    async (status) => {
      fetchRunMock.mockImplementation(async (id: string) => ({ run: makeRun(id, status) }))

      await renderAt(`/runs/run-${status}`)

      expectStatusFavicon()
    },
  )

  it("restores the default favicon on unmount", async () => {
    fetchRunMock.mockImplementation(async (id: string) => ({ run: makeRun(id, "failed") }))

    await renderAt("/runs/run-failed")

    expectStatusFavicon()

    act(() => root!.unmount())
    root = null

    expectDefaultFavicon()
  })
})
