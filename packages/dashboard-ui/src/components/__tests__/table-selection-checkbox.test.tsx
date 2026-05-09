// @vitest-environment jsdom

import { act, useState, type ReactElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"

import { SelectionCheckboxCell } from "@/components/table-selection-checkbox"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement | null = null
let root: Root | null = null

function mount(element: ReactElement) {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)

  act(() => {
    root!.render(element)
  })
}

afterEach(() => {
  if (root) {
    act(() => {
      root!.unmount()
    })
  }
  root = null
  container?.remove()
  container = null
})

function StatefulHarness() {
  const [checked, setChecked] = useState(false)

  return (
    <SelectionCheckboxCell
      checked={checked}
      onCheckedChange={setChecked}
    />
  )
}

describe("SelectionCheckboxCell", () => {
  it("toggles when the select-cell hit area is clicked", () => {
    mount(<StatefulHarness />)

    const hitArea = container?.querySelector("[data-selection-checkbox-hit-area]") as HTMLDivElement | null
    const checkbox = container?.querySelector('button[aria-label="Select row"]') as HTMLButtonElement | null
    expect(hitArea).not.toBeNull()
    expect(checkbox).not.toBeNull()
    expect(checkbox?.getAttribute("data-state")).toBe("unchecked")

    act(() => {
      hitArea!.click()
    })

    expect(checkbox?.getAttribute("data-state")).toBe("checked")
  })

  it("does not bubble checkbox clicks to a parent row handler", () => {
    const parentClick = vi.fn()
    mount(
      <div onClick={parentClick}>
        <StatefulHarness />
      </div>,
    )

    const checkbox = container?.querySelector('button[aria-label="Select row"]') as HTMLButtonElement | null
    expect(checkbox).not.toBeNull()

    act(() => {
      checkbox!.click()
    })

    expect(parentClick).not.toHaveBeenCalled()
  })

  it("does not bubble checkbox focus to a parent row handler", () => {
    const parentFocus = vi.fn()
    mount(
      <div onFocus={parentFocus}>
        <StatefulHarness />
      </div>,
    )

    const checkbox = container?.querySelector('button[aria-label="Select row"]') as HTMLButtonElement | null
    expect(checkbox).not.toBeNull()

    act(() => {
      checkbox!.dispatchEvent(new FocusEvent("focusin", { bubbles: true }))
    })

    expect(parentFocus).not.toHaveBeenCalled()
  })

  it("selects on the first checkbox click even when browser focus lands first", () => {
    mount(<StatefulHarness />)

    const checkbox = container?.querySelector('button[aria-label="Select row"]') as HTMLButtonElement | null
    expect(checkbox).not.toBeNull()

    act(() => {
      checkbox!.dispatchEvent(new FocusEvent("focusin", { bubbles: true }))
      checkbox!.click()
    })

    expect(checkbox?.getAttribute("data-state")).toBe("checked")
  })

  it("keeps a 32px minimum invisible hit area around a size-4 checkbox", () => {
    mount(<StatefulHarness />)

    const hitArea = container?.querySelector("[data-selection-checkbox-hit-area]") as HTMLDivElement | null
    const checkbox = container?.querySelector('button[aria-label="Select row"]') as HTMLButtonElement | null

    expect(hitArea?.className).toContain("min-h-8")
    expect(hitArea?.className).toContain("min-w-8")
    expect(hitArea?.className).toContain("-my-1")
    expect(hitArea?.className).toContain("-mx-2")
    expect(checkbox?.className).toContain("size-4")
  })
})
