// @vitest-environment jsdom

import { Children, act, cloneElement, isValidElement, type ButtonHTMLAttributes, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, Route, Routes, useLocation } from "react-router"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import TestsPage from "@/pages/tests"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const LONG_TEST_NAME = "This is a deliberately long test name that should wrap across multiple lines instead of widening the entire list page until it overflows horizontally"

const {
  fetchTestFilesMock,
  fetchRunsMock,
  triggerRunMock,
  purgeCacheMock,
  deleteTestFileMock,
  toastSuccessMock,
  toastErrorMock,
} = vi.hoisted(() => ({
  fetchTestFilesMock: vi.fn(),
  fetchRunsMock: vi.fn(),
  triggerRunMock: vi.fn(),
  purgeCacheMock: vi.fn(),
  deleteTestFileMock: vi.fn(),
  toastSuccessMock: vi.fn(),
  toastErrorMock: vi.fn(),
}))

vi.mock("@/lib/api", () => ({
  fetchTestFiles: fetchTestFilesMock,
  fetchRuns: fetchRunsMock,
  triggerRun: triggerRunMock,
  purgeCache: purgeCacheMock,
  deleteTestFile: deleteTestFileMock,
}))

vi.mock("@/hooks/use-run-config", () => ({
  useRunConfig: () => ({ defaultRunMode: "local", hasFarm: true, isLoading: false }),
}))
vi.mock("@/hooks/use-page-title", () => ({ usePageTitle: () => {} }))
vi.mock("@/hooks/use-keyboard-shortcuts", () => ({ useKeyboardShortcuts: () => {} }))
vi.mock("sonner", () => ({ toast: { success: toastSuccessMock, error: toastErrorMock } }))
vi.mock("@/components/page-skeleton", () => ({ TableSkeleton: () => <div>Loading...</div> }))
vi.mock("@/components/empty-state", () => ({
  EmptyState: ({ title }: { title: string }) => <div>{title}</div>,
}))
vi.mock("@/components/shortcut-hints", () => ({ ShortcutLegend: () => <div /> }))
vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
}))
vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}))
vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    className,
    disabled,
    onClick,
    type = "button",
    ...props
  }: {
    children: ReactNode
    className?: string
    disabled?: boolean
    onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void
  } & ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button
      type={type}
      className={className}
      disabled={disabled}
      onClick={onClick}
      {...props}
    >
      {children}
    </button>
  ),
}))
vi.mock("@/components/ui/checkbox", () => ({
  Checkbox: ({
    checked,
    disabled,
    onCheckedChange,
    ...props
  }: {
    checked?: boolean | string
    disabled?: boolean
    onCheckedChange?: (value: boolean) => void
    "aria-label"?: string
  } & Omit<React.InputHTMLAttributes<HTMLInputElement>, "checked" | "disabled" | "onChange">) => (
    <input
      type="checkbox"
      checked={checked === true}
      disabled={disabled}
      onChange={(event) => onCheckedChange?.(event.currentTarget.checked)}
      {...props}
    />
  ),
}))
vi.mock("@/components/ui/input", () => ({
  Input: ({
    className,
    onChange,
    placeholder,
    value,
  }: {
    className?: string
    onChange?: (event: React.ChangeEvent<HTMLInputElement>) => void
    placeholder?: string
    value?: string
  }) => (
    <input
      className={className}
      onChange={onChange}
      placeholder={placeholder}
      value={value}
    />
  ),
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
  SelectTrigger: ({ children, className }: { children: ReactNode; className?: string }) => (
    <button type="button" className={className}>{children}</button>
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
  }) => {
    return (
      <button
        type="button"
        data-select-value={value}
        onClick={() => __onValueChange?.(value)}
      >
        {children}
      </button>
    )
  },
}))
vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children, className }: { children: ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
  ScrollBar: () => null,
}))
vi.mock("@/components/batch-action-bar", () => ({
  BatchActionBar: ({
    actionSlot,
    onDelete,
    onCancel,
    secondaryAriaLabel,
    secondaryIcon,
    secondaryLabel,
    selectedCount,
    summaryMeta,
  }: {
    actionSlot?: ReactNode
    onDelete?: () => void
    onCancel: () => void
    secondaryAriaLabel?: string
    secondaryIcon?: ReactNode
    secondaryLabel?: string
    selectedCount: number
    summaryMeta?: string
  }) => {
    if (selectedCount === 0) return null

    return (
      <div data-testid="batch-actions">
        <div>{selectedCount} selected</div>
        {summaryMeta ? <div>{summaryMeta}</div> : null}
        {actionSlot}
        {onDelete ? (
          <button type="button" onClick={onDelete}>
            Delete
          </button>
        ) : null}
        <button
          type="button"
          aria-label={secondaryAriaLabel}
          onClick={onCancel}
        >
          {secondaryIcon ?? secondaryLabel ?? "Cancel"}
        </button>
      </div>
    )
  },
}))
vi.mock("@/components/test-run-options-popover", () => ({
  TestRunOptionsPopover: ({
    browserStackAvailable,
    disabled,
    hiddenCount,
    onOpenChange,
    onRunBrowserStack,
    onRunLocal,
    onUseCacheChange,
    onUseMemoryChange,
    open,
    selectedCount,
    useCache,
    useMemory,
  }: {
    browserStackAvailable: boolean
    disabled?: boolean
    hiddenCount: number
    onOpenChange: (open: boolean) => void
    onRunBrowserStack: () => void
    onRunLocal: () => void
    onUseCacheChange: (checked: boolean) => void
    onUseMemoryChange: (checked: boolean) => void
    open: boolean
    selectedCount: number
    useCache: boolean
    useMemory: boolean
  }) => (
    <div data-testid="run-options-popover">
      <button type="button" disabled={disabled} onClick={() => onOpenChange(!open)}>
        Run
      </button>
      {open ? (
        <div>
          <div>{selectedCount} selected</div>
          {hiddenCount > 0 ? <div>{hiddenCount} hidden by filters</div> : null}
          <label>
            <input
              type="checkbox"
              checked={useCache}
              onChange={(event) => onUseCacheChange(event.currentTarget.checked)}
            />
            <span>Use cache</span>
          </label>
          <label>
            <input
              type="checkbox"
              checked={useMemory}
              onChange={(event) => onUseMemoryChange(event.currentTarget.checked)}
            />
            <span>Use memory</span>
          </label>
          <button type="button" disabled={disabled} onClick={onRunLocal}>
            Run Local
          </button>
          <button
            type="button"
            disabled={disabled || !browserStackAvailable}
            onClick={onRunBrowserStack}
          >
            Run on BrowserStack
          </button>
        </div>
      ) : null}
    </div>
  ),
}))

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

async function flushRender() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function renderAt(url = "/tests") {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)

  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route
            path="/tests"
            element={
              <>
                <LocationProbe />
                <TestsPage />
              </>
            }
          />
          <Route path="/test/:testId" element={<div>Test detail</div>} />
          <Route path="/runs/:runId" element={<div>Run detail</div>} />
        </Routes>
      </MemoryRouter>,
    )
  })

  await flushRender()
  return container
}

function getLocationSearch() {
  return container?.querySelector('[data-testid="location"]')?.getAttribute("data-search")
}

function getLocationPathname() {
  return container?.querySelector('[data-testid="location"]')?.getAttribute("data-pathname")
}

function findBatchButton(label: string) {
  return Array.from(container?.querySelectorAll('button') ?? []).find((button) =>
    button.textContent?.trim() === label || button.getAttribute("aria-label") === label,
  ) as HTMLButtonElement | undefined
}

function findCheckboxByLabel(label: string) {
  const match = Array.from(container?.querySelectorAll("label") ?? []).find((element) =>
    element.textContent?.includes(label),
  )
  return match?.querySelector('input[type="checkbox"]') as HTMLInputElement | null
}

function findRow(text: string) {
  return Array.from(container?.querySelectorAll("tr") ?? []).find((row) =>
    row.textContent?.includes(text),
  ) as HTMLTableRowElement | undefined
}

function getSharedColumnContract() {
  return Array.from(container?.querySelectorAll("colgroup col") ?? []).map((column) => ({
    id: column.getAttribute("data-column-id"),
    width: (column as HTMLTableColElement).style.width,
  }))
}

function findHeading(text: string) {
  return Array.from(container?.querySelectorAll("h1") ?? []).find((heading) =>
    heading.textContent?.trim() === text,
  ) as HTMLHeadingElement | undefined
}

async function click(element: HTMLElement | null | undefined) {
  expect(element).toBeTruthy()
  await act(async () => {
    element!.click()
  })
  await flushRender()
}

async function focusIn(element: HTMLElement | null | undefined) {
  expect(element).toBeTruthy()
  await act(async () => {
    element!.dispatchEvent(new FocusEvent("focusin", { bubbles: true }))
  })
  await flushRender()
}

async function setSearch(value: string) {
  const input = container?.querySelector('input[placeholder="Search tests..."]') as HTMLInputElement | null
  expect(input).not.toBeNull()
  const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")
  await act(async () => {
    descriptor?.set?.call(input, value)
    input!.dispatchEvent(new Event("input", { bubbles: true }))
  })
  await flushRender()
}

async function clickSelectValue(value: string) {
  const button = container?.querySelector(`[data-select-value="${value}"]`) as HTMLButtonElement | null
  await click(button)
}

beforeEach(() => {
  fetchTestFilesMock.mockReset()
  fetchRunsMock.mockReset()
  triggerRunMock.mockReset()
  purgeCacheMock.mockReset()
  deleteTestFileMock.mockReset()
  toastSuccessMock.mockReset()
  toastErrorMock.mockReset()

  const files = Array.from({ length: 51 }, (_, index) => ({
    path: `tests/web/generated-${index + 1}.yaml`,
    name: `Generated flow ${index + 1}`,
    testId: `generated_${index + 1}`,
    modified: `2026-04-${String((index % 9) + 1).padStart(2, "0")}T00:00:00.000Z`,
    targetName: "web-prod",
    platform: "web",
  }))

  fetchTestFilesMock.mockResolvedValue({
    files: [
      {
        path: "tests/web/login.yaml",
        name: "Login flow",
        testId: "test_login",
        modified: "2026-04-18T00:00:00.000Z",
        targetName: "web-prod",
        platform: "web",
      },
      {
        path: "tests/android/signup.yaml",
        name: "Signup flow",
        testId: "test_signup",
        modified: "2026-04-18T01:00:00.000Z",
        targetName: "android-staging",
        platform: "android",
      },
      {
        path: "tests/web/very-long-name.yaml",
        name: LONG_TEST_NAME,
        testId: "test_long_name",
        modified: "2026-04-18T02:00:00.000Z",
        targetName: "web-prod",
        platform: "web",
      },
      ...files,
    ],
    targets: ["web-prod", "android-staging"],
  })
  fetchRunsMock.mockResolvedValue({
    runs: [
      { id: "run_login_latest", filePath: "tests/web/login.yaml", status: "failed", createdAt: "2026-04-18T04:00:00.000Z" },
      { id: "run_login_old", filePath: "tests/web/login.yaml", status: "passed", createdAt: "2026-04-17T04:00:00.000Z" },
      { id: "run_signup_latest", filePath: "tests/android/signup.yaml", status: "passed", createdAt: "2026-04-18T03:00:00.000Z" },
    ],
  })
  triggerRunMock.mockResolvedValue({ runId: "run_1" })
  purgeCacheMock.mockResolvedValue({ purged: 1 })
  deleteTestFileMock.mockResolvedValue({ deleted: true })
})

afterEach(() => {
  if (root) {
    act(() => {
      root!.unmount()
    })
  }
  root = null
  if (container) container.remove()
  container = null
  document.body.innerHTML = ""
})

describe("TestsPage", () => {
  it("places Keyboard shortcuts beside New Test in the heading actions instead of the filter row", async () => {
    await renderAt()

    const heading = findHeading("Tests")
    const headingRow = heading?.parentElement
    const filterRow = container?.querySelector('input[placeholder="Search tests..."]')?.parentElement

    expect(headingRow?.className).toContain("justify-between")
    expect(headingRow?.querySelector('button[aria-label="Keyboard shortcuts"]')).toBeTruthy()
    expect(Array.from(headingRow?.querySelectorAll("button") ?? []).some((button) =>
      button.textContent?.includes("New Test"),
    )).toBe(true)
    expect(filterRow?.querySelector('button[aria-label="Keyboard shortcuts"]')).toBeNull()
  })

  it("keeps search, target, and page in the canonical URL contract and resets page when filters change", async () => {
    await renderAt("/tests")

    expect(container?.textContent).toContain("Showing 1-50 of 54")

    await click(findBatchButton("Next"))
    expect(getLocationSearch()).toBe("?page=2")

    await clickSelectValue("web-prod")
    expect(getLocationSearch()).toBe("?target=web-prod")

    await setSearch("login")
    expect(getLocationSearch()).toBe("?search=login&target=web-prod")
  })

  it("preserves queued rows through search churn, shows hidden counts, and keeps row selection when the filter clears", async () => {
    await renderAt()

    const loginRow = findRow("Login flow")
    const loginCheckbox = loginRow?.querySelector('input[aria-label="Select row"]') as HTMLInputElement | null
    await click(loginCheckbox)

    await setSearch("no-match")

    expect(container?.textContent).toContain("1 selected")
    expect(container?.textContent).toContain("1 hidden by filters")
    expect(container?.textContent).toContain("No tests match the current search or filters.")

    await setSearch("")

    const loginRowAfterClear = findRow("Login flow")
    const loginCheckboxAfterClear = loginRowAfterClear?.querySelector('input[aria-label="Select row"]') as HTMLInputElement | null
    expect(loginCheckboxAfterClear?.checked).toBe(true)
  })

  it("selects an unfocused test row on the first select-cell click without navigating", async () => {
    await renderAt("/tests")

    const loginRow = findRow("Login flow")
    expect(loginRow?.getAttribute("aria-selected")).not.toBe("true")

    await click(loginRow?.querySelector("[data-selection-checkbox-hit-area]") as HTMLElement | null)

    expect(getLocationPathname()).toBe("/tests")
    expect(loginRow?.querySelector<HTMLInputElement>('input[aria-label="Select row"]')?.checked).toBe(true)
    expect(container?.textContent).toContain("1 selected")
    expect(getSharedColumnContract()[0]).toEqual({ id: "select", width: "2.75rem" })
  })

  it("selects an unfocused test row on the first checkbox click after browser focus", async () => {
    await renderAt("/tests")

    const loginRow = findRow("Login flow")
    const loginCheckbox = loginRow?.querySelector('input[aria-label="Select row"]') as HTMLInputElement | null
    expect(loginRow?.getAttribute("aria-selected")).not.toBe("true")

    await focusIn(loginCheckbox)
    expect(loginRow?.getAttribute("aria-selected")).not.toBe("true")

    await click(loginCheckbox)

    expect(getLocationPathname()).toBe("/tests")
    expect(loginCheckbox?.checked).toBe(true)
    expect(container?.textContent).toContain("1 selected")
  })

  it("applies target-aware filtering without dropping queued rows hidden by that filter", async () => {
    await renderAt()

    await click(findRow("Login flow")?.querySelector('input[aria-label="Select row"]') as HTMLInputElement | null)
    await click(findRow("Signup flow")?.querySelector('input[aria-label="Select row"]') as HTMLInputElement | null)

    await clickSelectValue("web-prod")

    expect(getLocationSearch()).toBe("?target=web-prod")
    expect(container?.textContent).toContain("2 selected")
    expect(container?.textContent).toContain("1 hidden by filters")
    expect(findRow("Signup flow")).toBeUndefined()
  })

  it("renders the compact parity columns and exposes the latest run as a direct link", async () => {
    await renderAt()

    expect(container?.textContent).toContain("Test Name")
    expect(container?.textContent).toContain("Target")
    expect(container?.textContent).toContain("Platform")
    expect(container?.textContent).toContain("Pass rate")
    expect(container?.textContent).toContain("Last run")
    expect(container?.textContent).not.toContain("File")
    expect(container?.textContent).not.toContain("Modified")
    expect(container?.querySelector('a[href="/runs/run_login_latest"]')).toBeTruthy()
  })

  it("shows explicit no-runs copy and the active row focus contract", async () => {
    await renderAt()

    const signupRow = findRow("Signup flow")
    const generatedRow = findRow("Generated flow 1")
    expect(generatedRow?.textContent).toContain("No runs")
    expect(generatedRow?.textContent).toContain("0 completed")

    const lastRunHeader = Array.from(container?.querySelectorAll("button") ?? []).find((button) =>
      button.textContent?.includes("Last run"),
    ) as HTMLButtonElement | undefined
    const lastRunLink = container?.querySelector('a[href="/runs/run_login_latest"]') as HTMLAnchorElement | null
    const noRunsCell = findRow("Generated flow 1")?.querySelector("td:last-child span") as HTMLSpanElement | null

    expect(lastRunHeader?.className).not.toContain("-ml-4")
    expect(lastRunHeader?.className).toContain("justify-end")
    expect(lastRunLink?.className).toContain("w-full")
    expect(lastRunLink?.className).toContain("items-end")
    expect(lastRunLink?.className).toContain("text-right")
    expect(noRunsCell?.className).toContain("block")

    await act(async () => {
      signupRow?.focus()
    })
    await flushRender()

    expect(signupRow?.getAttribute("aria-selected")).toBe("true")
    expect(signupRow?.className).toContain("bg-primary/10")
    expect(signupRow?.className).toContain("ring-primary/60")

    expect(getSharedColumnContract()).toEqual([
      { id: "select", width: "2.75rem" },
      { id: "name", width: "" },
      { id: "target", width: "10rem" },
      { id: "platform", width: "6.25rem" },
      { id: "passRate", width: "7.25rem" },
      { id: "lastRun", width: "9rem" },
    ])

    const legacyWidthClasses = Array.from(container?.querySelectorAll("th, td") ?? []).filter((cell) =>
      /\bw-\[\d+%]/.test((cell as HTMLElement).className),
    )
    expect(legacyWidthClasses).toHaveLength(0)
  })

  it("does not attach run history by basename when duplicate filenames live in different folders", async () => {
    fetchTestFilesMock.mockResolvedValueOnce({
      files: [
        {
          path: "tests/web/login.yaml",
          name: "Web login flow",
          testId: "test_web_login",
          modified: "2026-04-18T00:00:00.000Z",
          targetName: "web-prod",
          platform: "web",
        },
        {
          path: "tests/mobile/login.yaml",
          name: "Mobile login flow",
          testId: "test_mobile_login",
          modified: "2026-04-18T01:00:00.000Z",
          targetName: "ios-staging",
          platform: "ios",
        },
      ],
      targets: ["web-prod", "ios-staging"],
    })
    fetchRunsMock.mockResolvedValueOnce({
      runs: [
        { id: "run_web_login_latest", filePath: "tests/web/login.yaml", status: "passed", createdAt: "2026-04-18T04:00:00.000Z" },
      ],
    })

    await renderAt()

    const webRow = findRow("Web login flow")
    const mobileRow = findRow("Mobile login flow")

    expect(webRow?.querySelector('a[href="/runs/run_web_login_latest"]')).toBeTruthy()
    expect(mobileRow?.textContent).toContain("No runs")
    expect(mobileRow?.querySelector('a[href="/runs/run_web_login_latest"]')).toBeNull()
  })

  it("renders long test names with a wrap-friendly primary cell contract", async () => {
    await renderAt()

    const row = findRow(LONG_TEST_NAME)
    expect(row).toBeTruthy()
    const nameLabel = Array.from(row?.querySelectorAll("span") ?? []).find((element) =>
      element.textContent === LONG_TEST_NAME,
    ) as HTMLSpanElement | undefined

    expect(nameLabel?.className).toContain("whitespace-normal")
    expect(nameLabel?.className).toContain("break-words")
    expect(nameLabel?.className).not.toContain("truncate")
  })

  it("remembers toggle changes for the current page session, launches local runs with runtime overrides, and only clears the queue on the close button", async () => {
    await renderAt()

    await click(findRow("Login flow")?.querySelector('input[aria-label="Select row"]') as HTMLInputElement | null)
    await click(findRow("Signup flow")?.querySelector('input[aria-label="Select row"]') as HTMLInputElement | null)

    await click(findBatchButton("Run"))

    const useCache = findCheckboxByLabel("Use cache")
    const useMemory = findCheckboxByLabel("Use memory")
    expect(useCache?.checked).toBe(true)
    expect(useMemory?.checked).toBe(true)

    await click(useCache)
    await click(useMemory)

    await click(findBatchButton("Run"))
    await click(findBatchButton("Run"))

    expect(findCheckboxByLabel("Use cache")?.checked).toBe(false)
    expect(findCheckboxByLabel("Use memory")?.checked).toBe(false)

    await click(findBatchButton("Run Local"))

    const payloads = triggerRunMock.mock.calls.map(([payload]) => payload)
    expect(payloads).toHaveLength(2)
    expect(payloads).toEqual(expect.arrayContaining([
      { file: "tests/web/login.yaml", local: true, noCache: true, noMemory: true },
      { file: "tests/android/signup.yaml", local: true, noCache: true, noMemory: true },
    ]))
    expect(findBatchButton("Run Local")).toBeUndefined()
    expect(container?.textContent).toContain("2 selected")

    await click(findBatchButton("Clear queue"))
    expect(container?.querySelector('[data-testid="batch-actions"]')).toBeNull()
  })

  it("deletes selected tests from the shared bottom toolbar", async () => {
    await renderAt()

    await click(findRow("Login flow")?.querySelector('input[aria-label="Select row"]') as HTMLInputElement | null)
    await click(findRow("Signup flow")?.querySelector('input[aria-label="Select row"]') as HTMLInputElement | null)

    await click(findBatchButton("Delete"))

    expect(deleteTestFileMock).toHaveBeenCalledTimes(2)
    expect(deleteTestFileMock).toHaveBeenNthCalledWith(1, "test_login")
    expect(deleteTestFileMock).toHaveBeenNthCalledWith(2, "test_signup")
    expect(findRow("Login flow")).toBeUndefined()
    expect(findRow("Signup flow")).toBeUndefined()
    expect(container?.querySelector('[data-testid="batch-actions"]')).toBeNull()
  })
})
