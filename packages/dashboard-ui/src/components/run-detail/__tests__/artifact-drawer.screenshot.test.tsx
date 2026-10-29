// @vitest-environment jsdom
import { act, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"

import { PlayerLightbox } from "@/components/run-detail/player-lightbox"
import { ArtifactDrawer } from "@/components/run-detail/artifact-drawer"
import { routes } from "@/lib/routes"
import { EVIDENCE_INCOMPLETE_LABEL } from "@/lib/run-detail-view"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock("@/components/screenshot-viewer", () => ({
  ScreenshotViewer: ({ src, onUnavailable }: { src: string; onUnavailable?: () => void }) => (
    <img data-testid="screenshot-viewer" src={src} onError={() => onUnavailable?.()} />
  ),
}))

// The sheet is a portal in production; rendered inline here so the cells can read the subtree they
// mounted rather than hunting `document.body`. The TABS are the real ones on purpose — "only the
// active tab's content is mounted" is a property these cells depend on.
vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SheetContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SheetHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SheetTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  SheetDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
}))

vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))

const RUN_ID = "run-406-08"
const SHA = "c".repeat(64)

const RUN = {
  id: RUN_ID,
  name: "Checkout suite",
  filePath: "tests/checkout.yaml",
  status: "failed",
  duration: 10000,
  attributes: {},
  environment: null,
  metadata: null,
  startedAt: "2026-08-28T00:00:00.000Z",
  endedAt: "2026-08-28T00:00:10.000Z",
  failureSummary: null,
  errorLog: null,
  testId: null,
  suiteId: null,
  platform: "web",
  testFileContent: null,
  modelName: null,
  llmProvider: null,
  attemptNumber: 1,
  retryCount: 0,
  maxRetries: 0,
  createdAt: "2026-08-28T00:00:00.000Z",
}

let container: HTMLDivElement
let root: Root

function mountDrawer(over: {
  tab?: "test" | "config"
  screenshotSha?: string | null
} = {}) {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root.render(
      <ArtifactDrawer
        run={RUN as never}
        open
        tab={over.tab ?? "test"}
        {...{ screenshotSha: over.screenshotSha === undefined ? SHA : over.screenshotSha }}
        response={null}
        loading={false}
        error={null}
        onOpenChange={() => {}}
        onTabChange={() => {}}
        onRetry={() => {}}
      />,
    )
  })
  return container
}

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
})

function mountLightbox() {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root.render(<PlayerLightbox runId={RUN_ID} sha={SHA} open onOpenChange={() => {}} />))
  return document.querySelector('[data-player-lightbox]')!
}

afterEach(() => { vi.unstubAllGlobals() })

describe('the lightbox opens what the verdict cited', () => {
  it('mints its image src through the ONE route minter and nothing else', () => {
    const lightbox = mountLightbox()
    expect(lightbox.querySelector('img')?.getAttribute('src')).toBe(routes.runArtifact(RUN_ID, SHA))
    expect(lightbox.querySelector('[data-artifact-state="available"]')).not.toBeNull()
  })

  it('offers only the record-fed tabs even when a sha was clicked', () => {
    const drawer = mountDrawer()
    expect(drawer.querySelector('[data-artifact-drawer-tab="screenshot"]')).toBeNull()
    expect([...drawer.querySelectorAll('[role="tab"]')].map(tab => tab.textContent)).toEqual(['Test', 'Config'])
    expect(drawer.textContent).not.toContain('Memory')
  })

  it('paints the ONE absence component when the cited sha has no bytes to open', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 404 }))
    const lightbox = mountLightbox()
    await act(async () => { lightbox.querySelector('img')!.dispatchEvent(new Event('error')) })
    expect(lightbox.querySelector('[data-evidence-kind="frame"][data-evidence-state="unavailable"][data-evidence-incomplete]')).not.toBeNull()
    expect(lightbox.textContent).toContain(EVIDENCE_INCOMPLETE_LABEL)
    expect(lightbox.querySelector('img')).toBeNull()
  })

  it('says so when the blob vanished BETWEEN the read and the click', async () => {
    const fetch = vi.fn().mockResolvedValue({ status: 404 })
    vi.stubGlobal('fetch', fetch)
    const lightbox = mountLightbox()
    expect(lightbox.querySelector('[data-evidence-incomplete]')).toBeNull()
    await act(async () => { lightbox.querySelector('img')!.dispatchEvent(new Event('error')) })
    expect(fetch).toHaveBeenCalledWith(routes.runArtifact(RUN_ID, SHA), expect.objectContaining({ method: 'GET', headers: { Range: 'bytes=0-0' } }))
    expect(lightbox.querySelector('[data-artifact-state="unavailable"]')).not.toBeNull()
    expect(lightbox.querySelector('[data-evidence-state="unavailable"][data-evidence-incomplete]')).not.toBeNull()
    expect(lightbox.querySelector('img')).toBeNull()
  })

  it('DRAWER-NO-SCREENSHOT-TAB offers exactly Test and Config', () => {
    const drawer = mountDrawer({ tab: 'config' })
    expect([...drawer.querySelectorAll('[role="tab"]')].map(tab => tab.textContent)).toEqual(['Test', 'Config'])
    expect(drawer.querySelector('[data-artifact-drawer-tab="screenshot"]')).toBeNull()
  })
})
