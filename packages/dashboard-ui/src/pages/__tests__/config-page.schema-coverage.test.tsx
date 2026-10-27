// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CONFIG_SCHEMA_LEAVES,
  CONFIG_WRITE_DENIED_ROOTS,
  configLeafOwner,
  isPageWritableConfigPath,
  type ConfigPathSegment,
} from '@vostride/agent-qa-schema'

vi.mock('monaco-editor', () => ({
  languages: {
    CompletionItemKind: {
      Module: 0,
      Value: 1,
      Property: 2,
      Enum: 3,
      EnumMember: 4,
    },
    CompletionItemInsertTextRule: {
      None: 0,
    },
    registerCompletionItemProvider: vi.fn(),
  },
}))

import ConfigPage from '@/pages/config'
import {
  CONFIG_SECTIONS,
  CONFIG_TABS,
  CONNECTION_CHOICES,
  CONNECTION_CHOICE_PROVIDERS,
  LEGACY_CONFIG_PAIRS,
  type ConfigTab,
  type ConnectionChoice,
} from '@/lib/config-tabs'
import { connectLLM, deleteAuthCredential, fetchAuthStatus, saveCredential, type AuthCredentialInfo } from '@/lib/api'
import { LLM_PROVIDER_COMPLETION_VALUES } from '@/lib/yaml-completions'
import {
  ADD_FLOW_FIELD_LABELS,
  ADD_HEADER_LABEL,
  ADD_MODEL_LABEL,
  CONFIG_SECTION_LABELS,
  DEFAULT_BADGE,
  KEY_TYPE_LABELS,
  PLANNER_FIELD_LABELS,
  PROVIDER_FALLBACK_LABELS,
  REMOVE_KEY_LABEL,
  REPLACE_KEY_LABEL,
  SAVE_KEY_AND_TEST_LABEL,
  VISION_FIELD_LABELS,
  undoLine,
} from '@/lib/config-copy'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false
}
if (!Element.prototype.setPointerCapture) {
  Element.prototype.setPointerCapture = () => {}
}
if (!Element.prototype.releasePointerCapture) {
  Element.prototype.releasePointerCapture = () => {}
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {}
}

const { sampleConfig, fullConfig, page } = vi.hoisted(() => ({
  page: { config: undefined as Record<string, unknown> | undefined },
  // Every record and list holds at least one entry, so each list renders its rows (D-06).
  fullConfig: {
    workspace: {
      testMatch: ['tests/**/*.yaml'],
      suiteMatch: ['tests/**/*.suite.yaml'],
      testPathIgnore: ['**/draft/**'],
      hooksFile: 'tests/hooks.ts',
      envFile: '.env.local',
      secretsFile: '.env.secrets.local',
    },
    knowledge: { dir: 'agent-qa-knowledge' },
    services: {
      dashboard: {
        port: 4173,
        host: '127.0.0.1',
        baseUrl: 'http://127.0.0.1:4173',
        dbPath: '.agent-qa/runs.db',
        artifactsDir: '.agent-qa/artifacts',
        workspace: '.',
      },
      authState: { dir: '.agent-qa/auth' },
      cache: { dir: '.agent-qa/cache' },
      logging: { level: 'info' },
      recording: { enabled: true, keepFailuresOnly: false },
      accessibility: {
        enabled: true,
        standard: 'wcag2aa',
        runAfter: 'test-end',
        failOnViolation: false,
        disableRules: ['color-contrast'],
        exclude: ['#cookie-banner'],
      },
      vision: { screenshotSize: '256k', effectiveResolution: 768 },
      mcp: {
        enabled: true,
        port: 4174,
      },
    },
    registry: {
      llms: [
        {
          name: 'claude-proxy',
          provider: 'anthropic-compatible',
          model: 'claude-remote',
          baseURL: 'https://anthropic-proxy.example/messages',
          vision: true,
          contextWindow: '200k',
          providerHeaders: { 'X-Team': 'qa' },
        },
        { name: 'gemini-fast', provider: 'gemini', model: 'gemini-2.5-flash' },
      ],
      targets: {
        staging: { platform: 'web', url: 'https://example.com', product: 'example', environment: 'staging' },
        shop: {
          platform: 'android',
          appPackage: 'com.example.shop',
          appActivity: '.MainActivity',
          app: { path: 'apps/shop.apk' },
        },
      },
      devices: { iosLocal: { platform: 'ios', match: { udid: 'abc' } } },
    },
    use: {
      browser: { name: 'chromium', headless: true, viewport: { width: 1280, height: 720 } },
      timeout: { step: '30s', test: '10m', navigation: '10s' },
      planner: { maxActions: 30, maxPlanningTurns: 30, previousStepCount: 5 },
      logCapture: { console: true, network: true },
      mobile: { appState: 'reset' },
      llm: 'claude-proxy',
      parallel: true,
      workers: 2,
      buildTag: 'nightly',
      cache: true,
    },
    analytics: {
      privacy: true,
      passRateScope: { attributes: { 'git.branch': 'master', 'user.email': { regex: '^ci@' } } },
    },
  },
  sampleConfig: {
  workspace: {
    testMatch: ['tests/**/*.yaml'],
    suiteMatch: ['tests/**/*.suite.yaml'],
    testPathIgnore: ['**/draft/**'],
    hooksFile: 'tests/hooks.ts',
    envFile: '.env.local',
    secretsFile: '.env.secrets.local',
  },
  knowledge: {
    dir: 'agent-qa-knowledge',
  },
  services: {
    dashboard: {
      port: 4173,
      dbPath: '.agent-qa/runs.db',
      artifactsDir: '.agent-qa/artifacts',
    },
    cache: { dir: '.agent-qa/cache' },
    logging: { level: 'info' },
    recording: { enabled: true },
    accessibility: {
      enabled: true,
      standard: 'wcag2aa',
      runAfter: 'test-end',
      failOnViolation: false,
    },
    vision: {
      screenshotSize: '256k',
      effectiveResolution: 768,
    },
  },
  registry: {
    llms: [
      {
        name: 'anthropic-compatible',
        provider: 'anthropic-compatible',
        model: 'claude-remote',
        baseURL: 'https://anthropic-proxy.example/messages',
        effectiveResolution: 1568,
      },
      {
        name: 'openai-compatible',
        provider: 'openai-compatible',
        model: 'openrouter/auto',
        baseURL: 'https://openrouter.ai/api/v1',
      },
      { name: 'gemini-fast', provider: 'gemini', model: 'gemini-2.5-flash' },
      { name: 'codex', provider: 'openai-subscription', model: 'gpt-5.3-codex' },
      { name: 'claude-subscription', provider: 'anthropic-subscription', model: 'claude-sonnet-4-20250514' },
    ],
    targets: { staging: { platform: 'web', url: 'https://example.com' } },
    devices: { iosLocal: { platform: 'ios', match: { udid: 'abc' } } },
  },
  use: {
    browser: { name: 'chromium', headless: true, viewport: { width: 1280, height: 720 } },
    timeout: { step: '30s', test: '10m', navigation: '10s' },
    planner: { maxActions: 30, maxPlanningTurns: 30, previousStepCount: 5 },
    logCapture: { console: true, network: true },
    llm: 'anthropic-compatible',
    device: 'iosLocal',
    parallel: true,
  },
  analytics: {
    passRateScope: {
      attributes: {
        'git.branch': 'master',
        'user.email': { regex: '^ci@' },
      },
    },
  },
  },
}))

const mockFetchAuthStatus = vi.mocked(fetchAuthStatus)
const mockSaveCredential = vi.mocked(saveCredential)

vi.mock('@/lib/api', () => ({
  fetchAppMetadata: vi.fn().mockResolvedValue({ version: '0.1.13' }),
  fetchConfig: vi.fn(async () => ({
    config: page.config ?? sampleConfig,
    provider: null,
    revision: 'rev-1',
    file: { path: '/work/agent-qa.config.yaml', lines: [] },
  })),
  fetchConfigRevision: vi.fn().mockResolvedValue({ revision: 'rev-1' }),
  applyConfigChanges: vi.fn().mockResolvedValue({ revision: 'rev-2' }),
  undoConfigAction: vi.fn().mockResolvedValue({ restored: true, revision: 'rev-3' }),
  fetchAuthStates: vi.fn().mockResolvedValue({ authStates: [] }),
  fetchAuthStatus: vi.fn().mockResolvedValue({ credentials: [] }),
  fetchLLMProviders: vi.fn().mockResolvedValue({
    providers: [
      { id: 'openai-compatible', label: 'OpenAI-compatible', auth: { kind: 'api-key', credentialTypes: ['api-key'], optional: true }, needsBaseURL: true, authModes: ['api-key'], baseURLPlaceholder: 'https://openrouter.ai/api/v1' },
      { id: 'anthropic-compatible', label: 'Anthropic-compatible', auth: { kind: 'api-key', credentialTypes: ['api-key', 'bearer-token'], optional: true }, needsBaseURL: true, authModes: ['api-key', 'bearer-token'], baseURLPlaceholder: 'https://anthropic-proxy.example/messages' },
      { id: 'openai-subscription', label: 'OpenAI subscription', auth: { kind: 'oauth-plugin', mode: 'browser-poll', buttonLabel: 'Login with OpenAI subscription' } },
      { id: 'anthropic-subscription', label: 'Anthropic subscription', auth: { kind: 'oauth-plugin', mode: 'manual-code', buttonLabel: 'Login with Anthropic subscription' } },
      { id: 'gemini', label: 'Gemini', auth: { kind: 'api-key', credentialTypes: ['api-key'] }, needsBaseURL: false, authModes: ['api-key'] },
    ],
  }),
  fetchModelCatalog: vi.fn().mockResolvedValue({
    catalog: {
      'openai-compatible': [{ id: 'openrouter/auto', label: 'OpenRouter Auto', vision: true }],
      'anthropic-compatible': [{ id: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4', vision: true }],
      gemini: [{ id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', vision: true }],
    },
  }),
  fetchLiveModelCatalog: vi.fn().mockResolvedValue({ models: [] }),
  testLLMConnection: vi.fn(),
  saveCredential: vi.fn().mockResolvedValue({ saved: true }),
  startPluginAuth: vi.fn(),
  pollPluginAuthResult: vi.fn(),
  exchangePluginAuthCode: vi.fn(),
  deleteAuthCredential: vi.fn(),
  connectLLM: vi.fn(),
  moveCredential: vi.fn(),
}))

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('@/hooks/use-page-title', () => ({ usePageTitle: () => {} }))

const EXPECTED_DESTINATIONS = [
  'workspace:discovery',
  'workspace:files',
  'knowledge:store',
  'services:dashboard',
  'services:cache',
  'services:auth-states',
  'services:logging',
  'services:recording',
  'services:accessibility',
  'services:vision',
  'registry:llms',
  'registry:targets',
  'registry:devices',
  'use:browser',
  'use:timeouts',
  'use:planner',
  'use:log-capture',
  'use:mobile',
  'use:execution-defaults',
  'analytics:pass-rate-scope',
]

const SURFACE_MARKERS: Record<string, { title: string; marker: string }> = {
  'workspace:discovery': { title: 'Test discovery', marker: 'Test files' },
  'workspace:files': { title: 'Hooks, env and secrets files', marker: 'Hooks file' },
  'knowledge:store': { title: 'Knowledge', marker: 'Knowledge folder' },
  'services:dashboard': { title: 'Dashboard', marker: 'Database file' },
  'services:cache': { title: 'Cache', marker: 'Cache folder' },
  'services:auth-states': { title: 'Saved login states', marker: 'No saved login states yet.' },
  'services:logging': { title: 'Logging', marker: 'Log level' },
  'services:recording': { title: 'Recording', marker: 'Record video of each test. Recordings stay on this machine.' },
  'services:accessibility': { title: 'Accessibility', marker: 'Run checks after' },
  'services:vision': { title: 'Screenshot size', marker: VISION_FIELD_LABELS.screenshotSize },
  'registry:llms': { title: 'Models', marker: ADD_MODEL_LABEL },
  'registry:targets': { title: 'Targets', marker: 'Add target' },
  'registry:devices': { title: 'Devices', marker: 'Add device' },
  'use:browser': { title: 'Browser', marker: 'Viewport width' },
  'use:timeouts': { title: 'Timeouts', marker: 'Step timeout' },
  'use:planner': { title: 'Planner limits', marker: PLANNER_FIELD_LABELS.maxActions },
  'use:log-capture': { title: 'Log capture', marker: 'Capture network logs' },
  'use:mobile': { title: 'Mobile', marker: 'App state' },
  'use:execution-defaults': { title: 'Models', marker: DEFAULT_BADGE },
  'analytics:pass-rate-scope': { title: 'Pass-rate scope', marker: 'Add attribute' },
}

let container: HTMLDivElement | null = null
let root: Root | null = null

async function flushRender() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function renderAt(url: string) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)

  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="/config" element={<ConfigPage />} />
          <Route path="/config/:tab" element={<ConfigPage />} />
        </Routes>
      </MemoryRouter>,
    )
  })

  await flushRender()
  return container
}

// The model modal is gone (429-30 · D-10): its cells here drive the saved rows and the add row.
function modelRow(name: string) {
  return container?.querySelector(`[data-model-row][data-model-name="${name}"]`) as HTMLElement | null
}

function addRow() {
  return container?.querySelector('[data-model-draft]') as HTMLElement | null
}

function buttonIn(scope: ParentNode | null | undefined, label: string) {
  const buttons = Array.from(scope?.querySelectorAll('button') ?? []) as HTMLButtonElement[]
  return buttons.find((button) => button.textContent?.trim() === label) ?? null
}

async function press(element: Element | null | undefined) {
  expect(element).toBeTruthy()
  await act(async () => {
    ;(element as HTMLElement).focus()
    ;(element as HTMLElement).click()
  })
  await flushRender()
}

async function openModelRow(name: string) {
  const header = modelRow(name)?.querySelector('[data-model-row-toggle]')
  expect(header, `the ${name} row header`).toBeTruthy()
  if (header!.getAttribute('aria-expanded') !== 'true') await press(header)
  return modelRow(name)!.querySelector('[data-model-panel]') as HTMLElement
}

/** The Models tab with the add row open on a connection choice, its reads and catalog settled. */
async function renderAddRow(choice: ConnectionChoice) {
  await renderAt(`/config/models?add=${choice}`)
  for (let pass = 0; pass < 3; pass++) await flushRender()
  expect(addRow(), 'the add row').not.toBeNull()
}

async function chooseConnection(choice: ConnectionChoice) {
  await press(addRow()?.querySelector(`[data-connection-choice="${choice}"] [role="radio"]`))
}

function bearerCredential(): AuthCredentialInfo {
  return { configName: 'anthropic-compatible', provider: 'anthropic-compatible', type: 'bearer', expires: null, source: 'auth-store' }
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

function cleanupRender() {
  if (root) {
    act(() => root!.unmount())
  }
  root = null
  if (container) {
    container.remove()
  }
  container = null
}

async function assertConfigSectionShells(destinations: string[]) {
  for (const destination of destinations) {
    const [bucket, item] = destination.split(':')
    const contract = SURFACE_MARKERS[destination]
    const view = await renderAt(`/config?bucket=${bucket}&item=${item}`)

    expect(view.textContent).toContain(contract.title)
    expect(view.textContent).toContain(contract.marker)
    expect(view.textContent).not.toContain('Missing config surface')
    // A section rebuilt on ConfigField or as a record list has field rows in place of the shipped shell.
    expect(view.querySelector('[data-config-section-shell], [data-config-field], [data-field-list]')).not.toBeNull()
    expect(view.querySelector('[data-config-section-shell] [data-slot="card"]')).toBeNull()

    cleanupRender()
  }
}

// plugins.* is a file edit by decision; every other leaf of the published schema has a field on
// the page (D-06). 429-44: the page's write door refuses the same roots, so both read one constant.
// safety.* is not in the schema or the denied roots.
const DENIED_ROOTS: readonly string[] = CONFIG_WRITE_DENIED_ROOTS
const PAGE_LEAVES = CONFIG_SCHEMA_LEAVES.filter(
  (pattern) => !DENIED_ROOTS.includes(pattern.split('.')[0]!),
)

/** A concrete path for a leaf pattern or list owner: each '*' becomes 'k' and each '[]' index 0. */
function concretePath(pattern: string): ConfigPathSegment[] {
  return pattern.split('.').flatMap((token) => {
    let key = token
    const items: number[] = []
    while (key.endsWith('[]')) {
      key = key.slice(0, -2)
      items.push(0)
    }
    return [key === '*' ? 'k' : key, ...items]
  })
}

interface FieldMark {
  kind: 'path' | 'list'
  value: string
  where: string
}

function fieldMarks(tab: ConfigTab): FieldMark[] {
  const panel = container!.querySelector(`[data-config-panel="${tab}"]`)!
  return (Array.from(panel.querySelectorAll('[data-field-path], [data-field-list]')) as HTMLElement[]).flatMap((element) => {
    const where = `${tab}/${element.closest('[data-config-section]')?.getAttribute('data-config-section') ?? '?'}`
    const path = element.getAttribute('data-field-path')
    const list = element.getAttribute('data-field-list')
    return [
      ...(path === null ? [] : [{ kind: 'path' as const, value: path, where }]),
      ...(list === null ? [] : [{ kind: 'list' as const, value: list, where }]),
    ]
  })
}

async function activateTab(tab: ConfigTab) {
  const trigger = container!.querySelector(`[role="tab"][data-config-tab="${tab}"]`)
  expect(trigger, tab).not.toBeNull()
  await act(async () => {
    trigger!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }))
  })
  await flushRender()
}

/** Every field mark on every tab, with each row of each list opened in turn (Radix unmounts inactive panels). */
async function collectFieldMarks(): Promise<FieldMark[]> {
  const marks: FieldMark[] = []
  for (const tab of CONFIG_TABS) {
    await activateTab(tab)
    marks.push(...fieldMarks(tab))
    const panel = container!.querySelector(`[data-config-panel="${tab}"]`)!
    const headers = Array.from(panel.querySelectorAll('[data-model-row-toggle], [data-row-header]')) as HTMLElement[]
    for (const header of headers) {
      await act(async () => {
        header.click()
      })
      await flushRender()
      marks.push(...fieldMarks(tab))
    }
  }
  return marks
}

/**
 * The marks that can stand for a leaf: a field whose path is the pattern, a list whose owner is
 * the pattern's owner, or, for a list of plain values (`a.b[]`), the one field that edits the
 * whole list at its owner path.
 */
function coversLeaf(mark: FieldMark, pattern: string): boolean {
  const owner = configLeafOwner(pattern)
  if (mark.kind === 'list') return mark.value === owner
  return mark.value === pattern || (pattern === `${owner}[]` && mark.value === owner)
}

afterEach(() => {
  cleanupRender()
  page.config = undefined
  vi.clearAllMocks()
  // A stored add-row draft would re-open the add row on the next render.
  localStorage.clear()
})

describe('ConfigPage schema coverage', () => {
  it('SCHEMA-COVERAGE-EVERY-LEAF: every schema leaf but plugins has a field or list owner on some tab', async () => {
    page.config = fullConfig
    await renderAt('/config/models')

    const marks = await collectFieldMarks()
    const uncovered = PAGE_LEAVES.filter((pattern) => !marks.some((mark) => coversLeaf(mark, pattern)))
    expect(uncovered, `schema leaves with no field on the page: ${uncovered.join(', ')}`).toEqual([])
    for (const pattern of ['use.workers', 'use.buildTag']) {
      expect(marks.some((mark) => mark.kind === 'path' && mark.value === pattern), pattern).toBe(true)
    }
  })

  // The page-writable leaves are the strict leaves less the four plugin leaves; each has a
  // rendered owner and the write door admits it.
  it('C432-CONFIG-WRITABLE: exactly the page-writable leaves, each owned on the page, and only the four plugin leaves excluded', async () => {
    page.config = fullConfig
    await renderAt('/config/models')

    expect(PAGE_LEAVES).toEqual(expect.arrayContaining(['use.planner.maxActions', 'use.planner.maxPlanningTurns']))
    expect(CONFIG_WRITE_DENIED_ROOTS).toEqual(['plugins'])
    expect(CONFIG_SCHEMA_LEAVES.filter((pattern) => !PAGE_LEAVES.includes(pattern))).toEqual([
      'plugins.auth[].package',
      'plugins.auth[].path',
      'plugins.providers[].package',
      'plugins.providers[].path',
    ])
    const marks = await collectFieldMarks()
    const owned = PAGE_LEAVES.filter((pattern) => marks.some((mark) => coversLeaf(mark, pattern)))
    expect(owned).toEqual(PAGE_LEAVES)
    for (const leaf of ['use.planner.maxActions', 'use.planner.maxPlanningTurns']) {
      expect(
        [...new Set(marks.filter((mark) => mark.kind === 'path' && mark.value === leaf).map((mark) => mark.where))],
        leaf,
      ).toEqual(['models/planner-limits'])
    }
    expect(owned.filter((pattern) => !isPageWritableConfigPath(concretePath(pattern)))).toEqual([])
  })

  it('SCHEMA-COVERAGE-EXACTLY-ONCE: each leaf is owned by exactly one section, and no field or list renders in two sections', async () => {
    page.config = fullConfig
    await renderAt('/config/models')

    const marks = await collectFieldMarks()
    const twice = PAGE_LEAVES.flatMap((pattern) => {
      const sections = new Set(marks.filter((mark) => coversLeaf(mark, pattern)).map((mark) => mark.where))
      return sections.size > 1 ? [`${pattern} (${[...sections].join(', ')})`] : []
    })
    expect(twice, `schema leaves rendered by more than one section: ${twice.join('; ')}`).toEqual([])

    const sectionsByMark = new Map<string, Set<string>>()
    for (const mark of marks) {
      const key = `${mark.kind}=${mark.value}`
      sectionsByMark.set(key, (sectionsByMark.get(key) ?? new Set()).add(mark.where))
    }
    const shared = [...sectionsByMark].filter(([, sections]) => sections.size > 1).map(([key, sections]) => `${key} (${[...sections].join(', ')})`)
    expect(shared, `fields rendered by more than one section: ${shared.join('; ')}`).toEqual([])
  })

  it('WRITE-POLICY-MATCHES-COVERAGE: every field and list the page renders is writable through its door, and every leaf it leaves out is refused', async () => {
    page.config = fullConfig
    await renderAt('/config/models')

    const marks = await collectFieldMarks()
    expect(marks.length, 'the witness: the walk found fields').toBeGreaterThan(0)
    const refused = [...new Set(marks.map((mark) => mark.value))]
      .filter((value) => !isPageWritableConfigPath(concretePath(value)))
    expect(refused, `fields the page renders but its door refuses: ${refused.join(', ')}`).toEqual([])

    const excluded = CONFIG_SCHEMA_LEAVES.filter((pattern) => !PAGE_LEAVES.includes(pattern))
    expect(excluded.length, 'the witness: plugins leaves exist').toBeGreaterThan(0)
    const admitted = excluded.filter((pattern) => isPageWritableConfigPath(concretePath(pattern)))
    expect(admitted, `leaves without a field that the door still admits: ${admitted.join(', ')}`).toEqual([])
  })

  it('EVERY-SECTION-RENDERS-EMPTY: with an empty config all five tabs and every section heading render, unset leaves show defaults only as placeholders, and Models shows its empty state', async () => {
    page.config = {}
    const view = await renderAt('/config/models')

    const tabs = Array.from(view.querySelectorAll('[role="tab"]')) as HTMLElement[]
    expect(tabs.map((tab) => tab.getAttribute('data-config-tab'))).toEqual([...CONFIG_TABS])
    for (const tab of tabs) {
      expect(tab.hasAttribute('disabled'), tab.getAttribute('data-config-tab')!).toBe(false)
      expect(tab.getAttribute('aria-disabled'), tab.getAttribute('data-config-tab')!).not.toBe('true')
      expect(tab.hidden, tab.getAttribute('data-config-tab')!).toBe(false)
    }
    expect(view.querySelector('[data-config-section="models"] [data-models-empty]')).not.toBeNull()

    for (const tab of CONFIG_TABS) {
      await activateTab(tab)
      const panel = view.querySelector(`[data-config-panel="${tab}"]`) as HTMLElement
      expect(panel, tab).not.toBeNull()
      for (const id of CONFIG_SECTIONS[tab]) {
        const heading = panel.querySelector(`[data-config-section="${id}"] > h2`)
        expect(heading?.textContent, `${tab}/${id}`).toBe(CONFIG_SECTION_LABELS[id])
      }
      const filled = (
        Array.from(panel.querySelectorAll('[data-config-field] input, [data-config-field] textarea')) as (
          | HTMLInputElement
          | HTMLTextAreaElement
        )[]
      )
        .filter((control) => !['checkbox', 'radio', 'hidden'].includes(control.getAttribute('type') ?? ''))
        .filter((control) => control.value !== '')
        .map((control) => control.closest('[data-field-path]')?.getAttribute('data-field-path'))
      expect(filled, `${tab}: unset leaves showing a value instead of a placeholder`).toEqual([])
    }
  })

  it('matches the final UI-SPEC inventory exactly', () => {
    expect([...LEGACY_CONFIG_PAIRS]).toEqual(EXPECTED_DESTINATIONS)
  })

  it('exposes only the current LLM provider contract in UI fixtures', () => {
    // The built-in key providers are the add row's key choices; the sign-in ones come from the plugin.
    const keyProviders = CONNECTION_CHOICES.filter((choice) => choice.endsWith('-key')).map(
      (choice) => CONNECTION_CHOICE_PROVIDERS[choice],
    )
    expect(keyProviders).toEqual([
      'openai-compatible',
      'anthropic-compatible',
      'gemini',
    ])
    expect([...LLM_PROVIDER_COMPLETION_VALUES]).toEqual([
      'openai-compatible',
      'anthropic-compatible',
      'openai-subscription',
      'anthropic-subscription',
      'gemini',
    ])
    expect(keyProviders.map((provider) => PROVIDER_FALLBACK_LABELS[provider])).toEqual([
      'OpenAI-compatible',
      'Anthropic-compatible',
      'Gemini',
    ])
    const choiceProviders: string[] = Object.values(CONNECTION_CHOICE_PROVIDERS)
    expect(new Set(choiceProviders)).toEqual(new Set(LLM_PROVIDER_COMPLETION_VALUES))
    for (const retired of ['anthropic', 'openai', 'google', 'authMethod', 'ollama', 'lmstudio', 'custom']) {
      expect(choiceProviders).not.toContain(retired)
    }
  })

  it('renders provider header rows only for anthropic-compatible', async () => {
    await renderAt('/config/models')
    const proxy = await openModelRow('anthropic-compatible')
    expect(proxy.querySelector('[data-model-headers] legend')?.textContent).toBe(ADD_FLOW_FIELD_LABELS.headers)
    expect(buttonIn(proxy, ADD_HEADER_LABEL)).not.toBeNull()
    for (const name of ['openai-compatible', 'gemini-fast', 'codex', 'claude-subscription']) {
      const panel = await openModelRow(name)
      expect(panel.querySelector('[data-model-headers]'), name).toBeNull()
    }
    cleanupRender()

    await renderAddRow('anthropic-compatible-key')
    expect(addRow()?.querySelector('[data-add-headers]')).not.toBeNull()
    for (const choice of ['openai-compatible-key', 'gemini-key', 'chatgpt-sign-in', 'claude-sign-in'] as const) {
      await chooseConnection(choice)
      expect(addRow()?.querySelector('[data-add-headers]'), choice).toBeNull()
    }
  })

  it('allows bearer-token credential selection for anthropic-compatible', async () => {
    await renderAddRow('anthropic-compatible-key')
    const keyType = addRow()?.querySelector('[data-add-field="keyType"]')
    expect(keyType?.textContent).toContain(KEY_TYPE_LABELS['api-key'])
    expect(keyType?.textContent).toContain(KEY_TYPE_LABELS['bearer-token'])
    await press(keyType?.querySelector('[role="radio"][value="bearer-token"]'))
    expect(addRow()?.querySelector('[data-add-field="key"] label')?.textContent).toBe(ADD_FLOW_FIELD_LABELS.token)
    // The key goes with Connect; the modal's separate Save Credential button is gone.
    expect(document.body.textContent).not.toContain('Save Credential')

    await chooseConnection('openai-compatible-key')
    expect(addRow()?.querySelector('[data-add-field="keyType"]')).toBeNull()
  })

  it('saves anthropic-compatible bearer tokens through the typed credential API', async () => {
    mockFetchAuthStatus.mockResolvedValue({ credentials: [bearerCredential()] })
    try {
      await renderAt('/config/models')
      const panel = await openModelRow('anthropic-compatible')
      await press(buttonIn(panel, REPLACE_KEY_LABEL))
      const secretInput = modelRow('anthropic-compatible')!.querySelector('[data-replace-key] input[type="password"]') as HTMLInputElement | null
      expect(secretInput).not.toBeNull()
      await act(async () => {
        setInputValue(secretInput!, 'bearer-secret')
      })
      await press(buttonIn(modelRow('anthropic-compatible'), SAVE_KEY_AND_TEST_LABEL))

      expect(mockSaveCredential).toHaveBeenCalledWith(
        'anthropic-compatible',
        'anthropic-compatible',
        'bearer-token',
        'bearer-secret',
      )
      expect(container!.innerHTML).not.toContain('bearer-secret')
      cleanupRender()

      vi.mocked(connectLLM).mockResolvedValueOnce({ success: false, errorClass: 'auth_error', message: 'Refused.' })
      await renderAddRow('anthropic-compatible-key')
      await press(addRow()?.querySelector('[data-add-field="keyType"] [role="radio"][value="bearer-token"]'))
      for (const [field, value] of [['baseURL', 'https://anthropic-proxy.example/messages'], ['model', 'claude-remote'], ['key', 'draft-bearer'], ['name', 'claude-draft']] as const) {
        await act(async () => {
          setInputValue(addRow()!.querySelector(`[data-add-field="${field}"] input`) as HTMLInputElement, value)
        })
      }
      await flushRender()
      await press(addRow()?.querySelector('[data-add-connect]'))
      expect(vi.mocked(connectLLM).mock.calls[0]?.[0].credential).toEqual({ type: 'bearer-token', secret: 'draft-bearer' })
    } finally {
      mockFetchAuthStatus.mockResolvedValue({ credentials: [] })
    }
  })

  it('credential deletion no longer asks first: Remove key acts at once and offers Undo', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    mockFetchAuthStatus.mockResolvedValue({ credentials: [bearerCredential()] })
    vi.mocked(deleteAuthCredential).mockResolvedValueOnce({
      deleted: true,
      undo: { token: 'undo-key', expiresAt: Date.now() + 30_000 },
    } as never)
    try {
      await renderAt('/config/models')
      const panel = await openModelRow('anthropic-compatible')
      await press(buttonIn(panel, REMOVE_KEY_LABEL))

      expect(deleteAuthCredential).toHaveBeenCalledWith('anthropic-compatible')
      expect(document.body.querySelector('[role="dialog"], [role="alertdialog"]')).toBeNull()
      expect(confirmSpy).not.toHaveBeenCalled()
      expect(document.body.textContent).not.toContain('Delete saved credential for')
      expect(document.body.textContent).not.toContain('Keep Credential')
      expect(document.body.textContent).not.toContain('Delete Credential')
      expect(container!.textContent).toContain(undoLine('remove-key', 'anthropic-compatible'))
    } finally {
      mockFetchAuthStatus.mockResolvedValue({ credentials: [] })
      confirmSpy.mockRestore()
    }
  })

  it('uses a free text model input with datalist suggestions', async () => {
    await renderAt('/config/models')
    const panel = await openModelRow('openai-compatible')
    const saved = panel.querySelector('[data-field-path="registry.llms[].model"] input') as HTMLInputElement | null
    expect(saved?.type).toBe('text')
    expect(saved?.value).toBe('openrouter/auto')
    cleanupRender()

    await renderAddRow('openai-compatible-key')
    const input = addRow()?.querySelector('[data-add-field="model"] input') as HTMLInputElement | null
    expect(input?.type).toBe('text')
    const listId = input?.getAttribute('list')
    expect(listId).toBeTruthy()
    expect(document.getElementById(listId!)?.tagName).toBe('DATALIST')
  })

  it('renders maintained model suggestions without replacing free text entry', async () => {
    await renderAddRow('openai-compatible-key')
    const input = addRow()?.querySelector('[data-add-field="model"] input') as HTMLInputElement | null

    expect(document.body.innerHTML).toContain('<datalist')
    expect(document.getElementById(input!.getAttribute('list')!)?.querySelector('option[value="openrouter/auto"]')).not.toBeNull()
    await act(async () => {
      setInputValue(input!, 'my-own/model-id')
    })
    await flushRender()
    expect(input!.value).toBe('my-own/model-id')
    expect(document.body.textContent).not.toContain('PROVIDER_MODELS')
    expect(document.body.textContent).not.toContain('SUBSCRIPTION_MODELS')
    expect(document.body.textContent).not.toContain('Gemini 2.0 Flash')
    expect(document.body.textContent).not.toContain('GPT-4o')
    expect(document.body.textContent).not.toContain('Claude Sonnet 4')
  })

  it('renders a real editor surface for every schema-backed destination', async () => {
    for (const destination of EXPECTED_DESTINATIONS) {
      const [bucket, item] = destination.split(':')
      const contract = SURFACE_MARKERS[destination]
      const view = await renderAt(`/config?bucket=${bucket}&item=${item}`)

      expect(view.textContent).toContain(contract.title)
      expect(view.textContent).toContain(contract.marker)
      expect(view.textContent).not.toContain('Missing config surface')

      cleanupRender()
    }
  })

  it('Config section shells: every legacy destination', async () => {
    const destinations: string[] = [...LEGACY_CONFIG_PAIRS]

    expect(destinations).toEqual(EXPECTED_DESTINATIONS)
    await assertConfigSectionShells(destinations)
  })

  it('Config section shells: Workspace sections', async () => {
    await assertConfigSectionShells([
      'workspace:discovery',
      'workspace:files',
    ])
  })

  it('Config section shells: Services sections', async () => {
    await assertConfigSectionShells([
      'services:dashboard',
      'services:cache',
      'services:auth-states',
      'services:logging',
      'services:recording',
      'services:accessibility',
    ])
  })

  it('Config section shells: Use runtime sections', async () => {
    await assertConfigSectionShells([
      'use:browser',
      'use:timeouts',
      'use:planner',
      'use:log-capture',
    ])
  })

  it('Config section shells: Execution defaults sections', async () => {
    await assertConfigSectionShells([
      'use:execution-defaults',
    ])
  })

  it('Config section shells: Analytics sections', async () => {
    await assertConfigSectionShells([
      'analytics:pass-rate-scope',
    ])
  })

  it('Config section shells: Knowledge section', async () => {
    await assertConfigSectionShells([
      'knowledge:store',
    ])
  })

  it('Config section shells: Targets and Devices sections', async () => {
    await assertConfigSectionShells([
      'registry:targets',
      'registry:devices',
    ])
  })

  it('Config section shells: LLM section', async () => {
    await assertConfigSectionShells([
      'registry:llms',
    ])
  })
})
