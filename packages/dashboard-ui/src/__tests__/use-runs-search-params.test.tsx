// @vitest-environment jsdom

import { act, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, Route, Routes, useLocation } from "react-router"
import { afterEach, describe, expect, it } from "vitest"

import { useRunsSearchParams } from "@/hooks/use-runs-search-params"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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

function HookHarness() {
  const state = useRunsSearchParams()
  return (
    <div>
      <LocationProbe />
      <div data-testid="state">
        {JSON.stringify({
          tab: state.tab,
          search: state.search,
          platform: state.platform,
          target: state.target,
          attributePredicates: state.attributePredicates,
          sort: state.sort,
          order: state.order,
          page: state.page,
        })}
      </div>
      <button type="button" onClick={() => state.setPage(4)}>Page 4</button>
      <button type="button" onClick={() => state.setSearch("signup")}>Search signup</button>
      <button type="button" onClick={() => state.setTarget("android-staging")}>Target android-staging</button>
      <button type="button" onClick={() => state.setAttributePredicates([{ key: "git.branch", value: "^(master|main)$", mode: "regex" }])}>Attribute regex</button>
      <button type="button" onClick={() => state.setTab("failed")}>Tab failed</button>
      <button
        type="button"
        onClick={() => state.onSortingChange([{ id: "createdAt", desc: false }])}
      >
        Sort started asc
      </button>
    </div>
  )
}

let container: HTMLDivElement | null = null
let root: Root | null = null

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

  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="/runs" element={<HookHarness />} />
        </Routes>
      </MemoryRouter>,
    )
  })

  await flushRender()
  return container
}

afterEach(() => {
  if (root) {
    act(() => root!.unmount())
  }
  root = null
  if (container) container.remove()
  container = null
})

describe("useRunsSearchParams", () => {
  it("reads the full canonical runs URL state contract", async () => {
    const view = await renderAt("/runs?tab=failed&search=login&platform=android&target=hn-staging&attributes[git.branch]=phase223-main&attributes[user.email][regex]=^CI$&sort=createdAt&order=asc&page=3")
    const state = JSON.parse(view.querySelector('[data-testid="state"]')!.textContent ?? "{}")

    expect(state).toEqual({
      tab: "failed",
      search: "login",
      platform: "android",
      target: "hn-staging",
      attributePredicates: [
        { key: "git.branch", value: "phase223-main", mode: "exact" },
        { key: "user.email", value: "^CI$", mode: "regex" },
      ],
      sort: "createdAt",
      order: "asc",
      page: 3,
    })
  })

  it("normalizes invalid/default params back to the clean default URL", async () => {
    const view = await renderAt("/runs?tab=bogus&page=0&order=bogus")

    expect(view.querySelector('[data-testid="location"]')?.getAttribute("data-search")).toBe("")
    const state = JSON.parse(view.querySelector('[data-testid="state"]')!.textContent ?? "{}")
    expect(state.tab).toBe("all")
    expect(state.page).toBe(1)
    expect(state.order).toBe("desc")
  })

  it("resets page to 1 when search and filters change, while keeping sort URL-driven", async () => {
    const view = await renderAt("/runs?page=4")

    await act(async () => {
      ;(view.querySelector("button:nth-of-type(5)") as HTMLButtonElement).click()
    })
    await flushRender()
    expect(view.querySelector('[data-testid="location"]')?.getAttribute("data-search")).toBe("?tab=failed")

    await act(async () => {
      ;(view.querySelector("button:nth-of-type(2)") as HTMLButtonElement).click()
    })
    await flushRender()
    expect(view.querySelector('[data-testid="location"]')?.getAttribute("data-search")).toBe("?tab=failed&search=signup")

    await act(async () => {
      ;(view.querySelector("button:nth-of-type(6)") as HTMLButtonElement).click()
    })
    await flushRender()
    expect(view.querySelector('[data-testid="location"]')?.getAttribute("data-search")).toBe("?tab=failed&search=signup&sort=createdAt&order=asc")

    await act(async () => {
      ;(view.querySelector("button:nth-of-type(3)") as HTMLButtonElement).click()
    })
    await flushRender()
    expect(view.querySelector('[data-testid="location"]')?.getAttribute("data-search")).toBe("?tab=failed&search=signup&target=android-staging&sort=createdAt&order=asc")

    await act(async () => {
      ;(view.querySelector("button:nth-of-type(4)") as HTMLButtonElement).click()
    })
    await flushRender()
    expect(view.querySelector('[data-testid="location"]')?.getAttribute("data-search")).toBe("?tab=failed&search=signup&target=android-staging&attributes%5Bgit.branch%5D%5Bregex%5D=%5E%28master%7Cmain%29%24&sort=createdAt&order=asc")
  })
})
