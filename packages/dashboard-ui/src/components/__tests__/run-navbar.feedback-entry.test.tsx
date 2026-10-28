// @vitest-environment jsdom

// THE HEADER'S TEST-LEVEL FEEDBACK DOOR (426-03 · D-02, D-06, UI-SPEC S1).
//
// A separate file from run-navbar.test.tsx on purpose: the 425 mutation gate counts that file's
// cells as its 'ui-navbar' instrument (RESEARCH Pitfall 9). The harness is copied from it, except
// the tooltip, which is the real Radix primitive here — the entry's explanation must open on
// keyboard focus, and a passthrough mock would replace the one thing under test.

import { act, type ReactElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router"
import { afterEach, describe, expect, it, vi } from "vitest"

import { RunNavbar } from "@/components/run-detail/run-navbar"
import { TooltipProvider } from "@/components/ui/tooltip"
import {
  CHOICE_LABELS,
  FEEDBACK_ENTRY_MARKED_TOOLTIP,
  FEEDBACK_ENTRY_TOOLTIP,
  feedbackEntryLabel,
} from "@/lib/feedback-view"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock("@/lib/api", () => ({
  triggerRun: vi.fn(),
}))

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}))

vi.mock("@/components/id-badge", () => ({
  IdBadge: () => <div data-testid="id-badge">id-badge</div>,
}))

vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: ReactElement }) => <>{children}</>,
  PopoverTrigger: ({ children }: { children: ReactElement }) => children,
  PopoverContent: ({ children }: { children: ReactElement }) => <div>{children}</div>,
}))

let container: HTMLDivElement
let root: Root

function mount(el: ReactElement) {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root.render(
      <MemoryRouter>
        <TooltipProvider delayDuration={0}>{el}</TooltipProvider>
      </MemoryRouter>,
    )
  })
}

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  vi.clearAllMocks()
})

const baseRun = {
  id: "r_run-id",
  name: "Login run",
  filePath: "tests/login.yaml",
  status: "failed",
  duration: 1200,
  attributes: {
    "agent-qa.trigger": "cli",
    "agent-qa.runner": "local",
  },
  environment: null,
  metadata: null,
  startedAt: "2026-04-18T00:00:00.000Z",
  endedAt: "2026-04-18T00:00:01.200Z",
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
  createdAt: "2026-04-18T00:00:00.000Z",
}

const suiteRun = { ...baseRun, suiteId: "s_suite-id" }

function entryProps(marked = false, expanded = false) {
  return {
    label: feedbackEntryLabel({ scope: "test", ...(marked ? { markedChoice: "false-fail" as const } : {}) }),
    target: "0:run",
    marked,
    expanded,
    controls: "run-feedback-composer",
    onOpen: vi.fn(),
  }
}

function entries(): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>("[data-feedback-entry]")]
}

function glyph(entry: HTMLElement): SVGElement {
  const svg = entry.querySelector("svg")
  if (svg === null) throw new Error("the entry renders no glyph")
  return svg
}

function openTooltipText(): string {
  return [...document.querySelectorAll<HTMLElement>('[data-slot="tooltip-content"]')]
    .map(el => el.textContent ?? "")
    .join("|")
}

describe("426-03 the header's test-level feedback entry", () => {
  it("ENTRY-AFTER-BADGE: exactly one test entry, and it is the verdict badge's next sibling, for a test run and a suite run", () => {
    for (const run of [baseRun, suiteRun]) {
      mount(<RunNavbar run={run} shortcutsOpen={false} onToggleShortcuts={() => {}} feedbackEntry={entryProps()} />)
      const found = entries()
      expect(found).toHaveLength(1)
      expect(found[0]?.getAttribute("data-feedback-entry")).toBe("test")
      expect(found[0]?.previousElementSibling?.hasAttribute("data-verdict-badge")).toBe(true)
      act(() => { root.unmount() })
      container.remove()
      mount(<div />)
    }
  })

  it("ENTRY-ABSENT-WITHOUT-MARKS: no entry prop renders no entry and no disabled placeholder", () => {
    mount(<RunNavbar run={baseRun} shortcutsOpen={false} onToggleShortcuts={() => {}} />)
    expect(entries()).toHaveLength(0)
    const placeholders = [...container.querySelectorAll("button")].filter(button =>
      (button.getAttribute("aria-label") ?? "").startsWith("Give feedback"),
    )
    expect(placeholders).toHaveLength(0)
  })

  it("ENTRY-MARKED-FILLED: an unmarked target shows the plus glyph; a marked one the filled bubble and the marked name", () => {
    mount(<RunNavbar run={baseRun} shortcutsOpen={false} onToggleShortcuts={() => {}} feedbackEntry={entryProps(false)} />)
    const rest = entries()[0]!
    expect(glyph(rest).classList.contains("lucide-message-square-plus")).toBe(true)
    expect(rest.getAttribute("data-feedback-marked")).toBe("false")
    act(() => { root.unmount() })
    container.remove()

    mount(<RunNavbar run={baseRun} shortcutsOpen={false} onToggleShortcuts={() => {}} feedbackEntry={entryProps(true)} />)
    const marked = entries()[0]!
    const svg = glyph(marked)
    expect(svg.classList.contains("lucide-message-square")).toBe(true)
    expect(svg.classList.contains("lucide-message-square-plus")).toBe(false)
    expect(svg.classList.contains("fill-current")).toBe(true)
    expect(marked.getAttribute("data-feedback-marked")).toBe("true")
    expect(marked.getAttribute("aria-label")).toBe(
      feedbackEntryLabel({ scope: "test", markedChoice: "false-fail" }),
    )
    expect(marked.getAttribute("aria-label")?.endsWith(` — already marked: ${CHOICE_LABELS["false-fail"]}`)).toBe(true)
  })

  it("ENTRY-ARIA: controls the composer, reflects expanded, has no title, and explains itself on keyboard focus", async () => {
    mount(<RunNavbar run={baseRun} shortcutsOpen={false} onToggleShortcuts={() => {}} feedbackEntry={entryProps(false, true)} />)
    const entry = entries()[0]!
    expect(entry.getAttribute("aria-controls")).toBe("run-feedback-composer")
    expect(entry.getAttribute("aria-expanded")).toBe("true")
    expect(entry.hasAttribute("title")).toBe(false)
    expect(openTooltipText()).toBe("")
    await act(async () => { entry.focus() })
    expect(openTooltipText()).toContain(FEEDBACK_ENTRY_TOOLTIP)
    act(() => { root.unmount() })
    container.remove()

    mount(<RunNavbar run={baseRun} shortcutsOpen={false} onToggleShortcuts={() => {}} feedbackEntry={entryProps(true, false)} />)
    const marked = entries()[0]!
    expect(marked.getAttribute("aria-expanded")).toBe("false")
    await act(async () => { marked.focus() })
    expect(openTooltipText()).toContain(FEEDBACK_ENTRY_MARKED_TOOLTIP)
  })
})
