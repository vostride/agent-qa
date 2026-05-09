// @vitest-environment jsdom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const {
  deleteTestObservationMock,
  fetchTestObservationsMock,
  toastErrorMock,
  toastSuccessMock,
} = vi.hoisted(() => ({
  deleteTestObservationMock: vi.fn(),
  fetchTestObservationsMock: vi.fn(),
  toastErrorMock: vi.fn(),
  toastSuccessMock: vi.fn(),
}))

vi.mock("@/lib/api", () => ({
  deleteTestObservation: deleteTestObservationMock,
  fetchTestObservations: fetchTestObservationsMock,
}))
vi.mock("sonner", () => ({
  toast: {
    error: toastErrorMock,
    success: toastSuccessMock,
  },
}))
vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    className,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { children: React.ReactNode; className?: string }) => (
    <button type="button" onClick={onClick} className={className} {...props}>
      {children}
    </button>
  ),
}))
vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))
vi.mock("@/components/ui/alert-dialog", () => ({
  AlertDialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  AlertDialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogDescription: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogCancel: ({ children }: { children: React.ReactNode }) => <button type="button">{children}</button>,
  AlertDialogAction: ({
    children,
    onClick,
  }: {
    children: React.ReactNode
    onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void
  }) => <button type="button" onClick={onClick}>{children}</button>,
}))

import { MemoryObservationsPanel } from "@/components/memory-observations-panel"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

async function flushRender() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe("MemoryObservationsPanel", () => {
  beforeEach(() => {
    fetchTestObservationsMock.mockReset()
    deleteTestObservationMock.mockReset()
    toastErrorMock.mockReset()
    toastSuccessMock.mockReset()

    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  async function renderPanel() {
    await act(async () => {
      root.render(<MemoryObservationsPanel testId="t_alpha" />)
    })
    await flushRender()
  }

  it("renders title plus markdown body and shows a compact invalid-file warning without hiding valid observations", async () => {
    fetchTestObservationsMock.mockResolvedValue({
      observations: [
        {
          id: "obs_security-page",
          title: "Security page: recovery codes are below the fold",
          content: "The recovery code panel is **below the fold**.\n\nScroll past the account summary before it becomes visible.",
          trust: 0.82,
          created: "2026-04-18T08:00:00.000Z",
          last_confirmed: "2026-04-20T08:00:00.000Z",
          confirmed_count: 2,
          contradicted_count: 0,
          source_test: "t_alpha",
        },
      ],
      invalidFiles: [
        {
          scope: "test",
          scopeId: "t_alpha",
          filename: "obs_legacy-titleless.md",
          code: "parse_error",
          message: "Invalid observation frontmatter: title is required.",
        },
      ],
    })

    await renderPanel()

    expect(container.textContent).toContain("Security page: recovery codes are below the fold")
    expect(container.textContent).toContain("The recovery code panel is below the fold.")
    expect(container.textContent).not.toContain("**below the fold**")
    expect(container.textContent).toContain("1 invalid memory file hidden from this panel.")
    expect(container.textContent).toContain("obs_legacy-titleless.md")
  })

  it("keeps delete behavior intact after title and markdown adoption", async () => {
    fetchTestObservationsMock.mockResolvedValue({
      observations: [
        {
          id: "obs_security-page",
          title: "Security page: recovery codes are below the fold",
          content: "The recovery code panel is **below the fold**.",
          trust: 0.82,
          created: "2026-04-18T08:00:00.000Z",
          last_confirmed: "2026-04-20T08:00:00.000Z",
          confirmed_count: 2,
          contradicted_count: 0,
          source_test: "t_alpha",
        },
      ],
      invalidFiles: [],
    })
    deleteTestObservationMock.mockResolvedValue({ deleted: true })

    await renderPanel()

    const deleteButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Delete Observation",
    ) as HTMLButtonElement | undefined
    expect(deleteButton).toBeTruthy()

    await act(async () => {
      deleteButton?.click()
      await Promise.resolve()
    })
    await flushRender()

    expect(deleteTestObservationMock).toHaveBeenCalledWith("t_alpha", "obs_security-page")
    expect(container.textContent).not.toContain("Security page: recovery codes are below the fold")
    expect(toastSuccessMock).toHaveBeenCalledWith("Observation deleted")
  })
})
