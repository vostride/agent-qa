// @vitest-environment jsdom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <div data-testid="popover-root">{children}</div>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <div data-testid="popover-trigger">{children}</div>,
  PopoverContent: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div data-testid="popover-content" className={className}>
      {children}
    </div>
  ),
}))

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    className,
    disabled,
    onClick,
  }: {
    children: React.ReactNode
    className?: string
    disabled?: boolean
    onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void
  }) => (
    <button type="button" className={className} disabled={disabled} onClick={onClick}>
      {children}
    </button>
  ),
}))

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div data-testid="dropdown-root">{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <div data-testid="dropdown-trigger">{children}</div>,
  DropdownMenuContent: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div data-testid="dropdown-content" className={className}>
      {children}
    </div>
  ),
  DropdownMenuItem: ({
    children,
    disabled,
    onClick,
  }: {
    children: React.ReactNode
    disabled?: boolean
    onClick?: () => void
  }) => (
    <div
      data-testid="dropdown-item"
      data-disabled={disabled ? "true" : "false"}
      onClick={onClick}
    >
      {children}
    </div>
  ),
}))

vi.mock("@/components/ui/checkbox", () => ({
  Checkbox: ({ checked }: { checked?: boolean }) => (
    <input type="checkbox" checked={checked} readOnly />
  ),
}))

vi.mock("@/components/ui/separator", () => ({
  Separator: () => <hr />,
}))

import { TestRunOptionsPopover } from "@/components/test-run-options-popover"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement | null = null
let root: Root | null = null

async function renderPopover(
  props: Partial<React.ComponentProps<typeof TestRunOptionsPopover>> = {},
) {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)

  await act(async () => {
    root!.render(
      <TestRunOptionsPopover
        selectedCount={3}
        hiddenCount={1}
        useCache
        useMemory
        browserStackAvailable
        open
        onOpenChange={() => {}}
        onUseCacheChange={() => {}}
        onUseMemoryChange={() => {}}
        onRunLocal={() => {}}
        onRunBrowserStack={() => {}}
        {...props}
      />,
    )
  })

  return document.body
}

afterEach(() => {
  if (root) {
    act(() => root!.unmount())
  }
  root = null
  if (container) container.remove()
  container = null
  document.body.innerHTML = ""
})

describe("TestRunOptionsPopover", () => {
  it("renders the queue summary, runtime toggles, and a primary run dropdown", async () => {
    const view = await renderPopover()
    const dropdownItems = Array.from(view.querySelectorAll('[data-testid="dropdown-item"]'))

    expect(view.textContent).toContain("3 selected")
    expect(view.textContent).toContain("1 hidden by filters")
    expect(view.textContent).toContain("Use cache")
    expect(view.textContent).toContain("Use memory")
    expect(view.querySelector('[data-testid="dropdown-trigger"]')?.textContent).toContain("Run")
    expect(dropdownItems).toHaveLength(2)
    expect(dropdownItems[0]?.textContent).toContain("Run Local")
    expect(dropdownItems[1]?.textContent).toContain("Run on BrowserStack")
  })

  it("keeps BrowserStack in the dropdown but disabled with explanatory copy when unavailable", async () => {
    const view = await renderPopover({ browserStackAvailable: false })
    const browserStackItem = Array.from(view.querySelectorAll('[data-testid="dropdown-item"]')).find(
      (item) => item.textContent?.includes("Run on BrowserStack"),
    ) as HTMLDivElement | undefined

    expect(browserStackItem?.dataset.disabled).toBe("true")
    expect(view.textContent).toContain("BrowserStack is unavailable in the current config.")
  })
})
