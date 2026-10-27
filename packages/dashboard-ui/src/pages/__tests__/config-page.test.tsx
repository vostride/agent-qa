// @vitest-environment jsdom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { APPROVED_SAAS_PLACEHOLDER_SLUGS } from '@vostride/agent-qa-ids'
import { CONFIG_SCHEMA_LEAVES, configLeafOwner } from '@vostride/agent-qa-schema'

import {
  applyConfigChanges,
  connectLLM,
  exchangePluginAuthCode,
  fetchAppMetadata,
  fetchAuthStates,
  fetchAuthStatus,
  fetchConfig,
  fetchConfigRevision,
  fetchLLMProviders,
  pollPluginAuthResult,
  saveCredential,
  startPluginAuth,
  testLLMConnection,
} from '@/lib/api'
import {
  ACCESSIBILITY_FIELD_PLACEHOLDERS,
  ADD_DEVICE_LABEL,
  ADD_TARGET_LABEL,
  ADD_MODEL_LABEL,
  BASE_URL_HELP,
  BASE_URL_REQUIRED_ERROR,
  CONFIG_LOAD_FAILED_TITLE,
  CONFIG_PAGE_TITLE,
  CONFIG_SECTION_LABELS,
  CONFIG_TAB_LABELS,
  CONFIG_TABS_ARIA_LABEL,
  CONFIG_FILE_ISSUES_TITLE,
  HEADLESS_HELP,
  LEGACY_LINK_NOT_FOUND_TEXT,
  MAKE_DEFAULT_LABEL,
  MODEL_STATUS_WORDS,
  NOT_SAVED_ACTION_NAME,
  NO_DEVICES_TEXT,
  NO_LOGIN_STATES_TEXT,
  NO_TARGETS_TEXT,
  LOGIN_STATES_LOADING_TEXT,
  LOGIN_STATES_LOAD_FAILED_TEXT,
  LOGIN_STATE_COLUMN_LABELS,
  MOBILE_APP_STATE_LABELS,
  MOBILE_FIELD_LABELS,
  RELOAD_LOGIN_STATES_LABEL,
  TARGET_FIELD_LABELS,
  DEVICE_FIELD_LABELS,
  PORT_RESTART_HELP,
  PROVIDER_FALLBACK_LABELS,
  RELOAD_CONFIG_LABEL,
  RETRY_LABEL,
  SAVE_STATUS_WORDS,
  SETTLE_DELAY_MS,
  SIGN_IN_AGAIN_LABEL,
  TAB_DRAFT_SR_SUFFIX,
  TEST_CONNECTION_LABEL,
  TEST_RESULT_TEXT,
  VISION_FIELD_LABELS,
  PLANNER_FIELD_LABELS,
  applyActionName,
  connectionSentence,
  configFileIssuesBody,
  configLoadFailedBody,
  DASHBOARD_FIELD_LABELS,
  ENV_FILE_REQUIRED_ERROR,
  FILES_FIELD_HELP,
  FILES_FIELD_LABELS,
  HOOKS_FILE_REQUIRED_ERROR,
  KNOWLEDGE_FIELD_LABELS,
  PRIVACY_FIELD_LABELS,
  SUITE_MATCH_REQUIRED_ERROR,
  TEST_MATCH_REQUIRED_ERROR,
  attributeValueLabel,
  replaceValueName,
  undoLine,
} from '@/lib/config-copy'
import { CONFIG_DRAFTS_STORAGE_PREFIX, configFieldControlId, configFieldKeyOf } from '@/hooks/use-config-autosave'
import {
  CONFIG_SECTIONS,
  CONFIG_TABS,
  CONNECTION_CHOICES,
  CONNECTION_CHOICE_PROVIDERS,
  LEGACY_CONFIG_LINKS,
  LEGACY_CONFIG_PAIRS,
  type ConfigSectionId,
  type ConfigTab,
} from '@/lib/config-tabs'
import { routes } from '@/lib/routes'
import ConfigPage from '@/pages/config'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { sampleConfig, CONFIG_FILE_PATH } = vi.hoisted(() => ({
  CONFIG_FILE_PATH: '/work/agent-qa.config.yaml',
  sampleConfig: {
  workspace: {
    testMatch: ['tests/**/*.yaml'],
    suiteMatch: ['tests/**/*.suite.yaml'],
    testPathIgnore: ['**/draft/**'],
    hooksFile: 'tests/hooks.ts',
    envFile: '.env.local',
    secretsFile: '.secrets.local',
  },
  knowledge: {
    dir: 'agent-qa-knowledge',
    commitArtifacts: 'none',
  },
  services: {
    dashboard: {
      port: 4173,
      dbPath: '.agent-qa/runs.db',
      artifactsDir: '.agent-qa/artifacts',
    },
    cache: { dir: '.agent-qa/cache', ttl: '7d' },
    logging: { level: 'info' },
    recording: { enabled: true },
    accessibility: {
      enabled: true,
      standard: 'wcag2aa',
      runAfter: 'test-end',
      failOnViolation: false,
    },
  },
  registry: {
    llms: [{
      name: 'primary',
      provider: 'openai-compatible',
      model: 'gpt-4.1',
      baseURL: 'https://api.openai.com/v1',
      vision: true,
      contextWindow: '128k',
    }],
    targets: { staging: { platform: 'web', url: 'https://example.com' } },
    devices: { iosLocal: { platform: 'ios', transport: 'local', match: { udid: 'abc' } } },
  },
  use: {
    browser: { name: 'chromium', headless: true, viewport: { width: 1280, height: 720 } },
    timeout: { step: '30s', test: '10m', navigation: '10s' },
    planner: { maxActions: 30, maxPlanningTurns: 30, previousStepCount: 5 },
    logCapture: { console: true, network: true },
    mobile: { appState: 'reset' },
    llm: 'primary',
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

const API_EXPORTS = Object.keys(await vi.importActual<typeof import('@/lib/api')>('@/lib/api'))

vi.mock('@/lib/api', () => ({
  fetchAppMetadata: vi.fn().mockResolvedValue({
    version: '0.1.13',
  }),
  fetchConfig: vi.fn().mockResolvedValue({
    config: sampleConfig,
    provider: 'openai-compatible',
    revision: 'rev-1',
    file: { path: CONFIG_FILE_PATH, lines: [] },
  }),
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
  testLLMConnection: vi.fn().mockResolvedValue({ success: true }),
  saveCredential: vi.fn().mockResolvedValue({ saved: true }),
  startPluginAuth: vi.fn().mockResolvedValue({ authorizeUrl: 'https://auth.example/start', sessionId: 'session-1', mode: 'manual-code' }),
  pollPluginAuthResult: vi.fn().mockResolvedValue({ status: 'pending' }),
  exchangePluginAuthCode: vi.fn().mockResolvedValue({ status: 'completed', saved: true }),
  deleteAuthCredential: vi.fn(),
  connectLLM: vi.fn(),
  moveCredential: vi.fn(),
}))

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('@/hooks/use-page-title', () => ({ usePageTitle: () => {} }))
vi.mock('@/components/ui/tooltip', () => ({
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

function LocationProbe() {
  const location = useLocation()
  return (
    <div
      data-testid="location"
      data-pathname={location.pathname}
      data-search={location.search}
    />
  )
}

let container: HTMLDivElement | null = null
let root: Root | null = null
let scrollIntoViewSpy: ReturnType<typeof vi.fn>

beforeEach(() => {
  scrollIntoViewSpy = vi.fn()
  Element.prototype.scrollIntoView = scrollIntoViewSpy as unknown as Element['scrollIntoView']
})

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

  const page = (
    <>
      <LocationProbe />
      <ConfigPage />
    </>
  )

  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="/config" element={page} />
          <Route path="/config/:tab" element={page} />
        </Routes>
      </MemoryRouter>,
    )
  })

  await flushRender()
  return container
}

function currentLocation() {
  const probe = container?.querySelector('[data-testid="location"]')
  return {
    pathname: probe?.getAttribute('data-pathname') ?? null,
    search: probe?.getAttribute('data-search') ?? null,
  }
}

function tabTriggers() {
  return Array.from(container?.querySelectorAll('[role="tab"]') ?? []) as HTMLButtonElement[]
}

function tabTrigger(tab: ConfigTab) {
  return container?.querySelector(`[role="tab"][data-config-tab="${tab}"]`) as HTMLButtonElement | null
}

async function activateTab(tab: ConfigTab) {
  const trigger = tabTrigger(tab)
  expect(trigger, tab).not.toBeNull()
  await act(async () => {
    trigger!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }))
  })
  await flushRender()
}

async function pressKey(target: Element, key: string) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  await flushRender()
}

function section(id: ConfigSectionId) {
  return container?.querySelector(`[data-config-section="${id}"]`) as HTMLElement | null
}

function sectionButton(id: ConfigSectionId, label: string) {
  const buttons = Array.from(section(id)?.querySelectorAll('button') ?? []) as HTMLButtonElement[]
  return buttons.find((button) => button.textContent?.trim() === label) ?? null
}

function findButton(label: string) {
  const buttons = Array.from(container?.querySelectorAll('button') ?? []) as HTMLButtonElement[]
  return buttons.find((button) => button.textContent?.trim() === label) ?? null
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

// The page chrome with every section body stripped: what a reader sees besides the section
// headings and the shipped editors each section still mounts until its own plan rebuilds it.
function shellChrome(view: HTMLElement) {
  const page = view.querySelector('[data-config-page]')!.cloneNode(true) as HTMLElement
  for (const node of Array.from(page.querySelectorAll('[data-config-section] > :not(h2)'))) {
    node.remove()
  }
  return page
}

const BUCKET_LABELS = /\b(?:Workspace|Services|Registry|Use|Analytics)\b/
const DOTTED_CONFIG_PATH = /\b(?:workspace|services|registry|use|knowledge|analytics)\.[A-Za-z]/

function readAnswer({ config }: { config: Record<string, unknown> }) {
  return { config, provider: null, revision: 'rev-1', file: { path: CONFIG_FILE_PATH, lines: [] } }
}

function configWithLlm(llm: Record<string, unknown>) {
  const name = String(llm.name ?? '')
  return {
    ...sampleConfig,
    registry: {
      ...sampleConfig.registry,
      llms: [llm],
    },
    use: {
      ...sampleConfig.use,
      llm: name,
    },
  }
}

function configWithTargets(targets: Record<string, unknown>) {
  return {
    ...sampleConfig,
    registry: {
      ...sampleConfig.registry,
      targets,
    },
  }
}

/** The add row's draft field (429-25): its label, input, help and error line. */
function addField(name: string) {
  return container?.querySelector(`[data-model-draft] [data-add-field="${name}"]`) as HTMLElement | null
}

function modelRow(name: string) {
  return (Array.from(container?.querySelectorAll('[data-model-row]') ?? []) as HTMLElement[]).find(
    (item) => item.getAttribute('data-model-name') === name,
  ) ?? null
}

async function openModelRow(name: string) {
  const header = modelRow(name)?.querySelector('[data-model-row-toggle]') as HTMLButtonElement | null
  expect(header, `the ${name} row header`).not.toBeNull()
  await act(async () => {
    header!.click()
  })
  await flushRender()
  return modelRow(name)!.querySelector('[data-model-panel]') as HTMLElement
}

function buttonIn(scope: ParentNode | null | undefined, label: string) {
  const buttons = Array.from(scope?.querySelectorAll('button') ?? []) as HTMLButtonElement[]
  return buttons.find((button) => button.textContent?.trim() === label) ?? null
}

afterEach(() => {
  if (root) {
    act(() => root!.unmount())
  }
  root = null
  if (container) {
    container.remove()
  }
  container = null
  delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView
  vi.useRealTimers()
  vi.clearAllMocks()
  localStorage.clear()
})

const STEP_SEGMENTS = ['use', 'timeout', 'step']
const STEP_KEY = configFieldKeyOf(STEP_SEGMENTS)
const HEADLESS_SEGMENTS = ['use', 'browser', 'headless']
const PARALLEL_SEGMENTS = ['use', 'parallel']
const KEEP_FAILURES_SEGMENTS = ['services', 'recording', 'keepFailuresOnly']
const EXCLUDE_SEGMENTS = ['services', 'accessibility', 'exclude']
const TEST_MATCH_SEGMENTS = ['workspace', 'testMatch']
const SUITE_MATCH_SEGMENTS = ['workspace', 'suiteMatch']
const TEST_PATH_IGNORE_SEGMENTS = ['workspace', 'testPathIgnore']
const HOOKS_FILE_SEGMENTS = ['workspace', 'hooksFile']
const ENV_FILE_SEGMENTS = ['workspace', 'envFile']
const PRIVACY_SEGMENTS = ['analytics', 'privacy']

function fieldControl<T extends HTMLElement>(segments: readonly string[]) {
  return document.getElementById(configFieldControlId(configFieldKeyOf(segments))) as T | null
}

async function typeTextAndBlur(input: HTMLInputElement, value: string) {
  await act(async () => {
    input.focus()
    setInputValue(input, value)
  })
  await act(async () => {
    input.blur()
  })
  await flushRender()
}

async function typeListAndBlur(textarea: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
  await act(async () => {
    textarea.focus()
    setter?.call(textarea, value)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => {
    textarea.blur()
  })
  await flushRender()
}

/** The Step timeout ConfigField, which the 429-16 wiring cells drive. */
function stepInput() {
  return document.getElementById(configFieldControlId(STEP_KEY)) as HTMLInputElement | null
}

function statusRegion() {
  return container?.querySelector('[data-config-tabbar] [role="status"]') as HTMLElement | null
}

/** Types a value into Step timeout and leaves it focused, so only the pause can settle it. */
async function typeWithoutSettling(value: string) {
  const input = stepInput()
  expect(input, 'the Step timeout input').not.toBeNull()
  await act(async () => {
    input!.focus()
    setInputValue(input!, value)
  })
}

/** Types a value into Step timeout and settles it with Enter, so focus never leaves the field. */
async function typeAndSettle(value: string) {
  const input = stepInput()
  expect(input, 'the Step timeout input').not.toBeNull()
  await act(async () => {
    input!.focus()
    setInputValue(input!, value)
  })
  await act(async () => {
    input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  })
  await flushRender()
}

function refusedWrite() {
  return Object.assign(new Error('validation_failed'), {
    payload: {
      error: 'validation_failed',
      issues: [{ path: STEP_SEGMENTS, message: 'Step timeout must be at least 1s.' }],
    },
  })
}

/**
 * What Tab visits, in order: enabled controls and tabindex >= 0 elements in DOM order, skipping
 * hidden inactive panels. Radix makes the tab list itself the strip's one stop (roving focus
 * then lands on the active tab).
 */
const APP_STATE_SEGMENTS = ['use', 'mobile', 'appState']

function deferredValue<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

async function openRow(row: Element | null) {
  const header = row?.querySelector('[data-row-header]') as HTMLButtonElement | null
  expect(header, 'the row header').not.toBeNull()
  await act(async () => {
    header!.click()
  })
  await flushRender()
}

/** Opens a Radix select from the keyboard and picks the option with this text. */
async function chooseOption(trigger: HTMLElement | null, text: string) {
  expect(trigger, 'the select trigger').not.toBeNull()
  await act(async () => {
    trigger!.focus()
    trigger!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  })
  await flushRender()
  const option = (Array.from(document.body.querySelectorAll('[role="option"]')) as HTMLElement[]).find(
    (item) => item.textContent?.trim() === text,
  )
  expect(option, text).toBeDefined()
  await act(async () => {
    option!.focus()
    option!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  })
  await flushRender()
}

function tabStops(root: ParentNode): HTMLElement[] {
  return (Array.from(root.querySelectorAll('a[href], button, input, select, textarea, [tabindex]')) as HTMLElement[])
    .filter((element) => element.tabIndex >= 0 && !(element as HTMLButtonElement).disabled)
    .filter((element) => element.closest('[hidden], [aria-hidden="true"], .sr-only') === null)
}

describe('ConfigPage autosave wiring (429-16 Task 3)', () => {
  it('STATUS-IN-TAB-BAR: the one status sits in the tab bar, outside the scrolling tab list', async () => {
    const view = await renderAt('/config/models')

    const statuses = view.querySelectorAll('[data-save-status]')
    expect(statuses).toHaveLength(1)
    const status = statuses[0]!
    expect(status.closest('[data-config-tabbar]')).not.toBeNull()
    expect(status.closest('[data-config-tabs-scroll]')).toBeNull()
    expect(status.closest('[data-config-status-slot]')?.className).toContain('shrink-0')
    expect(status.getAttribute('data-save-status')).toBe('idle')
  })

  it('TAB-DRAFT-DOT: a draft restored from storage marks its tab with a dot and an accessible suffix', async () => {
    localStorage.setItem(
      `${CONFIG_DRAFTS_STORAGE_PREFIX}${CONFIG_FILE_PATH}`,
      JSON.stringify({ [STEP_KEY]: { segments: STEP_SEGMENTS, tab: 'execution', raw: '30 seconds' } }),
    )
    const view = await renderAt('/config/models')

    const execution = tabTrigger('execution')!
    expect(execution.querySelector('[data-tab-draft]')).not.toBeNull()
    expect(execution.querySelector('[data-tab-draft]')?.getAttribute('aria-hidden')).not.toBeNull()
    expect(execution.textContent).toBe(`${CONFIG_TAB_LABELS.execution}${TAB_DRAFT_SR_SUFFIX}`)
    for (const tab of CONFIG_TABS.filter((id) => id !== 'execution')) {
      expect(tabTrigger(tab)?.querySelector('[data-tab-draft]'), tab).toBeNull()
      expect(tabTrigger(tab)?.textContent, tab).toBe(CONFIG_TAB_LABELS[tab])
    }
    expect(view.querySelector('[data-save-status]')?.getAttribute('data-save-status')).toBe('draft')
    expect(applyConfigChanges).not.toHaveBeenCalled()
  })

  it('NOT-SAVED-GOES-TO-FIRST-DRAFT: Not saved opens the draft\'s tab and focuses its field', async () => {
    localStorage.setItem(
      `${CONFIG_DRAFTS_STORAGE_PREFIX}${CONFIG_FILE_PATH}`,
      JSON.stringify({ [STEP_KEY]: { segments: STEP_SEGMENTS, tab: 'execution', raw: '30 seconds' } }),
    )
    await renderAt('/config/models')

    const notSaved = container?.querySelector(`button[aria-label="${NOT_SAVED_ACTION_NAME}"]`) as HTMLButtonElement | null
    expect(notSaved).not.toBeNull()
    await act(async () => {
      notSaved!.click()
    })
    await flushRender()
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(currentLocation().pathname).toBe('/config/execution')
    expect(document.activeElement).toBe(stepInput())
    expect(document.activeElement?.id).toBe(configFieldControlId(STEP_KEY))
    expect(stepInput()?.value).toBe('30 seconds')
  })

  it('ERROR-ANNOUNCED-FOCUS-STAYS: a refused write is announced politely, marks the field, and leaves focus where it was', async () => {
    vi.mocked(applyConfigChanges).mockRejectedValueOnce(refusedWrite())
    await renderAt('/config/execution')

    await typeAndSettle('0s')

    expect(applyConfigChanges).toHaveBeenCalledTimes(1)
    expect(vi.mocked(applyConfigChanges).mock.calls[0]![0]).toEqual([{ op: 'set', path: STEP_SEGMENTS, value: '0s' }])
    expect(statusRegion()?.getAttribute('aria-live')).toBe('polite')
    expect(statusRegion()?.textContent).toBe(SAVE_STATUS_WORDS.failed)
    expect(container?.querySelector('[data-save-status]')?.getAttribute('data-save-status')).toBe('failed')
    expect(container?.querySelector('[data-save-status]')?.textContent).not.toContain(SAVE_STATUS_WORDS.saved)
    expect(document.activeElement).toBe(stepInput())
    expect(stepInput()?.value).toBe('0s')
    expect(stepInput()?.getAttribute('aria-invalid')).toBe('true')
    const describedBy = stepInput()?.getAttribute('aria-describedby')
    expect(document.getElementById(describedBy!)?.textContent).toBe('Step timeout must be at least 1s.')
    expect(tabTrigger('execution')?.querySelector('[data-tab-draft]')).not.toBeNull()

    await act(async () => {
      findButton(RETRY_LABEL)!.click()
    })
    await flushRender()
    expect(applyConfigChanges).toHaveBeenCalledTimes(2)
    expect(container?.querySelector('[data-save-status]')?.getAttribute('data-save-status')).toBe('saved')
  })

  it('RETRY-RETURNS-FOCUS: once a Retry lands, focus goes back to the field whose write failed', async () => {
    vi.mocked(applyConfigChanges).mockRejectedValueOnce(
      Object.assign(new Error('write_failed'), { payload: { error: 'write_failed' } }),
    )
    await renderAt('/config/execution')
    await typeAndSettle('45s')
    expect(container?.querySelector('[data-save-status]')?.getAttribute('data-save-status')).toBe('failed')

    const retry = findButton(RETRY_LABEL)!
    await act(async () => {
      retry.focus()
    })
    expect(document.activeElement).toBe(retry)
    await act(async () => {
      retry.click()
    })
    await flushRender()

    expect(applyConfigChanges).toHaveBeenCalledTimes(2)
    expect(container?.querySelector('[data-save-status]')?.getAttribute('data-save-status')).toBe('saved')
    expect(document.activeElement).toBe(stepInput())
  })

  it('TAB-ORDER-STRIP-STATUS-PANEL: Tab goes from the active tab to Retry, then into the panel', async () => {
    vi.mocked(applyConfigChanges).mockRejectedValueOnce(refusedWrite())
    await renderAt('/config/execution')
    await typeAndSettle('0s')
    expect(container?.querySelector('[data-save-status]')?.getAttribute('data-save-status')).toBe('failed')

    const stops = tabStops(container!)
    const tablist = container!.querySelector('[role="tablist"]')!
    const strip = stops.filter((element) => element === tablist || tablist.contains(element))
    expect(strip, 'the tab strip is one stop').toHaveLength(1)
    expect(tabTrigger('execution')?.getAttribute('aria-selected')).toBe('true')
    const retry = findButton(RETRY_LABEL)!
    const panel = container!.querySelector('[data-config-panel="execution"]')!
    const firstPanelStop = stops.findIndex((element) => panel === element || panel.contains(element))

    expect(stops.indexOf(strip[0]!)).toBe(0)
    expect(firstPanelStop).toBeGreaterThan(0)
    expect(stops.slice(1, firstPanelStop)).toEqual([retry])
  })

  it('FILE-ISSUES-RECOVER-WITHOUT-RELOAD: a file failing validation shows one notice above the tabs, which clears when the file is fixed', async () => {
    vi.mocked(fetchConfig).mockResolvedValueOnce({
      ...readAnswer({ config: sampleConfig }),
      fileIssues: [{ path: STEP_SEGMENTS, message: 'Step timeout must be a duration such as 30s.' }],
    })
    const view = await renderAt('/config/models')

    const notices = view.querySelectorAll('[data-config-file-issues]')
    expect(notices).toHaveLength(1)
    expect(notices[0]!.textContent).toContain(CONFIG_FILE_ISSUES_TITLE)
    expect(notices[0]!.textContent).toContain(configFileIssuesBody('Step timeout must be a duration such as 30s'))
    const tabbar = view.querySelector('[data-config-tabbar]')!
    expect(notices[0]!.compareDocumentPosition(tabbar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    vi.mocked(fetchConfigRevision).mockResolvedValueOnce({ revision: 'rev-fixed' })
    vi.mocked(fetchConfig).mockResolvedValueOnce({ ...readAnswer({ config: sampleConfig }), revision: 'rev-fixed' })
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
    })
    await flushRender()

    expect(fetchConfig).toHaveBeenCalledTimes(2)
    expect(view.querySelector('[data-config-file-issues]')).toBeNull()
    expect(tabTriggers()).toHaveLength(CONFIG_TABS.length)
  })
})

describe('ConfigPage task tabs shell', () => {
  it('SHELL-LOADING: a pending read shows only the Config-shaped FormSkeleton and no tab strip', async () => {
    vi.mocked(fetchConfig).mockReturnValueOnce(new Promise(() => {}))

    const view = await renderAt('/config/models')

    expect(view.querySelector('[data-config-page]')?.getAttribute('data-config-state')).toBe('loading')
    expect(view.querySelector('[data-skeleton="config"]')).not.toBeNull()
    expect(view.querySelector('[role="tab"]')).toBeNull()
    expect(view.querySelector('[data-config-tabbar]')).toBeNull()
    expect(view.querySelector('[data-config-panel]')).toBeNull()
  })

  it('SHELL-LOADING: switching tabs renders from the loaded config and fetches nothing', async () => {
    const view = await renderAt('/config/models')
    expect(view.querySelector('[data-config-page]')?.getAttribute('data-config-state')).toBe('ready')
    expect(fetchConfig).toHaveBeenCalledTimes(1)

    await activateTab('execution')
    await activateTab('project')

    expect(currentLocation().pathname).toBe('/config/project')
    expect(section('files')).not.toBeNull()
    expect(fetchConfig).toHaveBeenCalledTimes(1)
  })

  it('LOAD-ERROR-RELOADS-WITHOUT-PAGE-RELOAD: a failed read offers Reload config, which re-reads in place', async () => {
    vi.mocked(fetchConfig).mockRejectedValueOnce(new Error('agent-qa.config.yaml is not valid YAML.'))

    const view = await renderAt('/config/models')

    const error = view.querySelector('[data-config-load-error]')
    expect(view.querySelector('[data-config-page]')?.getAttribute('data-config-state')).toBe('error')
    expect(error).not.toBeNull()
    expect(error?.textContent).toContain(CONFIG_LOAD_FAILED_TITLE)
    expect(error?.textContent).toContain(configLoadFailedBody('agent-qa.config.yaml is not valid YAML'))
    expect(view.querySelector('[role="tab"]')).toBeNull()
    expect(toast.error).not.toHaveBeenCalled()

    const reload = findButton(RELOAD_CONFIG_LABEL)
    expect(reload).not.toBeNull()
    await act(async () => {
      reload!.click()
    })
    await flushRender()

    expect(fetchConfig).toHaveBeenCalledTimes(2)
    expect(view.querySelector('[data-config-load-error]')).toBeNull()
    expect(tabTriggers()).toHaveLength(CONFIG_TABS.length)
    expect(currentLocation().pathname).toBe('/config/models')
  })

  it('TABS-FIVE-IN-ORDER: exactly five tabs in the order Models, Targets, Execution, Project, Advanced', async () => {
    const view = await renderAt('/config/models')

    const triggers = tabTriggers()
    expect(triggers).toHaveLength(5)
    expect(triggers.map((trigger) => trigger.textContent?.trim())).toEqual(
      CONFIG_TABS.map((tab) => CONFIG_TAB_LABELS[tab]),
    )
    expect(triggers.map((trigger) => trigger.getAttribute('data-config-tab'))).toEqual([...CONFIG_TABS])
    expect(view.querySelectorAll('[role="tablist"]')).toHaveLength(1)
    expect(view.querySelector('[role="tablist"]')?.getAttribute('aria-label')).toBe(CONFIG_TABS_ARIA_LABEL)
    expect(view.querySelector('[role="tablist"]')?.getAttribute('data-tour-id')).toBe('tour-config-nav')
    expect(view.querySelector('[data-config-tabs-scroll] [role="tablist"]')).not.toBeNull()
    expect(view.querySelector('[data-config-tabbar] > [data-config-status-slot]')).not.toBeNull()
    expect(view.querySelector('[data-config-tabs-scroll] [data-config-status-slot]')).toBeNull()
    expect(view.querySelector('h1')?.textContent).toBe(CONFIG_PAGE_TITLE)
  })

  it('BARE-CONFIG-LANDS-ON-MODELS: bare /config is replaced by /config/models with the Models panel active', async () => {
    const view = await renderAt('/config')

    expect(currentLocation()).toEqual({ pathname: '/config/models', search: '' })
    expect(tabTrigger('models')?.getAttribute('aria-selected')).toBe('true')
    expect(view.querySelector('[data-config-panel="models"]')).not.toBeNull()
    expect(view.querySelector('[data-config-panel="models"]')?.getAttribute('data-tour-id')).toBe('tour-config-section')
    expect(view.querySelector('[data-config-invalid-notice]')).toBeNull()
    expect(fetchConfig).toHaveBeenCalledTimes(1)
  })

  it.each(LEGACY_CONFIG_PAIRS)(
    'LEGACY-PAIR-LANDS-AND-FOCUSES: %s lands on its tab with its heading focused and no ?section left',
    async (pair) => {
      const [bucket, item] = pair.split(':')
      const { tab, section: sectionId } = LEGACY_CONFIG_LINKS[pair]

      const view = await renderAt(`/config?bucket=${bucket}&item=${item}`)

      expect(currentLocation()).toEqual({ pathname: `/config/${tab}`, search: '' })
      expect(tabTrigger(tab)?.getAttribute('aria-selected')).toBe('true')
      const heading = section(sectionId)?.querySelector('h2')
      expect(heading?.textContent).toBe(CONFIG_SECTION_LABELS[sectionId])
      expect(document.activeElement).toBe(heading)
      expect(scrollIntoViewSpy.mock.contexts).toContain(heading)
      expect(view.querySelector('[data-config-invalid-notice]')).toBeNull()
      expect(routes.configItem(bucket, item)).toBe(`/config/${tab}?section=${sectionId}`)
    },
  )

  it('LEGACY-PAIR-LANDS-AND-FOCUSES: the table covers every live legacy pair', () => {
    expect(LEGACY_CONFIG_PAIRS.length, 'the witness: there are legacy pairs').toBeGreaterThan(0)
    expect(Object.keys(LEGACY_CONFIG_LINKS).sort()).toEqual([...LEGACY_CONFIG_PAIRS].sort())
  })

  it('SECTION-DEEP-LINK-FOCUSES: ?section scrolls its heading into view, focuses it, then leaves the URL', async () => {
    const view = await renderAt('/config/execution?section=timeouts')

    const heading = section('timeouts')?.querySelector('h2')
    expect(heading).not.toBeNull()
    expect(heading?.getAttribute('tabindex')).toBe('-1')
    expect(section('timeouts')?.getAttribute('aria-labelledby')).toBe(heading?.id)
    expect(document.activeElement).toBe(heading)
    const call = scrollIntoViewSpy.mock.calls[scrollIntoViewSpy.mock.contexts.indexOf(heading)]
    expect(call?.[0]).toMatchObject({ block: 'start' })
    expect(currentLocation()).toEqual({ pathname: '/config/execution', search: '' })
    expect(view.querySelector('[data-config-invalid-notice]')).toBeNull()
  })

  it('UNKNOWN-LINK-NOTICE-ONCE: an unknown legacy link lands on Models with the notice until the next tab change', async () => {
    const view = await renderAt('/config?bucket=workspace&item=unknown')

    expect(currentLocation()).toEqual({ pathname: '/config/models', search: '' })
    const notice = view.querySelector('[data-config-invalid-notice]')
    expect(notice?.textContent).toBe(LEGACY_LINK_NOT_FOUND_TEXT)
    expect(notice?.hasAttribute('data-config-line-notice')).toBe(true)
    expect(notice?.textContent).not.toContain('bucket')
    expect(notice?.textContent).not.toContain('unknown')
    expect(notice?.querySelector('[data-slot="badge"]')).toBeNull()
    expect(view.querySelectorAll('[data-config-invalid-notice]')).toHaveLength(1)

    await activateTab('targets')
    expect(view.querySelector('[data-config-invalid-notice]')).toBeNull()

    await activateTab('models')
    expect(view.querySelector('[data-config-invalid-notice]')).toBeNull()
  })

  it('UNKNOWN-LINK-NOTICE-ONCE: an unknown tab or a section from another tab lands on Models with the notice', async () => {
    let view = await renderAt('/config/storage')

    expect(currentLocation()).toEqual({ pathname: '/config/models', search: '' })
    expect(view.querySelector('[data-config-invalid-notice]')?.textContent).toBe(LEGACY_LINK_NOT_FOUND_TEXT)
    expect(view.textContent).not.toContain('storage')

    cleanupAfterDialog()
    view = await renderAt('/config/models?section=browser')

    expect(currentLocation()).toEqual({ pathname: '/config/models', search: '' })
    expect(view.querySelector('[data-config-invalid-notice]')?.textContent).toBe(LEGACY_LINK_NOT_FOUND_TEXT)
  })

  it('NO-RAIL: the desktop rail and its main column never render', async () => {
    for (const tab of CONFIG_TABS) {
      const view = await renderAt(`/config/${tab}`)

      expect(view.querySelector('[data-config-rail]')).toBeNull()
      expect(view.querySelector('[data-config-main]')).toBeNull()
      expect(view.querySelector('[data-config-page-root]')).toBeNull()
      expect(view.querySelector('aside')).toBeNull()
      expect(view.querySelector('[data-config-page] > [data-slot="card"]')).toBeNull()
      expect(view.querySelector('[data-config-page]')?.className).toContain('max-w-4xl')

      cleanupAfterDialog()
    }
  })

  it('NO-NAV-SELECT: no select or combobox navigates Config, at desktop or ~400px', async () => {
    const originalWidth = window.innerWidth
    try {
      for (const width of [1280, 400]) {
        Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
        window.dispatchEvent(new Event('resize'))

        const view = await renderAt('/config/models')
        const chrome = shellChrome(view)

        expect(view.querySelector('[data-config-mobile-selector]')).toBeNull()
        expect(chrome.querySelector('select, [role="combobox"], [role="listbox"]')).toBeNull()
        expect(chrome.textContent).not.toContain('Select Setting')
        expect(view.querySelector('[aria-label="Select config setting"]')).toBeNull()
        expect(view.querySelectorAll('[role="tablist"]')).toHaveLength(1)
        expect(tabTriggers()).toHaveLength(5)

        cleanupAfterDialog()
      }
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalWidth })
    }
  })

  it('NO-PATH-BADGES: no bucket name, item id, dotted config path or badge renders in the page chrome', async () => {
    for (const tab of CONFIG_TABS) {
      const view = await renderAt(`/config/${tab}`)
      const chrome = shellChrome(view)
      const text = chrome.textContent ?? ''

      expect(chrome.querySelector('[data-slot="badge"]')).toBeNull()
      expect(text).not.toMatch(DOTTED_CONFIG_PATH)
      expect(text).not.toMatch(BUCKET_LABELS)
      for (const pair of LEGACY_CONFIG_PAIRS) {
        const [bucket, item] = pair.split(':')
        expect(text).not.toContain(pair)
        expect(text).not.toContain(`${bucket}/${item}`)
        if (item.includes('-')) expect(text).not.toContain(item)
      }
      expect(text).not.toContain('Manage workspace, services, registry, and runtime defaults.')
      expect(text).not.toContain('Missing config surface')

      const headings = Array.from(view.querySelectorAll('[data-config-section] > h2')).map((h) => h.textContent)
      const sectionIds = Array.from(view.querySelectorAll('[data-config-section]')).map((node) =>
        node.getAttribute('data-config-section') as ConfigSectionId,
      )
      expect(headings).toEqual(sectionIds.map((id) => CONFIG_SECTION_LABELS[id]))
      expect(sectionIds.every((id) => (CONFIG_SECTIONS[tab] as readonly string[]).includes(id))).toBe(true)

      cleanupAfterDialog()
    }
  })

  it('TAB-ARROW-KEYS: Right moves to and activates Targets with focus kept on its tab, End activates Advanced', async () => {
    await renderAt('/config/models')

    const models = tabTrigger('models')!
    await act(async () => {
      models.focus()
    })
    expect(document.activeElement).toBe(models)

    await pressKey(models, 'ArrowRight')

    const targets = tabTrigger('targets')!
    expect(targets.getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(targets)
    expect(currentLocation().pathname).toBe('/config/targets')
    expect(scrollIntoViewSpy.mock.contexts).toContain(targets)
    const targetsCall = scrollIntoViewSpy.mock.calls[scrollIntoViewSpy.mock.contexts.lastIndexOf(targets)]
    expect(targetsCall?.[0]).toMatchObject({ inline: 'nearest', block: 'nearest' })

    await pressKey(targets, 'End')

    const advanced = tabTrigger('advanced')!
    expect(advanced.getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(advanced)
    expect(currentLocation().pathname).toBe('/config/advanced')

    await pressKey(advanced, 'Home')

    expect(tabTrigger('models')?.getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(tabTrigger('models'))
    expect(currentLocation().pathname).toBe('/config/models')

    await pressKey(tabTrigger('models')!, 'ArrowLeft')

    expect(tabTrigger('advanced')?.getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(tabTrigger('advanced'))
  })

  it('renders the app version as subtle footer metadata below the tabs', async () => {
    const view = await renderAt('/config/project')

    const footer = view.querySelector('[data-config-app-version]')
    const page = view.querySelector('[data-config-page]')
    const tabbar = view.querySelector('[data-config-tabbar]')

    expect(fetchAppMetadata).toHaveBeenCalledTimes(1)
    expect(footer).not.toBeNull()
    expect(footer?.textContent).toBe('agent-qa v0.1.13')
    expect(page?.contains(footer)).toBe(true)
    expect(tabbar?.textContent).not.toContain('0.1.13')
    expect(footer?.className).toContain('text-[11px]')
    expect(footer?.className).toContain('font-mono')
    expect(footer?.className).toContain('text-muted-foreground/70')
    expect(footer?.className).toContain('border-t')
    expect(footer?.querySelector('a,button')).toBeNull()
  })

  it('renders version fallback when metadata returns an empty version', async () => {
    vi.mocked(fetchAppMetadata).mockResolvedValueOnce({ version: '   ' })

    const view = await renderAt('/config/project')
    const footer = view.querySelector('[data-config-app-version]')

    expect(footer?.textContent).toBe('agent-qa version unavailable')
    expect(section('test-discovery')?.querySelector('h2')?.textContent).toBe(CONFIG_SECTION_LABELS['test-discovery'])
    expect(section('test-discovery')?.contains(fieldControl(TEST_MATCH_SEGMENTS))).toBe(true)
  })

  it('keeps config content available and quiet when metadata loading fails', async () => {
    vi.mocked(fetchAppMetadata).mockRejectedValueOnce(new Error('metadata unavailable'))

    const view = await renderAt('/config/project')
    const footer = view.querySelector('[data-config-app-version]')

    expect(footer?.textContent).toBe('agent-qa version unavailable')
    expect(section('test-discovery')).not.toBeNull()
    expect(section('test-discovery')?.contains(fieldControl(TEST_MATCH_SEGMENTS))).toBe(true)
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('updates the URL and the panel when a tab is chosen', async () => {
    const view = await renderAt('/config')

    await activateTab('project')

    expect(currentLocation()).toEqual({ pathname: '/config/project', search: '' })
    expect(tabTrigger('project')?.getAttribute('aria-selected')).toBe('true')
    expect(view.querySelector('[data-config-panel="models"]')?.getAttribute('data-state')).toBe('inactive')
    expect(view.querySelector('[data-config-panel="models"] [data-config-section]')).toBeNull()
    expect(view.querySelectorAll('[data-tour-id="tour-config-section"]')).toHaveLength(1)
    expect(view.querySelector('[data-tour-id="tour-config-section"]')?.getAttribute('data-config-panel')).toBe('project')
    expect(section('files')).not.toBeNull()
    expect(section('files')?.textContent).toContain(FILES_FIELD_LABELS.secretsFile)
    expect(section('files')?.querySelector('[data-field-path="workspace.secretsFile"] code')?.textContent).toBe('.secrets.local')
    expect(view.textContent).toContain(FILES_FIELD_HELP.secretsFile)
    expect(view.textContent).toContain(FILES_FIELD_HELP.envFile)
  })

  it('NO-SAVE-BUTTON-PROJECT: the hooks and environment files autosave by leaf, with no Save button or pop-up message', async () => {
    await renderAt('/config/project?section=files')

    expect(sectionButton('files', 'Save Changes')).toBeNull()
    expect(section('files')!.querySelector('[data-config-section-shell]')).toBeNull()
    const hooksInput = fieldControl<HTMLInputElement>(HOOKS_FILE_SEGMENTS)
    const envInput = fieldControl<HTMLInputElement>(ENV_FILE_SEGMENTS)
    expect(hooksInput?.value).toBe('tests/hooks.ts')
    expect(envInput?.value).toBe('.env.local')
    expect(section('files')!.querySelector('[data-field-path="workspace.secretsFile"] input')).toBeNull()

    await typeTextAndBlur(hooksInput!, 'tests/runtime-hooks.ts')
    await typeTextAndBlur(envInput!, '.env.ci')

    expect(vi.mocked(applyConfigChanges).mock.calls.map((call) => call[0])).toEqual([
      [{ op: 'set', path: HOOKS_FILE_SEGMENTS, value: 'tests/runtime-hooks.ts' }],
      [{ op: 'set', path: ENV_FILE_SEGMENTS, value: '.env.ci' }],
    ])
    expect(API_EXPORTS).not.toContain('updateSettings')
    expect(toast.success).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('NO-SAVE-BUTTON-PROJECT: an emptied hooks or environment file stays a draft with its error and writes nothing', async () => {
    await renderAt('/config/project?section=files')

    const hooksInput = fieldControl<HTMLInputElement>(HOOKS_FILE_SEGMENTS)
    const envInput = fieldControl<HTMLInputElement>(ENV_FILE_SEGMENTS)
    await typeTextAndBlur(hooksInput!, '')
    await typeTextAndBlur(envInput!, '   ')

    expect(section('files')?.textContent).toContain(HOOKS_FILE_REQUIRED_ERROR)
    expect(section('files')?.textContent).toContain(ENV_FILE_REQUIRED_ERROR)
    expect(hooksInput?.getAttribute('aria-invalid')).toBe('true')
    expect(envInput?.getAttribute('aria-invalid')).toBe('true')
    expect(applyConfigChanges).not.toHaveBeenCalled()
    expect(API_EXPORTS).not.toContain('updateSettings')
    expect(sectionButton('files', 'Save Changes')).toBeNull()
  })

  it('NO-SAVE-BUTTON-PROJECT: an emptied test or suite pattern list stays a draft with a plain error and writes nothing', async () => {
    await renderAt('/config/project?section=test-discovery')

    expect(sectionButton('test-discovery', 'Save Changes')).toBeNull()
    const testMatch = fieldControl<HTMLTextAreaElement>(TEST_MATCH_SEGMENTS)
    const suiteMatch = fieldControl<HTMLTextAreaElement>(SUITE_MATCH_SEGMENTS)
    await typeListAndBlur(testMatch!, '')
    await typeListAndBlur(suiteMatch!, '  \n ')

    const discovery = section('test-discovery')!
    expect(discovery.textContent).toContain(TEST_MATCH_REQUIRED_ERROR)
    expect(discovery.textContent).toContain(SUITE_MATCH_REQUIRED_ERROR)
    expect(discovery.textContent).not.toMatch(DOTTED_CONFIG_PATH)
    expect(testMatch?.getAttribute('aria-invalid')).toBe('true')
    expect(applyConfigChanges).not.toHaveBeenCalled()
    expect(API_EXPORTS).not.toContain('updateSettings')
  })

  it('TEST-DISCOVERY-LIST-FIELDS: test files, suite files and paths to skip are list fields, one pattern per line, that write on settle', async () => {
    await renderAt('/config/project?section=test-discovery')

    const discovery = section('test-discovery')!
    const fields = [
      [TEST_MATCH_SEGMENTS, 'workspace.testMatch', 'tests/**/*.yaml'],
      [SUITE_MATCH_SEGMENTS, 'workspace.suiteMatch', 'tests/**/*.suite.yaml'],
      [TEST_PATH_IGNORE_SEGMENTS, 'workspace.testPathIgnore', '**/draft/**'],
    ] as const
    for (const [segments, pattern, text] of fields) {
      const control = fieldControl<HTMLTextAreaElement>(segments)
      expect(control?.tagName, pattern).toBe('TEXTAREA')
      expect(control?.value, pattern).toBe(text)
      expect(control?.closest('[data-field-path]')?.getAttribute('data-field-path'), pattern).toBe(pattern)
      expect(discovery.contains(control), pattern).toBe(true)
    }

    await typeListAndBlur(fieldControl<HTMLTextAreaElement>(TEST_PATH_IGNORE_SEGMENTS)!, '**/draft/**\n  \n**/tmp/**')
    await typeListAndBlur(fieldControl<HTMLTextAreaElement>(TEST_MATCH_SEGMENTS)!, 'e2e/**/*.yaml')

    expect(vi.mocked(applyConfigChanges).mock.calls.map((call) => call[0])).toEqual([
      [{ op: 'set', path: TEST_PATH_IGNORE_SEGMENTS, value: ['**/draft/**', '**/tmp/**'] }],
      [{ op: 'set', path: TEST_MATCH_SEGMENTS, value: ['e2e/**/*.yaml'] }],
    ])
    expect(API_EXPORTS).not.toContain('updateSettings')
  })

  it('SECRETS-FILE-SHOWN-AS-SENT: the secrets file shows the server\'s text with no reveal control, and never an editable input', async () => {
    vi.mocked(fetchConfig).mockResolvedValueOnce(readAnswer({
      config: { ...sampleConfig, workspace: { ...sampleConfig.workspace, secretsFile: '[secret:SECRETS_PATH]' } },
    }) as never)
    await renderAt('/config/project?section=files')

    const secret = section('files')!.querySelector('[data-secret-field][data-field-path="workspace.secretsFile"]') as HTMLElement | null
    expect(secret).not.toBeNull()
    expect(secret!.querySelector('code')?.textContent).toBe('[secret:SECRETS_PATH]')
    expect(secret!.querySelector('input')).toBeNull()
    expect(Array.from(secret!.querySelectorAll('button')).map((button) => button.getAttribute('aria-label'))).toEqual([
      replaceValueName(FILES_FIELD_LABELS.secretsFile),
    ])
    expect(applyConfigChanges).not.toHaveBeenCalled()
  })

  it('keeps Logging on Project and Log capture on Execution, each deep-linkable', async () => {
    await renderAt('/config/project?section=logging')

    expect(currentLocation()).toEqual({ pathname: '/config/project', search: '' })
    expect(document.activeElement).toBe(section('logging')?.querySelector('h2'))
    expect(section('log-capture')).toBeNull()

    cleanupAfterDialog()
    await renderAt('/config/execution?section=log-capture')

    expect(currentLocation()).toEqual({ pathname: '/config/execution', search: '' })
    expect(document.activeElement).toBe(section('log-capture')?.querySelector('h2'))
    expect(section('logging')).toBeNull()
  })

  it('renders the model list, the default model, screenshot size and planner limits in one place under Models', async () => {
    const view = await renderAt('/config/models')

    const panel = view.querySelector('[data-config-panel="models"]')
    expect(panel).not.toBeNull()
    expect(Array.from(panel!.querySelectorAll('[data-config-section]')).map((node) => node.getAttribute('data-config-section'))).toEqual([
      'models',
      'screenshot-size',
      'planner-limits',
    ])
    expect(section('models')?.textContent).toContain('primary')
    expect(section('models')?.querySelector('#use-parallel')).toBeNull()
    expect(section('models')?.querySelector('[data-field-path="use.parallel"]')).toBeNull()
    expect(section('models')?.textContent).not.toContain('Parallel Execution')
    expect(section('screenshot-size')?.querySelector('h2')?.textContent).toBe(CONFIG_SECTION_LABELS['screenshot-size'])
    expect(section('planner-limits')?.querySelector('h2')?.textContent).toBe(CONFIG_SECTION_LABELS['planner-limits'])
    expect(findButton('Execution Defaults')).toBeNull()
  })

  it('SHARED-MODEL-SETTINGS-UNDER-LIST: on Models the model list comes first, then Screenshot size and Planner limits, and the old default-model picker is gone', async () => {
    await renderAt('/config/models')

    const list = section('models')?.querySelector('[data-model-list]')
    const screenshotHeading = section('screenshot-size')?.querySelector('h2')
    const plannerHeading = section('planner-limits')?.querySelector('h2')
    expect(list).not.toBeNull()
    expect(screenshotHeading?.textContent).toBe(CONFIG_SECTION_LABELS['screenshot-size'])
    expect(plannerHeading?.textContent).toBe(CONFIG_SECTION_LABELS['planner-limits'])
    expect(list!.compareDocumentPosition(screenshotHeading!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screenshotHeading!.compareDocumentPosition(plannerHeading!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    // The heading row holds the Models heading and Add model; the list spans the row below.
    const addModel = sectionButton('models', ADD_MODEL_LABEL)
    expect(addModel?.parentElement).toBe(section('models'))
    expect(section('models')?.firstElementChild?.tagName).toBe('H2')

    for (const segments of [
      ['services', 'vision', 'screenshotSize'],
      ['services', 'vision', 'effectiveResolution'],
    ]) {
      expect(section('screenshot-size')!.contains(fieldControl(segments)), segments.join('.')).toBe(true)
    }
    for (const segments of [
      ['use', 'planner', 'maxActions'],
      ['use', 'planner', 'maxPlanningTurns'],
      ['use', 'planner', 'previousStepCount'],
    ]) {
      expect(section('planner-limits')!.contains(fieldControl(segments)), segments.join('.')).toBe(true)
    }
    expect(section('planner-limits')?.textContent).toContain(PLANNER_FIELD_LABELS.maxActions)
    expect(section('planner-limits')?.textContent).toContain(PLANNER_FIELD_LABELS.maxPlanningTurns)

    expect(document.body.querySelector('#use-default-llm')).toBeNull()
    expect(document.body.textContent).not.toContain('Default LLM')
    expect(findButton('Save Runtime Defaults')).toBeNull()
    expect(findButton('Save Changes')).toBeNull()
    expect(document.body.querySelector('[data-config-section-shell]')).toBeNull()
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
  })

  it('NO-SAVE-BUTTON-TARGETS: mobile app state shows its saved choice in a select, with no Save button, boxed shell or pop-up message', async () => {
    await renderAt('/config/targets?section=mobile-app-state')

    const mobile = section('mobile-app-state')!
    const field = mobile.querySelector('[data-field-path="use.mobile.appState"]')
    expect(field).not.toBeNull()
    expect(field!.textContent).toContain(MOBILE_FIELD_LABELS.appState)
    expect(field!.textContent).toContain(MOBILE_APP_STATE_LABELS.reset)
    expect(fieldControl(APP_STATE_SEGMENTS)?.getAttribute('role')).toBe('combobox')
    expect(sectionButton('mobile-app-state', 'Save Mobile Defaults')).toBeNull()
    expect(mobile.querySelector('[data-config-section-shell]')).toBeNull()
    expect(mobile.textContent).not.toContain('use.mobile.appState')
    expect(mobile.textContent).not.toContain('Mobile defaults saved')
    expect(API_EXPORTS).not.toContain('updateSettings')
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('MOBILE-APP-STATE-AUTOSAVES: choosing an app state writes that one leaf at once, with no Save button', async () => {
    await renderAt('/config/targets?section=mobile-app-state')

    await chooseOption(fieldControl(APP_STATE_SEGMENTS), MOBILE_APP_STATE_LABELS.preserve)

    expect(vi.mocked(applyConfigChanges).mock.calls).toEqual([
      [[{ op: 'set', path: APP_STATE_SEGMENTS, value: 'preserve' }]],
    ])
    expect(API_EXPORTS).not.toContain('updateSettings')
    expect(section('mobile-app-state')!.textContent).toContain(MOBILE_APP_STATE_LABELS.preserve)
  })

  it('keeps browser headless out of the Models tab defaults: the default model is a row badge, and Make default writes only the default model', async () => {
    vi.mocked(fetchConfig).mockResolvedValueOnce(readAnswer({
      config: {
        ...sampleConfig,
        registry: {
          ...sampleConfig.registry,
          llms: [...sampleConfig.registry.llms, { name: 'backup', provider: 'gemini', model: 'gemini-2.5-flash' }],
        },
      },
    }))
    await renderAt('/config/models')

    const models = section('models')!
    expect(modelRow('primary')?.querySelector('[data-model-default-badge]')).not.toBeNull()
    expect(models.textContent).not.toContain('Default LLM')
    expect(models.textContent).not.toContain('Global Headless')
    expect(document.body.querySelector('#use-global-headless')).toBeNull()
    expect(document.body.querySelector('#browser-headless')).toBeNull()
    expect(models.textContent).not.toContain('use.browser.headless')
    expect(models.textContent).not.toContain('use.headless')

    expect(models.querySelector('#use-parallel')).toBeNull()
    expect(sectionButton('models', 'Save Runtime Defaults')).toBeNull()

    const panel = await openModelRow('backup')
    await act(async () => {
      buttonIn(panel, MAKE_DEFAULT_LABEL)!.click()
    })
    await flushRender()

    expect(vi.mocked(applyConfigChanges).mock.calls).toEqual([[[{ op: 'set', path: ['use', 'llm'], value: 'backup' }]]])
    expect(API_EXPORTS).not.toContain('updateSettings')
    expect(modelRow('backup')?.querySelector('[data-model-default-badge]')).not.toBeNull()
    expect(models.textContent).not.toContain('Default Device')
    expect(models.textContent).not.toContain('use.device')
  })

  it('BROWSER-HEADLESS-ONE-WRITE: toggling headless in the Browser section writes that one leaf at once', async () => {
    await renderAt('/config/execution?section=browser')

    const browser = section('browser')!
    expect(browser.querySelector('h2')?.textContent).toBe(CONFIG_SECTION_LABELS.browser)
    expect(browser.textContent).toContain(HEADLESS_HELP)

    const headlessSwitch = browser.querySelector(`#${configFieldControlId(configFieldKeyOf(HEADLESS_SEGMENTS))}`) as HTMLButtonElement | null
    expect(headlessSwitch).not.toBeNull()
    expect(headlessSwitch!.closest('[data-field-path]')?.getAttribute('data-field-path')).toBe('use.browser.headless')

    await act(async () => {
      headlessSwitch!.click()
    })
    await flushRender()

    expect(applyConfigChanges).toHaveBeenCalledTimes(1)
    expect(vi.mocked(applyConfigChanges).mock.calls[0]![0]).toEqual([
      { op: 'set', path: HEADLESS_SEGMENTS, value: false },
    ])
    expect(API_EXPORTS).not.toContain('updateSettings')
  })

  it('TIMEOUT-ONE-LEAF-WRITE: typing into Step timeout writes that one leaf once, after the pause', async () => {
    await renderAt('/config/execution?section=timeouts')
    vi.useFakeTimers()

    await typeWithoutSettling('45s')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SETTLE_DELAY_MS - 1)
    })
    expect(applyConfigChanges).not.toHaveBeenCalled()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })

    expect(applyConfigChanges).toHaveBeenCalledTimes(1)
    expect(vi.mocked(applyConfigChanges).mock.calls[0]![0]).toEqual([{ op: 'set', path: STEP_SEGMENTS, value: '45s' }])
    expect(API_EXPORTS).not.toContain('updateSettings')
  })

  it('TIMEOUT-ONE-LEAF-WRITE: with no timeouts in the file, the same write carries the two other timeouts at their shown defaults', async () => {
    const { timeout: _timeout, ...useWithoutTimeout } = sampleConfig.use
    vi.mocked(fetchConfig).mockResolvedValueOnce(readAnswer({ config: { ...sampleConfig, use: useWithoutTimeout } }) as never)
    await renderAt('/config/execution?section=timeouts')
    expect(stepInput()?.value).toBe('')
    expect(stepInput()?.placeholder).toBe('30s')
    vi.useFakeTimers()

    await typeWithoutSettling('45s')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SETTLE_DELAY_MS)
    })

    expect(applyConfigChanges).toHaveBeenCalledTimes(1)
    expect(vi.mocked(applyConfigChanges).mock.calls[0]![0]).toEqual([
      { op: 'set', path: STEP_SEGMENTS, value: '45s' },
      { op: 'set-if-absent', path: ['use', 'timeout', 'test'], value: '10m' },
      { op: 'set-if-absent', path: ['use', 'timeout', 'navigation'], value: '10s' },
    ])
  })

  it('NO-SAVE-BUTTON-BROWSER-TIMEOUTS: Browser and Timeouts have no Save button, no boxed shell and no pop-up message', async () => {
    await renderAt('/config/execution')

    for (const id of ['browser', 'timeouts'] as const) {
      const body = section(id)!
      expect(body, id).not.toBeNull()
      expect(sectionButton(id, 'Save Changes'), id).toBeNull()
      expect(body.querySelector('[data-config-section-shell]'), id).toBeNull()
      expect(body.querySelectorAll('[data-config-field]').length, id).toBeGreaterThan(0)
    }
    expect(section('timeouts')!.querySelectorAll('[data-config-field]')).toHaveLength(3)

    await act(async () => {
      ;(section('browser')!.querySelector(`#${configFieldControlId(configFieldKeyOf(HEADLESS_SEGMENTS))}`) as HTMLButtonElement).click()
    })
    await flushRender()
    await typeAndSettle('45s')

    expect(applyConfigChanges).toHaveBeenCalledTimes(2)
    expect(toast.success).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('NO-SAVE-BUTTON-EXECUTION: the Execution panel has no Save Changes or Save Runtime Defaults button, and its switches autosave with no pop-up message', async () => {
    await renderAt('/config/execution')

    const panel = container!.querySelector('[data-config-panel="execution"]') as HTMLElement
    expect(panel).not.toBeNull()
    const buttonNames = Array.from(panel.querySelectorAll('button')).map((button) => button.textContent?.trim())
    expect(buttonNames).not.toContain('Save Changes')
    expect(buttonNames).not.toContain('Save Runtime Defaults')
    expect(panel.querySelector('[data-config-section-shell]')).toBeNull()
    for (const id of CONFIG_SECTIONS.execution) {
      expect(section(id)?.querySelectorAll('[data-config-field]').length, id).toBeGreaterThan(0)
    }

    const parallelSwitch = document.getElementById(configFieldControlId(configFieldKeyOf(PARALLEL_SEGMENTS))) as HTMLButtonElement | null
    expect(section('runs')?.contains(parallelSwitch)).toBe(true)
    expect(parallelSwitch?.getAttribute('aria-checked')).toBe('true')
    await act(async () => {
      parallelSwitch!.click()
    })
    await flushRender()
    const keepFailuresSwitch = document.getElementById(configFieldControlId(configFieldKeyOf(KEEP_FAILURES_SEGMENTS))) as HTMLButtonElement | null
    await act(async () => {
      keepFailuresSwitch!.click()
    })
    await flushRender()

    expect(vi.mocked(applyConfigChanges).mock.calls.map((call) => call[0])).toEqual([
      [{ op: 'set', path: PARALLEL_SEGMENTS, value: false }],
      [{ op: 'set', path: KEEP_FAILURES_SEGMENTS, value: true }],
    ])
    expect(API_EXPORTS).not.toContain('updateSettings')
    expect(toast.success).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('EXECUTION-LEAVES-HAVE-FIELDS: every Execution leaf that had no field at HEAD now has one on the Execution tab', async () => {
    await renderAt('/config/execution')

    const panel = container!.querySelector('[data-config-panel="execution"]') as HTMLElement
    for (const pattern of [
      'use.parallel',
      'use.workers',
      'use.buildTag',
      'use.cache',
      'services.recording.keepFailuresOnly',
      'services.accessibility.disableRules',
      'services.accessibility.exclude',
    ]) {
      expect(panel.querySelectorAll(`[data-field-path="${pattern}"]`), pattern).toHaveLength(1)
    }
    expect(section('runs')?.querySelector('[data-field-path="use.workers"] input')?.getAttribute('placeholder')).toBe('3')
    expect(section('cache')?.querySelector('[data-field-path="use.cache"] [role="switch"]')?.getAttribute('aria-checked')).toBe('true')
  })

  it('LIST-FIELD-ZERO-ONE-MANY: a list leaf reads the same at zero, one and many items', async () => {
    await renderAt('/config/execution?section=accessibility')

    const exclude = document.getElementById(configFieldControlId(configFieldKeyOf(EXCLUDE_SEGMENTS))) as HTMLTextAreaElement | null
    expect(exclude?.tagName).toBe('TEXTAREA')
    expect(exclude!.value).toBe('')
    expect(exclude!.placeholder).toBe(ACCESSIBILITY_FIELD_PLACEHOLDERS.exclude)
    expect(exclude!.closest('[data-field-path]')?.getAttribute('data-field-path')).toBe('services.accessibility.exclude')

    await act(async () => {
      exclude!.focus()
    })
    await act(async () => {
      exclude!.blur()
    })
    await flushRender()
    expect(applyConfigChanges).not.toHaveBeenCalled()

    await typeListAndBlur(exclude!, '#cookie-banner\n.chat-widget')
    expect(vi.mocked(applyConfigChanges).mock.calls.at(-1)![0]).toEqual([
      { op: 'set', path: EXCLUDE_SEGMENTS, value: ['#cookie-banner', '.chat-widget'] },
    ])
    expect(exclude!.value).toBe('#cookie-banner\n.chat-widget')

    await typeListAndBlur(exclude!, '#cookie-banner')
    expect(vi.mocked(applyConfigChanges).mock.calls.at(-1)![0]).toEqual([
      { op: 'set', path: EXCLUDE_SEGMENTS, value: ['#cookie-banner'] },
    ])
    expect(applyConfigChanges).toHaveBeenCalledTimes(2)
    expect(API_EXPORTS).not.toContain('updateSettings')
  })

  it('shows consolidated runtime path placeholders for dashboard and cache', async () => {
    const view = await renderAt('/config/project?section=dashboard')

    const dbPathInput = section('dashboard')?.querySelector(
      `#${configFieldControlId(configFieldKeyOf(['services', 'dashboard', 'dbPath']))}`,
    ) as HTMLInputElement | null
    expect(dbPathInput).not.toBeNull()
    expect(dbPathInput?.placeholder).toBe('.agent-qa/runs.db')
    expect(view.textContent).not.toContain('Tests Directory')
    expect(document.body.querySelector('#dashboard-tests-dir')).toBeNull()

    await activateTab('execution')

    expect(currentLocation()).toEqual({ pathname: '/config/execution', search: '' })
    const cacheDirInput = section('cache')?.querySelector(
      `#${configFieldControlId(configFieldKeyOf(['services', 'cache', 'dir']))}`,
    ) as HTMLInputElement | null
    expect(cacheDirInput).not.toBeNull()
    expect(cacheDirInput?.placeholder).toBe('.agent-qa/cache')
  })

  it('renders Saved login states as a list-only Targets section without secret details', async () => {
    vi.mocked(fetchAuthStates).mockResolvedValueOnce({
      authStates: [
        {
          version: 2,
          kind: 'web',
          target: 'staging-web',
          name: 'admin',
          capturedAt: '2026-05-17T10:00:00.000Z',
          storageStatePath: '.agent-qa/auth-states/staging-web/admin/storage-state.json',
          payload: { cookies: [{ name: 'sid', value: 'secret-session' }] },
          localStorage: 'unsafe-storage-value',
          indexedDB: 'unsafe-indexed-db',
          counts: { cookies: 1 },
          ttl: '7d',
          expiry: '2026-05-24T10:00:00.000Z',
          source: 'live-mode',
          createdAt: '2026-05-17T09:00:00.000Z',
          updatedAt: '2026-05-17T10:01:00.000Z',
        } as never,
      ],
    })

    await renderAt('/config/targets?section=login-states')

    const loginStates = section('login-states')!
    expect(currentLocation()).toEqual({ pathname: '/config/targets', search: '' })
    expect(loginStates.querySelector('h2')?.textContent).toBe(CONFIG_SECTION_LABELS['login-states'])
    expect(loginStates.textContent).not.toContain('services.authState')
    const headings = Array.from(loginStates.querySelectorAll('th')).map((cell) => cell.textContent)
    expect(headings).toEqual([
      LOGIN_STATE_COLUMN_LABELS.target,
      LOGIN_STATE_COLUMN_LABELS.name,
      LOGIN_STATE_COLUMN_LABELS.captured,
    ])
    expect(loginStates.textContent).not.toContain('Kind')
    expect(loginStates.textContent).toContain('staging-web')
    expect(loginStates.textContent).toContain('admin')
    expect(loginStates.querySelector('time[datetime="2026-05-17T10:00:00.000Z"]')).not.toBeNull()
    expect(fetchAuthStates).toHaveBeenCalledTimes(1)

    const forbiddenCopy = [
      'Delete',
      'Export',
      'Import',
      'Rename',
      'Reveal path',
      'View payload',
      '.agent-qa/auth-states',
      'storage-state.json',
      'secret-session',
      'unsafe-storage-value',
      'unsafe-indexed-db',
      'counts',
      '7d',
      '2026-05-24T10:00:00.000Z',
      'live-mode',
      '2026-05-17T09:00:00.000Z',
      '2026-05-17T10:01:00.000Z',
    ]
    for (const text of forbiddenCopy) {
      expect(loginStates.textContent).not.toContain(text)
    }
  })

  it('renders the Saved login states empty state copy', async () => {
    vi.mocked(fetchAuthStates).mockResolvedValueOnce({ authStates: [] })

    await renderAt('/config/targets?section=login-states')

    expect(section('login-states')?.textContent).toContain(NO_LOGIN_STATES_TEXT)
    expect(section('login-states')?.textContent).not.toContain('No auth states saved')
    expect(section('login-states')?.textContent).not.toContain('Save auth state from a connected web Live Mode session.')
    expect(section('login-states')?.querySelector('h3')).toBeNull()
  })

  it('renders a safe Saved login states load failure message', async () => {
    vi.mocked(fetchAuthStates).mockRejectedValueOnce(new Error('metadata path leaked'))

    const view = await renderAt('/config/targets?section=login-states')

    expect(section('login-states')?.textContent).toContain(LOGIN_STATES_LOAD_FAILED_TEXT)
    expect(section('login-states')?.textContent).not.toContain('Could not load saved auth states.')
    expect(view.textContent).not.toContain('metadata path leaked')
  })

  it('LOGIN-STATES-LOADING: until the saved login states read lands its section says so, while the rest of the Targets tab renders', async () => {
    const read = deferredValue<{ authStates: never[] }>()
    vi.mocked(fetchAuthStates).mockReturnValueOnce(read.promise)

    await renderAt('/config/targets')

    expect(section('login-states')?.textContent).toContain(LOGIN_STATES_LOADING_TEXT)
    expect(section('login-states')?.querySelector('table')).toBeNull()
    expect(section('targets')?.querySelector('[data-target="staging"]')).not.toBeNull()
    expect(section('devices')?.querySelector('[data-device="iosLocal"]')).not.toBeNull()
    expect(section('mobile-app-state')?.querySelector('[data-field-path="use.mobile.appState"]')).not.toBeNull()

    await act(async () => {
      read.resolve({ authStates: [] })
    })
    await flushRender()
    expect(section('login-states')?.textContent).not.toContain(LOGIN_STATES_LOADING_TEXT)
    expect(section('login-states')?.textContent).toContain(NO_LOGIN_STATES_TEXT)
  })

  it('LOGIN-STATES-RELOAD: a failed read offers Reload login states, which re-runs only that read and shows the list, while the other sections stay rendered', async () => {
    vi.mocked(fetchAuthStates)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({
        authStates: [{ version: 2, kind: 'web', target: 'staging-web', name: 'admin', capturedAt: '2026-05-17T10:00:00.000Z' }],
      })

    await renderAt('/config/targets')

    const loginStates = section('login-states')!
    expect(loginStates.textContent).toContain(LOGIN_STATES_LOAD_FAILED_TEXT)
    const reload = sectionButton('login-states', RELOAD_LOGIN_STATES_LABEL)
    expect(reload).not.toBeNull()
    expect(section('targets')?.querySelector('[data-target="staging"]')).not.toBeNull()
    expect(section('devices')?.querySelector('[data-device="iosLocal"]')).not.toBeNull()
    expect(fetchConfig).toHaveBeenCalledTimes(1)

    await act(async () => {
      reload!.click()
    })
    await flushRender()

    expect(fetchAuthStates).toHaveBeenCalledTimes(2)
    expect(fetchConfig).toHaveBeenCalledTimes(1)
    expect(section('login-states')!.textContent).not.toContain(LOGIN_STATES_LOAD_FAILED_TEXT)
    expect(section('login-states')!.querySelector('[data-login-state="staging-web:admin"]')).not.toBeNull()
    expect(section('targets')?.querySelector('[data-target="staging"]')).not.toBeNull()
    expect(section('devices')?.querySelector('[data-device="iosLocal"]')).not.toBeNull()
    expect(section('mobile-app-state')?.querySelector('[data-field-path="use.mobile.appState"]')).not.toBeNull()
  })

  it('RECORD-LIST-EMPTY-STATES: empty lists say so beside their Add buttons, the read-only saved login states name the next step, and the shipped sentences are gone', async () => {
    vi.mocked(fetchConfig).mockResolvedValueOnce(readAnswer({
      config: { ...sampleConfig, registry: { llms: sampleConfig.registry.llms } },
    }))
    vi.mocked(fetchAuthStates).mockResolvedValueOnce({ authStates: [] })

    const view = await renderAt('/config/targets')

    expect(section('targets')!.textContent).toContain(NO_TARGETS_TEXT)
    expect(sectionButton('targets', ADD_TARGET_LABEL)).not.toBeNull()
    expect(section('devices')!.textContent).toContain(NO_DEVICES_TEXT)
    expect(sectionButton('devices', ADD_DEVICE_LABEL)).not.toBeNull()
    expect(section('login-states')!.textContent).toContain(NO_LOGIN_STATES_TEXT)
    expect(section('targets')!.querySelector('[data-target]')).toBeNull()
    expect(section('devices')!.querySelector('[data-device]')).toBeNull()

    const panel = view.querySelector('[data-config-panel="targets"]')!.textContent ?? ''
    for (const removed of [
      'No targets configured',
      'No devices configured',
      'No providers configured',
      'No auth states saved',
      'Save auth state from a connected web Live Mode session.',
      'runtime defaults',
      'JSON',
    ]) {
      expect(panel, removed).not.toContain(removed)
    }
  })

  it('KNOWLEDGE-DIR-APPLY: the knowledge folder saves only through Apply, as one undoable write, with no Save button', async () => {
    vi.mocked(applyConfigChanges).mockResolvedValueOnce({ revision: 'rev-2', undo: { token: 'undo-knowledge' } } as never)
    await renderAt('/config/project?section=knowledge')
    vi.useFakeTimers()

    const knowledge = section('knowledge')!
    expect(sectionButton('knowledge', 'Save Changes')).toBeNull()
    expect(knowledge.querySelector('[data-config-section-shell]')).toBeNull()
    const knowledgeDirInput = document.getElementById(
      configFieldControlId(configFieldKeyOf(['knowledge', 'dir'])),
    ) as HTMLInputElement | null
    expect(knowledgeDirInput).not.toBeNull()
    expect(knowledgeDirInput?.placeholder).toBe('agent-qa-knowledge')
    expect(knowledgeDirInput?.value).toBe('agent-qa-knowledge')

    await act(async () => {
      knowledgeDirInput!.focus()
      setInputValue(knowledgeDirInput!, 'docs/agent-qa-knowledge')
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SETTLE_DELAY_MS * 5)
    })
    expect(applyConfigChanges).not.toHaveBeenCalled()
    expect(knowledge.querySelector('[data-field-path="knowledge.dir"]')?.getAttribute('data-apply-state')).toBe('pending')

    const apply = Array.from(knowledge.querySelectorAll('button')).find(
      (button) => button.getAttribute('aria-label') === applyActionName(KNOWLEDGE_FIELD_LABELS.dir),
    ) as HTMLButtonElement | undefined
    expect(apply).toBeDefined()
    await act(async () => {
      apply!.click()
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(applyConfigChanges).toHaveBeenCalledTimes(1)
    expect(vi.mocked(applyConfigChanges).mock.calls[0]).toEqual([
      [{ op: 'set', path: ['knowledge', 'dir'], value: 'docs/agent-qa-knowledge' }],
      { undoable: true },
    ])
    expect(statusRegion()?.textContent).toContain(undoLine('change-knowledge-dir', KNOWLEDGE_FIELD_LABELS.dir))
    expect(API_EXPORTS).not.toContain('updateSettings')
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('PORT-AUTOSAVES-WITH-RESTART-LINE: changing the dashboard port writes once after the pause, and its help line says it takes effect after a restart', async () => {
    await renderAt('/config/project?section=dashboard')
    vi.useFakeTimers()

    const dashboard = section('dashboard')!
    expect(sectionButton('dashboard', 'Save Changes')).toBeNull()
    expect(dashboard.querySelector('[data-config-section-shell]')).toBeNull()
    const portRow = dashboard.querySelector('[data-field-path="services.dashboard.port"]') as HTMLElement | null
    expect(portRow).not.toBeNull()
    expect(portRow!.querySelector('[data-field-help]')?.textContent).toBe(PORT_RESTART_HELP)
    expect(portRow!.hasAttribute('data-apply-state')).toBe(false)
    const portInput = document.getElementById(
      configFieldControlId(configFieldKeyOf(['services', 'dashboard', 'port'])),
    ) as HTMLInputElement | null
    expect(portInput?.value).toBe('4173')

    await act(async () => {
      portInput!.focus()
      setInputValue(portInput!, '4180')
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SETTLE_DELAY_MS - 1)
    })
    expect(applyConfigChanges).not.toHaveBeenCalled()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })

    expect(applyConfigChanges).toHaveBeenCalledTimes(1)
    expect(vi.mocked(applyConfigChanges).mock.calls[0]).toEqual([
      [{ op: 'set', path: ['services', 'dashboard', 'port'], value: 4180 }],
    ])
    expect(Array.from(dashboard.querySelectorAll('button')).map((button) => button.textContent?.trim())).not.toContain(
      applyActionName(DASHBOARD_FIELD_LABELS.port),
    )
    expect(API_EXPORTS).not.toContain('updateSettings')
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('PROJECT-DATA-LEAVES-HAVE-FIELDS: the Project tab has a field for every knowledge leaf and every Dashboard leaf', async () => {
    await renderAt('/config/project')

    const panel = container!.querySelector('[data-config-panel="project"]') as HTMLElement
    expect(panel).not.toBeNull()
    for (const path of [
      'knowledge.dir',
      'knowledge.commitArtifacts',
      'knowledge.contextBudgetTokens',
      'services.dashboard.dbPath',
      'services.dashboard.artifactsDir',
      'services.dashboard.port',
      'services.dashboard.host',
      'services.dashboard.baseUrl',
      'services.dashboard.workspace',
    ]) {
      expect(panel.querySelector(`[data-field-path="${path}"]`), path).not.toBeNull()
    }
    for (const path of ['knowledge.dir', 'services.dashboard.dbPath', 'services.dashboard.artifactsDir']) {
      expect(panel.querySelector(`[data-field-path="${path}"]`)?.getAttribute('data-apply-state'), path).toBe('clean')
    }
    expect(panel.querySelector('[data-field-path^="services.dashboard.runServiceTokens"]')).toBeNull()
    for (const id of ['knowledge', 'dashboard'] as const) {
      expect(section(id)?.textContent, id).not.toContain('Save Changes')
    }
  })

  it('NO-SAVE-BUTTON-PROJECT: pass-rate scope lists masked attribute rows with no Save button, and its privacy switch autosaves with no pop-up message', async () => {
    await renderAt('/config/project?section=pass-rate-scope')

    const scope = section('pass-rate-scope')!
    expect(currentLocation()).toEqual({ pathname: '/config/project', search: '' })
    expect(scope.querySelector('h2')?.textContent).toBe(CONFIG_SECTION_LABELS['pass-rate-scope'])
    expect(scope.textContent).not.toContain('analytics.passRateScope.attributes')
    expect(sectionButton('pass-rate-scope', 'Save Changes')).toBeNull()
    expect(scope.querySelector('[data-config-section-shell]')).toBeNull()
    expect(scope.querySelectorAll('input[type="text"], input[type="password"], textarea')).toHaveLength(0)
    const rows = Array.from(scope.querySelectorAll('[data-pass-rate-attribute]')).map((row) => row.getAttribute('data-pass-rate-attribute'))
    expect(rows).toEqual(['git.branch', 'user.email'])
    expect(Array.from(scope.querySelectorAll('button')).some(
      (button) => button.getAttribute('aria-label') === replaceValueName(attributeValueLabel('git.branch')),
    )).toBe(true)

    const privacy = fieldControl<HTMLButtonElement>(PRIVACY_SEGMENTS)
    expect(privacy?.getAttribute('aria-checked')).toBe('false')
    expect(scope.querySelector('[data-field-path="analytics.privacy"]')?.textContent).toContain(PRIVACY_FIELD_LABELS.privacy)
    await act(async () => {
      privacy!.click()
    })
    await flushRender()

    expect(vi.mocked(applyConfigChanges).mock.calls.map((call) => call[0])).toEqual([
      [{ op: 'set', path: PRIVACY_SEGMENTS, value: true }],
    ])
    expect(API_EXPORTS).not.toContain('updateSettings')
    expect(toast.success).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('PROJECT-LEAVES-HAVE-FIELDS: every workspace, knowledge, dashboard, logging and analytics leaf has a field on the Project tab', async () => {
    await renderAt('/config/project')

    const panel = container!.querySelector('[data-config-panel="project"]') as HTMLElement
    const projectLeaves = CONFIG_SCHEMA_LEAVES.filter(
      (pattern) =>
        pattern.startsWith('workspace.') ||
        pattern.startsWith('knowledge.') ||
        pattern.startsWith('services.dashboard.') ||
        pattern.startsWith('services.logging.') ||
        pattern.startsWith('analytics.'),
    )
    expect(projectLeaves.length, 'the witness: the filter found the Project leaves').toBeGreaterThanOrEqual(19)
    for (const pattern of projectLeaves) {
      const owner = configLeafOwner(pattern)
      expect(panel.querySelector(`[data-field-path="${owner}"], [data-field-list="${owner}"]`), pattern).not.toBeNull()
    }
    const buttonNames = Array.from(panel.querySelectorAll('button')).map((button) => button.textContent?.trim())
    expect(buttonNames).not.toContain('Save Changes')
    expect(panel.querySelector('[data-config-section-shell]')).toBeNull()
  })

  // 2026-10-01 (432-22, D-12): re-spelled from ADVANCED-TOKEN-LEAVES-HAVE-FIELDS. The MCP field claim
  // survives; the token lists and the stdio switch are deleted with their keys, so they are absent.
  it('ADVANCED-MCP-LEAVES-HAVE-FIELDS: the Advanced tab has a field for every MCP leaf', async () => {
    await renderAt('/config/advanced')

    const panel = container!.querySelector('[data-config-panel="advanced"]') as HTMLElement
    expect(panel).not.toBeNull()
    expect(section('mcp')).not.toBeNull()
    const mcpLeaves = CONFIG_SCHEMA_LEAVES.filter((pattern) => pattern.startsWith('services.mcp.'))
    expect(mcpLeaves).toEqual([
      'services.mcp.enabled',
      'services.mcp.host',
      'services.mcp.path',
      'services.mcp.port',
      'services.mcp.transport',
    ])
    for (const pattern of mcpLeaves) {
      expect(section('mcp')!.querySelector(`[data-field-path="${pattern}"]`), pattern).not.toBeNull()
    }
    const buttonNames = Array.from(panel.querySelectorAll('button')).map((button) => button.textContent?.trim())
    expect(buttonNames).not.toContain('Save Changes')
  })

  it('C432-NO-TOKEN-CONTROLS: no tab renders a token section, token list, token row or the stdio switch', async () => {
    await renderAt('/config/advanced')

    const panel = container!.querySelector('[data-config-panel="advanced"]') as HTMLElement
    expect(Array.from(panel.querySelectorAll('[data-config-section]')).map((element) => element.getAttribute('data-config-section')))
      .toEqual(['mcp', 'config-file'])
    expect(section('run-service-tokens' as never)).toBeNull()
    expect(panel.querySelector('[data-field-list]')).toBeNull()
    expect(panel.querySelector('[data-token-row], [data-token-draft]')).toBeNull()
    expect(panel.querySelector('[data-field-path*="stdio"], [data-field-path*="tokens"]')).toBeNull()
    const buttonNames = Array.from(panel.querySelectorAll('button')).map((button) => button.textContent?.trim())
    expect(buttonNames).not.toContain('Add token')
    expect(CONFIG_SCHEMA_LEAVES.filter((pattern) => /tokens|stdio|trustScope|^safety\./.test(pattern))).toEqual([])
  })

  it('exposes vision and context window per model while the shared screenshot budget stays out of the model row', async () => {
    await renderAt('/config/models')

    const panel = await openModelRow('primary')
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
    expect(modelRow('primary')!.contains(panel)).toBe(true)
    expect(panel.querySelector('[data-field-path^="services.vision"]')).toBeNull()
    expect(panel.textContent).not.toContain(VISION_FIELD_LABELS.effectiveResolution)
    expect(section('screenshot-size')?.querySelector('[data-field-path="services.vision.effectiveResolution"]')).not.toBeNull()

    const visionSwitch = panel.querySelector('[data-field-path="registry.llms[].vision"] [role="switch"]')
    const contextWindowInput = panel.querySelector('[data-field-path="registry.llms[].contextWindow"] input') as HTMLInputElement | null
    expect(visionSwitch?.getAttribute('aria-checked')).toBe('true')
    expect(contextWindowInput?.value).toBe('128k')
  })

  it('formats OpenAI-Compatible configs and keeps static provider fallback built-in only', async () => {
    vi.mocked(fetchConfig).mockResolvedValueOnce(readAnswer({
      config: configWithLlm({
        name: 'planner',
        provider: 'openai-compatible',
        model: 'openrouter/auto',
        baseURL: 'https://openrouter.ai/api/v1',
      }),
    }))

    const view = await renderAt('/config/models')

    // The built-in key providers are the add row's key choices; the sign-in ones come from the plugin.
    const keyProviders = CONNECTION_CHOICES.filter((choice) => choice.endsWith('-key')).map(
      (choice) => CONNECTION_CHOICE_PROVIDERS[choice],
    )
    expect(keyProviders).toEqual(['openai-compatible', 'anthropic-compatible', 'gemini'])
    expect(keyProviders.map((provider) => PROVIDER_FALLBACK_LABELS[provider])).toEqual([
      'OpenAI-compatible',
      'Anthropic-compatible',
      'Gemini',
    ])
    expect(view.textContent).toContain('OpenAI-compatible')
    expect(view.textContent).not.toContain('Ollama')
    expect(view.textContent).not.toContain('LM Studio')
    expect(view.textContent).not.toContain('Custom')
  })

  it('does not mark provider-mismatched same-name credentials connected', async () => {
    vi.mocked(fetchConfig).mockResolvedValueOnce(readAnswer({
      config: configWithLlm({
        name: 'planner',
        provider: 'anthropic-subscription',
        model: 'claude-sonnet-4-20250514',
      }),
    }))
    vi.mocked(fetchAuthStatus).mockResolvedValueOnce({
      credentials: [{
        configName: 'planner',
        provider: 'openai-subscription',
        type: 'oauth',
        expires: Date.now() + 3600000,
        source: 'auth',
      }],
    })

    await renderAt('/config/models')

    expect(modelRow('planner')?.getAttribute('data-model-status')).toBe('not-connected')
    expect(modelRow('planner')?.querySelector('[data-model-row-status]')?.textContent).toBe(MODEL_STATUS_WORDS['not-connected'])
    expect(section('models')?.textContent).not.toContain(MODEL_STATUS_WORDS['signed-in'])
  })

  it('renders the OpenAI-Compatible model free-form in its row, with the Base URL and its help in the open row', async () => {
    vi.mocked(fetchConfig).mockResolvedValueOnce(readAnswer({
      config: configWithLlm({
        name: 'planner',
        provider: 'openai-compatible',
        model: 'openrouter/auto',
        baseURL: 'https://openrouter.ai/api/v1',
        vision: true,
        contextWindow: '256k',
      }),
    }))

    await renderAt('/config/models')
    const line = modelRow('planner')?.querySelector('[data-model-row-model]')
    expect(line?.textContent).toBe('openrouter/auto · OpenAI-compatible')
    expect(modelRow('planner')?.textContent).not.toContain('Subscription')

    const panel = await openModelRow('planner')
    const modelInput = panel.querySelector('[data-field-path="registry.llms[].model"] input') as HTMLInputElement | null
    const baseUrlField = panel.querySelector('[data-field-path="registry.llms[].baseURL"]')
    const contextWindowInput = panel.querySelector('[data-field-path="registry.llms[].contextWindow"] input') as HTMLInputElement | null
    expect(modelInput?.type).toBe('text')
    expect(modelInput?.value).toBe('openrouter/auto')
    expect(baseUrlField?.textContent).toContain('Base URL')
    expect(baseUrlField?.textContent).toContain(BASE_URL_HELP)
    expect((baseUrlField?.querySelector('input') as HTMLInputElement | null)?.value).toBe('https://openrouter.ai/api/v1')
    expect(contextWindowInput?.value).toBe('256k')
    // The help is an inline line now; the modal's tooltip trigger is gone.
    expect(document.body.querySelector('button[aria-label="Compatible endpoint help"]')).toBeNull()
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()

    cleanupAfterDialog()
    await renderAt('/config/models?add=openai-compatible-key')
    const addBaseUrl = addField('baseURL')?.querySelector('input') as HTMLInputElement | null
    const addModel = addField('model')?.querySelector('input') as HTMLInputElement | null
    expect(addBaseUrl?.placeholder).toBe('https://openrouter.ai/api/v1')
    expect(addField('baseURL')?.textContent).toContain(BASE_URL_HELP)
    const listId = addModel?.getAttribute('list')
    expect(listId).toBeTruthy()
    expect(document.getElementById(listId!)?.querySelector('option[value="openrouter/auto"]')).not.toBeNull()
  })

  it('requires Base URL before connecting OpenAI-Compatible models in the add row', async () => {
    await renderAt('/config/models?add=openai-compatible-key')
    const modelInput = addField('model')?.querySelector('input') as HTMLInputElement
    await act(async () => {
      setInputValue(modelInput, 'openrouter/auto')
    })
    await flushRender()

    await act(async () => {
      ;(container!.querySelector('[data-model-draft] [data-add-connect]') as HTMLButtonElement).click()
    })
    await flushRender()

    const baseUrlInput = addField('baseURL')?.querySelector('input') as HTMLInputElement | null
    const error = addField('baseURL')?.querySelector('[data-field-error]')
    expect(error?.textContent).toBe(BASE_URL_REQUIRED_ERROR)
    expect(baseUrlInput?.getAttribute('aria-invalid')).toBe('true')
    expect(baseUrlInput?.getAttribute('aria-describedby')?.split(' ')).toContain(error?.id)
    expect(connectLLM).not.toHaveBeenCalled()
    expect(API_EXPORTS).not.toContain('updateSettings')
  })

  it('saves and tests OpenAI-Compatible credentials with the named config key', async () => {
    vi.mocked(fetchConfig).mockResolvedValueOnce(readAnswer({
      config: configWithLlm({
        name: 'planner',
        provider: 'openai-compatible',
        model: 'openrouter/auto',
        baseURL: 'https://openrouter.ai/api/v1',
      }),
    }))
    vi.mocked(testLLMConnection).mockResolvedValueOnce({
      success: true,
      provider: 'openai-compatible',
      model: 'openrouter/auto',
      unauthenticated: false,
    })

    await renderAt('/config/models')
    const panel = await openModelRow('planner')
    expect(panel.querySelector('input[type="password"]')).toBeNull()

    await act(async () => {
      buttonIn(panel, TEST_CONNECTION_LABEL)!.click()
    })
    await flushRender()

    expect(saveCredential).not.toHaveBeenCalled()
    expect(testLLMConnection).toHaveBeenCalledWith({
      provider: 'openai-compatible',
      model: 'openrouter/auto',
      baseURL: 'https://openrouter.ai/api/v1',
      configName: 'planner',
    })
    expect(modelRow('planner')?.querySelector('[data-test-result]')?.textContent).toBe(TEST_RESULT_TEXT.connected)
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
  })

  it('does not render blocking no-api-key copy for compatible no-key tests', async () => {
    vi.mocked(fetchConfig).mockResolvedValueOnce(readAnswer({
      config: configWithLlm({
        name: 'planner',
        provider: 'openai-compatible',
        model: 'openrouter/auto',
        baseURL: 'https://openrouter.ai/api/v1',
      }),
    }))
    vi.mocked(testLLMConnection).mockResolvedValueOnce({
      success: false,
      error: 'no_api_key',
      unauthenticated: true,
      message: 'Testing without a saved API key.',
    })

    await renderAt('/config/models')
    const panel = await openModelRow('planner')
    expect(panel.querySelector('[data-model-connection]')?.textContent).toContain(
      connectionSentence('not-connected', 'OpenAI-compatible', { signIn: false, keyOptional: true }),
    )

    await act(async () => {
      buttonIn(panel, TEST_CONNECTION_LABEL)!.click()
    })
    await flushRender()

    expect(modelRow('planner')?.querySelector('[data-test-result]')?.textContent).toBe('Testing without a saved API key.')
    expect(document.body.textContent).not.toContain('No API key or subscription configured')
  })

  it('keeps first-party subscription auth UI available', async () => {
    vi.mocked(fetchConfig).mockResolvedValueOnce(readAnswer({
      config: configWithLlm({
        name: 'planner',
        provider: 'openai-subscription',
        model: 'gpt-5.4',
      }),
    }))

    await renderAt('/config/models')
    const panel = await openModelRow('planner')
    expect(panel.querySelector('[data-model-connection]')?.textContent).toContain(
      connectionSentence('not-connected', 'ChatGPT', { signIn: true }),
    )
    expect(panel.querySelector('input[type="password"]')).toBeNull()
    expect(panel.textContent).not.toContain('Save Credential')

    // A not-connected sign-in row offers Sign in again (429-26); the modal's login button is gone.
    expect(buttonIn(panel, SIGN_IN_AGAIN_LABEL)).not.toBeNull()
    expect(document.body.textContent).not.toContain('Login with OpenAI subscription')
    expect(document.body.textContent).not.toContain('Save Credential')
  })

  it('exchanges Anthropic subscription codes with the product provider identifier (Sign in again on its row)', async () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null)
    vi.mocked(fetchConfig).mockResolvedValueOnce(readAnswer({
      config: configWithLlm({
        name: 'planner',
        provider: 'anthropic-subscription',
        model: 'claude-sonnet-4-20250514',
      }),
    }))

    try {
      await renderAt('/config/models')
      const panel = await openModelRow('planner')

      await act(async () => {
        buttonIn(panel, SIGN_IN_AGAIN_LABEL)!.click()
      })
      await flushRender()

      const codeInput = modelRow('planner')!.querySelector('[data-sign-in-code] input') as HTMLInputElement
      expect(codeInput.type).toBe('password')
      await act(async () => {
        setInputValue(codeInput, 'anthropic-code')
      })
      await flushRender()

      await act(async () => {
        ;(modelRow('planner')!.querySelector('[data-sign-in-code-connect]') as HTMLButtonElement).click()
      })
      await flushRender()

      expect(startPluginAuth).toHaveBeenCalledWith('anthropic-subscription', 'planner')
      expect(openSpy.mock.calls[0]?.slice(0, 2)).toEqual(['https://auth.example/start', '_blank'])
      expect(exchangePluginAuthCode).toHaveBeenCalledWith(
        'anthropic-subscription',
        'session-1',
        'anthropic-code',
      )
      expect(document.body.querySelector('[role="dialog"]')).toBeNull()
    } finally {
      openSpy.mockRestore()
    }
  })

  it('polls OpenAI subscription OAuth and relies on server-owned credential persistence (Sign in again on its row)', async () => {
    vi.useFakeTimers()
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null)
    vi.mocked(fetchConfig).mockResolvedValueOnce(readAnswer({
      config: configWithLlm({
        name: 'planner',
        provider: 'openai-subscription',
        model: 'gpt-5.4',
      }),
    }))
    vi.mocked(startPluginAuth).mockResolvedValueOnce({
      authorizeUrl: 'https://auth.example/openai',
      sessionId: 'session-1',
      mode: 'browser-poll',
    })
    vi.mocked(pollPluginAuthResult).mockResolvedValueOnce({ status: 'completed', saved: true })

    try {
      await renderAt('/config/models')
      const panel = await openModelRow('planner')

      await act(async () => {
        buttonIn(panel, SIGN_IN_AGAIN_LABEL)!.click()
      })
      await flushRender()

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000)
      })
      await flushRender()

      expect(startPluginAuth).toHaveBeenCalledWith('openai-subscription', 'planner')
      expect(openSpy.mock.calls[0]?.slice(0, 2)).toEqual(['https://auth.example/openai', '_blank'])
      expect(pollPluginAuthResult).toHaveBeenCalledWith('openai-subscription', 'session-1')
      expect(saveCredential).not.toHaveBeenCalled()
      expect(exchangePluginAuthCode).not.toHaveBeenCalled()
    } finally {
      openSpy.mockRestore()
      vi.useRealTimers()
    }
  })

  it('NO-DIALOG-TARGETS: targets and devices open their fields in place, with no Edit dialog, Edit button or Save button', async () => {
    await renderAt('/config/targets?section=targets')

    expect(sectionButton('targets', 'Edit')).toBeNull()
    expect(sectionButton('targets', 'Save Changes')).toBeNull()
    expect(section('targets')!.querySelector('[data-config-section-shell]')).toBeNull()
    await openRow(section('targets')!.querySelector('[data-target="staging"]'))

    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
    expect(fieldControl<HTMLInputElement>(['registry', 'targets', 'staging', 'url'])?.value).toBe('https://example.com')
    expect(section('targets')!.textContent).toContain(TARGET_FIELD_LABELS.url)
    expect(document.body.textContent).not.toContain('Apply Target Changes')

    cleanupAfterDialog()

    await renderAt('/config/targets?section=devices')

    expect(sectionButton('devices', 'Edit')).toBeNull()
    expect(sectionButton('devices', 'Save Changes')).toBeNull()
    await openRow(section('devices')!.querySelector('[data-device="iosLocal"]'))

    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
    expect(section('devices')!.querySelector('[data-field-path="registry.devices.*.platform"]')).not.toBeNull()
    expect(section('devices')!.textContent).toContain(DEVICE_FIELD_LABELS.transport)
    expect(document.body.textContent).not.toContain('Apply Device Changes')
  })

  it('uses an approved SaaS slug for the target product placeholder', async () => {
    await renderAt('/config/targets')

    await openRow(section('targets')!.querySelector('[data-target="staging"]'))

    const productInput = fieldControl<HTMLInputElement>(['registry', 'targets', 'staging', 'product'])
    expect(productInput).not.toBeNull()

    const firstPlaceholder = productInput!.placeholder
    expect([...APPROVED_SAAS_PLACEHOLDER_SLUGS]).toContain(firstPlaceholder)

    await flushRender()
    expect(fieldControl<HTMLInputElement>(['registry', 'targets', 'staging', 'product'])?.placeholder).toBe(firstPlaceholder)
  })

  it('NO-SAVE-BUTTON-TARGETS: a mobile target\'s app file and BrowserStack app autosave by leaf from its row', async () => {
    vi.mocked(fetchConfig).mockResolvedValueOnce(readAnswer({
      config: configWithTargets({
        releaseAndroid: {
          platform: 'android',
          appPackage: 'org.wikipedia.alpha',
          appActivity: 'org.wikipedia.main.MainActivity',
        },
      }),
    }))

    await renderAt('/config/targets')

    await openRow(section('targets')!.querySelector('[data-target="releaseAndroid"]'))

    const appPathInput = fieldControl<HTMLInputElement>(['registry', 'targets', 'releaseAndroid', 'app', 'path'])
    const browserstackInput = fieldControl<HTMLInputElement>(['registry', 'targets', 'releaseAndroid', 'app', 'browserstack'])
    expect(appPathInput).not.toBeNull()
    expect(browserstackInput).not.toBeNull()

    await typeTextAndBlur(appPathInput!, 'apps/wikipedia-alpha.apk')
    await typeTextAndBlur(browserstackInput!, 'bs://uploaded-app')

    expect(vi.mocked(applyConfigChanges).mock.calls).toEqual([
      [[{ op: 'set', path: ['registry', 'targets', 'releaseAndroid', 'app', 'path'], value: 'apps/wikipedia-alpha.apk' }]],
      [[{ op: 'set', path: ['registry', 'targets', 'releaseAndroid', 'app', 'browserstack'], value: 'bs://uploaded-app' }]],
    ])
    expect(section('targets')?.textContent).toContain('App: apps/wikipedia-alpha.apk / bs://uploaded-app')
    expect(API_EXPORTS).not.toContain('updateSettings')
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
  })
})

function cleanupAfterDialog() {
  if (root) {
    act(() => root!.unmount())
  }
  root = null
  if (container) {
    container.remove()
  }
  container = null
}
