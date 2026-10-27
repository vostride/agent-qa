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
        open
        onOpenChange={() => {}}
        onUseCacheChange={() => {}}
        onRun={() => {}}
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

function runButtons(view: HTMLElement): HTMLButtonElement[] {
  return Array.from(view.querySelectorAll<HTMLButtonElement>('[data-testid="popover-content"] button'))
}

describe("TestRunOptionsPopover", () => {
  it("renders the queue summary, the cache toggle and one Run button", async () => {
    const view = await renderPopover()

    expect(view.textContent).toContain("3 selected")
    expect(view.textContent).toContain("1 hidden by filters")
    expect(view.textContent).toContain("Use cache")
    expect(runButtons(view).map((button) => button.textContent)).toEqual(["Run"])
  })

  it("runs and closes the popover when Run is clicked", async () => {
    const onRun = vi.fn()
    const onOpenChange = vi.fn()
    const view = await renderPopover({ onRun, onOpenChange })

    await act(async () => {
      runButtons(view)[0]!.click()
    })

    expect(onRun).toHaveBeenCalledTimes(1)
    expect(onRun).toHaveBeenCalledWith()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("does nothing when Run is clicked while disabled", async () => {
    const onRun = vi.fn()
    const onOpenChange = vi.fn()
    const view = await renderPopover({ onRun, onOpenChange, disabled: true })

    expect(runButtons(view)[0]!.disabled).toBe(true)
    await act(async () => {
      runButtons(view)[0]!.click()
    })

    expect(onRun).not.toHaveBeenCalled()
    expect(onOpenChange).not.toHaveBeenCalled()
  })
})
