// @vitest-environment jsdom
//
// THE RUN BUTTON, WITH NO DIALOG (432-14, D-14; formerly the run trigger's dialog, Phase 401 plan 09).
//
// RE-SPELLED 2026-10-01. This file pinned what a person was offered when a run asked for approval:
// three answers and no fourth, the action's own disclosure beside them, and a denial that read as a
// denial. Phase 432 deletes the question, the dialog, the channel the page held open to be asked on,
// and the mark approval the composer rendered from the same frames. What survives is the one claim
// those cells existed to protect — a click does exactly what the person asked — now measured as the
// absence of everything that stood between the click and the run.
//
// AN INTEGRATION CELL, ON PURPOSE. The shipped app shell is mounted with its real overlays, over the
// real API client (`@/lib/api` is NOT mocked except for the app-metadata read), with `fetch` and
// `EventSource` captured. A page whose Run button is wired to the client's own `triggerRun` stands
// in for the nine run doors, which all funnel through that one function. So the assertions are
// about what the browser would actually send and open, not about a component in isolation.

import { readFileSync } from "node:fs"
import { resolve as resolvePath } from "node:path"

import { act, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const harness = vi.hoisted(() => ({
  eventSources: [] as string[],
  requests: [] as { url: string; method: string; body: unknown }[],
}))

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, fetchAppMetadata: vi.fn(async () => ({ version: "0.1.18" })) }
})

// The Run door every page funnels through, rendered with the REAL client function.
vi.mock("@/pages/tests", async () => {
  const { triggerRun, markRun } = await import("@/lib/api")
  return {
    default: () => (
      <div data-testid="tests-page">
        <button type="button" data-run-button onClick={() => { void triggerRun({ file: "tests/a.yaml" }) }}>
          Run
        </button>
        <button
          type="button"
          data-mark-button
          onClick={() => { void markRun("run_432_14", { kind: "false-fail", note: "one submit" }) }}
        >
          Send feedback
        </button>
      </div>
    ),
  }
})
for (const page of [
  "runs", "hooks", "suites", "config", "run-detail", "live-run", "test-editor", "test-viewer",
  "hook-editor", "hook-viewer", "suite-editor", "suite-viewer", "insights",
]) {
  vi.doMock(`@/pages/${page}`, () => ({ default: () => <div data-testid={`${page}-page`} /> }))
}
vi.mock("@/components/theme-provider", () => ({
  ThemeProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}))
vi.mock("@/components/ui/sidebar", () => ({
  SidebarProvider: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SidebarInset: ({ children }: { children: ReactNode }) => <section>{children}</section>,
}))
vi.mock("@/components/app-sidebar", () => ({ AppSidebar: () => <aside data-testid="app-sidebar" /> }))
vi.mock("@/components/mobile-navigation-trigger", () => ({ MobileNavigationTrigger: () => null }))
vi.mock("@/components/command-palette", () => ({ CommandPalette: () => null }))
vi.mock("@/components/ui/sonner", () => ({ Toaster: () => null }))
vi.mock("@/components/error-boundary", () => ({ RouteErrorBoundary: () => null }))

const READY = { service: "up", hostComposed: true, contractVersion: 2 }

let container: HTMLDivElement | null = null
let root: Root | null = null
let originalFetch: typeof fetch

beforeEach(() => {
  harness.eventSources = []
  harness.requests = []
  originalFetch = globalThis.fetch
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    harness.requests.push({
      url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    })
    const body = url.includes("/api/run-readiness")
      ? READY
      : url.includes("/api/runs/trigger")
        ? { runId: "run_432_14", status: "queued" }
        : url.endsWith("/mark")
          ? { kind: "run-not-found", runId: "run_432_14" }
          : {}
    return { ok: true, status: 200, statusText: "OK", json: async () => body } as unknown as Response
  }) as unknown as typeof fetch
  // A CAPTURING CONSTRUCTOR, so any stream the shell opens is recorded rather than skipped by a
  // `typeof EventSource === "undefined"` guard.
  ;(globalThis as { EventSource?: unknown }).EventSource = class {
    constructor(url: string) { harness.eventSources.push(String(url)) }
    addEventListener(): void {}
    close(): void {}
  }
})

afterEach(() => {
  act(() => { root?.unmount() })
  container?.remove()
  container = null
  root = null
  globalThis.fetch = originalFetch
  delete (globalThis as { EventSource?: unknown }).EventSource
})

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 6; i += 1) await Promise.resolve()
  })
}

async function renderShellAt(path: string): Promise<HTMLDivElement> {
  vi.resetModules()
  window.history.pushState({}, "", path)
  const { default: App } = await import("@/app")
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => { root?.render(<App />) })
  await flush()
  await vi.waitFor(() => { expect(document.querySelector("[data-run-button]")).not.toBeNull() })
  return container
}

// The first-visit product tour is a dialog too, and it is not an approval: a dialog counts here only
// when it asks for one. The retired components' own data attributes count wherever they appear.
function approvalSurfaces(): Element[] {
  const marked = Array.from(document.querySelectorAll(
    '[data-run-confirm-dialog], [data-feedback-approval], [data-confirm-answer], [data-confirm-id]',
  ))
  const asking = Array.from(document.querySelectorAll('[role="dialog"], [role="group"], [aria-modal="true"]'))
    .filter((element) => /approv/i.test(`${element.getAttribute("aria-label") ?? ""} ${element.textContent ?? ""}`))
  return [...marked, ...asking]
}

describe("the Run button starts a run in one request, with no dialog (432-14)", () => {
  it("C432-NO-APPROVAL-DIALOG: the shell opens no confirm channel, and one click is one trigger request", async () => {
    await renderShellAt("/tests")
    expect(
      harness.eventSources.filter((url) => url.includes("run-confirm")),
      "the app shell still holds a channel to be asked on",
    ).toEqual([])

    await act(async () => { document.querySelector<HTMLButtonElement>("[data-run-button]")!.click() })
    await vi.waitFor(() => {
      expect(harness.requests.some((request) => request.url.includes("/api/runs/trigger"))).toBe(true)
    })
    await flush()

    const triggers = harness.requests.filter((request) => request.url.includes("/api/runs/trigger"))
    expect(triggers).toHaveLength(1)
    expect(triggers[0]).toMatchObject({ method: "POST" })
    expect(triggers[0]!.body).toEqual({ file: "tests/a.yaml" })
    expect(harness.requests.some((request) => request.url.includes("run-confirm"))).toBe(false)
    expect(approvalSurfaces(), "an approval surface rendered after the click").toEqual([])
  })

  it("C432-NO-APPROVAL-DIALOG: one feedback submit is one mark request carrying the body as written", async () => {
    await renderShellAt("/tests")
    await act(async () => { document.querySelector<HTMLButtonElement>("[data-mark-button]")!.click() })
    await vi.waitFor(() => {
      expect(harness.requests.some((request) => request.url.endsWith("/mark"))).toBe(true)
    })
    await flush()

    const marks = harness.requests.filter((request) => request.url.endsWith("/mark"))
    expect(marks).toHaveLength(1)
    expect(marks[0]!.url).toContain("/api/runs/run_432_14/mark")
    expect(marks[0]!.body).toEqual({ kind: "false-fail", note: "one submit" })
    expect(approvalSurfaces()).toEqual([])
  })

  it("C432-NO-APPROVAL-DIALOG: the shell and the composer ship no approval component", () => {
    const src = (path: string) => readFileSync(resolvePath(__dirname, path), "utf8")
    const shell = src("../../app.tsx")
    expect(shell).not.toContain("RunConfirm" + "Host")
    expect(shell).not.toContain("run-confirm" + "-dialog")
    const composer = src("../run-detail/feedback-composer.tsx")
    expect(composer).not.toContain("Feedback" + "Approval")
    expect(composer).not.toContain("awaiting-" + "approval")
  })
})
