// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { asRef, type RunDetailProjection } from '@vostride/agent-qa-schema'

import i18n, { applyLanguage } from '@/i18n'
import RunDetailPage from '@/pages/run-detail'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// A member with no name and a step with no text, so both are named from the catalog.
const UNNAMED: RunDetailProjection = {
  runId: 'run-1',
  members: [{ testIndex: 0, attempts: 1 }],
  steps: [
    {
      testIndex: 0,
      stepIndex: 0,
      cacheStatus: 'miss',
      verifierVerdict: { pass: true, reasoning: 'Complete' },
      selfHealOccurred: false,
      briefDigest: 'digest',
      status: 'passed',
    },
  ],
  subActions: [
    {
      testIndex: 0,
      stepIndex: 0,
      subActionIndex: 0,
      plan: 'Press the button',
      plannedAction: { type: 'click', ref: asRef('button-0') },
      screenStateHash: 'f'.repeat(64),
      result: { success: true },
    },
  ],
  tokens: { measuredSteps: 0, unmeasuredSteps: 1 },
}

vi.mock('@/lib/api', () => ({
  fetchRun: async () => ({
    run: { id: 'run-1', name: 'Checkout run', status: 'passed', attributes: {}, platform: 'web' },
  }),
  fetchRunDetail: async () => UNNAMED,
  fetchRunAnalysis: async () => ({ runId: 'run-1', verdicts: [], sentences: [], clusters: [] }),
  fetchRunKnowledge: async () => ({ kind: 'evidence-incomplete', runId: '' }),
  fetchExecutionLogs: async () => ({ logs: [] }),
  fetchRunEvidence: async () => ({ kind: 'failed', error: 'No records in this fixture' }),
  fetchRunArtifact: vi.fn(),
  triggerRun: vi.fn(),
  markRun: vi.fn(),
  watchPostProcessing: () => () => {},
}))
vi.mock('@/hooks/use-page-title', () => ({ usePageTitle: () => {} }))
vi.mock('@/components/ui/resizable', () => ({
  ResizablePanelGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ResizablePanel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ResizableHandle: () => null,
}))
vi.mock('@/components/ui/scroll-area', () => ({
  ScrollArea: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))
// The double draws the page's own timeline and shows the name of the step the page hands down.
vi.mock('@/components/run-detail/tab-panels', () => ({
  TabPanels: ({ timeline, step }: { timeline: ReactNode; step: { name: string } | null }) => (
    <div data-tab-panels data-handed-step-name={step?.name ?? ''}>
      {timeline}
    </div>
  ),
}))

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  localStorage.clear()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }))
})

afterEach(async () => {
  await act(async () => {
    await applyLanguage('en')
  })
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

async function renderPage() {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={['/runs/run-1']}>
        <Routes>
          <Route path="/runs/:id" element={<RunDetailPage />} />
        </Routes>
      </MemoryRouter>,
    )
  })
}

async function switchTo(language: 'en' | 'es') {
  await act(async () => {
    await applyLanguage(language)
  })
}

function memberName(language: 'en' | 'es') {
  return i18n.t('runDetail.member.fallbackName', { lng: language, number: '1' })
}

function stepName(language: 'en' | 'es') {
  return i18n.t('common.untitledStep', { lng: language })
}

describe('a mounted run page with an unnamed member and step after a language change', () => {
  it('names the member on the timeline in the new language on the same timeline, then English again', async () => {
    await renderPage()
    const timeline = host.querySelector('[data-timeline]')
    const slider = () => host.querySelector('[data-timeline-playhead]')?.getAttribute('aria-label')
    expect(timeline).not.toBeNull()
    expect(slider()).toContain(memberName('en'))

    await switchTo('es')
    expect(memberName('es')).not.toBe(memberName('en'))
    expect(host.querySelector('[data-timeline]'), 'not remounted').toBe(timeline)
    expect(slider()).toContain(memberName('es'))
    expect(slider()).not.toContain(memberName('en'))

    await switchTo('en')
    expect(slider()).toContain(memberName('en'))
  })

  it('hands the tabs the selected step under its name in the new language, then English again', async () => {
    await renderPage()
    const handed = () =>
      host.querySelector('[data-tab-panels]')?.getAttribute('data-handed-step-name')
    expect(handed()).toBe(stepName('en'))

    await switchTo('es')
    expect(stepName('es')).not.toBe(stepName('en'))
    expect(handed()).toBe(stepName('es'))

    await switchTo('en')
    expect(handed()).toBe(stepName('en'))
  })
})
