// @vitest-environment jsdom

// Amber, never red: a degraded rung is reached by design, so red vocabulary is asserted absent.

import { act, type ReactElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router"
import { afterEach, describe, expect, it, vi } from "vitest"

import { RetrievalRungBanner } from "@/components/run-detail/retrieval-rung-banner"
import { RunNavbar } from "@/components/run-detail/run-navbar"
import { rungBannerText } from "@/lib/knowledge-view"
import type { RunRow } from "@/lib/api"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

let root: Root | undefined
let container: HTMLDivElement | undefined

afterEach(() => {
  if (root !== undefined) act(() => { root?.unmount() })
  container?.remove()
  root = undefined
  container = undefined
})

function mount(element: ReactElement): HTMLElement {
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
  act(() => { root?.render(element) })
  return container
}

const banner = (host: HTMLElement) => host.querySelector<HTMLElement>("[data-rung-banner]")

/** The sentence of record, taken from the module that owns it so feed and assertion cannot drift. */
const FLOOR_SENTENCE = rungBannerText({ rung: "static-floor", reason: "native-runtime-unavailable" })
const CORRUPT_SENTENCE = rungBannerText({ rung: "bundle-scan", reason: "index-corrupt" })

function glyphClass(el: Element | null | undefined): string {
  return [...(el?.querySelector("svg")?.classList ?? [])].find(name => name.startsWith("lucide-")) ?? ""
}

function runRow(): RunRow {
  return {
    id: "r_rung_header",
    name: "a header probe",
    filePath: "tests/probe.test.yaml",
    status: "passed",
    duration: 1000,
    attributes: {},
    environment: null,
    metadata: null,
    startedAt: null,
    endedAt: null,
    failureSummary: null,
    errorLog: null,
    testId: null,
    suiteId: null,
    platform: "web",
    testFileContent: null,
    modelName: null,
    llmProvider: null,
    attemptNumber: 1,
    retryCount: 0,
    maxRetries: 0,
    createdAt: "2026-08-29T00:00:00.000Z",
  }
}

describe("the top rung and the unknown rung render NOTHING", () => {
  it("renders no element at all for `memidex`", () => {
    const host = mount(<RetrievalRungBanner rung="memidex" />)
    expect(banner(host)).toBeNull()
    expect(host.textContent).toBe("")
  })

  it("renders no element at all when no rung is known yet", () => {
    const host = mount(<RetrievalRungBanner />)
    expect(banner(host)).toBeNull()
    expect(host.textContent).toBe("")
  })
})

describe("only a warning class paints the strip, with its statement and the doctor pointer", () => {
  it("WARNING-STRIP-WITH-POINTER: a corrupt index carries the DOM contract, its class glyph and the sentence of record", () => {
    const host = mount(<RetrievalRungBanner rung="bundle-scan" reason="index-corrupt" />)
    const el = banner(host)
    expect(el).not.toBeNull()
    expect(el?.getAttribute("data-rung")).toBe("bundle-scan")
    expect(el?.getAttribute("data-rung-reason")).toBe("index-corrupt")
    expect(el?.getAttribute("data-retrieval-class")).toBe("index-problem")
    // `status`, never `alert`: it informs about a run and does not interrupt.
    expect(el?.getAttribute("role")).toBe("status")
    expect(el?.getAttribute("class")).toContain("py-1.5")
    expect(el?.getAttribute("class")).toContain("bg-amber-500/5")
    expect(glyphClass(el)).toBe("lucide-triangle-alert")
    // BYTE-EQUAL including the `code` element around the command: the DOM cells read `textContent`,
    // so an element split that inserted or dropped a space would be a silent copy change.
    expect(CORRUPT_SENTENCE).toBeDefined()
    expect(el?.textContent).toBe(CORRUPT_SENTENCE)
    expect(el?.getAttribute("title")).toBe(CORRUPT_SENTENCE)
    expect(el?.querySelector("code")?.textContent).toBe("agent-qa doctor")
    expect(el?.textContent).not.toContain("`")
  })

  it("BOOTSTRAP-NOT-IN-STRIP: both variants paint nothing for a fresh index, an unrecorded cause or a configured level", () => {
    const cases = [
      ["bundle-scan", "index-not-built"],
      ["bundle-scan", "index-unavailable"],
      ["static-floor", "profile-static-configured"],
      ["lexical-only", "floor-disabled"],
    ] as const
    for (const [rung, reason] of cases) {
      for (const variant of ["navbar", "live"] as const) {
        const host = mount(<RetrievalRungBanner variant={variant} rung={rung} reason={reason} />)
        expect(banner(host)).toBeNull()
        expect(host.textContent).toBe("")
        act(() => { root?.unmount() })
        container?.remove()
        root = undefined
      }
    }
  })

  it("BOOTSTRAP-NOT-IN-STRIP: a degraded rung that recorded no cause paints no strip either", () => {
    const host = mount(<RetrievalRungBanner rung="lexical-only" />)
    expect(banner(host)).toBeNull()
    expect(host.textContent).toBe("")
  })
})

describe("the tint is amber, and it is never red", () => {
  it("paints the class glyph amber in the navbar variant", () => {
    const host = mount(<RetrievalRungBanner rung="static-floor" reason="native-runtime-unavailable" />)
    const icon = banner(host)?.querySelector("svg")
    expect(icon).not.toBeNull()
    expect(glyphClass(banner(host))).toBe("lucide-search-x")
    expect(icon?.getAttribute("class")).toContain("text-amber-500")
    expect(icon?.getAttribute("aria-hidden")).toBe("true")
  })

  it("carries no red or destructive class anywhere in the rendered subtree", () => {
    const host = mount(<RetrievalRungBanner rung="lexical-only" reason="model-not-downloaded" />)
    expect(banner(host)).not.toBeNull()
    for (const el of host.querySelectorAll("*")) {
      expect(el.getAttribute("class") ?? "").not.toMatch(/destructive|red-\d/)
    }
  })
})

describe("two variants, one sentence", () => {
  it("the live variant is a `p` in the meta strip's idiom — amber text, no icon", () => {
    const host = mount(
      <RetrievalRungBanner variant="live" rung="static-floor" reason="native-runtime-unavailable" />,
    )
    const el = banner(host)
    expect(el?.tagName).toBe("P")
    expect(el?.getAttribute("class")).toContain("text-amber-500")
    // No icon: it sits among `data-gap-marker` and `data-run-notice` siblings, which carry none.
    expect(el?.querySelector("svg")).toBeNull()
    expect(el?.textContent).toBe(FLOOR_SENTENCE)
  })

  it("the navbar variant is a full-width strip row, not an inline chip", () => {
    const host = mount(<RetrievalRungBanner rung="static-floor" reason="native-runtime-unavailable" />)
    const el = banner(host)
    expect(el?.tagName).toBe("DIV")
    // 28px: 6 + 16 + 6. The header block never grows past the 56px navbar plus this row.
    expect(el?.getAttribute("class")).toContain("py-1.5")
    // The sentence truncates INSIDE the fixed row; the whole of it stays in the wrapper's `title`.
    expect(el?.querySelector(".truncate")).not.toBeNull()
  })

  it("WARNING-STRIP-WITH-POINTER: both variants render the SAME sentence and class for unavailable semantic search", () => {
    const navbarHost = mount(<RetrievalRungBanner rung="static-floor" reason="native-runtime-unavailable" />)
    const navbar = banner(navbarHost)
    expect(navbar?.getAttribute("data-retrieval-class")).toBe("semantic-search-unavailable")
    expect(glyphClass(navbar)).toBe("lucide-search-x")
    const navbarText = navbar?.textContent
    expect(navbarText).toBe(FLOOR_SENTENCE)
    act(() => { root?.unmount() })
    container?.remove()
    const liveHost = mount(<RetrievalRungBanner variant="live" rung="static-floor" reason="native-runtime-unavailable" />)
    expect(banner(liveHost)?.getAttribute("data-retrieval-class")).toBe("semantic-search-unavailable")
    expect(banner(liveHost)?.textContent).toBe(navbarText)
  })
})

describe("the run header wires it as a second row, once", () => {
  it("renders EXACTLY ONE banner when the durable read carried a warning-class rung", () => {
    const host = mount(
      <MemoryRouter>
        <RunNavbar
          run={runRow()}
          shortcutsOpen={false}
          onToggleShortcuts={() => {}}
          retrievalRung={{ schemaVersion: 2, rung: "bundle-scan", reason: "index-locked" }}
        />
      </MemoryRouter>,
    )
    expect(host.querySelectorAll("[data-rung-banner]")).toHaveLength(1)
    expect(host.querySelector("[data-rung-banner]")?.getAttribute("data-rung")).toBe("bundle-scan")
    // The verdict badge is still painted exactly once — the second row is an ADDITION.
    expect(host.querySelectorAll("[data-verdict-badge]")).toHaveLength(1)
  })

  it("renders no banner at all when the header was handed no rung", () => {
    const host = mount(
      <MemoryRouter>
        <RunNavbar run={runRow()} shortcutsOpen={false} onToggleShortcuts={() => {}} />
      </MemoryRouter>,
    )
    expect(host.querySelectorAll("[data-rung-banner]")).toHaveLength(0)
    expect(host.querySelectorAll("[data-verdict-badge]")).toHaveLength(1)
  })

  it("NO OTHER ELEMENT in the header carries `data-rung` (UI-SPEC DOM contract)", () => {
    const host = mount(
      <MemoryRouter>
        <RunNavbar
          run={runRow()}
          shortcutsOpen={false}
          onToggleShortcuts={() => {}}
          retrievalRung={{ schemaVersion: 2, rung: "static-floor", reason: "native-runtime-unavailable" }}
        />
      </MemoryRouter>,
    )
    const carriers = [...host.querySelectorAll("[data-rung]")]
    expect(carriers).toHaveLength(1)
    expect(carriers[0]?.hasAttribute("data-rung-banner")).toBe(true)
  })

  it("renders no banner for a run served on the top rung", () => {
    const host = mount(
      <MemoryRouter>
        <RunNavbar
          run={runRow()}
          shortcutsOpen={false}
          onToggleShortcuts={() => {}}
          retrievalRung={{ schemaVersion: 2, rung: "memidex" }}
        />
      </MemoryRouter>,
    )
    expect(host.querySelectorAll("[data-rung-banner]")).toHaveLength(0)
  })
})
