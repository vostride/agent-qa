// @vitest-environment jsdom

import { act, type MouseEvent, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"

import { SplitButton } from "@/components/split-button"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock("@/hooks/use-run-config", () => ({
  useRunConfig: () => ({ defaultRunMode: "farm", hasFarm: true, isLoading: false }),
}))

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
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
  DropdownMenuSeparator: () => <hr />,
}))

let container: HTMLDivElement
let root: Root

function mount(onRun = vi.fn()) {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root.render(<SplitButton onRun={onRun} />)
  })
  return onRun
}

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  vi.clearAllMocks()
})

describe("SplitButton", () => {
  it("keeps the primary dashboard run local even when farm is configured", () => {
    const onRun = mount()
    const primaryRunButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Run") && !button.textContent?.includes("Run Local"),
    )

    act(() => {
      primaryRunButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    })

    expect(onRun).toHaveBeenCalledWith(true)
  })
})
