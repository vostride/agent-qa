// @vitest-environment jsdom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("@/components/split-button", () => ({
  SplitButton: () => <div data-testid="split-button">split-button</div>,
}))

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    className,
    onClick,
    disabled,
    ...props
  }: {
    children: React.ReactNode
    className?: string
    onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void
    disabled?: boolean
    "aria-label"?: string
    title?: string
  }) => (
    <button type="button" className={className} onClick={onClick} disabled={disabled} {...props}>
      {children}
    </button>
  ),
}))

import { BatchActionBar } from "@/components/batch-action-bar"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement | null = null
let root: Root | null = null

async function renderBar(
  props: Partial<React.ComponentProps<typeof BatchActionBar>> = {},
) {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)

  await act(async () => {
    root!.render(
      <BatchActionBar
        selectedCount={2}
        onRun={() => {}}
        onRunNoCache={() => {}}
        onCancel={() => {}}
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

describe("BatchActionBar", () => {
  it("keeps the legacy split-button launcher when no custom action slot is provided", async () => {
    const view = await renderBar()

    expect(view.textContent).toContain("2 selected")
    expect(view.querySelector('[data-testid="split-button"]')).not.toBeNull()
    expect(view.textContent).toContain("Cancel")
  })

  it("renders summary meta, a custom action slot, and an icon-only clear action for tests-page mode", async () => {
    const view = await renderBar({
      summaryMeta: "1 hidden by filters",
      secondaryIcon: <span aria-hidden="true">x</span>,
      secondaryAriaLabel: "Clear queue",
      actionSlot: <button type="button">Run</button>,
    })

    const shell = view.querySelector(".fixed") as HTMLDivElement | null
    const clearButton = view.querySelector('button[aria-label="Clear queue"]')

    expect(view.textContent).toContain("1 hidden by filters")
    expect(view.textContent).toContain("Run")
    expect(clearButton?.textContent).toContain("x")
    expect(view.querySelector('[data-testid="split-button"]')).toBeNull()
    expect(shell?.className).toContain("rounded-md")
    expect(shell?.className).toContain("w-max")
    expect(shell?.className).not.toContain("w-[min(22rem,calc(100vw-1rem))]")
    expect(shell?.className).not.toContain("rounded-lg")
    expect(shell?.className).not.toContain("backdrop-blur")
  })

  it("renders a shared delete action alongside custom toolbar actions", async () => {
    const onDelete = vi.fn()
    const view = await renderBar({
      actionSlot: <button type="button">Run</button>,
      onDelete,
    })

    const deleteButton = Array.from(view.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Delete"),
    ) as HTMLButtonElement | undefined

    expect(deleteButton).toBeTruthy()

    await act(async () => {
      deleteButton?.click()
    })

    expect(onDelete).toHaveBeenCalledTimes(1)
  })
})
