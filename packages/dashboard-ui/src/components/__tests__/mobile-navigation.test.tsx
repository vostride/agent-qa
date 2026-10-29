// @vitest-environment jsdom
//
// G-433-7 / F-433-29 (433-31). The shipped app shell is mounted with the real SidebarProvider,
// SidebarInset and AppSidebar, so the control under test opens the same off-canvas sheet a phone
// user gets. Pages, the product tour, the palette and toasts are stand-ins; they are not under test.

import { act, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, fetchAppMetadata: vi.fn(async () => ({ version: "0.1.21" })) }
})
// Runs keeps its real shape where it matters here: a page-level bare Enter shortcut.
vi.mock("@/pages/runs", async () => {
  const { useKeyboardShortcuts } = await import("@/hooks/use-keyboard-shortcuts")
  return {
    default: () => {
      useKeyboardShortcuts({ enter: () => {} })
      return <div data-testid="runs-page" />
    },
  }
})
for (const page of [
  "tests", "hooks", "suites", "config", "run-detail", "live-run", "test-editor", "test-viewer",
  "hook-editor", "hook-viewer", "suite-editor", "suite-viewer", "insights",
]) {
  vi.doMock(`@/pages/${page}`, () => ({ default: () => <div data-testid={`${page}-page`} /> }))
}
vi.mock("@/components/theme-provider", () => ({
  ThemeProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  useTheme: () => ({ theme: "light", setTheme: () => {} }),
}))
vi.mock("@/components/product-tour", () => ({
  ProductTourProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  ProductTourOverlay: () => null,
  useProductTour: () => ({ restartTour: () => {} }),
}))
vi.mock("@/components/command-palette", () => ({ CommandPalette: () => null }))
vi.mock("@/components/ui/sonner", () => ({ Toaster: () => null }))

const TOP_LEVEL = ["Runs", "Tests", "Hooks", "Suites", "Insights", "Config"]

let container: HTMLDivElement | null = null
let root: Root | null = null
let originalFetch: typeof fetch
let originalWidth: number

function setWidth(width: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: width })
  window.matchMedia = ((media: string) => {
    const max = Number(/max-width:\s*(\d+)px/.exec(media)?.[1] ?? Infinity)
    return {
      matches: width <= max,
      media,
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent: () => true,
    }
  }) as unknown as typeof window.matchMedia
}

beforeEach(() => {
  originalWidth = window.innerWidth
  originalFetch = globalThis.fetch
  globalThis.fetch = vi.fn(async () => (
    { ok: true, status: 200, statusText: "OK", json: async () => ({}) } as unknown as Response
  )) as unknown as typeof fetch
  ;(globalThis as { EventSource?: unknown }).EventSource = class {
    addEventListener(): void {}
    close(): void {}
  }
})

afterEach(() => {
  act(() => { root?.unmount() })
  container?.remove()
  container = null
  root = null
  globalThis.fetch = originalFetch
  delete (globalThis as { EventSource?: unknown }).EventSource
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: originalWidth })
})

async function renderShellAt(path: string, width: number): Promise<void> {
  setWidth(width)
  vi.resetModules()
  window.history.pushState({}, "", path)
  const { default: App } = await import("@/app")
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => { root?.render(<App />) })
  await act(async () => {
    for (let i = 0; i < 6; i += 1) await Promise.resolve()
  })
  await vi.waitFor(() => { expect(document.querySelector('[data-testid="runs-page"]')).not.toBeNull() })
}

function navigationButtons(): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
    .filter((button) => /navigation/i.test(button.getAttribute("aria-label") ?? button.textContent ?? ""))
}

describe("a navigation control at narrow widths", () => {
  it("narrow layouts render an Open navigation button", async () => {
    await renderShellAt("/runs", 400)
    const buttons = navigationButtons()
    expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual(["Open navigation"])
    expect(buttons[0].closest('[data-slot="sidebar-inset"]'), "the control sits outside the layout's inset").not.toBeNull()
  })

  it("pressing it opens the navigation with the six top-level links", async () => {
    await renderShellAt("/runs", 400)
    const [button] = navigationButtons()
    expect(button, "no Open navigation button to press").toBeDefined()
    expect(document.querySelector('[role="dialog"]')).toBeNull()

    await act(async () => { button.click() })
    const dialog = await vi.waitFor(() => {
      const found = document.querySelector('[role="dialog"]')
      expect(found).not.toBeNull()
      return found!
    })
    const links = Array.from(dialog.querySelectorAll("a")).map((link) => (link.textContent ?? "").trim())
    for (const name of TOP_LEVEL) expect(links, `the open navigation has no ${name} link`).toContain(name)
    expect(button.getAttribute("aria-expanded")).toBe("true")
  })

  it("a page's bare Enter shortcut leaves Enter to the focused control", async () => {
    await renderShellAt("/runs", 400)
    const [button] = navigationButtons()
    expect(button, "no Open navigation button to press").toBeDefined()
    button.focus()
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })
    await act(async () => { button.dispatchEvent(enter) })
    expect(enter.defaultPrevented, "the Runs page's Enter shortcut cancelled Enter on the control").toBe(false)
  })

  it("wide layouts render no navigation button", async () => {
    await renderShellAt("/runs", 1280)
    expect(navigationButtons()).toEqual([])
    const links = Array.from(document.querySelectorAll('[data-slot="sidebar"] a')).map((link) => (link.textContent ?? "").trim())
    for (const name of TOP_LEVEL) expect(links, `the sidebar has no ${name} link`).toContain(name)
  })
})
