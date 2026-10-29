// @vitest-environment jsdom

// No durable row carries snapshot text, so the tab renders not-captured and requests nothing.

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"

import { TabAriaTree } from "@/components/run-detail/tab-aria-tree"
import { EVIDENCE_COPY } from '@/lib/evidence-state-view'
import { fromRunDetailStep } from "@/lib/display-step"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const fetchSpy = vi.fn()

vi.stubGlobal("fetch", fetchSpy)

let container: HTMLDivElement | null = null
let root: Root | null = null

const STEP = fromRunDetailStep(
  {
    testIndex: 0,
    stepIndex: 0,
    stepText: "Open login",
    cacheStatus: "miss",
    verifierVerdict: { pass: true, reasoning: "the login form is up" },
    selfHealOccurred: false,
    briefDigest: "d00",
    status: "passed",
    durationMs: 1000,
  },
  [],
)

async function renderTree() {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)

  await act(async () => {
    root!.render(<TabAriaTree step={STEP} />)
  })

  return container
}

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  container?.remove()
  container = null
  vi.clearAllMocks()
})

describe("TabAriaTree", () => {
  it("says no snapshot was captured, in its own words and in a readable posture", async () => {
    const view = await renderTree()

    expect(view.textContent).toContain(EVIDENCE_COPY.aria['no-selection'].title)
    expect(view.querySelector('[data-evidence-kind="aria"][data-evidence-state="no-selection"]')).not.toBeNull()
  })

  it("offers no before/after toggle over snapshots nothing recorded", async () => {
    const view = await renderTree()

    expect(view.querySelector("pre")).toBeNull()
    expect(Array.from(view.querySelectorAll("button")).map((b) => b.textContent)).toEqual([])
  })

  // The teeth: an absence rendered after a request is a different (and worse) thing than an
  // absence that costs nothing to state.
  it("asks nobody for a snapshot that has no producer", async () => {
    await renderTree()

    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
