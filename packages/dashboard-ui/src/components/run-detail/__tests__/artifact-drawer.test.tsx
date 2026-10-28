// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { generateRunId } from '@vostride/agent-qa-ids'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ArtifactDrawer, type ArtifactDrawerTab } from '../artifact-drawer'
import type { RunArtifactResponse, RunRow } from '@/lib/api'
import { DRAWER_COPY, DRAWER_TITLE_FALLBACK } from '@/lib/drawer-view'
import { ArtifactConfigTab } from '../artifact-config-tab'
import type { ComponentType } from 'react'

const testTabs = import.meta.glob<{ ArtifactTestTab: ComponentType<{ response: RunArtifactResponse }> }>('../artifact-test-tab.tsx', { eager: true })

function mountRecordTab(data: RunArtifactResponse, tab: 'test' | 'config' = 'test') {
  const Component = tab === 'config' ? ArtifactConfigTab : testTabs['../artifact-test-tab.tsx']?.ArtifactTestTab
  expect(Component, 'Test record content is available').toBeTypeOf('function')
  const RecordTab = Component!
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(<RecordTab response={data} />))
  return container
}

function sections(element: Element) {
  return Array.from(element.querySelectorAll('[data-drawer-section]')).map(section => section.getAttribute('data-drawer-section'))
}

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const run: RunRow = {
  id: generateRunId(), name: 'Checkout suite', filePath: null, status: 'passed', duration: 1,
  attributes: {}, environment: null, metadata: null, startedAt: null, endedAt: null,
  failureSummary: null, errorLog: null, testId: null, suiteId: null,
  platform: 'web', testFileContent: null, modelName: null, llmProvider: null,
  parentRunId: null, attemptNumber: 1, retryCount: 0, maxRetries: 0,
  createdAt: '2026-09-20T00:00:00Z',
}

function response(sealed = true): RunArtifactResponse {
  return {
    run,
    artifact: {
      runId: run.id, kind: 'test', schemaVersion: 17,
      createdAt: run.createdAt, updatedAt: run.createdAt,
      finalizedAt: sealed ? '2026-09-20T01:00:00Z' : null,
      payload: {
        schemaVersion: 17,
        config: {
          runtime: { targetName: 'staging', platform: 'web' },
          effectiveConfig: { use: { browser: { name: 'chromium' } } },
          model: { planner: { model: 'test-model' } },
        },
      },
    },
    missingSections: [],
  }
}

let root: Root | undefined
let container: HTMLDivElement

function mount(data: RunArtifactResponse | null = response(), options: {
  tab?: ArtifactDrawerTab; row?: RunRow; loading?: boolean; error?: string; onRetry?: () => void
} = {}) {
  if (!root) {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  }
  act(() => root!.render(
    <ArtifactDrawer run={options.row ?? data?.run ?? run} open tab={options.tab}
      response={data} loading={options.loading ?? false}
      error={options.error ?? null} onOpenChange={() => {}} onTabChange={() => {}}
      onRetry={options.onRetry ?? (() => {})} />,
  ))
  return document.querySelector('[data-slot="sheet-content"]')!
}

function technicalDetails(drawer: Element) {
  const details = drawer.querySelector('[data-technical-details]')
  expect(details).not.toBeNull()
  return details!
}

function expand(details: Element) {
  const trigger = details.querySelector('button')!
  act(() => trigger.click())
}

afterEach(() => {
  act(() => root?.unmount())
  root = undefined
  container?.remove()
  vi.restoreAllMocks()
})

describe('run-context drawer', () => {
  it('DRAWER-TABS-TEST-FIRST', () => {
    const drawer = mount()
    expect(Array.from(drawer.querySelectorAll('[role="tab"]')).map(tab => tab.textContent)).toEqual(['Test', 'Config'])
    expect(drawer.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('Test')
    expect(drawer.querySelector('[data-drawer-section="test-as-written"]')).not.toBeNull()
    expect(drawer.querySelector('[data-drawer-section]')?.closest('[data-slot="scroll-area"]')).not.toBeNull()
  })

  it('DRAWER-TEST-SECTION-ORDER', () => {
    const data = response()
    const childRunId = generateRunId()
    data.run = { ...run, attributes: { channel: 'nightly' } }
    data.artifact!.payload.source = {
      kind: 'suite', rawYaml: 'name: Checkout suite', resolvedDefinition: { name: 'Checkout suite' },
      members: [{ index: 0, name: 'Checkout', childRunId }],
    }
    const tab = mountRecordTab(data)
    expect(sections(tab)).toEqual(['test-as-written', 'resolved-definition', 'suite-members', 'run-attributes'])
    expect(tab.querySelector('a')?.getAttribute('href')).toBe(`/runs/${childRunId}`)
    act(() => Array.from(tab.querySelectorAll('button')).find(button => button.textContent === 'Raw suite YAML')!.click())
    expect(tab.querySelector('pre')?.textContent).toBe('name: Checkout suite')
    for (const raw of ['a/b', 'a?b', 'a#b', 'a%b', 'a b', 'a%2Fb']) {
      data.artifact!.payload.source = { kind: 'suite', members: [{ index: 0, name: 'Child', childRunId: raw }] }
      const Component = testTabs['../artifact-test-tab.tsx'].ArtifactTestTab
      act(() => root!.render(<Component response={data} />))
      expect(tab.querySelector('a')?.getAttribute('href')).toBe(`/runs/${encodeURIComponent(raw)}`)
    }
  })

  it('DRAWER-ATTRIBUTES-ONLY-WHEN-PRESENT', () => {
    const data = response()
    const tab = mountRecordTab(data)
    expect(sections(tab)).toEqual(['test-as-written', 'resolved-definition'])
    expect(tab.textContent).not.toMatch(/no run attributes|did not record any attributes/i)
    const samples: Record<string, string>[] = [{ channel: 'nightly' }, { channel: 'nightly', owner: 'team' }]
    for (const attributes of samples) {
      data.run = { ...run, attributes }
      const Component = testTabs['../artifact-test-tab.tsx'].ArtifactTestTab
      act(() => root!.render(<Component response={data} />))
      const rows = tab.querySelectorAll('[data-drawer-section="run-attributes"] tbody tr')
      expect(rows).toHaveLength(Object.keys(attributes).length)
      expect(Array.from(rows).every(row => row.querySelector('[aria-label^="Copy "]'))).toBe(true)
    }
  })

  it('DRAWER-SUITE-MEMBERS-SUITES-ONLY', () => {
    const data = response()
    data.artifact!.payload.source = { kind: 'test', members: [{ index: 0, name: 'Unexpected member' }] }
    const tab = mountRecordTab(data)
    expect(sections(tab)).toEqual(['test-as-written', 'resolved-definition'])
    expect(tab.textContent).not.toContain('Unexpected member')
    expect(tab.textContent).toContain(DRAWER_COPY.notCaptured)
  })

  it('DRAWER-CONFIG-SECTION-ORDER', () => {
    const tab = mountRecordTab(response(), 'config')
    expect(sections(tab)).toEqual(['effective-config', 'global-config', 'model', 'runtime', 'errors'])
    expect(Array.from(tab.querySelectorAll('h3')).map(heading => heading.textContent)).toEqual([
      DRAWER_COPY.effectiveConfig, DRAWER_COPY.globalConfigAsWritten, DRAWER_COPY.model, DRAWER_COPY.runtime, DRAWER_COPY.errors,
    ])
    expect(tab.textContent).not.toMatch(/Artifact kind|Schema version|Finalized|Run Summary/)
    expect(tab.textContent).toContain(DRAWER_COPY.notCaptured)
  })

  it('DRAWER-HEADER-NO-ENVELOPE', () => {
    const drawer = mount()
    const header = drawer.querySelector('[data-slot="sheet-header"]')!
    expect(header.querySelector('h2')?.textContent).toBe(run.name)
    expect(header.textContent).toContain('staging · web chromium · test-model')
    expect(header.textContent).not.toContain(run.id)
    expect(header.textContent).not.toContain('17')
    expect(header.querySelector('[data-slot="badge"]')).toBeNull()
    expect(header.querySelector('h2')?.classList.contains('line-clamp-2')).toBe(true)
    expect(header.querySelector('h2')?.classList.contains('font-medium')).toBe(true)
    expect(header.querySelector('[data-slot="sheet-description"]')?.classList.contains('truncate')).toBe(true)
  })

  it('DRAWER-TECHNICAL-COLLAPSED', () => {
    for (const tab of ['test', 'config'] as const) {
      const drawer = mount(response(), { tab })
      const details = technicalDetails(drawer)
      expect(details.closest('[data-slot="tabs"]')).toBeNull()
      expect(details.compareDocumentPosition(drawer.querySelector('[data-slot="tabs"]')!) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy()
      expect(details.getAttribute('data-state')).toBe('closed')
      expect(details.textContent).toBe(DRAWER_COPY.technicalDetails)
      expand(details)
      expect(Array.from(details.querySelectorAll('dt')).map(row => row.textContent)).toEqual([
        DRAWER_COPY.runId, DRAWER_COPY.artifactKind, DRAWER_COPY.schemaVersion, DRAWER_COPY.captureSealedAt,
      ])
      expect(Array.from(details.querySelectorAll('dd')).map(row => row.textContent)).toEqual([
        run.id, 'Test', '17', response().artifact!.finalizedAt,
      ])
      expect(Array.from(details.querySelectorAll('dd')).every(row => row.classList.contains('break-all'))).toBe(true)
      expand(details)
    }
  })

  it('DRAWER-UNSEALED-LINE', () => {
    const drawer = mount(response(false))
    const lines = drawer.querySelectorAll('[data-capture-state="unsealed"]')
    expect(lines).toHaveLength(1)
    expect(lines[0].getAttribute('role')).toBe('status')
    expect(lines[0].textContent).toBe(DRAWER_COPY.unsealedCapture)
    expect(lines[0].querySelector('svg')).not.toBeNull()
    const details = technicalDetails(drawer)
    expand(details)
    expect(details.textContent).not.toContain(DRAWER_COPY.captureSealedAt)
  })

  it('DRAWER-SEALED-SILENT', () => {
    const drawer = mount()
    expect(drawer.querySelector('[data-capture-state]')).toBeNull()
    expect(drawer.textContent).not.toMatch(/\b(finalized|open)\b/i)
    const details = technicalDetails(drawer)
    expect(drawer.textContent).not.toContain(response().artifact!.finalizedAt)
    expand(details)
    expect(details.textContent).toContain(DRAWER_COPY.captureSealedAt)
    expect(details.textContent).toContain(response().artifact!.finalizedAt)
  })

  it('DRAWER-COPY-RUN-ID', () => {
    const data = response()
    data.run = { ...run, id: `${run.id} [secret:RUN_TOKEN]` }
    data.artifact!.runId = data.run.id
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const details = technicalDetails(mount(data))
    expand(details)
    const copy = details.querySelector<HTMLButtonElement>(`[aria-label="${DRAWER_COPY.copyRunId}"]`)
    expect(copy).not.toBeNull()
    act(() => copy!.click())
    expect(writeText).toHaveBeenCalledExactlyOnceWith(data.run.id)
    expect(details.textContent).toContain(data.run.id)
    expect(details.querySelector('[data-masked]')).toBeNull()
  })

  it('shows header producer text as stored and degrades absent names and config', () => {
    const data = response()
    data.run = { ...run, name: 'Checkout as qa-person@example.com' }
    data.artifact!.payload.config = { runtime: { targetName: '[secret:TARGET_HOST]' } }
    const header = mount(data).querySelector('[data-slot="sheet-header"]')!
    expect(header.textContent).toContain('Checkout as qa-person@example.com')
    expect(header.textContent).toContain('[secret:TARGET_HOST]')
    expect(header.querySelector('[data-masked]')).toBeNull()
    data.run = { ...run, name: '' }
    data.artifact!.payload.config = undefined
    const absent = mount(data).querySelector('[data-slot="sheet-header"]')!
    expect(absent.querySelector('h2')?.textContent).toBe(DRAWER_TITLE_FALLBACK(run.id))
    expect(absent.textContent).toContain(DRAWER_COPY.configNotCaptured)
  })

  it('keeps load states and retries with the drawer label', () => {
    expect(mount(null, { loading: true }).textContent).toContain('Loading artifact data...')
    expect(mount(null).textContent).toContain('Artifact data is not available for this run')
    const onRetry = vi.fn()
    const drawer = mount(null, { error: 'Read failed for [secret:API_TOKEN]', onRetry })
    expect(drawer.textContent).toContain('Could not load artifact data')
    expect(drawer.textContent).toContain('Read failed for [secret:API_TOKEN]')
    const retry = Array.from(drawer.querySelectorAll('button')).find(button => button.textContent === DRAWER_COPY.retry)
    expect(retry).toBeDefined()
    act(() => retry!.click())
    expect(onRetry).toHaveBeenCalledOnce()
  })
})
