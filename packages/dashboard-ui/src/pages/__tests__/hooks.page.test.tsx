// @vitest-environment jsdom

import { Children, act, cloneElement, isValidElement, type ButtonHTMLAttributes, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import HooksPage from "@/pages/hooks"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { fetchHookCatalogMock } = vi.hoisted(() => ({
  fetchHookCatalogMock: vi.fn(),
}))

vi.mock("@/lib/api", () => ({
  fetchHookCatalog: fetchHookCatalogMock,
}))

vi.mock("@/hooks/use-page-title", () => ({ usePageTitle: () => {} }))
vi.mock("@/hooks/use-keyboard-shortcuts", () => ({ useKeyboardShortcuts: () => {} }))
vi.mock("@/components/page-skeleton", () => ({ TableSkeleton: () => <div data-testid="skeleton" /> }))
vi.mock("@/components/empty-state", () => ({
  EmptyState: ({ title, description, actionLabel }: { title: string; description: string; actionLabel?: string }) => (
    <div>
      <div>{title}</div>
      <div>{description}</div>
      {actionLabel ? <button type="button">{actionLabel}</button> : null}
    </div>
  ),
}))
vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    className,
    type = "button",
    ...props
  }: {
    children: ReactNode
    onClick?: () => void
    className?: string
  } & ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type={type} className={className} onClick={onClick} {...props}>
      {children}
    </button>
  ),
}))
vi.mock("@/components/ui/input", () => ({
  Input: ({
    value,
    placeholder,
    onChange,
    className,
  }: {
    value?: string
    placeholder?: string
    onChange?: (event: React.ChangeEvent<HTMLInputElement>) => void
    className?: string
  }) => (
    <input
      value={value}
      placeholder={placeholder}
      onChange={onChange}
      className={className}
    />
  ),
}))
vi.mock("@/components/ui/select", () => ({
  Select: ({
    children,
    onValueChange,
  }: {
    children: ReactNode
    onValueChange?: (value: string) => void
  }) => (
    <div>
      {Children.map(children, (child) => {
        if (!isValidElement(child)) return child
        return cloneElement(child as any, { __onValueChange: onValueChange })
      })}
    </div>
  ),
  SelectTrigger: ({ children }: { children: ReactNode }) => <button type="button">{children}</button>,
  SelectValue: ({ placeholder }: { placeholder?: string }) => <span>{placeholder}</span>,
  SelectContent: ({
    children,
    __onValueChange,
  }: {
    children: ReactNode
    __onValueChange?: (value: string) => void
  }) => (
    <div>
      {Children.map(children, (child) => {
        if (!isValidElement(child)) return child
        return cloneElement(child as any, { __onValueChange })
      })}
    </div>
  ),
  SelectItem: ({
    children,
    value,
    __onValueChange,
  }: {
    children: ReactNode
    value: string
    __onValueChange?: (value: string) => void
  }) => (
    <button type="button" data-select-value={value} onClick={() => __onValueChange?.(value)}>
      {children}
    </button>
  ),
}))
vi.mock("@/components/ui/table", () => ({
  Table: ({ children }: { children: ReactNode }) => <table>{children}</table>,
  TableHeader: ({ children }: { children: ReactNode }) => <thead>{children}</thead>,
  TableBody: ({ children }: { children: ReactNode }) => <tbody>{children}</tbody>,
  TableRow: ({ children, ...props }: { children: ReactNode } & Record<string, unknown>) => <tr {...props}>{children}</tr>,
  TableHead: ({ children }: { children: ReactNode }) => <th>{children}</th>,
  TableCell: ({ children }: { children: ReactNode }) => <td>{children}</td>,
}))
vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}))
vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
}))
vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ScrollBar: () => null,
}))
vi.mock("@/components/shortcut-hints", () => ({
  ShortcutLegend: ({
    hints,
  }: {
    hints: Array<{ key: string; label: string }>
  }) => (
    <div>
      {hints.map((hint) => (
        <span key={hint.key}>
          {hint.key} {hint.label}
        </span>
      ))}
    </div>
  ),
}))

describe("HooksPage", () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    fetchHookCatalogMock.mockReset()
    fetchHookCatalogMock.mockResolvedValue({
      hooks: [
        {
          id: "h_amber-birch-coral-delta-ember-falcon-garden-harbor-island-jungle",
          name: "login",
          runtime: "node",
          file: "./scripts/login.js",
          timeout: 30000,
          network: true,
          fileMissing: false,
        },
        {
          id: "h_aster-bloom-cloud-drift-ember-field-glade-hollow-ivory-jasper",
          name: "setup",
          runtime: "bun",
          file: "./scripts/setup.ts",
          timeout: 15000,
          network: false,
          fileMissing: false,
        },
      ],
      filePath: "./hooks.yaml",
      errors: [],
      missing: false,
    })
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  async function renderPage() {
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)

    act(() => {
      root.render(
        <MemoryRouter initialEntries={["/hooks"]}>
          <HooksPage />
        </MemoryRouter>,
      )
    })

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }

  function findHeading(text: string) {
    return Array.from(container.querySelectorAll("h1")).find((heading) =>
      heading.textContent?.trim() === text,
    ) as HTMLHeadingElement | undefined
  }

  function getBodyRows() {
    return Array.from(container.querySelectorAll("tbody tr")) as HTMLTableRowElement[]
  }

  it("places Keyboard shortcuts beside Create Hook in the heading actions instead of the filter row", async () => {
    await renderPage()

    const heading = findHeading("Hooks")
    const headingRow = heading?.parentElement?.parentElement
    const filterRow = container.querySelector('input[placeholder="Search hooks"]')?.parentElement?.parentElement

    expect(headingRow?.className).toContain("justify-between")
    expect(headingRow?.querySelector('button[aria-label="Keyboard shortcuts"]')).toBeTruthy()
    expect(Array.from(headingRow?.querySelectorAll("button") ?? []).some((button) =>
      button.textContent?.includes("Create Hook"),
    )).toBe(true)
    expect(filterRow?.querySelector('button[aria-label="Keyboard shortcuts"]')).toBeNull()
  })

  it("renders the locked runtime lineup without TypeScript affordances", async () => {
    await renderPage()

    const cells = Array.from(container.querySelectorAll("td"))
    const buttonLabels = Array.from(container.querySelectorAll("button"))
      .map((button) => button.textContent?.trim())
      .filter((label): label is string => Boolean(label))

    expect(container.textContent).toContain("Hooks")
    expect(container.textContent).toContain("Create Hook")
    expect(container.querySelector('input[placeholder="Search hooks"]')).not.toBeNull()
    expect(container.textContent).toContain("Runtime")
    expect(container.textContent).toContain("Health")
    expect(container.textContent).toContain("login")
    expect(container.textContent).toContain("./scripts/login.js")
    expect(cells[1]?.textContent?.trim()).toBe("Node.js")
    expect(cells[5]?.textContent?.trim()).toBe("Bun")
    expect(container.textContent).toContain("Open in new tab")
    expect(container.textContent).not.toContain("h_amber-birch")
    expect(container.textContent).not.toContain("JS")
    expect(container.textContent).not.toContain("TypeScript")
    expect(buttonLabels).toEqual(expect.arrayContaining(["All runtimes", "Node.js", "Bun", "Python", "Bash"]))
  })

  it("filters rows by runtime without adding run or delete actions", async () => {
    await renderPage()

    await act(async () => {
      const runtimeButton = Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent === "Bun",
      )
      runtimeButton?.click()
      await Promise.resolve()
    })

    const buttonLabels = Array.from(container.querySelectorAll("button"))
      .map((button) => button.textContent?.trim())
      .filter((label): label is string => Boolean(label))

    expect(container.textContent).toContain("setup")
    expect(container.textContent).not.toContain("login")
    expect(buttonLabels).not.toContain("Run")
    expect(buttonLabels).not.toContain("Delete")
  })

  it("shows 50 hooks per page and paginates the remaining rows", async () => {
    fetchHookCatalogMock.mockResolvedValueOnce({
      hooks: Array.from({ length: 55 }, (_, index) => ({
        id: `h_${String(index + 1).padStart(3, "0")}`,
        name: `hook ${String(index + 1).padStart(3, "0")}`,
        runtime: "node",
        file: `./scripts/hook-${String(index + 1).padStart(3, "0")}.js`,
        timeout: 30000,
        network: true,
        fileMissing: false,
      })),
      filePath: "./hooks.yaml",
      errors: [],
      missing: false,
    })

    await renderPage()

    expect(getBodyRows()).toHaveLength(50)
    expect(getBodyRows()[0]?.textContent).toContain("hook 001")
    expect(getBodyRows()[49]?.textContent).toContain("hook 050")
    expect(container.textContent).toContain("Showing 1-50 of 55")
    expect(container.textContent).not.toContain("hook 051")

    await act(async () => {
      Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Next")?.click()
      await Promise.resolve()
    })

    expect(getBodyRows()).toHaveLength(5)
    expect(getBodyRows()[0]?.textContent).toContain("hook 051")
    expect(getBodyRows()[4]?.textContent).toContain("hook 055")
    expect(container.textContent).toContain("Showing 51-55 of 55")
    expect(container.textContent).not.toContain("hook 050")
  })
})
