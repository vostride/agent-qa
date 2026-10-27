// @vitest-environment jsdom

import { act, type MouseEvent, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"

import { SplitButton } from "@/components/split-button"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock("@/components/shortcut-hints", () => ({
  ShortcutKey: ({ shortcut }: { shortcut: string }) => <span>{shortcut}</span>,
}))

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    ...props
  }: {
    children: ReactNode
    onClick?: (event: MouseEvent<HTMLButtonElement>) => void
  } & React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" onClick={onClick} {...props}>
      {children}
    </button>
  ),
}))

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({
    children,
    onClick,
  }: {
    children: ReactNode
    onClick?: (event: MouseEvent<HTMLButtonElement>) => void
  }) => (
    <button type="button" data-menu-item onClick={onClick}>
      {children}
    </button>
  ),
}))

let container: HTMLDivElement
let root: Root

function mount(props: Partial<React.ComponentProps<typeof SplitButton>> = {}) {
  const onRun = vi.fn()
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root.render(<SplitButton onRun={onRun} {...props} />)
  })
  return onRun
}

function click(button: Element | undefined) {
  act(() => {
    button?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
  })
}

function menuItems(): string[] {
  return Array.from(container.querySelectorAll("[data-menu-item]")).map((item) => item.textContent ?? "")
}

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  vi.clearAllMocks()
})

describe("SplitButton", () => {
  it("is a plain Run button that calls onRun with no argument when no cache action is passed", () => {
    const onRun = mount()
    const buttons = Array.from(container.querySelectorAll("button"))

    expect(buttons.map((button) => button.textContent)).toEqual(["Run"])
    click(buttons[0])

    expect(onRun).toHaveBeenCalledTimes(1)
    expect(onRun).toHaveBeenCalledWith()
  })

  it("lists exactly the cache actions a page passes, starting with Run without cache", () => {
    mount({ onPurgeCache: vi.fn() })
    expect(menuItems()).toEqual(["Purge all cached plans"])
    act(() => {
      root.unmount()
    })
    container.remove()

    const onRunNoCache = vi.fn()
    const onPurgeCache = vi.fn()
    const onRun = mount({ onRunNoCache, onPurgeCache })
    expect(menuItems()).toEqual(["Run without cache", "Purge all cached plans"])

    click(container.querySelector("[data-menu-item]") ?? undefined)
    expect(onRunNoCache).toHaveBeenCalledTimes(1)
    expect(onRunNoCache).toHaveBeenCalledWith()

    click(Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Run"))
    expect(onRun).toHaveBeenCalledWith()
  })
})
