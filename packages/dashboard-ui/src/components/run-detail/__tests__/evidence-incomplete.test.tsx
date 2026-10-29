// @vitest-environment jsdom

// THE ONE COMPONENT'S CELLS.
//
// THREE ABSENCES, THREE VOCABULARIES. A masked chip says "redacted on purpose", the read-unavailable
// state says "the read failed", and this component says "the bytes are gone". The distinctness cells
// below assert the other two attributes are ABSENT from this component's subtree, because a
// vocabulary collapse is invisible in a screenshot and unrecoverable for the reader who trusts it.
//
// COPY BY CONSTANT, NEVER BY STRING (405-06's law). A re-typed sentence here would stay green while
// the page said something else, which is the exact drift the exported constant exists to prevent.
//
// THE FOUR REF ARMS. Producer-flagged, read-time-absent and click-time-404 are ONE visible state and
// never a request; presence UNKNOWN — no `present` key at all — still renders the image, because a
// host that cannot stat its own store has not measured an absence and must not claim one.

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { EvidenceIncomplete } from '@/components/run-detail/evidence-incomplete'
import { TabOverview } from '@/components/run-detail/tab-overview'
import { buildTimelineModel } from "@/lib/playhead"
import { fromRunDetailStep } from '@/lib/display-step'
import { routes } from '@/lib/routes'
import { EVIDENCE_INCOMPLETE_LABEL, SCREENSHOT_UNAVAILABLE_LABEL } from '@/lib/run-detail-view'
import type { RunDetailArtifactRef, RunDetailSubAction } from '@vostride/agent-qa-schema'
import { asRef } from '@vostride/agent-qa-schema'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// A faithful double, not a blank: it renders the `img` the real viewer renders, so the arms below
// measure the seam rather than the mock.
vi.mock('@/components/screenshot-viewer', () => ({
  ScreenshotViewer: ({ src, onUnavailable }: { src: string; onUnavailable?: () => void }) => (
    <img data-testid="screenshot-viewer" src={src} onError={() => onUnavailable?.()} />
  ),
}))

vi.mock('@/components/reasoning-pipeline', () => ({
  ReasoningPipeline: () => <div data-testid="reasoning-pipeline" />,
}))

const SHA = 'a1b2c3d4'.repeat(8)

const RAW_STEP = {
    testIndex: 0,
    stepIndex: 0,
    stepText: 'Open dashboard',
    cacheStatus: 'miss',
    verifierVerdict: { pass: true, reasoning: 'the dashboard is up' },
    selfHealOccurred: false,
    briefDigest: 'd00',
    status: 'passed',
    durationMs: 1000,
  } as const
const STEP = fromRunDetailStep(RAW_STEP, [])

function makeSubAction(artifactRefs: readonly RunDetailArtifactRef[]): RunDetailSubAction {
  return {
    testIndex: 0,
    stepIndex: 0,
    subActionIndex: 0,
    plan: 'Open the dashboard',
    plannedAction: { type: 'click', ref: asRef('dashboard') },
    result: { success: true },
    screenStateHash: 'f'.repeat(64),
    artifactRefs,
  }
}

let container: HTMLDivElement | null = null
let root: Root | null = null

function mount(node: ReactNode): HTMLDivElement {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root!.render(node)
  })
  return container
}

async function renderOverview(ref: RunDetailArtifactRef): Promise<HTMLDivElement> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(
      <TabOverview step={STEP} subAction={makeSubAction([ref])} runId="run-1"
        model={buildTimelineModel({ member: { testIndex: 0, name: "Test", attempts: 1 }, steps: [{ step: RAW_STEP, subActions: [makeSubAction([ref])] }] })}
        playhead={makeSubAction([ref])} />,
    )
  })
  return container
}

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  container?.remove()
  container = null
})

describe('EvidenceIncomplete', () => {
  it.each(['pane', 'inline'] as const)('INCOMPLETE-WRAPPER-DELEGATES: %s uses the shared frame state', (variant) => {
    const view = mount(<EvidenceIncomplete variant={variant} />)
    const node = view.firstElementChild
    expect(node?.getAttribute('data-evidence-state')).toBe('unavailable')
    expect(node?.hasAttribute('data-evidence-incomplete')).toBe(true)
    expect(node?.getAttribute('data-evidence-kind')).toBe('frame')
    expect(node?.getAttribute('data-evidence-tone')).toBe('neutral')
    expect(node?.textContent).toContain(EVIDENCE_INCOMPLETE_LABEL)
  })

  it('paints the pane variant under the one attribute and the one label', () => {
    const view = mount(<EvidenceIncomplete variant="pane" />)

    const node = view.querySelector('[data-evidence-state="unavailable"][data-evidence-incomplete]')
    expect(node).not.toBeNull()
    expect(node?.textContent).toContain(EVIDENCE_INCOMPLETE_LABEL)
  })

  it('keeps the pane out of the other two absence vocabularies', () => {
    const view = mount(<EvidenceIncomplete variant="pane" />)

    expect(view.querySelector('[data-masked]')).toBeNull()
    expect(view.querySelector('[data-run-detail-error]')).toBeNull()
  })

  it('paints the inline variant as a span chip that is neither a button nor a link', () => {
    const view = mount(<EvidenceIncomplete variant="inline" />)

    const node = view.querySelector('[data-evidence-state="unavailable"][data-evidence-incomplete]')
    expect(node).not.toBeNull()
    expect(node?.tagName).toBe('SPAN')
    expect(node?.textContent).toContain(EVIDENCE_INCOMPLETE_LABEL)
    expect(view.querySelector('button')).toBeNull()
    expect(view.querySelector('[href]')).toBeNull()
    expect(view.querySelector('[data-masked]')).toBeNull()
    expect(view.querySelector('[data-run-detail-error]')).toBeNull()
  })

  // 405's name kept as an alias, pinned so a later respelling of either has to be deliberate.
  it('keeps the screenshot-unavailable name as an alias of the evidence-incomplete label', () => {
    expect(SCREENSHOT_UNAVAILABLE_LABEL).toBe(EVIDENCE_INCOMPLETE_LABEL)
  })
})

describe('the overview decision screenshot reads presence', () => {
  it('renders the incomplete state, and never a request, for a ref the read found absent', async () => {
    const view = await renderOverview({ id: `decision-screenshot:${SHA}`, sha: SHA, present: false })

    expect(view.querySelector('[data-artifact-state="unavailable"]')).not.toBeNull()
    expect(
      view.querySelector('[data-artifact-state="unavailable"] [data-evidence-state="unavailable"][data-evidence-incomplete]'),
    ).not.toBeNull()
    expect(view.querySelector('img')).toBeNull()
    expect(view.textContent).toContain(EVIDENCE_INCOMPLETE_LABEL)
  })

  it('renders the same state for a ref the producer already flagged incomplete', async () => {
    const view = await renderOverview({
      id: `decision-screenshot:${SHA}`,
      sha: SHA,
      evidenceIncomplete: true,
    })

    expect(
      view.querySelector('[data-artifact-state="unavailable"] [data-evidence-state="unavailable"][data-evidence-incomplete]'),
    ).not.toBeNull()
    expect(view.querySelector('img')).toBeNull()
  })

  it('mints the image through the one route minter for a ref the read found present', async () => {
    const view = await renderOverview({ id: `decision-screenshot:${SHA}`, sha: SHA, present: true })

    expect(view.querySelector('[data-artifact-state="available"]')).not.toBeNull()
    expect(view.querySelector('img')?.getAttribute('src')).toBe(routes.runArtifact('run-1', SHA))
    expect(view.querySelector('[data-evidence-state="unavailable"][data-evidence-incomplete]')).toBeNull()
  })

  // Presence UNKNOWN is not an absence. A host whose store cannot stat leaves the key off entirely,
  // and the click-time `blob_absent` refusal still covers the blob that is really gone.
  it('still requests the blob when presence was never measured', async () => {
    const view = await renderOverview({ id: `decision-screenshot:${SHA}`, sha: SHA })

    expect(view.querySelector('[data-artifact-state="available"]')).not.toBeNull()
    expect(view.querySelector('img')?.getAttribute('src')).toBe(routes.runArtifact('run-1', SHA))
    expect(view.querySelector('[data-evidence-state="unavailable"][data-evidence-incomplete]')).toBeNull()
  })
})
