// @vitest-environment jsdom

import { Children, act, cloneElement, isValidElement, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, Route, Routes } from "react-router"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { MemoryWorkspaceObservation } from "@/lib/api"

const {
  fetchMemoryCatalogMock,
  fetchMemoryProductDetailMock,
  toastErrorMock,
  toastSuccessMock,
} = vi.hoisted(() => ({
  fetchMemoryCatalogMock: vi.fn(),
  fetchMemoryProductDetailMock: vi.fn(),
  toastErrorMock: vi.fn(),
  toastSuccessMock: vi.fn(),
}))

vi.mock("@/lib/api", () => ({
  fetchMemoryCatalog: fetchMemoryCatalogMock,
  fetchMemoryProductDetail: fetchMemoryProductDetailMock,
}))
vi.mock("sonner", () => ({
  toast: {
    success: toastSuccessMock,
    error: toastErrorMock,
  },
}))

vi.mock("@/hooks/use-page-title", () => ({ usePageTitle: () => {} }))
vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
}))
vi.mock("@/components/ui/select", () => ({
  Select: ({
    children,
    onValueChange,
  }: {
    children: ReactNode
    onValueChange?: (value: string) => void
  }) => (
    <div>
      {Children.map(children, (child) => {
        if (!isValidElement(child)) return child
        return cloneElement(child as any, { __onValueChange: onValueChange })
      })}
    </div>
  ),
  SelectTrigger: ({
    children,
    className,
  }: {
    children: ReactNode
    className?: string
  }) => (
    <button type="button" className={className}>
      {children}
    </button>
  ),
  SelectValue: ({ placeholder }: { placeholder?: string }) => <span>{placeholder}</span>,
  SelectContent: ({
    children,
    __onValueChange,
  }: {
    children: ReactNode
    __onValueChange?: (value: string) => void
  }) => (
    <div>
      {Children.map(children, (child) => {
        if (!isValidElement(child)) return child
        return cloneElement(child as any, { __onValueChange })
      })}
    </div>
  ),
  SelectItem: ({
    children,
    value,
    __onValueChange,
  }: {
    children: ReactNode
    value: string
    __onValueChange?: (value: string) => void
  }) => (
    <button
      type="button"
      data-select-value={value}
      onClick={() => __onValueChange?.(value)}
    >
      {children}
    </button>
  ),
}))
vi.mock("@/components/ui/popover", async () => {
  const React = await import("react")

  const PopoverContext = React.createContext<{
    open: boolean
    setOpen: (nextOpen: boolean) => void
  } | null>(null)

  function Popover({
    children,
    defaultOpen = false,
    onOpenChange,
    open,
  }: {
    children: ReactNode
    defaultOpen?: boolean
    onOpenChange?: (nextOpen: boolean) => void
    open?: boolean
  }) {
    const [internalOpen, setInternalOpen] = React.useState(defaultOpen)
    const resolvedOpen = open ?? internalOpen
    const setOpen = (nextOpen: boolean) => {
      onOpenChange?.(nextOpen)
      if (open === undefined) {
        setInternalOpen(nextOpen)
      }
    }

    return (
      <PopoverContext.Provider value={{ open: resolvedOpen, setOpen }}>
        {children}
      </PopoverContext.Provider>
    )
  }

  function PopoverTrigger({
    asChild,
    children,
  }: {
    asChild?: boolean
    children: ReactNode
  }) {
    const ctx = React.useContext(PopoverContext)
    const toggle = () => ctx?.setOpen(!ctx.open)

    if (asChild && isValidElement(children)) {
      return cloneElement(children as any, {
        onClick: (event: MouseEvent) => {
          ;(children as any).props.onClick?.(event)
          toggle()
        },
      })
    }

    return (
      <button type="button" onClick={toggle}>
        {children}
      </button>
    )
  }

  function PopoverContent({
    children,
    onCloseAutoFocus,
    onEscapeKeyDown,
    onOpenAutoFocus,
  }: {
    children: ReactNode
    onCloseAutoFocus?: (event: Event) => void
    onEscapeKeyDown?: (event: KeyboardEvent) => void
    onOpenAutoFocus?: (event: Event) => void
  }) {
    const ctx = React.useContext(PopoverContext)

    React.useEffect(() => {
      if (!ctx?.open) return
      onOpenAutoFocus?.(new Event("open"))
    }, [ctx?.open, onOpenAutoFocus])

    if (!ctx?.open) {
      return null
    }

    return (
      <div
        data-popover-content="true"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return
          onEscapeKeyDown?.(event.nativeEvent)
          if (!event.defaultPrevented) {
            ctx.setOpen(false)
            onCloseAutoFocus?.(new Event("close"))
          }
        }}
      >
        {children}
      </div>
    )
  }

  return { Popover, PopoverTrigger, PopoverContent }
})
vi.mock("@/components/ui/command", () => ({
  Command: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CommandInput: ({
    placeholder,
  }: {
    placeholder?: string
  }) => <input placeholder={placeholder} />,
  CommandList: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CommandEmpty: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CommandGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CommandItem: ({
    children,
    onSelect,
    value,
  }: {
    children: ReactNode
    onSelect?: (value: string) => void
    value: string
  }) => (
    <button
      type="button"
      data-command-value={value}
      onClick={() => onSelect?.(value)}
    >
      {children}
    </button>
  ),
}))

import MemoryPage from "@/pages/memory"
import MemoryProductPage from "@/pages/memory-product"
import { formatDate, formatDateShort } from "@/lib/utils"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let intersectionObservers: MockIntersectionObserver[] = []
let clipboardWriteTextMock = vi.fn()
let scrollIntoViewMock = vi.fn()

class MockIntersectionObserver {
  readonly callback: IntersectionObserverCallback
  readonly elements = new Set<Element>()
  readonly root = null
  readonly rootMargin = "0px"
  readonly thresholds = [0]

  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback
    intersectionObservers.push(this)
  }

  disconnect = () => {
    this.elements.clear()
    intersectionObservers = intersectionObservers.filter((observer) => observer !== this)
  }

  observe = (element: Element) => {
    this.elements.add(element)
  }

  takeRecords = () => []

  unobserve = (element: Element) => {
    this.elements.delete(element)
  }
}

function triggerIntersection(
  targetId: string,
  options: { intersectionRatio?: number; isIntersecting?: boolean } = {},
) {
  const target = document.getElementById(targetId)
  expect(target).not.toBeNull()

  for (const observer of intersectionObservers) {
    if (!observer.elements.has(target!)) {
      continue
    }

    observer.callback(
      [
        {
          boundingClientRect: {} as DOMRectReadOnly,
          intersectionRatio: options.intersectionRatio ?? 1,
          intersectionRect: {} as DOMRectReadOnly,
          isIntersecting: options.isIntersecting ?? true,
          rootBounds: null,
          target: target!,
          time: 0,
        },
      ] as IntersectionObserverEntry[],
      observer as unknown as IntersectionObserver,
    )
  }
}

const PRODUCT_ATLAS_OBSERVATIONS = [
  {
    id: "obs-core-product",
    title: "Atlas heading: raw product key stays canonical",
    content: "The atlas keeps the **raw product key** as the canonical workspace heading.",
    trust: 0.93,
    created: "2026-03-20T08:00:00.000Z",
    last_confirmed: "2026-04-22T08:00:00.000Z",
    confirmed_count: 6,
    contradicted_count: 0,
    source_test: "t_memory_catalog",
    scope: "product",
    scopeId: "alpha-product",
  },
  {
    id: "obs-needs-verification",
    title: "Fallback sorting: contradicted note says atlas sections disappear",
    content: "A contradicted note says fallback sorting hides atlas sections from readers.",
    trust: 0.31,
    created: "2026-04-18T08:00:00.000Z",
    last_confirmed: "2026-04-20T08:00:00.000Z",
    confirmed_count: 1,
    contradicted_count: 2,
    source_test: "t_memory_regression",
    scope: "test",
    scopeId: "t_memory_regression",
  },
  {
    id: "obs-slash-search",
    title: "Keyboard shortcuts: slash focuses atlas search",
    content: "The atlas search input can be focused quickly from the toolbar.",
    trust: 0.68,
    created: "2026-04-22T09:00:00.000Z",
    last_confirmed: "2026-04-22T09:30:00.000Z",
    confirmed_count: 2,
    contradicted_count: 0,
    source_test: "t_keyboard_shortcuts",
    scope: "test",
    scopeId: "t_keyboard_shortcuts",
  },
  {
    id: "obs-suite-anchor",
    title: "Suite metadata: anchors stay subtle for readers",
    content: "Suite runs learned the atlas keeps metadata anchors subtle for readers.",
    trust: 0.61,
    created: "2026-04-21T09:00:00.000Z",
    last_confirmed: "2026-04-21T10:00:00.000Z",
    confirmed_count: 3,
    contradicted_count: 0,
    source_test: "t_checkout_suite",
    scope: "suite",
    scopeId: "suite_checkout",
  },
  {
    id: "obs-ledger-copy",
    title: "Atlas ledger: counts, freshness, and coverage stay in one sentence",
    content: "The ledger sentence summarizes counts, freshness, and source coverage without tiles.",
    trust: 0.58,
    created: "2026-04-20T09:00:00.000Z",
    last_confirmed: "2026-04-20T12:00:00.000Z",
    confirmed_count: 2,
    contradicted_count: 0,
    source_test: "t_memory_catalog",
    scope: "product",
    scopeId: "alpha-product",
  },
  {
    id: "obs-source-filter",
    title: "Source filters: queries also match source test ids",
    content: "Search terms match source test ids as well as observation prose.",
    trust: 0.52,
    created: "2026-04-19T09:00:00.000Z",
    last_confirmed: "2026-04-19T11:00:00.000Z",
    confirmed_count: 2,
    contradicted_count: 0,
    source_test: "t_source_filters",
    scope: "suite",
    scopeId: "suite_search",
  },
  {
    id: "obs-read-only-copy",
    title: "Read-only copy: atlas stays workspace-safe",
    content: "Helper copy keeps the route explicitly read-only for this workspace.",
    trust: 0.64,
    created: "2026-04-17T09:00:00.000Z",
    last_confirmed: "2026-04-17T11:00:00.000Z",
    confirmed_count: 2,
    contradicted_count: 0,
    source_test: "t_read_only_guard",
    scope: "test",
    scopeId: "t_read_only_guard",
  },
  {
    id: "obs-single-article",
    title: "Single article: atlas avoids mixed table-and-card layouts",
    content: "The reading surface stays in one article instead of splitting into tables and cards.",
    trust: 0.57,
    created: "2026-04-16T09:00:00.000Z",
    last_confirmed: "2026-04-16T11:00:00.000Z",
    confirmed_count: 2,
    contradicted_count: 0,
    source_test: "t_memory_catalog",
    scope: "product",
    scopeId: "alpha-product",
  },
  {
    id: "obs-local-filters",
    title: "Local filters: section bucketing happens after filtering",
    content: "Filters rebuild the visible atlas locally before section bucketing.",
    trust: 0.49,
    created: "2026-04-15T09:00:00.000Z",
    last_confirmed: "2026-04-15T11:00:00.000Z",
    confirmed_count: 2,
    contradicted_count: 0,
    source_test: "t_source_filters",
    scope: "suite",
    scopeId: "suite_search",
  },
  {
    id: "obs-selection-guard",
    title: "Text selection: observation prose stays inert",
    content: "Observation prose remains selectable text instead of acting like a row trigger.",
    trust: 0.54,
    created: "2026-04-14T09:00:00.000Z",
    last_confirmed: "2026-04-14T11:00:00.000Z",
    confirmed_count: 2,
    contradicted_count: 0,
    source_test: "t_selection_guard",
    scope: "test",
    scopeId: "t_selection_guard",
  },
  {
    id: "obs-remaining-memory",
    title: "Archive context: remaining memory keeps old onboarding notes",
    content: "Archived onboarding context remains available in the remaining memory section.",
    trust: 0.46,
    created: "2026-01-05T09:00:00.000Z",
    last_confirmed: "2026-02-01T11:00:00.000Z",
    confirmed_count: 1,
    contradicted_count: 0,
    source_test: "t_archive_memory",
    scope: "product",
    scopeId: "alpha-product",
  },
] as const

const SUITE_SCOPE_REFS: Record<string, NonNullable<MemoryWorkspaceObservation["scopeRef"]>> = {
  suite_checkout: {
    kind: "suite",
    id: "suite_checkout",
    label: "Checkout suite",
    targetName: "alpha-target",
    href: "/suite/suite_checkout",
  },
  suite_search: {
    kind: "suite",
    id: "suite_search",
    label: "Search suite",
    targetName: "alpha-target",
    href: "/suite/suite_search",
  },
}

const TEST_SCOPE_REFS: Record<string, NonNullable<MemoryWorkspaceObservation["scopeRef"]>> = {
  t_memory_regression: {
    kind: "test",
    id: "t_memory_regression",
    label: "Memory regression",
    targetName: "alpha-target",
    href: "/test/t_memory_regression",
  },
  t_keyboard_shortcuts: {
    kind: "test",
    id: "t_keyboard_shortcuts",
    label: "Keyboard shortcuts smoke",
    targetName: "alpha-target",
    href: "/test/t_keyboard_shortcuts",
  },
  t_read_only_guard: {
    kind: "test",
    id: "t_read_only_guard",
    label: "Read-only guard",
    targetName: "alpha-target",
    href: "/test/t_read_only_guard",
  },
  t_selection_guard: {
    kind: "test",
    id: "t_selection_guard",
    label: "Selection guard",
    targetName: "alpha-target",
    href: "/test/t_selection_guard",
  },
}

const PRODUCT_WORKSPACE_OBSERVATIONS: MemoryWorkspaceObservation[] = PRODUCT_ATLAS_OBSERVATIONS.map((observation) => ({
  ...observation,
  updated: observation.last_confirmed,
  scopeRef:
    observation.scope === "suite"
      ? SUITE_SCOPE_REFS[observation.scopeId] ?? null
      : observation.scope === "test"
        ? TEST_SCOPE_REFS[observation.scopeId] ?? null
        : null,
  sourceTestRef: {
    kind: "source_test",
    id: observation.source_test,
    label: observation.source_test,
    targetName: "alpha-target",
    href: `/test/${observation.source_test}`,
  },
}))

describe("memory pages", () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-04-22T14:00:00.000Z"))
    fetchMemoryCatalogMock.mockReset()
    fetchMemoryProductDetailMock.mockReset()
    toastSuccessMock.mockReset()
    toastErrorMock.mockReset()
    clipboardWriteTextMock = vi.fn().mockResolvedValue(undefined)
    scrollIntoViewMock = vi.fn()
    intersectionObservers = []

    vi.stubGlobal("navigator", {
      ...navigator,
      clipboard: { writeText: clipboardWriteTextMock },
    })
    vi.stubGlobal(
      "IntersectionObserver",
      MockIntersectionObserver as unknown as typeof IntersectionObserver,
    )

    Object.defineProperty(window, "scrollTo", {
      configurable: true,
      value: vi.fn(),
      writable: true,
    })
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
      writable: true,
    })
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1024,
      writable: true,
    })
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoViewMock,
    })

    fetchMemoryCatalogMock.mockResolvedValue({
      products: [
        {
          productKey: "alpha-product",
          observationCount: 5,
          scopeCounts: { product: 0, suite: 1, test: 2 },
          freshness: "2026-04-22T08:00:00.000Z",
          sourceCoverage: 4,
          targetReferences: [
            "alpha-android",
            "alpha-target",
            "alpha-tv",
            "alpha-web",
          ],
          sourceCounts: { suite: 1, test: 2 },
        },
        {
          productKey: "beta-product",
          observationCount: 2,
          scopeCounts: { product: 1, suite: 0, test: 1 },
          freshness: "2026-04-22T07:00:00.000Z",
          sourceCoverage: 1,
          targetReferences: [],
          sourceCounts: { suite: 0, test: 1 },
        },
      ],
    })
    fetchMemoryProductDetailMock.mockResolvedValue({
      product: {
        productKey: "alpha-product",
        observationCount: PRODUCT_WORKSPACE_OBSERVATIONS.length,
        scopeCounts: { product: 4, suite: 3, test: 4 },
        freshness: "2026-04-22T09:30:00.000Z",
        sourceCoverage: 8,
        targetReferences: [
          "alpha-android",
          "alpha-target",
          "alpha-tv",
          "alpha-web",
        ],
        sourceCounts: { suite: 2, test: 6 },
        scopes: {
          product: {
            scope: "product",
            observationCount: 4,
            freshness: "2026-04-22T08:00:00.000Z",
            sourceCoverage: 2,
            scopeIds: ["alpha-product"],
          },
          suite: {
            scope: "suite",
            observationCount: 3,
            freshness: "2026-04-21T10:00:00.000Z",
            sourceCoverage: 2,
            scopeIds: ["suite_checkout", "suite_search"],
          },
          test: {
            scope: "test",
            observationCount: 4,
            freshness: "2026-04-22T09:30:00.000Z",
            sourceCoverage: 4,
            scopeIds: [
              "t_memory_regression",
              "t_keyboard_shortcuts",
              "t_read_only_guard",
              "t_selection_guard",
            ],
          },
        },
        observations: PRODUCT_WORKSPACE_OBSERVATIONS,
        invalidFiles: [
          {
            scope: "test",
            scopeId: "t_memory_regression",
            filename: "obs_legacy-titleless.md",
            code: "parse_error",
            message: "Invalid observation frontmatter: title is required.",
          },
          {
            scope: "test",
            scopeId: "t_memory_regression",
            filename: "obs_prompt-injection.md",
            code: "security_scan_failed",
            message: "Security scan blocked: prompt_injection",
          },
        ],
      },
    })
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  async function flushRender() {
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  async function renderAt(url: string) {
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)

    act(() => {
      root.render(
        <MemoryRouter initialEntries={[url]}>
          <Routes>
            <Route path="/memory" element={<MemoryPage />} />
            <Route path="/memory/:product" element={<MemoryProductPage />} />
          </Routes>
        </MemoryRouter>,
      )
    })

    await flushRender()
  }

  function findButton(label: string) {
    return Array.from(container.querySelectorAll("button")).find(
      (button) =>
        button.textContent?.trim() === label ||
        button.getAttribute("aria-label") === label,
    ) as HTMLButtonElement | undefined
  }

  function getMemoryColumnContract() {
    return Array.from(container?.querySelectorAll("colgroup col") ?? []).map((column) => ({
      id: column.getAttribute("data-column-id"),
      width: (column as HTMLTableColElement).style.width,
    }))
  }

  function getHeaderCell(label: string) {
    return Array.from(container.querySelectorAll("th")).find(
      (cell) => cell.textContent?.trim() === label,
    ) as HTMLTableCellElement | undefined
  }

  function findObservationMetadataButton(snippet: string) {
    const paragraph = Array.from(container.querySelectorAll("p")).find((node) =>
      node.textContent?.includes(snippet),
    ) as HTMLElement | undefined

    let current = paragraph
    while (current && current !== container) {
      const buttons = current.querySelectorAll(
        'button[aria-label="Observation details"]',
      )
      if (buttons.length === 1) {
        return buttons[0] as HTMLButtonElement
      }
      current = current.parentElement ?? undefined
    }

    return undefined
  }

  function findOutlineButton(label: string) {
    return Array.from(
      container.querySelectorAll("[data-workspace-outline-item]"),
    ).find((node) => node.textContent?.trim() === label) as
      | HTMLButtonElement
      | undefined
  }

  async function click(element: HTMLElement | null | undefined) {
    expect(element).toBeTruthy()
    await act(async () => {
      element!.click()
    })
    await flushRender()
  }

  async function setSearch(value: string) {
    const input = container.querySelector(
      'input[placeholder="Search this memory..."]',
    ) as HTMLInputElement | null
    expect(input).not.toBeNull()
    const descriptor = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )
    await act(async () => {
      descriptor?.set?.call(input, value)
      input!.dispatchEvent(new Event("input", { bubbles: true }))
    })
    await flushRender()
  }

  async function focusAndPress(element: HTMLElement | null | undefined, key: string) {
    expect(element).toBeTruthy()
    await act(async () => {
      element!.focus()
      element!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }))
    })
    await flushRender()
  }

  async function clickSelectValue(value: string) {
    await click(
      container.querySelector(`[data-select-value="${value}"]`) as HTMLButtonElement | null,
    )
  }

  async function clickCommandValue(value: string) {
    await click(
      container.querySelector(`[data-command-value="${value}"]`) as HTMLButtonElement | null,
    )
  }

  it("keeps the /memory alignment shell aligned with the Phase 200 content contract", async () => {
    await renderAt("/memory")

    expect(container.textContent).toContain("Memory")
    expect(container.textContent).toContain("Browse what the agent has learned for each product.")
    const table = container.querySelector('table[data-slot="table"]') as HTMLTableElement | null
    expect(table?.className).toContain("table-fixed")
    expect(getMemoryColumnContract()).toEqual([
      { id: "product", width: "" },
      { id: "scope", width: "9rem" },
      { id: "source", width: "8rem" },
      { id: "lastConfirmed", width: "9rem" },
    ])
    expect(
      Array.from(container.querySelectorAll("th")).map((node) => node.textContent?.trim()),
    ).toEqual([
      "Product",
      "Product / Suite / Test",
      "Suite / Test",
      "Last confirmed",
    ])
    expect(container.querySelector('input[placeholder="Search products"]')).not.toBeNull()
    expect(container.querySelector('input[placeholder="Search products..."]')).toBeNull()

    const pageHeader = container.querySelector("header") as HTMLElement | null
    const headerTopRow = pageHeader?.firstElementChild as HTMLElement | null
    expect(headerTopRow?.className).toContain("justify-between")
    expect(headerTopRow?.querySelector('button[aria-label="Keyboard shortcuts"]')).not.toBeNull()
    expect(
      container
        .querySelector('input[placeholder="Search products"]')
        ?.parentElement
        ?.querySelector('button[aria-label="Keyboard shortcuts"]'),
    ).toBeNull()
    expect(getHeaderCell("Product")?.className).not.toContain("text-right")
    expect(getHeaderCell("Product / Suite / Test")?.className).toContain("text-right")
    expect(getHeaderCell("Suite / Test")?.className).toContain("text-right")
    expect(getHeaderCell("Last confirmed")?.className).toContain("text-right")

    const rowTitles = Array.from(container.querySelectorAll("[data-memory-product]"))
      .map((node) => node.textContent?.trim())
      .filter((value): value is string => Boolean(value))
    expect(rowTitles[0]).toContain("alpha-product")
    expect(rowTitles[1]).toContain("beta-product")

    const alphaRow = container.querySelector('[data-memory-product="alpha-product"]') as HTMLTableRowElement | null
    expect(alphaRow?.querySelector('[data-column-id="product"]')?.className).not.toContain("text-right")
    expect(alphaRow?.querySelector('[data-column-id="scope"]')?.className).toContain("text-right")
    expect(alphaRow?.querySelector('[data-column-id="source"]')?.className).toContain("text-right")
    expect(alphaRow?.querySelector('[data-column-id="lastConfirmed"]')?.className).toContain("text-right")
    expect(alphaRow?.querySelector("[data-memory-targets]")?.textContent).toBe(
      "alpha-android, alpha-target, alpha-tv, +1 more",
    )
    expect(alphaRow?.querySelector('[data-column-id="scope"]')?.textContent).toContain("0 / 1 / 2")
    expect(alphaRow?.querySelector('[data-column-id="source"]')?.textContent).toContain("1 / 2")
    expect(alphaRow?.querySelector('[data-column-id="lastConfirmed"]')?.textContent).toContain(
      formatDate("2026-04-22T08:00:00.000Z"),
    )
    expect(alphaRow?.querySelector('[data-column-id="lastConfirmed"]')?.textContent).toContain(
      formatDateShort("2026-04-22T08:00:00.000Z"),
    )

    const betaRow = container.querySelector('[data-memory-product="beta-product"]') as HTMLTableRowElement | null
    expect(betaRow?.querySelector("[data-memory-targets]")).toBeNull()
    expect(betaRow?.textContent).toContain("1 / 0 / 1")
    expect(betaRow?.textContent).toContain("0 / 1")

    const legacyWidthClasses = Array.from(container?.querySelectorAll("th, td") ?? []).filter((cell) =>
      /\bw-\[\d+%]/.test((cell as HTMLElement).className),
    )
    expect(legacyWidthClasses).toHaveLength(0)
  })

  it("navigates row clicks to the canonical /memory/:product route", async () => {
    await renderAt("/memory")

    const alphaRow = container.querySelector('[data-memory-product="alpha-product"]')
    expect(alphaRow).not.toBeNull()

    await act(async () => {
      alphaRow?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
      await Promise.resolve()
    })

    expect(container.textContent).toContain("Copy page")
    expect(fetchMemoryProductDetailMock).toHaveBeenCalledWith("alpha-product")
  })

  it("supports arrow, J/K, and enter-based row navigation on the landing page", async () => {
    await renderAt("/memory")

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }))
      await Promise.resolve()
    })

    const rows = Array.from(container.querySelectorAll("[data-memory-product]"))
    expect(rows[0]?.getAttribute("aria-selected")).toBe("true")

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true }))
      await Promise.resolve()
    })

    expect(rows[1]?.getAttribute("aria-selected")).toBe("true")

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", bubbles: true }))
      await Promise.resolve()
    })

    expect(rows[0]?.getAttribute("aria-selected")).toBe("true")

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }))
      await Promise.resolve()
    })

    expect(rows[0]?.getAttribute("aria-selected")).toBe("true")

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
      await Promise.resolve()
    })

    expect(fetchMemoryProductDetailMock).toHaveBeenCalledWith("alpha-product")
    expect(container.textContent).toContain("Copy page")
  })

  it("opens the selected product in a new tab on ctrl-enter", async () => {
    const windowOpenMock = vi.spyOn(window, "open").mockImplementation(() => null)

    await renderAt("/memory")

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true }))
      await Promise.resolve()
    })

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }))
      await Promise.resolve()
    })

    expect(windowOpenMock).toHaveBeenCalledWith("/memory/alpha-product", "_blank")
    expect(fetchMemoryProductDetailMock).not.toHaveBeenCalled()

    windowOpenMock.mockRestore()
  })

  it("renders the workspace shell with breadcrumb chrome, canonical sections, outline rail, and no atlas toolbar", async () => {
    await renderAt("/memory/alpha-product")

    expect(container.querySelector('[data-workspace-navbar="true"]')).not.toBeNull()
    expect(container.querySelector('[data-workspace-shell="true"]')).not.toBeNull()
    expect(container.querySelector('[data-workspace-outline="true"]')).not.toBeNull()
    expect(container.querySelector('[data-workspace-filter-rail="true"]')).not.toBeNull()
    expect(container.querySelector('[data-workspace-reader-page="true"]')).not.toBeNull()
    expect(container.querySelector('[data-workspace-copy-button="true"]')).not.toBeNull()
    expect(container.querySelector('button[aria-label="Keyboard shortcuts"]')).not.toBeNull()
    expect(container.textContent).toContain("Memory")
    expect(container.textContent).toContain("alpha-product")
    expect(container.textContent).toContain("Copy page")
    expect(container.textContent).toContain("On this page")
    expect(container.textContent).toContain("Any (0.00 - 1.00)")
    expect(container.textContent).toContain("Date")
    expect(container.textContent).toContain("Last confirmed")
    expect(container.textContent).toContain("Updated")
    expect(container.textContent).toContain("Created")
    expect(container.textContent).toContain("All time")
    expect(container.textContent).toContain("7d")
    expect(container.textContent).toContain("30d")
    expect(container.textContent).toContain("90d")
    expect(container.querySelector('input[placeholder="Search this memory..."]')).toBeNull()
    expect(container.textContent).not.toContain("Back to Memory")
    expect(container.textContent).not.toContain("Core facts")
    expect(container.textContent).not.toContain("Recent learnings")
    expect(container.textContent).not.toContain("Needs verification")
    expect(container.textContent).not.toContain("Remaining memory")
    expect(container.textContent).not.toContain("All scopes")
    expect(container.textContent).not.toContain("All freshness")
    expect(container.textContent).not.toContain("All sources")
    expect(container.textContent).not.toContain("Atlas order")

    expect(
      Array.from(container.querySelectorAll("[data-workspace-section]")).map((node) =>
        node.getAttribute("data-workspace-section"),
      ),
    ).toEqual(["product", "suite", "test"])
    expect(container.textContent).toContain("Checkout suite")
    expect(container.textContent).toContain("Search suite")
    expect(container.textContent).toContain("Keyboard shortcuts smoke")
  })

  it("renders titled markdown bodies and keeps invalid file warnings inline without hiding valid observations", async () => {
    await renderAt("/memory/alpha-product")

    const block = container.querySelector(
      '[data-observation-block="obs-core-product"]',
    ) as HTMLElement | null
    const title = block?.querySelector("h3")

    expect(title?.textContent).toBe("Atlas heading: raw product key stays canonical")
    expect(block?.textContent).toContain("The atlas keeps the raw product key as the canonical workspace heading.")
    expect(block?.textContent).not.toContain("**raw product key**")
    expect(block?.textContent?.match(/Atlas heading: raw product key stays canonical/g)?.length).toBe(1)
    expect(container.textContent).toContain("2 invalid memory files hidden from this workspace.")
    expect(container.textContent).toContain("obs_legacy-titleless.md")
    expect(container.textContent).toContain("obs_prompt-injection.md")
  })

  it("keeps the product route read-only with no edit, delete, checkbox, or batch chrome", async () => {
    await renderAt("/memory/alpha-product")

    expect(container.textContent).not.toContain("Edit")
    expect(container.textContent).not.toContain("Delete")
    expect(container.querySelector('input[type="checkbox"]')).toBeNull()
  })

  it("renders a fully expanded outline with section, group, and observation entries", async () => {
    await renderAt("/memory/alpha-product")

    const outline = container.querySelector('[data-workspace-outline="true"]') as HTMLElement | null
    expect(outline?.textContent).toContain("Product")
    expect(outline?.textContent).toContain("Suite")
    expect(outline?.textContent).toContain("Test")
    expect(outline?.textContent).toContain("Checkout suite")
    expect(outline?.textContent).toContain("Keyboard shortcuts smoke")
    expect(outline?.textContent).toContain("Atlas heading: raw product key stays canonical")
  })

  it("copies the full canonical page as markdown even when filters hide suite and test observations", async () => {
    await renderAt("/memory/alpha-product")

    await clickSelectValue("high")

    expect(container.textContent).not.toContain("Checkout suite")
    expect(container.textContent).not.toContain("Keyboard shortcuts smoke")

    await click(findButton("Copy page"))

    expect(clipboardWriteTextMock).toHaveBeenCalledTimes(1)
    const markdown = clipboardWriteTextMock.mock.calls[0]?.[0] as string
    expect(markdown).toContain("# Memory: alpha-product")
    expect(markdown).toContain("## Product")
    expect(markdown).toContain("## Suite")
    expect(markdown).toContain("### Checkout suite")
    expect(markdown).toContain("#### Suite metadata: anchors stay subtle for readers")
    expect(markdown).toContain("## Test")
    expect(markdown).toContain("### Keyboard shortcuts smoke")
    expect(markdown).toContain("#### Keyboard shortcuts: slash focuses atlas search")
    expect(toastSuccessMock).toHaveBeenCalledWith("Copied page as Markdown")
  })

  it("supports workspace keyboard shortcuts for entry navigation and page copy", async () => {
    await renderAt("/memory/alpha-product")

    scrollIntoViewMock.mockClear()
    clipboardWriteTextMock.mockClear()

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true }))
      await Promise.resolve()
    })

    expect(
      findOutlineButton("Atlas heading: raw product key stays canonical")?.getAttribute("aria-current"),
    ).toBe("location")
    expect(scrollIntoViewMock).toHaveBeenCalled()

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "c", bubbles: true }))
      await Promise.resolve()
    })

    expect(clipboardWriteTextMock).toHaveBeenCalledTimes(1)
  })

  it("navigates from the outline and highlights the active item when observer updates arrive", async () => {
    await renderAt("/memory/alpha-product")

    const groupButton = findOutlineButton("Keyboard shortcuts smoke")
    await click(groupButton)

    expect(scrollIntoViewMock).toHaveBeenCalled()
    expect(groupButton?.getAttribute("aria-current")).toBe("location")

    scrollIntoViewMock.mockClear()
    triggerIntersection("memory-observation-obs-needs-verification")
    await flushRender()

    expect(
      findOutlineButton("Fallback sorting: contradicted note says atlas sections disappear")
        ?.getAttribute("aria-current"),
    ).toBe("location")
    expect(scrollIntoViewMock).toHaveBeenCalled()
  })

  it("shows resolved references and created/updated/last confirmed metadata in the popover", async () => {
    await renderAt("/memory/alpha-product")

    await click(
      findObservationMetadataButton(
        "Suite runs learned the atlas keeps metadata anchors subtle for readers.",
      ),
    )

    const popover = container.querySelector('[data-popover-content="true"]') as HTMLElement | null
    expect(popover?.textContent).toContain("Scope reference")
    expect(popover?.textContent).toContain("Checkout suite")
    expect(popover?.textContent).toContain("alpha-target")
    expect(popover?.textContent).toContain("Source test")
    expect(popover?.textContent).toContain("t_checkout_suite")
    expect(popover?.textContent).toContain("Trust")
    expect(popover?.textContent).toContain("Created")
    expect(popover?.textContent).toContain("Updated")
    expect(popover?.textContent).toContain("Last confirmed")
    expect(popover?.textContent).toContain(formatDateShort("2026-04-21T09:00:00.000Z"))
    expect(popover?.textContent).toContain(formatDateShort("2026-04-21T10:00:00.000Z"))
    expect(popover?.textContent).not.toContain("Suite metadata: anchors stay subtle for readers")
    expect(popover?.textContent).not.toContain(
      "Suite runs learned the atlas keeps metadata anchors subtle for readers.",
    )
  })
})
