// @vitest-environment jsdom

import { act, type ReactElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router"
import { afterEach, describe, expect, it, vi } from "vitest"

import { RunNavbar } from "@/components/run-detail/run-navbar"
import { triggerRun } from "@/lib/api"
import {
  TOKENS_NOT_MEASURED_LABEL,
  TOKEN_USAGE_TRIGGER_LABEL,
  tokenPairLine,
  usageCoverageLine,
  usageTotalsLine,
} from "@/lib/run-detail-view"
import { formatDuration } from "@/lib/utils"

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

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactElement }) => children,
  TooltipTrigger: ({ children }: { children: ReactElement }) => children,
  TooltipContent: ({ children }: { children: ReactElement }) => <>{children}</>,
}))

vi.mock("@/components/ui/popover", async () => {
  const React = await vi.importActual<typeof import("react")>("react")
  let latestOpen = false
  let latestOnOpenChange: ((open: boolean) => void) | undefined

  return {
    Popover: ({
      children,
      open,
      onOpenChange,
    }: {
      children: ReactElement
      open?: boolean
      onOpenChange?: (open: boolean) => void
    }) => {
      latestOpen = Boolean(open)
      latestOnOpenChange = onOpenChange
      return <>{children}</>
    },
    PopoverTrigger: ({ children }: { children: ReactElement }) => {
      if (!React.isValidElement(children)) return children
      const existingOnClick = (children.props as { onClick?: (event: unknown) => void }).onClick
      return React.cloneElement(children, {
        onClick: (event: unknown) => {
          existingOnClick?.(event)
          latestOnOpenChange?.(!latestOpen)
        },
      } as Record<string, unknown>)
    },
    PopoverContent: ({ children }: { children: ReactElement }) => <div>{children}</div>,
  }
})

let container: HTMLDivElement
let root: Root

function mount(el: ReactElement) {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root.render(<MemoryRouter>{el}</MemoryRouter>)
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
  status: "passed",
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

// The header is addressed by position because layout has no `data-*` of its own to hang off.
function headerBlock(): HTMLElement {
  return container.firstElementChild as HTMLElement
}

function headerRow(): HTMLElement {
  return headerBlock().firstElementChild as HTMLElement
}

// Walks the header once and labels what it meets; first matcher wins and each label is taken once.
const HEADER_ITEM_MATCHERS: ReadonlyArray<readonly [string, (el: Element) => boolean]> = [
  ["breadcrumb", el => el.tagName === "BUTTON" && el.textContent === "Runs"],
  ["name", el => el.tagName === "SPAN" && el.hasAttribute("title")],
  ["source", el => el.tagName === "A" && (el.getAttribute("aria-label") ?? "").startsWith("Open ")],
  ["verdict", el => el.hasAttribute("data-verdict-badge")],
  ["indicators", el => el.hasAttribute("data-chips-state")],
  ["tokens", el => el.hasAttribute("data-run-token-summary")],
  ["duration", el => el.hasAttribute("data-run-duration")],
  ["separator", el => el.tagName === "DIV" && el.className === "h-4 w-px bg-border"],
  ["artifacts", el => el.getAttribute("aria-label") === "Open run artifacts"],
  ["shortcuts", el => el.getAttribute("aria-label") === "Keyboard shortcuts"],
  ["rerun", el => el.getAttribute("aria-label") === "Re-run"],
]

/** What a SIGHTED reader sees on a root — the `sr-only` name is a separate claim, asserted apart. */
function visibleTextOf(el: HTMLElement): string {
  return [...el.childNodes]
    .filter(node => !(node instanceof HTMLElement && node.classList.contains("sr-only")))
    .map(node => node.textContent ?? "")
    .join("")
}

function headerOrder(root: HTMLElement): string[] {
  const seen: string[] = []
  for (const el of Array.from(root.querySelectorAll("*"))) {
    for (const [label, matches] of HEADER_ITEM_MATCHERS) {
      if (seen.includes(label)) continue
      if (matches(el)) {
        seen.push(label)
        break
      }
    }
  }
  return seen
}

describe("RunNavbar", () => {
  it("links test runs to the canonical test page in a new tab without showing ids", () => {
    mount(
      <RunNavbar
        run={{ ...baseRun, testId: "t_login", name: "Test run" }}
        shortcutsOpen={false}
        onToggleShortcuts={() => {}}
      />,
    )

    const link = container.querySelector('a[aria-label="Open test"]') as HTMLAnchorElement | null
    expect(link).not.toBeNull()
    expect(link?.getAttribute("href")).toBe("/test/t_login")
    expect(link?.getAttribute("target")).toBe("_blank")
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer")
    expect(container.querySelector('[data-testid="id-badge"]')).toBeNull()
    expect(container.textContent).not.toContain("t_login")
  })

  it("links suite runs to the canonical suite page in a new tab", () => {
    mount(
      <RunNavbar
        run={{ ...baseRun, suiteId: "s_smoke", name: "Suite run" }}
        shortcutsOpen={false}
        onToggleShortcuts={() => {}}
      />,
    )

    const link = container.querySelector('a[aria-label="Open suite"]') as HTMLAnchorElement | null
    expect(link).not.toBeNull()
    expect(link?.getAttribute("href")).toBe("/suite/s_smoke")
    expect(link?.getAttribute("target")).toBe("_blank")
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer")
    expect(container.textContent).not.toContain("s_smoke")
  })

  it("omits the source arrow when no test or suite id is available", () => {
    mount(
      <RunNavbar
        run={{ ...baseRun, name: "Detached run" }}
        shortcutsOpen={false}
        onToggleShortcuts={() => {}}
      />,
    )

    expect(container.querySelector('a[aria-label="Open test"]')).toBeNull()
    expect(container.querySelector('a[aria-label="Open suite"]')).toBeNull()
  })

  // The bus records one decision screenshot per turn, so the legend offers no side selection.
  it("documents the keys that exist, and advertises no side-selection the page cannot honour", () => {
    mount(
      <RunNavbar
        run={{ ...baseRun, name: "Screenshot run" }}
        shortcutsOpen={true}
        onToggleShortcuts={() => {}}
      />,
    )

    expect(container.textContent).toContain("Details: Attributes")
    expect(container.textContent).toContain("Artifacts: Config")
    // `M` opens the Knowledge tab, and the legend says so.
    expect(container.textContent).toContain("Knowledge tab")
    expect(container.textContent).not.toContain("Artifacts: Memory")
    expect(container.textContent).toContain("Shift+?")
    expect(container.textContent).not.toContain("Before screenshot")
    expect(container.textContent).not.toContain("After screenshot")
  })

  it("lists the source shortcut without restoring the retired recording link", () => {
    mount(
      <RunNavbar
        run={baseRun}
        shortcutsOpen
        onToggleShortcuts={() => {}}
      />,
    )

    expect(container.querySelector('a[aria-label="Open recording"]')).toBeNull()
    expect(container.querySelectorAll('a[href^="/api/videos/"]')).toHaveLength(0)
    expect(container.textContent).toContain("Frames / Video")
  })

  // The projection's sum separates an unmeasured run from one that spent nothing.
  it("says tokens were not measured rather than rendering nothing for an unmeasured run", () => {
    mount(
      <RunNavbar
        run={baseRun}
        tokens={{ measuredSteps: 0, unmeasuredSteps: 3 }}
        shortcutsOpen={false}
        onToggleShortcuts={() => {}}
      />,
    )

    const line = container.querySelector('[data-run-token-summary]')
    expect(line?.textContent).toContain(TOKENS_NOT_MEASURED_LABEL)
  })

  // Coverage lives in the card; the tooltip mock passes through, so card lines render inline.
  it("NO-HEADER-COVERAGE: the header says in and out, never how much of the run was measured", () => {
    const tokens = {
      measuredSteps: 2,
      unmeasuredSteps: 1,
      promptTokens: 103074,
      completionTokens: 456,
      totalTokens: 103530,
    }
    mount(
      <RunNavbar
        run={baseRun}
        tokens={tokens}
        shortcutsOpen={false}
        onToggleShortcuts={() => {}}
      />,
    )

    const line = container.querySelector("[data-run-token-summary]") as HTMLElement | null
    expect(line).not.toBeNull()
    expect(visibleTextOf(line!)).toBe(tokenPairLine(tokens))
    expect(line!.textContent).not.toMatch(/of \d+ steps/)
    expect(line!.textContent).not.toContain(TOKENS_NOT_MEASURED_LABEL)

    expect(container.querySelector('[data-usage-line="coverage"]')?.textContent).toBe(
      usageCoverageLine(tokens),
    )
  })

  // The card is all there is to see, so the root is a focusable `span` with an `sr-only` name.
  it("TOKEN-USAGE-TRIGGER: the token line is a focusable span with an sr-only name, never a button", () => {
    const tokens = {
      measuredSteps: 3,
      unmeasuredSteps: 0,
      promptTokens: 103074,
      completionTokens: 456,
      totalTokens: 103530,
    }
    mount(
      <RunNavbar
        run={baseRun}
        tokens={tokens}
        shortcutsOpen={false}
        onToggleShortcuts={() => {}}
      />,
    )

    const line = container.querySelector("[data-run-token-summary]") as HTMLElement | null
    expect(line?.tagName).toBe("SPAN")
    expect(line?.getAttribute("tabindex")).toBe("0")
    expect(line?.querySelector(".sr-only")?.textContent).toBe(TOKEN_USAGE_TRIGGER_LABEL)
    expect(container.querySelector("button[data-run-token-summary]")).toBeNull()

    expect(container.querySelector('[data-usage-line="totals"]')?.textContent).toBe(
      usageTotalsLine(tokens),
    )
    // A fully measured run states no coverage anywhere, card included.
    expect(container.querySelector('[data-usage-line="coverage"]')).toBeNull()
  })

  it("TOKEN-USAGE-MODELS: the summary the page hands down is what names the model", () => {
    const models = { declared: [{ provider: "openai", modelId: "gpt-5.6-terra", stepCount: 3 }] }
    mount(
      <RunNavbar
        run={baseRun}
        tokens={{
          measuredSteps: 3,
          unmeasuredSteps: 0,
          promptTokens: 103074,
          completionTokens: 456,
          totalTokens: 103530,
        }}
        models={models}
        shortcutsOpen={false}
        onToggleShortcuts={() => {}}
      />,
    )

    expect(container.querySelector('[data-usage-line="model"]')?.textContent).toBe(
      "Model gpt-5.6-terra (openai)",
    )
  })

  // `run.modelName` and `run.llmProvider` describe the host's config, not who answered this run.
  it("NO-HEADER-MODEL-ITEM: the run row's legacy model fields reach nothing in the header", () => {
    mount(
      <RunNavbar
        run={{ ...baseRun, modelName: "gpt-5.6-terra", llmProvider: "openai" }}
        shortcutsOpen={false}
        onToggleShortcuts={() => {}}
      />,
    )

    expect(container.textContent).not.toContain("gpt-5.6-terra")
    expect(container.textContent).not.toContain("openai")
    expect(container.querySelector("svg.lucide-brain")).toBeNull()
  })

  it("renders no token line at all while the durable read has not landed", () => {
    mount(
      <RunNavbar run={baseRun} shortcutsOpen={false} onToggleShortcuts={() => {}} />,
    )

    expect(container.querySelector('[data-run-token-summary]')).toBeNull()
  })

  // jsdom has no Tailwind, so the cell reads classes that survived tailwind-merge.
  it("BADGE-DOMINANT: the verdict badge is the header's one enlarged, filled element", () => {
    mount(
      <RunNavbar run={baseRun} shortcutsOpen={false} onToggleShortcuts={() => {}} />,
    )

    const badges = container.querySelectorAll("[data-verdict-badge]")
    expect(badges).toHaveLength(1)

    const badge = badges[0] as HTMLElement
    expect(badge.getAttribute("data-verdict-badge")).toBe("passed")

    const classes = badge.className.split(/\s+/)
    expect(classes).toContain("text-sm")
    expect(classes).toContain("font-medium")
    expect(classes).toContain("py-1")
    expect(classes).not.toContain("text-xs")
    expect(classes).not.toContain("py-0.5")
  })

  it("BADGE-TIMEOUT-ARM: a timed-out run's badge reads Timed out over the raw status word", () => {
    mount(
      <RunNavbar
        run={{ ...baseRun, status: "timeout" }}
        shortcutsOpen={false}
        onToggleShortcuts={() => {}}
      />,
    )

    const badge = container.querySelector("[data-verdict-badge]")
    expect(badge?.getAttribute("data-verdict-badge")).toBe("timeout")
    expect(badge?.textContent).toBe("Timed out")
  })

  // A container query, so ~400px and 1280px at 200% zoom both stack with one rule.
  it("HEADER-STACKS: the header is a container-query block that stacks into two rows and keeps every action", () => {
    mount(
      <RunNavbar
        run={baseRun}
        shortcutsOpen={false}
        onToggleShortcuts={() => {}}
      />,
    )

    expect(headerBlock().className.split(/\s+/)).toContain("@container")

    const row = headerRow().className.split(/\s+/)
    expect(row).toContain("min-h-14")
    expect(row).toContain("flex-col")
    expect(row).toContain("@5xl:flex-row")
    expect(row).toContain("@5xl:items-center")
    expect(row).toContain("@5xl:justify-between")
    expect(row).not.toContain("h-14")

    const cluster = container.querySelector(".ml-auto") as HTMLElement | null
    expect(cluster).not.toBeNull()
    expect(cluster?.querySelector('button[aria-label="Open run artifacts"]')).not.toBeNull()
    expect(cluster?.querySelector('button[aria-label="Keyboard shortcuts"]')).not.toBeNull()
    expect(cluster?.querySelector('button[aria-label="Re-run"]')).not.toBeNull()
  })

  // The name is the only flexible item, so it truncates first and keeps its full text in `title`.
  it("HEADER-NAME-TRUNCATES: the name is the one flexible item and keeps its full text in title", () => {
    const longName = "L".repeat(200)
    mount(
      <RunNavbar
        run={{ ...baseRun, name: longName }}
        shortcutsOpen={false}
        onToggleShortcuts={() => {}}
      />,
    )

    const name = container.querySelector("span[title]") as HTMLElement | null
    expect(name).not.toBeNull()
    expect(name?.getAttribute("title")).toBe(longName)
    expect(name?.textContent).toBe(longName)

    const classes = name!.className.split(/\s+/)
    expect(classes).toContain("truncate")
    expect(classes).toContain("min-w-[96px]")

    const badge = container.querySelector("[data-verdict-badge]")
    expect(badge).not.toBeNull()
    expect(
      name!.compareDocumentPosition(badge!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it("HEADER-DURATION-HOOK: the duration span is addressable and reads the shipped formatter", () => {
    mount(
      <RunNavbar run={baseRun} shortcutsOpen={false} onToggleShortcuts={() => {}} />,
    )

    const duration = container.querySelector("[data-run-duration]")
    expect(duration).not.toBeNull()
    expect(duration?.textContent).toContain(formatDuration(baseRun.duration))
  })

  // Order is read over two prop sets, so dropping an item cannot silently permute the rest.
  it("HEADER-ORDER-FIXED: the DOM order of the present header items is fixed across prop sets", () => {
    mount(
      <RunNavbar
        run={{
          ...baseRun,
          testId: "t_login",
        }}
        tokens={{ measuredSteps: 2, unmeasuredSteps: 0, promptTokens: 900, completionTokens: 100, totalTokens: 1000 }}
        hasPostProcessing
        shortcutsOpen={false}
        onToggleShortcuts={() => {}}
      />,
    )

    expect(headerOrder(headerBlock())).toEqual([
      "breadcrumb",
      "name",
      "source",
      "verdict",
      "indicators",
      "tokens",
      "duration",
      "separator",
      "artifacts",
      "shortcuts",
      "rerun",
    ])

    act(() => {
      root.unmount()
    })
    container.remove()

    mount(
      <RunNavbar run={baseRun} shortcutsOpen={false} onToggleShortcuts={() => {}} />,
    )

    expect(headerOrder(headerBlock())).toEqual([
      "breadcrumb",
      "name",
      "verdict",
      "duration",
      "separator",
      "artifacts",
      "shortcuts",
      "rerun",
    ])
  })

  // The only empty HTML leaf allowed is the rule between meta and actions; SVG icons are excluded.
  it("HEADER-EMPTY-META: an unmeasured, unwired run renders no empty element", () => {
    mount(
      <RunNavbar run={baseRun} shortcutsOpen={false} onToggleShortcuts={() => {}} />,
    )

    expect(container.querySelector("[data-verdict-badge]")).not.toBeNull()
    expect(container.querySelector("[data-run-duration]")).not.toBeNull()
    expect(container.querySelectorAll("button[aria-label]")).toHaveLength(3)
    expect(container.querySelector("[data-run-token-summary]")).toBeNull()
    expect(container.querySelector("[data-chips-state]")).toBeNull()

    const emptyLeaves = Array.from(headerBlock().querySelectorAll("*")).filter(
      el =>
        el.namespaceURI === "http://www.w3.org/1999/xhtml" &&
        el.children.length === 0 &&
        (el.textContent ?? "").trim() === "",
    )
    expect(emptyLeaves.map(el => el.className)).toEqual(["h-4 w-px bg-border"])
  })

  it("opens run details on the Test tab from the navbar action", () => {
    const onOpenArtifacts = vi.fn()
    mount(
      <RunNavbar
        run={{ ...baseRun, name: "Artifact run" }}
        shortcutsOpen={false}
        onToggleShortcuts={() => {}}
        onOpenArtifacts={onOpenArtifacts}
      />,
    )

    const trigger = container.querySelector('button[aria-label="Open run artifacts"]') as HTMLButtonElement | null
    expect(trigger).not.toBeNull()
    expect(trigger?.getAttribute("title")).toBe("Run details (I/C/M)")

    act(() => {
      trigger!.click()
    })

    expect(onOpenArtifacts).toHaveBeenCalledTimes(1)
    expect(onOpenArtifacts).toHaveBeenCalledWith("test")
  })

  it("toggles the shortcut popover once when closing from the trigger", () => {
    const onToggleShortcuts = vi.fn()
    mount(
      <RunNavbar
        run={{ ...baseRun, name: "Screenshot run" }}
        shortcutsOpen={true}
        onToggleShortcuts={onToggleShortcuts}
      />,
    )

    const trigger = container.querySelector('button[aria-label="Keyboard shortcuts"]') as HTMLButtonElement | null
    expect(trigger).not.toBeNull()

    act(() => {
      trigger!.click()
    })

    expect(onToggleShortcuts).toHaveBeenCalledTimes(1)
  })

  it("reruns suite parents with only the stored suite file path", async () => {
    const triggerRunMock = vi.mocked(triggerRun)
    triggerRunMock.mockResolvedValue({ runId: "run_rerun", status: "queued" })
    const readKeys: string[] = []
    const attributes = new Proxy(baseRun.attributes, {
      get(target, key, receiver) {
        if (typeof key === "string") readKeys.push(key)
        return Reflect.get(target, key, receiver)
      },
    })

    mount(
      <RunNavbar
        run={{
          ...baseRun,
          attributes,
          name: "Sample Basic suite",
          filePath: "suites/sample-basic.suite.yaml",
          suiteId: "s_sample_basic",
        }}
        shortcutsOpen={false}
        onToggleShortcuts={() => {}}
      />,
    )

    const trigger = container.querySelector('button[aria-label="Re-run"]') as HTMLButtonElement | null
    expect(trigger).not.toBeNull()

    await act(async () => {
      trigger!.click()
      await Promise.resolve()
    })

    expect(triggerRunMock).toHaveBeenCalledWith({
      file: "suites/sample-basic.suite.yaml",
    })
    expect(readKeys).not.toContain("agent-qa.runner")
  })
})
