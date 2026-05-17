// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

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
import { CONFIG_NAVIGATION_ITEMS } from '@/lib/config-navigation'
import { DEVICE_TRANSPORT_OPTIONS } from '@/components/config-manager/devices-section'
import { LLM_PROVIDER_OPTIONS } from '@/components/config-manager/llm-section'
import { fetchAuthStatus, saveCredential } from '@/lib/api'
import { LLM_PROVIDER_COMPLETION_VALUES } from '@/lib/yaml-completions'

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

const { sampleConfig } = vi.hoisted(() => ({
  sampleConfig: {
  workspace: {
    testMatch: ['tests/**/*.yaml'],
    suiteMatch: ['tests/**/*.suite.yaml'],
    testPathIgnore: ['**/draft/**'],
    hooksFile: 'tests/hooks.ts',
    agentRules: 'AGENT_RULES.md',
    envFile: '.env.local',
    secretsFile: '.env.secrets.local',
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
    memory: {
      enabled: true,
      provider: 'local',
      dir: 'agent-qa-memory',
      minTrust: 0.3,
      maxInjections: 3,
      curatorEnabled: true,
      curatorLockTimeout: 120000,
      trustConfirmDelta: 0.05,
      trustContradictDelta: 0.1,
      ablationEnabled: true,
      circuitBreakerEnabled: true,
      circuitBreakerWindowSize: 20,
      circuitBreakerBaselineSize: 3,
      circuitBreakerThreshold: 0.15,
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
    devices: { iosLocal: { platform: 'ios', transport: 'local', match: { udid: 'abc' } } },
    providers: { openai: { apiBase: 'https://api.openai.com/v1' } },
  },
  use: {
    browser: { name: 'chromium', headless: true, viewport: { width: 1280, height: 720 } },
    timeout: { step: '30s', test: '10m', navigation: '10s' },
    healing: { maxAttempts: 3 },
    planner: { maxSubActions: 20, previousStepCount: 5 },
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
  fetchConfig: vi.fn().mockResolvedValue({
    config: sampleConfig,
  }),
  updateSettings: vi.fn().mockResolvedValue({ updated: true }),
  fetchAuthStates: vi.fn().mockResolvedValue({ authStates: [] }),
  fetchAuthStatus: vi.fn().mockResolvedValue({ credentials: [] }),
  fetchLLMProviders: vi.fn().mockResolvedValue({
    providers: [
      { id: 'openai-compatible', label: 'OpenAI-compatible', auth: { kind: 'api-key', credentialTypes: ['api-key'], optional: true } },
      { id: 'anthropic-compatible', label: 'Anthropic-compatible', auth: { kind: 'api-key', credentialTypes: ['api-key', 'bearer-token'], optional: true } },
      { id: 'openai-subscription', label: 'OpenAI subscription', auth: { kind: 'oauth-plugin', mode: 'browser-poll', buttonLabel: 'Login with OpenAI subscription' } },
      { id: 'anthropic-subscription', label: 'Anthropic subscription', auth: { kind: 'oauth-plugin', mode: 'manual-code', buttonLabel: 'Login with Anthropic subscription' } },
      { id: 'gemini', label: 'Gemini', auth: { kind: 'api-key', credentialTypes: ['api-key'] } },
    ],
  }),
  testLLMConnection: vi.fn(),
  saveCredential: vi.fn().mockResolvedValue({ saved: true }),
  startPluginAuth: vi.fn(),
  pollPluginAuthResult: vi.fn(),
  exchangePluginAuthCode: vi.fn(),
  deleteAuthCredential: vi.fn(),
  fetchAgentRules: vi.fn().mockResolvedValue({
    filePath: 'AGENT_RULES.md',
    content: '# Rules',
  }),
  updateAgentRules: vi.fn(),
  createAgentRulesFile: vi.fn(),
}))

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('@/hooks/use-page-title', () => ({ usePageTitle: () => {} }))

const EXPECTED_DESTINATIONS = [
  'workspace:discovery',
  'workspace:files',
  'workspace:agent-rules',
  'services:dashboard',
  'services:cache',
  'services:auth-states',
  'services:logging',
  'services:recording',
  'services:accessibility',
  'services:memory',
  'registry:llms',
  'registry:targets',
  'registry:devices',
  'registry:providers',
  'use:browser',
  'use:timeouts',
  'use:healing',
  'use:planner',
  'use:log-capture',
  'use:mobile',
  'use:execution-defaults',
  'analytics:pass-rate-scope',
]

const SURFACE_MARKERS: Record<string, { title: string; marker: string }> = {
  'workspace:discovery': { title: 'Discovery', marker: 'Test Match Patterns' },
  'workspace:files': { title: 'Files', marker: 'Hooks File' },
  'workspace:agent-rules': { title: 'Agent Rules', marker: 'Change Path' },
  'services:dashboard': { title: 'Dashboard', marker: 'Database Path' },
  'services:cache': { title: 'Cache', marker: 'Cache Directory' },
  'services:auth-states': { title: 'Auth States', marker: 'No auth states saved' },
  'services:logging': { title: 'Logging', marker: 'Log Level' },
  'services:recording': { title: 'Recording', marker: 'Record video of test execution' },
  'services:accessibility': { title: 'Accessibility', marker: 'Run After' },
  'services:memory': { title: 'Memory', marker: 'Memory Directory' },
  'registry:llms': { title: 'LLMs', marker: 'Add Configuration' },
  'registry:targets': { title: 'Targets', marker: 'Add Target' },
  'registry:devices': { title: 'Devices', marker: 'Add Device' },
  'registry:providers': { title: 'Providers', marker: 'BrowserStack' },
  'use:browser': { title: 'Browser', marker: 'Viewport Width' },
  'use:timeouts': { title: 'Timeouts', marker: 'Step Timeout' },
  'use:healing': { title: 'Healing', marker: 'Max Healing Attempts' },
  'use:planner': { title: 'Planner', marker: 'Max Sub-Actions' },
  'use:log-capture': { title: 'Log Capture', marker: 'Capture network logs' },
  'use:mobile': { title: 'Mobile', marker: 'App state' },
  'use:execution-defaults': { title: 'Execution Defaults', marker: 'Parallel Execution' },
  'analytics:pass-rate-scope': { title: 'Pass Rate Scope', marker: 'Add Attribute' },
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
        </Routes>
      </MemoryRouter>,
    )
  })

  await flushRender()
  return container
}

async function openEditModalForConfig(view: HTMLDivElement, name: string) {
  const row = Array.from(view.querySelectorAll('tr')).find((item) => item.textContent?.includes(name))
  expect(row, `row for ${name}`).toBeDefined()
  const button = row!.querySelector('button[title="Edit configuration"]') as HTMLButtonElement | null
  expect(button, `edit button for ${name}`).not.toBeNull()

  await act(async () => {
    button!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await flushRender()
}

async function renderLlmEditorForConfig(name: string) {
  const view = await renderAt('/config?bucket=registry&item=llms')
  await openEditModalForConfig(view, name)
  return view
}

async function openAddLlmModal(view: HTMLDivElement) {
  const button = Array.from(view.querySelectorAll('button')).find((item) => item.textContent?.includes('Add Configuration'))
  expect(button).toBeDefined()

  await act(async () => {
    button!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await flushRender()
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
    expect(view.querySelector('[data-config-section-shell]')).not.toBeNull()
    expect(view.querySelector('[data-config-section-shell] [data-slot="card"]')).toBeNull()

    cleanupRender()
  }
}

afterEach(() => {
  cleanupRender()
  vi.clearAllMocks()
})

describe('ConfigPage schema coverage', () => {
  it('matches the final UI-SPEC inventory exactly', () => {
    expect(CONFIG_NAVIGATION_ITEMS.map((item) => `${item.bucket}:${item.item}`)).toEqual(EXPECTED_DESTINATIONS)
  })

  it('exposes only the current LLM provider contract in UI fixtures', () => {
    expect(LLM_PROVIDER_OPTIONS.map((option) => option.value)).toEqual([
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
    expect(LLM_PROVIDER_OPTIONS.map((option) => option.label)).toEqual([
      'OpenAI-compatible',
      'Anthropic-compatible',
      'Gemini',
    ])
    expect(LLM_PROVIDER_OPTIONS.map((option) => option.value)).not.toContain('anthropic')
    expect(LLM_PROVIDER_OPTIONS.map((option) => option.value)).not.toContain('openai')
    expect(LLM_PROVIDER_OPTIONS.map((option) => option.value)).not.toContain('google')
    expect(LLM_PROVIDER_OPTIONS.map((option) => option.value)).not.toContain('authMethod')
    expect(LLM_PROVIDER_OPTIONS.map((option) => option.value)).not.toContain('ollama')
    expect(LLM_PROVIDER_OPTIONS.map((option) => option.value)).not.toContain('lmstudio')
    expect(LLM_PROVIDER_OPTIONS.map((option) => option.value)).not.toContain('custom')
  })

  it('renders provider header rows only for anthropic-compatible', async () => {
    await renderLlmEditorForConfig('anthropic-compatible')
    expect(document.body.textContent).toContain('Provider Headers')
    expect(document.body.querySelector('input[placeholder="header-name"]')).not.toBeNull()
    expect(document.body.querySelector('input[placeholder="header-value"]')).not.toBeNull()
    cleanupRender()

    for (const name of ['openai-compatible', 'gemini-fast', 'codex', 'claude-subscription']) {
      await renderLlmEditorForConfig(name)
      expect(document.body.textContent).not.toContain('Provider Headers')
      expect(document.body.querySelector('input[placeholder="header-name"]')).toBeNull()
      expect(document.body.querySelector('input[placeholder="header-value"]')).toBeNull()
      cleanupRender()
    }
  })

  it('allows bearer-token credential selection for anthropic-compatible', async () => {
    await renderLlmEditorForConfig('anthropic-compatible')

    expect(document.body.textContent).toContain('API key')
    expect(document.body.textContent).toContain('Bearer token')
    expect(document.body.textContent).toContain('Save Credential')
  })

  it('saves anthropic-compatible bearer tokens through the typed credential API', async () => {
    await renderLlmEditorForConfig('anthropic-compatible')

    const secretInput = document.body.querySelector('input[type="password"][placeholder="secret-value"]') as HTMLInputElement | null
    expect(secretInput).not.toBeNull()
    await act(async () => {
      setInputValue(secretInput!, 'bearer-secret')
    })

    const saveButton = Array.from(document.body.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Save Credential'),
    ) as HTMLButtonElement | undefined
    expect(saveButton).toBeDefined()
    await act(async () => {
      saveButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flushRender()

    expect(mockSaveCredential).toHaveBeenCalledWith(
      'anthropic-compatible',
      'anthropic-compatible',
      'bearer-token',
      'bearer-secret',
    )
  })

  it('confirms credential deletion before deleting', async () => {
    mockFetchAuthStatus.mockResolvedValueOnce({
      credentials: [{
        configName: 'anthropic-compatible',
        provider: 'anthropic-compatible',
        type: 'bearer',
        expires: null,
        source: 'auth-store',
      }],
    })
    await renderLlmEditorForConfig('anthropic-compatible')

    const deleteButton = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent === 'Delete' || button.getAttribute('aria-label') === 'Delete credential',
    ) as HTMLButtonElement | undefined
    expect(deleteButton).toBeDefined()

    await act(async () => {
      deleteButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flushRender()

    expect(document.body.textContent).toContain(
      'Delete saved credential for anthropic-compatible? Tests using this config may fail until a new credential is saved.',
    )
    expect(document.body.textContent).toContain('Keep Credential')
    expect(document.body.textContent).toContain('Delete Credential')
  })

  it('uses a free text model input without datalist', async () => {
    await renderLlmEditorForConfig('openai-compatible')

    const input = document.body.querySelector('input[placeholder="model-name"]')
    expect(input).not.toBeNull()
    expect(input?.getAttribute('list')).toBeNull()
  })

  it('does not render maintained model suggestions', async () => {
    const view = await renderAt('/config?bucket=registry&item=llms')
    await openAddLlmModal(view)

    expect(document.body.innerHTML).not.toContain('<datalist')
    expect(document.body.textContent).not.toContain('PROVIDER_MODELS')
    expect(document.body.textContent).not.toContain('SUBSCRIPTION_MODELS')
    expect(document.body.textContent).not.toContain('Gemini 2.0 Flash')
    expect(document.body.textContent).not.toContain('GPT-4o')
    expect(document.body.textContent).not.toContain('Claude Sonnet 4')
  })

  it('exposes only supported device transports in UI fixtures', () => {
    expect(DEVICE_TRANSPORT_OPTIONS.map((option) => option.value)).toEqual(['local', 'browserstack'])
    expect(DEVICE_TRANSPORT_OPTIONS.map((option) => option.label)).toEqual(['Local', 'BrowserStack'])
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

  it('Config section shells: all 21 destinations', async () => {
    const destinations = CONFIG_NAVIGATION_ITEMS.map((item) => `${item.bucket}:${item.item}`)

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
      'use:healing',
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

  it('Config section shells: Agent Rules and Memory sections', async () => {
    await assertConfigSectionShells([
      'workspace:agent-rules',
      'services:memory',
    ])
  })

  it('Config section shells: Targets Devices Providers sections', async () => {
    await assertConfigSectionShells([
      'registry:targets',
      'registry:devices',
      'registry:providers',
    ])
  })

  it('Config section shells: LLM section', async () => {
    await assertConfigSectionShells([
      'registry:llms',
    ])
  })
})
