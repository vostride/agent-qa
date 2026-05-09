// @vitest-environment jsdom

import { act, useState } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it } from "vitest"

import { useSelectionQueue } from "@/hooks/use-selection-queue"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

interface QueueItem {
  id: string
}

function QueueHarness() {
  const [items] = useState<QueueItem[]>([
    { id: "run-1" },
    { id: "run-2" },
    { id: "run-3" },
  ])
  const [visibleIds, setVisibleIds] = useState<string[]>(items.map((item) => item.id))
  const queue = useSelectionQueue({
    items,
    getId: (item) => item.id,
    visibleIds,
  })

  return (
    <div>
      <div data-testid="selected-ids">{queue.selectedIds.join(",")}</div>
      <div data-testid="selected-count">{String(queue.selectedCount)}</div>
      <div data-testid="hidden-count">{String(queue.hiddenCount)}</div>
      <button type="button" onClick={() => queue.setItemSelected(items[0]!, true)}>
        Select 1
      </button>
      <button type="button" onClick={() => queue.setItemsSelected([items[1]!, items[2]!], true)}>
        Select 2 and 3
      </button>
      <button type="button" onClick={() => setVisibleIds(["run-1"])}>
        Show 1
      </button>
      <button type="button" onClick={() => setVisibleIds(items.map((item) => item.id))}>
        Show all
      </button>
      <button type="button" onClick={() => queue.clearSelection()}>
        Clear
      </button>
    </div>
  )
}

let container: HTMLDivElement | null = null
let root: Root | null = null

async function renderHarness() {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)

  await act(async () => {
    root!.render(<QueueHarness />)
  })

  return container
}

async function click(label: string) {
  const button = Array.from(container?.querySelectorAll("button") ?? []).find((candidate) =>
    candidate.textContent === label,
  ) as HTMLButtonElement | undefined
  expect(button).toBeTruthy()
  await act(async () => {
    button!.click()
  })
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

describe("useSelectionQueue", () => {
  it("keeps selected ids stable when the visible id set changes and reports hidden counts truthfully", async () => {
    await renderHarness()

    await click("Select 1")
    await click("Select 2 and 3")

    expect(container?.querySelector('[data-testid="selected-ids"]')?.textContent).toBe("run-1,run-2,run-3")
    expect(container?.querySelector('[data-testid="hidden-count"]')?.textContent).toBe("0")

    await click("Show 1")

    expect(container?.querySelector('[data-testid="selected-ids"]')?.textContent).toBe("run-1,run-2,run-3")
    expect(container?.querySelector('[data-testid="hidden-count"]')?.textContent).toBe("2")

    await click("Show all")

    expect(container?.querySelector('[data-testid="hidden-count"]')?.textContent).toBe("0")
  })

  it("clears the queue without mutating visible state", async () => {
    await renderHarness()

    await click("Select 1")
    await click("Show 1")
    await click("Clear")

    expect(container?.querySelector('[data-testid="selected-count"]')?.textContent).toBe("0")
    expect(container?.querySelector('[data-testid="hidden-count"]')?.textContent).toBe("0")
  })
})
