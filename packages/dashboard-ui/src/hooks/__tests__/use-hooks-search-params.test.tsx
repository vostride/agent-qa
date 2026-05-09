// @vitest-environment jsdom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, useLocation } from "react-router"
import { afterEach, describe, expect, it } from "vitest"

import { useHooksSearchParams } from "@/hooks/use-hooks-search-params"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function Harness() {
  const location = useLocation()
  const {
    search,
    runtime,
    health,
    sorting,
    setSearch,
    setRuntime,
    setHealth,
    onSortingChange,
  } = useHooksSearchParams()

  return (
    <div>
      <div data-testid="state">
        {JSON.stringify({
          search,
          runtime,
          health,
          sorting,
          location: `${location.pathname}${location.search}`,
        })}
      </div>
      <button type="button" onClick={() => setSearch("login")}>set-search</button>
      <button type="button" onClick={() => setRuntime("python")}>set-runtime</button>
      <button type="button" onClick={() => setHealth("file-missing")}>set-health</button>
      <button type="button" onClick={() => onSortingChange([{ id: "name", desc: false }])}>sort-name</button>
      <button type="button" onClick={() => onSortingChange([{ id: "timeout", desc: true }])}>sort-timeout</button>
      <button type="button" onClick={() => onSortingChange([])}>clear-sort</button>
    </div>
  )
}

describe("useHooksSearchParams", () => {
  let container: HTMLDivElement
  let root: Root

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  function renderAt(url: string) {
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)

    act(() => {
      root.render(
        <MemoryRouter initialEntries={[url]}>
          <Harness />
        </MemoryRouter>,
      )
    })
  }

  it("reads canonical hook list params from the URL", async () => {
    renderAt("/hooks?search=login&runtime=node&health=file-missing&sort=name&order=desc")
    await act(async () => {
      await Promise.resolve()
    })

    expect(container.textContent).toContain('"search":"login"')
    expect(container.textContent).toContain('"runtime":"node"')
    expect(container.textContent).toContain('"health":"file-missing"')
    expect(container.textContent).toContain('"id":"name"')
    expect(container.textContent).toContain('"desc":true')
  })

  it("updates search, filters, and sort in the URL", async () => {
    renderAt("/hooks")

    await act(async () => {
      container.querySelector("button")?.click()
      await Promise.resolve()
    })
    await act(async () => {
      container.querySelectorAll("button")[1]?.click()
      await Promise.resolve()
    })
    await act(async () => {
      container.querySelectorAll("button")[2]?.click()
      await Promise.resolve()
    })
    await act(async () => {
      container.querySelectorAll("button")[3]?.click()
      await Promise.resolve()
    })

    expect(container.textContent).toContain('/hooks?search=login&runtime=python&health=file-missing&sort=name&order=asc')
  })

  it("removes sorting params when the sort state is cleared", async () => {
    renderAt("/hooks?sort=timeout&order=desc")

    await act(async () => {
      container.querySelectorAll("button")[5]?.click()
      await Promise.resolve()
    })

    expect(container.textContent).toContain('"sorting":[]')
    expect(container.textContent).toContain('"location":"/hooks"')
  })
})
