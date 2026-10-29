// @vitest-environment jsdom

// A step reference's accessible name and its producer text.

import { act, type ReactElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"

import { KnowledgeStepRef, KnowledgeStepRefs } from "@/components/run-detail/knowledge-step-ref"
import {
  formatStepRefs,
  stepRefAccessibleName,
  type StepAddress,
  type StepRefContext,
} from "@/lib/knowledge-view"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
let container: HTMLDivElement | undefined

afterEach(() => {
  if (root) act(() => { root?.unmount() })
  container?.remove()
  root = undefined
  container = undefined
})

function mount(element: ReactElement): HTMLElement {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => { root?.render(element) })
  return container
}

function context(testNames: ReadonlyMap<number, string> = new Map()): StepRefContext {
  return { onSelect: vi.fn(), resolvable: () => true, testNames }
}

const HOSTILE = "<img src=x onerror=alert(1)>"

describe("a step reference names where it goes", () => {
  it("STEP-REF-ACCESSIBLE-NAME: the button's aria-label is stepRefAccessibleName's and its visible text is only the number", () => {
    const address: StepAddress = { testIndex: 0, stepIndex: 1, stepText: "Open cart" }

    const single = mount(<KnowledgeStepRefs segments={formatStepRefs([address])} stepRefs={context()} />)
    const button = single.querySelector("button[data-step-ref]")
    expect(button?.getAttribute("aria-label")).toBe(stepRefAccessibleName(address))
    expect(button?.getAttribute("aria-label")).toBe("Go to step 2 · Open cart")
    expect(button?.textContent).toBe("2")
    expect(single.textContent).toBe("step 2")
    act(() => { root?.unmount() })
    root = undefined

    const names = new Map([[0, "checkout"]])
    const suite = mount(<KnowledgeStepRefs segments={formatStepRefs([address], names)} stepRefs={context(names)} />)
    const suiteButton = suite.querySelector("button[data-step-ref]")
    expect(suiteButton?.getAttribute("aria-label")).toBe(stepRefAccessibleName(address, "checkout"))
    expect(suiteButton?.getAttribute("aria-label")).toBe("Go to checkout · step 2 · Open cart")
    expect(suiteButton?.textContent).toBe("2")
    expect(suite.textContent).toBe("checkout · step 2")
    expect([...suite.querySelectorAll("button")].map(control => control.textContent)).toEqual(["2"])
  })

  it("activating a reference calls back with its address and nothing else", () => {
    const address: StepAddress = { testIndex: 2, stepIndex: 4, stepText: "Pay" }
    const stepRefs = context()
    const view = mount(<KnowledgeStepRef address={address} stepRefs={stepRefs}>5</KnowledgeStepRef>)
    act(() => { view.querySelector<HTMLButtonElement>("button[data-step-ref]")?.click() })
    expect(stepRefs.onSelect).toHaveBeenCalledTimes(1)
    expect(stepRefs.onSelect).toHaveBeenCalledWith(address)
  })
})

describe("producer text in a step reference stays text", () => {
  it("STEP-REF-HOSTILE-TEXT: a hostile test name renders as text and a hostile step text lives only in aria-label", () => {
    const address: StepAddress = { testIndex: 0, stepIndex: 0, stepText: HOSTILE }
    const names = new Map([[0, HOSTILE]])
    const view = mount(<KnowledgeStepRefs segments={formatStepRefs([address], names)} stepRefs={context(names)} />)

    expect(view.querySelector("img")).toBeNull()
    expect(view.textContent).toBe(`${HOSTILE} · step 1`)
    const button = view.querySelector("button[data-step-ref]")
    expect(button?.textContent).toBe("1")
    expect(button?.getAttribute("aria-label")).toBe(`Go to ${HOSTILE} · step 1 · ${HOSTILE}`)
    // The step text is an attribute value React escaped, so the only element here is the control.
    expect([...view.querySelectorAll("*")].map(element => element.tagName)).toEqual(["BUTTON"])
  })
})
