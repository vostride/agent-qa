// @vitest-environment jsdom

// The banner shows the stored summary as text; the clipboard carries exactly the sentence shown.

import { act, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  FAILURE_BANNER_PREVIEW_WORDS,
  FailureBanner,
} from "@/components/run-detail/failure-banner"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const INSIDE_MARKER = "[secret:CONTACT_ADDRESS]"
const PAST_MARKER = "[secret:OPERATOR_TOKEN]"

// Derived from `FAILURE_BANNER_PREVIEW_WORDS`, so a budget change moves the markers with it.
const INSIDE_ORDINAL = FAILURE_BANNER_PREVIEW_WORDS - 2
const PAST_ORDINAL = FAILURE_BANNER_PREVIEW_WORDS + 6
const SUMMARY_WORDS = FAILURE_BANNER_PREVIEW_WORDS + 10

/** The summary's LAST word — past the budget, so no cell may find it in the preview. */
const LAST_WORD = `w${String(SUMMARY_WORDS)}`

/** A summary of {@link SUMMARY_WORDS} words carrying both markers at the ordinals above. */
function summaryOverTheBudget(): string {
  const parts: string[] = []
  for (let ordinal = 1; ordinal <= SUMMARY_WORDS; ordinal += 1) {
    if (ordinal === INSIDE_ORDINAL) parts.push(INSIDE_MARKER)
    else if (ordinal === PAST_ORDINAL) parts.push(PAST_MARKER)
    else parts.push(`w${String(ordinal)}`)
  }
  return parts.join(" ")
}

let container: HTMLDivElement | null = null
let root: Root | null = null

function mount(node: ReactNode): HTMLDivElement {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root!.render(node)
  })
  return container
}

function stateOf(view: HTMLDivElement): string | null {
  return view.querySelector("[data-failure-banner]")?.getAttribute("data-failure-banner-state") ?? null
}

function toggleOf(view: HTMLDivElement): HTMLButtonElement | null {
  return view.querySelector<HTMLButtonElement>("[data-failure-banner-toggle]")
}

/** The sentence the banner is actually showing — the medium `data-failure-banner-state` describes. */
function textOf(view: HTMLDivElement): string {
  return view.querySelector("[data-failure-banner-text]")?.textContent ?? ""
}

function copyOf(view: HTMLDivElement): HTMLButtonElement | null {
  return view.querySelector<HTMLButtonElement>("[data-failure-banner-copy]")
}

/** What the last copy attempt did, as the button records it — `idle`, `copied` or `failed`. */
function copyStatusOf(view: HTMLDivElement): string | null {
  return copyOf(view)?.getAttribute("data-copy-status") ?? null
}

/** What the live region is currently announcing — empty until an attempt has been made. */
function announcementOf(view: HTMLDivElement): string {
  return view.querySelector("[data-failure-banner-copy-status]")?.textContent ?? ""
}

/**
 * A clipboard the copy cells can read back.
 *
 * `navigator` IS SHARED ACROSS EVERY CELL IN THIS FILE, so the stub is torn down in `afterEach`
 * below rather than left standing. jsdom implements no `navigator.clipboard`, and a cell that
 * asserts the ABSENCE of the API — the one directly below — would silently see a previous cell's
 * leftover stub and pass while measuring nothing.
 */
function stubClipboard(): ReturnType<typeof vi.fn<(text: string) => Promise<void>>> {
  const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined)
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true })
  return writeText
}

/** Whatever `navigator.clipboard` was before any cell in this file touched it (jsdom: nothing). */
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard")

function restoreClipboard(): void {
  if (originalClipboard === undefined) delete (navigator as { clipboard?: unknown }).clipboard
  else Object.defineProperty(navigator, "clipboard", originalClipboard)
}

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  container?.remove()
  container = null
  restoreClipboard()
})

describe("FailureBanner", () => {
  it("shows only the markers inside the preview budget, as text, while truncated", () => {
    const view = mount(<FailureBanner summary={summaryOverTheBudget()} />)

    expect(stateOf(view)).toBe("truncated")
    // AND THE STATE IS CHECKED AGAINST THE TEXT. `truncated` was once a compile-time constant of
    // this component — derived from the toggle's `useState(false)`, so it read `truncated` on first
    // paint for every input, including one whose truncation had been deleted outright. These two
    // assertions are the fact the attribute claims: the last word of the summary is NOT on the page,
    // and the helper's ellipsis is. Without them the line above asserts `useState`.
    expect(textOf(view)).not.toContain(LAST_WORD)
    expect(textOf(view).endsWith("...")).toBe(true)
    expect(textOf(view)).toContain(INSIDE_MARKER)
    expect(textOf(view)).not.toContain(PAST_MARKER)
    expect(view.querySelector("[data-masked]")).toBeNull()
  })

  it("shows both markers as text once expanded, and returns to the preview when toggled back", () => {
    const view = mount(<FailureBanner summary={summaryOverTheBudget()} />)

    const toggle = toggleOf(view)
    expect(toggle).not.toBeNull()
    act(() => { toggle!.click() })

    expect(stateOf(view)).toBe("full")
    expect(textOf(view)).toBe(summaryOverTheBudget())
    expect(view.querySelector("[data-masked]")).toBeNull()

    act(() => { toggleOf(view)!.click() })
    expect(stateOf(view)).toBe("truncated")
    expect(textOf(view)).not.toContain(PAST_MARKER)
  })

  it("offers no toggle for a summary that was never over the budget, and shows all of it", () => {
    const short = `Step 1/1 "probe" failed: ${INSIDE_MARKER} and nothing else`
    const view = mount(<FailureBanner summary={short} />)

    expect(toggleOf(view)).toBeNull()
    // FULL, ON FIRST PAINT, WITH NOTHING PRESSED. Nothing was cut, so the banner is showing the
    // whole sentence — and the attribute a DOM cell reads to name which claim it is making has to
    // say so. This is the cell that reds if the state is ever derived from the toggle again.
    expect(stateOf(view)).toBe("full")
    expect(textOf(view)).toBe(short)
    expect(view.querySelector("[data-masked]")).toBeNull()
  })

  it("old marker text renders as written", () => {
    // An old run's stored text can hold a numbered placeholder or a fenced marker; both show as is.
    const old = `Step 1/1 "probe" failed: token <SECRET_1> and ␟masked:secret␟ stay as stored`
    const view = mount(<FailureBanner summary={old} />)

    expect(textOf(view)).toBe(old)
    expect(textOf(view)).toContain("<SECRET_1>")
    expect(textOf(view)).toContain("␟masked:secret␟")
    expect(view.querySelector("[data-masked]")).toBeNull()
  })

  it("writes only the PREVIEW to the clipboard while the banner is collapsed", async () => {
    const writeText = stubClipboard()

    const view = mount(<FailureBanner summary={summaryOverTheBudget()} />)
    await act(async () => { copyOf(view)!.click() })

    expect(writeText).toHaveBeenCalledTimes(1)
    expect(copyStatusOf(view)).toBe("copied")
    const written = writeText.mock.calls[0]![0]

    // WHAT WAS RENDERED, AND NOT ONE WORD MORE. The banner is showing `FAILURE_BANNER_PREVIEW_WORDS`
    // words; the second marker and the summary's last word are both past that budget, and neither is
    // on the page. A clipboard that carries them is carrying text this reader was never shown.
    expect(written).toBe(textOf(view))
    expect(written).not.toContain(LAST_WORD)
    expect(written).not.toContain(PAST_MARKER)
    expect(written).toContain("w1 ")
    expect(written).toContain(INSIDE_MARKER)
    expect(written.endsWith("...")).toBe(true)
  })

  it("writes the whole summary once the banner has been expanded", async () => {
    const writeText = stubClipboard()

    const view = mount(<FailureBanner summary={summaryOverTheBudget()} />)
    act(() => { toggleOf(view)!.click() })
    await act(async () => { copyOf(view)!.click() })

    expect(writeText).toHaveBeenCalledTimes(1)
    expect(copyStatusOf(view)).toBe("copied")
    const written = writeText.mock.calls[0]![0]

    // EXPANDED, THE PAGE CARRIES THE WHOLE SENTENCE, SO THE CLIPBOARD DOES TOO. The rule is not
    // "copy less"; it is "copy what was rendered" — a copy button stuck on the preview would give a
    // reader a bug report missing the half of the sentence they opened the banner to read.
    expect(written).toBe(summaryOverTheBudget())
    expect(written).toBe(textOf(view))
  })

  // A rejected write and a non-secure context neither show a check mark nor throw from the click.

  it("does not claim success when the clipboard write rejects", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>()
      .mockRejectedValue(new DOMException("Document is not focused", "NotAllowedError"))
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true })

    const view = mount(<FailureBanner summary={summaryOverTheBudget()} />)
    await act(async () => { copyOf(view)!.click() })

    expect(writeText).toHaveBeenCalledTimes(1)
    expect(copyStatusOf(view)).toBe("failed")
  })

  it("neither throws nor claims success when there is no clipboard API at all", async () => {
    // A NON-SECURE CONTEXT, WHICH IS WHAT jsdom ALREADY IS. `restoreClipboard` in `afterEach` puts
    // the property back exactly as this environment had it — absent — so this cell is measuring the
    // real shape of the API rather than a stub some earlier cell forgot to take away.
    expect((navigator as { clipboard?: unknown }).clipboard).toBeUndefined()

    const view = mount(<FailureBanner summary={summaryOverTheBudget()} />)
    await act(async () => { copyOf(view)!.click() })

    expect(copyStatusOf(view)).toBe("failed")
  })

  it("names the copy button and announces both outcomes in a live region", async () => {
    const view = mount(<FailureBanner summary={summaryOverTheBudget()} />)

    // A NAME, WHICH `title` IS NOT. `title` is a tooltip; the accessible name is what a screen
    // reader reads when the button takes focus, and without it the control announced as "button".
    expect(copyOf(view)!.getAttribute("aria-label")).toBe("Copy failure summary")

    // AND A REGION THAT IS PRESENT FROM FIRST PAINT, EMPTY. A live region inserted at the same
    // moment its text appears is frequently not announced; this one exists before the click and
    // only its contents change.
    const region = view.querySelector("[data-failure-banner-copy-status]")
    expect(region).not.toBeNull()
    expect(region!.getAttribute("aria-live")).toBe("polite")
    expect(region!.getAttribute("role")).toBe("status")
    expect(announcementOf(view)).toBe("")

    const writeText = stubClipboard()
    await act(async () => { copyOf(view)!.click() })
    expect(announcementOf(view)).toContain("copied")
    expect(writeText).toHaveBeenCalledTimes(1)
  })

  it("announces the failure too, rather than only swapping an icon", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>()
      .mockRejectedValue(new DOMException("Document is not focused", "NotAllowedError"))
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true })

    const view = mount(<FailureBanner summary={summaryOverTheBudget()} />)
    await act(async () => { copyOf(view)!.click() })

    expect(announcementOf(view)).toContain("Could not copy")
  })

  // Feeding markup and finding no element is the only assertion that keeps the text a text node.
  it("renders a summary containing markup as text, never as an element", () => {
    const view = mount(<FailureBanner summary={'<img src=x onerror="alert(1)">'} />)

    expect(view.querySelector("img")).toBeNull()
    expect(view.querySelector("[data-failure-banner-text]")?.textContent)
      .toBe('<img src=x onerror="alert(1)">')
  })
})
