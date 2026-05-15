// @vitest-environment jsdom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { toast } from 'sonner'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { APPROVED_SAAS_PLACEHOLDER_SLUGS } from '@vostride/agent-qa-ids'

import {
  exchangePluginAuthCode,
  fetchAppMetadata,
  fetchAuthStatus,
  fetchConfig,
  fetchLLMProviders,
  pollPluginAuthResult,
  saveCredential,
  startPluginAuth,
  testLLMConnection,
  updateSettings,
} from '@/lib/api'
import { LLM_PROVIDER_OPTIONS } from '@/components/config-manager/llm-section'
import ConfigPage from '@/pages/config'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { sampleConfig } = vi.hoisted(() => ({
  sampleConfig: {
  workspace: {
    testMatch: ['tests/**/*.yaml'],
    suiteMatch: ['tests/**/*.suite.yaml'],
    testPathIgnore: ['**/draft/**'],
    hooksFile: 'tests/hooks.ts',
    agentRules: 'AGENT_RULES.md',
    envFile: '.env.local',
    secretsFile: '.secrets.local',
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
    llms: [{
      name: 'primary',
      provider: 'openai-compatible',
      model: 'gpt-4.1',
      baseURL: 'https://api.openai.com/v1',
      effectiveResolution: 1568,
    }],
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

vi.mock('@/lib/api', () => ({
  fetchAppMetadata: vi.fn().mockResolvedValue({
    version: '0.1.13',
  }),
  fetchConfig: vi.fn().mockResolvedValue({
    config: sampleConfig,
  }),
  updateSettings: vi.fn().mockResolvedValue({ updated: true }),
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
  testLLMConnection: vi.fn().mockResolvedValue({ success: true }),
  saveCredential: vi.fn().mockResolvedValue({ saved: true }),
  startPluginAuth: vi.fn().mockResolvedValue({ authorizeUrl: 'https://auth.example/start', sessionId: 'session-1', mode: 'manual-code' }),
  pollPluginAuthResult: vi.fn().mockResolvedValue({ status: 'pending' }),
  exchangePluginAuthCode: vi.fn().mockResolvedValue({ status: 'completed', saved: true }),
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
          <Route
            path="/config"
            element={
              <>
                <LocationProbe />
                <ConfigPage />
              </>
            }
          />
        </Routes>
      </MemoryRouter>,
    )
  })

  await flushRender()
  return container
}

function findButton(label: string) {
  const buttons = Array.from(container?.querySelectorAll('button') ?? []) as HTMLButtonElement[]
  return buttons.find((button) => button.textContent?.trim() === label) ?? null
}

function findDocumentButton(label: string) {
  const buttons = Array.from(document.body.querySelectorAll('button')) as HTMLButtonElement[]
  return buttons.find((button) => button.textContent?.trim() === label) ?? null
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
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

async function openFirstLlmEditor() {
  await act(async () => {
    ;(document.body.querySelector('button[title="Edit configuration"]') as HTMLButtonElement).click()
  })
  await flushRender()
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
  vi.clearAllMocks()
})

describe('ConfigPage schema-driven shell', () => {
  it('uses the shared Config-shaped FormSkeleton while loading', async () => {
    vi.mocked(fetchConfig).mockReturnValueOnce(new Promise(() => {}))

    const view = await renderAt('/config?bucket=workspace&item=discovery')

    expect(view.querySelector('[data-skeleton="config"]')).not.toBeNull()
    expect(view.querySelector('[data-skeleton-part="config-layout"]')).not.toBeNull()
    expect(view.querySelector('[data-skeleton-part="config-rail"]')).not.toBeNull()
    expect(view.querySelector('[data-skeleton-part="config-main"]')).not.toBeNull()
    expect(view.querySelector('[data-config-page-root]')).toBeNull()
  })

  it('exposes the Phase 205 rail/main layout without card chrome', async () => {
    const view = await renderAt('/config?bucket=workspace&item=discovery')

    const rootElement = view.querySelector('[data-config-page-root]')
    expect(rootElement).not.toBeNull()
    expect(rootElement?.className).toContain('gap-0')

    const rail = view.querySelector('[data-config-rail]')
    expect(rail).not.toBeNull()
    expect(rail?.className).toContain('border-r')
    expect(rail?.className).toContain('border-border')

    const main = view.querySelector('[data-config-main]')
    expect(main).not.toBeNull()
    expect(main?.className).toContain('pl-6')

    const activeItem = findButton('Discovery')
    expect(activeItem?.className).not.toContain('rounded-md')
    expect(activeItem?.className).not.toContain('bg-accent')
    expect(view.querySelector('[data-config-page-root] [data-slot="card"]')).toBeNull()
  })

  it('renders the app version as subtle footer metadata in the config main column', async () => {
    const view = await renderAt('/config?bucket=workspace&item=discovery')

    const footer = view.querySelector('[data-config-app-version]')
    const main = view.querySelector('[data-config-main]')
    const rail = view.querySelector('[data-config-rail]')

    expect(fetchAppMetadata).toHaveBeenCalledTimes(1)
    expect(footer).not.toBeNull()
    expect(footer?.textContent).toBe('agent-qa v0.1.13')
    expect(main?.contains(footer)).toBe(true)
    expect(rail?.textContent).not.toContain('0.1.13')
    expect(footer?.className).toContain('text-[11px]')
    expect(footer?.className).toContain('font-mono')
    expect(footer?.className).toContain('text-muted-foreground/70')
    expect(footer?.className).toContain('border-t')
    expect(footer?.querySelector('a,button')).toBeNull()
  })

  it('renders version fallback when metadata returns an empty version', async () => {
    vi.mocked(fetchAppMetadata).mockResolvedValueOnce({ version: '   ' })

    const view = await renderAt('/config?bucket=workspace&item=discovery')
    const footer = view.querySelector('[data-config-app-version]')

    expect(footer?.textContent).toBe('agent-qa version unavailable')
    expect(view.textContent).toContain('Discovery')
    expect(view.textContent).toContain('workspace.testMatch')
  })

  it('keeps config content available and quiet when metadata loading fails', async () => {
    vi.mocked(fetchAppMetadata).mockRejectedValueOnce(new Error('metadata unavailable'))

    const view = await renderAt('/config?bucket=workspace&item=discovery')
    const footer = view.querySelector('[data-config-app-version]')

    expect(footer?.textContent).toBe('agent-qa version unavailable')
    expect(view.textContent).toContain('Discovery')
    expect(view.textContent).toContain('workspace.testMatch')
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('renders the mobile selector and invalid-selection notice as unframed line blocks', async () => {
    const view = await renderAt('/config?bucket=workspace&item=unknown')

    const mobileSelector = view.querySelector('[data-config-mobile-selector]')
    expect(mobileSelector).not.toBeNull()
    expect(mobileSelector?.className).toContain('border-b')
    expect(mobileSelector?.querySelector('[data-slot="card"]')).toBeNull()

    const invalidNotice = view.querySelector('[data-config-invalid-notice]')
    expect(invalidNotice).not.toBeNull()
    expect(invalidNotice?.className).toContain('border')
    expect(invalidNotice?.querySelector('[data-slot="card"]')).toBeNull()
  })

  it('canonicalizes bare /config and renders grouped schema buckets', async () => {
    const view = await renderAt('/config')
    const location = view.querySelector('[data-testid="location"]')

    expect(location?.getAttribute('data-pathname')).toBe('/config')
    expect(location?.getAttribute('data-search')).toBe('?bucket=workspace&item=discovery')
    expect(view.textContent).toContain('Workspace')
    expect(view.textContent).toContain('Services')
    expect(view.textContent).toContain('Registry')
    expect(view.textContent).toContain('Use')
    expect(view.textContent).toContain('Analytics')
    expect(view.textContent).toContain('Discovery')
    expect(view.textContent).not.toContain('Missing config surface')

    const buttons = Array.from(view.querySelectorAll('button')).map((button) => button.textContent?.trim())
    expect(buttons).not.toContain('LLM')
  })

  it('updates the URL and selected heading when the sidebar selection changes', async () => {
    const view = await renderAt('/config')
    const filesButton = findButton('Files')
    expect(filesButton).not.toBeNull()

    await act(async () => {
      filesButton!.click()
    })
    await flushRender()

    expect(view.querySelector('[data-testid="location"]')?.getAttribute('data-search')).toBe('?bucket=workspace&item=files')
    expect(view.textContent).toContain('Files')
    expect(view.textContent).toContain('workspace.hooksFile')
    expect(view.textContent).toContain('workspace.agentRules')
    expect(view.textContent).toContain('workspace.envFile')
    expect(view.textContent).toContain('workspace.secretsFile')
    expect(view.textContent).toContain('Agent Rules File')
    expect(view.textContent).toContain('Secrets File')
    expect((document.body.querySelector('#workspace-agent-rules') as HTMLInputElement | null)?.value).toBe('AGENT_RULES.md')
    expect((document.body.querySelector('#workspace-secrets-file') as HTMLInputElement | null)?.value).toBe('.secrets.local')
    expect(view.textContent).toContain('Required dotenv-style file for runtime-only secrets.')
    expect(view.textContent).toContain('Required dotenv file loaded before runs start.')
  })

  it('saves workspace file paths with a required secrets file', async () => {
    await renderAt('/config?bucket=workspace&item=files')

    const hooksInput = document.body.querySelector('#workspace-hooks-file') as HTMLInputElement | null
    const agentRulesInput = document.body.querySelector('#workspace-agent-rules') as HTMLInputElement | null
    const envInput = document.body.querySelector('#workspace-env-file') as HTMLInputElement | null
    const secretsInput = document.body.querySelector('#workspace-secrets-file') as HTMLInputElement | null
    expect(hooksInput).not.toBeNull()
    expect(agentRulesInput).not.toBeNull()
    expect(envInput).not.toBeNull()
    expect(secretsInput).not.toBeNull()

    await act(async () => {
      setInputValue(hooksInput!, 'tests/runtime-hooks.ts')
      setInputValue(agentRulesInput!, 'runtime/agent-rules.md')
      setInputValue(envInput!, '.env.ci')
      setInputValue(secretsInput!, '.secrets.ci')
    })

    await act(async () => {
      findDocumentButton('Save Changes')!.click()
    })
    await flushRender()

    expect(updateSettings).toHaveBeenCalledWith({
      'workspace.hooksFile': 'tests/runtime-hooks.ts',
      'workspace.agentRules': 'runtime/agent-rules.md',
      'workspace.envFile': '.env.ci',
      'workspace.secretsFile': '.secrets.ci',
    })
  })

  it('blocks saving workspace files when required file paths are empty', async () => {
    await renderAt('/config?bucket=workspace&item=files')

    const hooksInput = document.body.querySelector('#workspace-hooks-file') as HTMLInputElement | null
    const agentRulesInput = document.body.querySelector('#workspace-agent-rules') as HTMLInputElement | null
    const envInput = document.body.querySelector('#workspace-env-file') as HTMLInputElement | null
    const secretsInput = document.body.querySelector('#workspace-secrets-file') as HTMLInputElement | null
    expect(hooksInput).not.toBeNull()
    expect(agentRulesInput).not.toBeNull()
    expect(envInput).not.toBeNull()
    expect(secretsInput).not.toBeNull()

    await act(async () => {
      setInputValue(hooksInput!, '')
      setInputValue(agentRulesInput!, '')
      setInputValue(envInput!, '')
      setInputValue(secretsInput!, '')
    })

    await act(async () => {
      findDocumentButton('Save Changes')!.click()
    })
    await flushRender()

    expect(document.body.textContent).toContain('Hooks file is required.')
    expect(document.body.textContent).toContain('Agent rules file is required.')
    expect(document.body.textContent).toContain('Environment file is required.')
    expect(document.body.textContent).toContain('Secrets file is required.')
    expect(hooksInput?.getAttribute('aria-invalid')).toBe('true')
    expect(agentRulesInput?.getAttribute('aria-invalid')).toBe('true')
    expect(envInput?.getAttribute('aria-invalid')).toBe('true')
    expect(secretsInput?.getAttribute('aria-invalid')).toBe('true')
    expect(updateSettings).not.toHaveBeenCalled()
  })

  it('blocks saving empty workspace discovery match arrays', async () => {
    await renderAt('/config?bucket=workspace&item=discovery')

    const testMatchInput = document.body.querySelector('#test-match') as HTMLTextAreaElement | null
    const suiteMatchInput = document.body.querySelector('#suite-match') as HTMLTextAreaElement | null
    expect(testMatchInput).not.toBeNull()
    expect(suiteMatchInput).not.toBeNull()

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(testMatchInput!, '')
      testMatchInput!.dispatchEvent(new Event('input', { bubbles: true }))
      setter?.call(suiteMatchInput!, '')
      suiteMatchInput!.dispatchEvent(new Event('input', { bubbles: true }))
    })

    await act(async () => {
      findDocumentButton('Save Changes')!.click()
    })
    await flushRender()

    expect(document.body.textContent).toContain('workspace.testMatch must contain at least one pattern.')
    expect(document.body.textContent).toContain('workspace.suiteMatch must contain at least one pattern.')
    expect(updateSettings).not.toHaveBeenCalled()
  })

  it('keeps Logging and Log Capture as separate deep-linkable destinations', async () => {
    const view = await renderAt('/config?bucket=services&item=logging')

    expect(view.querySelector('[data-testid="location"]')?.getAttribute('data-search')).toBe('?bucket=services&item=logging')
    expect(view.textContent).toContain('Logging')
    expect(view.textContent).toContain('services.logging')
    expect(view.textContent).not.toContain('use.logCapture')

    const logCaptureButton = findButton('Log Capture')
    expect(logCaptureButton).not.toBeNull()

    await act(async () => {
      logCaptureButton!.click()
    })
    await flushRender()

    expect(view.querySelector('[data-testid="location"]')?.getAttribute('data-search')).toBe('?bucket=use&item=log-capture')
    expect(view.textContent).toContain('Log Capture')
    expect(view.textContent).toContain('use.logCapture')
  })

  it('keeps LLMs and Execution Defaults as separate destinations', async () => {
    const view = await renderAt('/config?bucket=registry&item=llms')

    expect(view.querySelector('[data-testid="location"]')?.getAttribute('data-search')).toBe('?bucket=registry&item=llms')
    expect(view.textContent).toContain('LLMs')
    expect(view.textContent).toContain('registry.llms')

    const defaultsButton = findButton('Execution Defaults')
    expect(defaultsButton).not.toBeNull()

    await act(async () => {
      defaultsButton!.click()
    })
    await flushRender()

    expect(view.querySelector('[data-testid="location"]')?.getAttribute('data-search')).toBe('?bucket=use&item=execution-defaults')
    expect(view.textContent).toContain('Execution Defaults')
    expect(view.textContent).toContain('use.parallel')
    expect(view.textContent).not.toContain('use.device')
    expect(view.textContent).not.toContain('Global Headless')
  })

  it('renders and saves mobile app-state defaults from the Mobile destination', async () => {
    const view = await renderAt('/config?bucket=use&item=mobile')

    expect(view.textContent).toContain('Mobile')
    expect(view.textContent).toContain('use.mobile.appState')
    expect(view.textContent).toContain('App state')
    expect(view.textContent).toContain('Reset app data')

    await act(async () => {
      findDocumentButton('Save Mobile Defaults')!.click()
    })
    await flushRender()

    expect(updateSettings).toHaveBeenCalledWith({
      'use.mobile.appState': 'reset',
    })
  })

  it('keeps browser headless out of execution defaults', async () => {
    await renderAt('/config?bucket=use&item=execution-defaults')

    expect(document.body.textContent).toContain('Allow eligible web runs and suite parent jobs to share available queue slots by default.')
    expect(document.body.textContent).not.toContain('Global Headless')
    expect(document.body.querySelector('#use-global-headless')).toBeNull()
    expect(document.body.textContent).not.toContain('use.browser.headless')
    expect(document.body.textContent).not.toContain('use.headless')

    const parallelSwitch = document.body.querySelector('#use-parallel') as HTMLButtonElement | null
    expect(parallelSwitch).not.toBeNull()

    await act(async () => {
      parallelSwitch!.click()
    })
    await flushRender()

    await act(async () => {
      findDocumentButton('Save Runtime Defaults')!.click()
    })
    await flushRender()

    expect(updateSettings).toHaveBeenCalledWith({
      'use.parallel': false,
      'use.llm': 'primary',
    })
    expect(document.body.textContent).not.toContain('Default Device')
    expect(document.body.textContent).not.toContain('use.device')
  })

  it('saves browser headless from the Browser section only', async () => {
    const view = await renderAt('/config?bucket=use&item=browser')

    expect(view.textContent).toContain('Browser')
    expect(view.textContent).toContain('Run web browsers without a visible window.')

    const headlessSwitch = document.body.querySelector('#browser-headless') as HTMLButtonElement | null
    expect(headlessSwitch).not.toBeNull()

    await act(async () => {
      headlessSwitch!.click()
    })
    await flushRender()

    await act(async () => {
      findDocumentButton('Save Changes')!.click()
    })
    await flushRender()

    expect(updateSettings).toHaveBeenCalledWith({
      'use.browser': {
        name: 'chromium',
        headless: false,
        viewport: { width: 1280, height: 720 },
      },
    })
  })

  it('shows consolidated runtime path placeholders for dashboard and cache', async () => {
    const view = await renderAt('/config?bucket=services&item=dashboard')

    const dbPathInput = document.body.querySelector('#dashboard-db-path') as HTMLInputElement | null
    expect(dbPathInput).not.toBeNull()
    expect(dbPathInput?.placeholder).toBe('.agent-qa/runs.db')
    expect(view.textContent).not.toContain('Tests Directory')
    expect(document.body.querySelector('#dashboard-tests-dir')).toBeNull()

    const cacheButton = findButton('Cache')
    expect(cacheButton).not.toBeNull()

    await act(async () => {
      cacheButton!.click()
    })
    await flushRender()

    expect(view.querySelector('[data-testid="location"]')?.getAttribute('data-search')).toBe('?bucket=services&item=cache')
    const cacheDirInput = document.body.querySelector('#cache-dir') as HTMLInputElement | null
    expect(cacheDirInput).not.toBeNull()
    expect(cacheDirInput?.placeholder).toBe('.agent-qa/cache')
  })

  it('exposes and saves the memory directory with the memory settings block', async () => {
    await renderAt('/config?bucket=services&item=memory')

    const memoryDirInput = document.body.querySelector('#memory-dir') as HTMLInputElement | null
    expect(memoryDirInput).not.toBeNull()
    expect(memoryDirInput?.placeholder).toBe('agent-qa-memory')
    expect(memoryDirInput?.value).toBe('agent-qa-memory')

    await act(async () => {
      setInputValue(memoryDirInput!, '.agent-qa/custom-memory')
    })
    await flushRender()

    await act(async () => {
      findDocumentButton('Save Changes')!.click()
    })
    await flushRender()

    expect(updateSettings).toHaveBeenCalledWith({
      'services.memory': {
        enabled: true,
        provider: 'local',
        dir: '.agent-qa/custom-memory',
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
    })
  })

  it('edits analytics pass rate scope attributes', async () => {
    const view = await renderAt('/config?bucket=analytics&item=pass-rate-scope')

    expect(view.querySelector('[data-testid="location"]')?.getAttribute('data-search')).toBe('?bucket=analytics&item=pass-rate-scope')
    expect(view.textContent).toContain('Pass Rate Scope')
    expect(view.textContent).toContain('analytics.passRateScope.attributes')
    expect(view.textContent).toContain('Regex')

    const branchValue = document.body.querySelector('#analytics-scope-value-existing-0') as HTMLInputElement | null
    expect(branchValue?.value).toBe('master')

    await act(async () => {
      setInputValue(branchValue!, 'main')
    })

    await act(async () => {
      findDocumentButton('Save Changes')!.click()
    })
    await flushRender()

    expect(updateSettings).toHaveBeenCalledWith({
      'analytics.passRateScope': {
        attributes: {
          'git.branch': 'main',
          'user.email': { regex: '^ci@' },
        },
      },
    })
  })

  it('exposes effective resolution in the LLM configuration modal', async () => {
    await renderAt('/config?bucket=registry&item=llms')

    await openFirstLlmEditor()

    const effectiveResolutionInput = document.body.querySelector('#config-effective-resolution') as HTMLInputElement | null
    expect(document.body.textContent).toContain('Effective Resolution')
    expect(effectiveResolutionInput?.value).toBe('1568')
  })

  it('formats OpenAI-Compatible configs and keeps static provider fallback built-in only', async () => {
    vi.mocked(fetchConfig).mockResolvedValueOnce({
      config: configWithLlm({
        name: 'planner',
        provider: 'openai-compatible',
        model: 'openrouter/auto',
        baseURL: 'https://openrouter.ai/api/v1',
      }),
    })

    const view = await renderAt('/config?bucket=registry&item=llms')

    expect(LLM_PROVIDER_OPTIONS.map((option) => option.value)).toEqual([
      'openai-compatible',
      'anthropic-compatible',
      'gemini',
    ])
    expect(view.textContent).toContain('OpenAI-compatible')
    expect(view.textContent).not.toContain('Ollama')
    expect(view.textContent).not.toContain('LM Studio')
    expect(view.textContent).not.toContain('Custom')
  })

  it('does not mark provider-mismatched same-name credentials connected', async () => {
    vi.mocked(fetchConfig).mockResolvedValueOnce({
      config: configWithLlm({
        name: 'planner',
        provider: 'anthropic-subscription',
        model: 'claude-sonnet-4-20250514',
      }),
    })
    vi.mocked(fetchAuthStatus).mockResolvedValueOnce({
      credentials: [{
        configName: 'planner',
        provider: 'openai-subscription',
        type: 'oauth',
        expires: Date.now() + 3600000,
        source: 'auth',
      }],
    })

    const view = await renderAt('/config?bucket=registry&item=llms')

    expect(view.textContent).toContain('Missing credential')
    expect(view.textContent).not.toContain('OAuth connected')
  })

  it('renders the OpenAI-Compatible modal with free-form model and Base URL tooltip', async () => {
    vi.mocked(fetchConfig).mockResolvedValueOnce({
      config: configWithLlm({
        name: 'planner',
        provider: 'openai-compatible',
        model: 'openrouter/auto',
        baseURL: 'https://openrouter.ai/api/v1',
        effectiveResolution: 1568,
      }),
    })

    await renderAt('/config?bucket=registry&item=llms')
    await openFirstLlmEditor()

    const modelInput = Array.from(document.body.querySelectorAll('input'))
      .find((input) => input.value === 'openrouter/auto') as HTMLInputElement | undefined
    const baseUrlInput = document.body.querySelector('#config-base-url') as HTMLInputElement | null
    const endpointHelp = document.body.querySelector('button[aria-label="Compatible endpoint help"]')

    expect(document.body.textContent).toContain('Base URL')
    expect(document.body.textContent).toContain('Enter the exact endpoint base URL. agent-qa will not append paths.')
    expect(endpointHelp).not.toBeNull()
    expect(baseUrlInput?.placeholder).toBe('https://openrouter.ai/api/v1')
    expect(baseUrlInput?.value).toBe('https://openrouter.ai/api/v1')
    expect(modelInput?.getAttribute('list')).toBeNull()
    expect(document.body.textContent).not.toContain('Subscription')
  })

  it('requires Base URL before saving OpenAI-Compatible configs', async () => {
    vi.mocked(fetchConfig).mockResolvedValueOnce({
      config: configWithLlm({
        name: 'planner',
        provider: 'openai-compatible',
        model: 'openrouter/auto',
      }),
    })

    await renderAt('/config?bucket=registry&item=llms')
    await openFirstLlmEditor()

    await act(async () => {
      findDocumentButton('Save Changes')!.click()
    })
    await flushRender()

    const baseUrlInput = document.body.querySelector('#config-base-url') as HTMLInputElement | null
    expect(document.body.textContent).toContain('Base URL is required for compatible providers.')
    expect(baseUrlInput?.getAttribute('aria-describedby')).toBe('base-url-error')
  })

  it('saves and tests OpenAI-Compatible credentials with the named config key', async () => {
    vi.mocked(fetchConfig).mockResolvedValueOnce({
      config: configWithLlm({
        name: 'planner',
        provider: 'openai-compatible',
        model: 'openrouter/auto',
        baseURL: 'https://openrouter.ai/api/v1',
      }),
    })
    vi.mocked(testLLMConnection).mockResolvedValueOnce({
      success: true,
      provider: 'openai-compatible',
      model: 'openrouter/auto',
      unauthenticated: false,
    })

    await renderAt('/config?bucket=registry&item=llms')
    await openFirstLlmEditor()

    const keyInput = document.body.querySelector('input[type="password"][placeholder="secret-value"]') as HTMLInputElement
    await act(async () => {
      setInputValue(keyInput, 'sk-router')
    })
    await flushRender()

    await act(async () => {
      findDocumentButton('Save Credential')!.click()
    })
    await flushRender()

    expect(saveCredential).toHaveBeenCalledWith('planner', 'openai-compatible', 'api-key', 'sk-router')

    await act(async () => {
      findDocumentButton('Test Connection')!.click()
    })
    await flushRender()

    expect(testLLMConnection).toHaveBeenCalledWith({
      provider: 'openai-compatible',
      model: 'openrouter/auto',
      baseURL: 'https://openrouter.ai/api/v1',
      configName: 'planner',
    })
    expect(document.body.textContent).toContain('Connection successful')
  })

  it('does not render blocking no-api-key copy for compatible no-key tests', async () => {
    vi.mocked(fetchConfig).mockResolvedValueOnce({
      config: configWithLlm({
        name: 'planner',
        provider: 'openai-compatible',
        model: 'openrouter/auto',
        baseURL: 'https://openrouter.ai/api/v1',
      }),
    })
    vi.mocked(testLLMConnection).mockResolvedValueOnce({
      success: false,
      error: 'no_api_key',
      unauthenticated: true,
      message: 'Testing without a saved API key.',
    })

    await renderAt('/config?bucket=registry&item=llms')
    await openFirstLlmEditor()

    await act(async () => {
      findDocumentButton('Test Connection')!.click()
    })
    await flushRender()

    expect(document.body.textContent).toContain('Testing without a saved API key.')
    expect(document.body.textContent).not.toContain('No API key or subscription configured')
  })

  it('keeps first-party subscription auth UI available', async () => {
    vi.mocked(fetchConfig).mockResolvedValueOnce({
      config: configWithLlm({
        name: 'planner',
        provider: 'openai-subscription',
        model: 'gpt-5.4',
      }),
    })

    await renderAt('/config?bucket=registry&item=llms')
    await openFirstLlmEditor()

    expect(document.body.textContent).toContain('Login with OpenAI subscription')
    expect(document.body.textContent).not.toContain('Save Credential')
  })

  it('exchanges Anthropic subscription codes with the product provider identifier', async () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null)
    vi.mocked(fetchConfig).mockResolvedValueOnce({
      config: configWithLlm({
        name: 'planner',
        provider: 'anthropic-subscription',
        model: 'claude-sonnet-4-20250514',
      }),
    })

    try {
      await renderAt('/config?bucket=registry&item=llms')
      await openFirstLlmEditor()

      await act(async () => {
        findDocumentButton('Login with Anthropic subscription')!.click()
      })
      await flushRender()

      const codeInput = document.body.querySelector('input[placeholder="authorization-code"]') as HTMLInputElement
      await act(async () => {
        setInputValue(codeInput, 'anthropic-code')
      })
      await flushRender()

      await act(async () => {
        findDocumentButton('Connect')!.click()
      })
      await flushRender()

      expect(startPluginAuth).toHaveBeenCalledWith('anthropic-subscription', 'planner')
      expect(openSpy).toHaveBeenCalledWith('https://auth.example/start', '_blank')
      expect(exchangePluginAuthCode).toHaveBeenCalledWith(
        'anthropic-subscription',
        'session-1',
        'anthropic-code',
      )
    } finally {
      openSpy.mockRestore()
    }
  })

  it('polls OpenAI subscription OAuth and relies on server-owned credential persistence', async () => {
    vi.useFakeTimers()
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null)
    vi.mocked(startPluginAuth).mockResolvedValueOnce({
      authorizeUrl: 'https://auth.example/openai',
      sessionId: 'session-1',
      mode: 'browser-poll',
    })
    vi.mocked(pollPluginAuthResult).mockResolvedValueOnce({ status: 'completed', saved: true })
    vi.mocked(fetchConfig).mockResolvedValueOnce({
      config: configWithLlm({
        name: 'planner',
        provider: 'openai-subscription',
        model: 'gpt-5.4',
      }),
    })

    try {
      await renderAt('/config?bucket=registry&item=llms')
      await openFirstLlmEditor()

      await act(async () => {
        findDocumentButton('Login with OpenAI subscription')!.click()
      })
      await flushRender()

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000)
      })
      await flushRender()

      expect(startPluginAuth).toHaveBeenCalledWith('openai-subscription', 'planner')
      expect(openSpy).toHaveBeenCalledWith('https://auth.example/openai', '_blank')
      expect(pollPluginAuthResult).toHaveBeenCalledWith('openai-subscription', 'session-1')
      expect(saveCredential).not.toHaveBeenCalled()
      expect(exchangePluginAuthCode).not.toHaveBeenCalled()
    } finally {
      openSpy.mockRestore()
      vi.useRealTimers()
    }
  })

  it('uses focused modal edit flows for Targets and Devices', async () => {
    await renderAt('/config?bucket=registry&item=targets')

    await act(async () => {
      findDocumentButton('Edit')!.click()
    })
    await flushRender()

    expect(document.body.textContent).toContain('Edit staging')
    expect(document.body.textContent).toContain('Apply Target Changes')

    cleanupAfterDialog()

    await renderAt('/config?bucket=registry&item=devices')

    await act(async () => {
      findDocumentButton('Edit')!.click()
    })
    await flushRender()

    expect(document.body.textContent).toContain('Edit iosLocal')
    expect(document.body.textContent).toContain('Apply Device Changes')
  })

  it('uses an approved SaaS slug for the target product placeholder', async () => {
    await renderAt('/config?bucket=registry&item=targets')

    await act(async () => {
      findDocumentButton('Add Target')!.click()
    })
    await flushRender()

    const productInput = document.body.querySelector('#target-product') as HTMLInputElement | null
    expect(productInput).not.toBeNull()

    const firstPlaceholder = productInput!.placeholder
    expect([...APPROVED_SAAS_PLACEHOLDER_SLUGS]).toContain(firstPlaceholder)

    await flushRender()
    expect((document.body.querySelector('#target-product') as HTMLInputElement | null)?.placeholder).toBe(firstPlaceholder)
  })

  it('saves mobile target app install fields from the target editor', async () => {
    vi.mocked(fetchConfig).mockResolvedValueOnce({
      config: configWithTargets({
        releaseAndroid: {
          platform: 'android',
          appPackage: 'org.wikipedia.alpha',
          appActivity: 'org.wikipedia.main.MainActivity',
        },
      }),
    })

    const view = await renderAt('/config?bucket=registry&item=targets')

    await act(async () => {
      findDocumentButton('Edit')!.click()
    })
    await flushRender()

    const appPathInput = document.body.querySelector('#target-app-path') as HTMLInputElement | null
    const browserstackInput = document.body.querySelector('#target-browserstack-app') as HTMLInputElement | null
    expect(appPathInput).not.toBeNull()
    expect(browserstackInput).not.toBeNull()

    await act(async () => {
      setInputValue(appPathInput!, 'apps/wikipedia-alpha.apk')
      setInputValue(browserstackInput!, 'bs://uploaded-app')
    })
    await flushRender()

    await act(async () => {
      findDocumentButton('Apply Target Changes')!.click()
    })
    await flushRender()

    expect(view.textContent).toContain('App: apps/wikipedia-alpha.apk / bs://uploaded-app')

    await act(async () => {
      findDocumentButton('Save Changes')!.click()
    })
    await flushRender()

    expect(updateSettings).toHaveBeenCalledWith({
      'registry.targets': {
        releaseAndroid: {
          platform: 'android',
          appPackage: 'org.wikipedia.alpha',
          appActivity: 'org.wikipedia.main.MainActivity',
          app: {
            path: 'apps/wikipedia-alpha.apk',
            browserstack: 'bs://uploaded-app',
          },
        },
      },
    })
  })

  it('explains Providers usage clearly and edits providers in a modal', async () => {
    const view = await renderAt('/config?bucket=registry&item=providers')

    expect(view.textContent).toContain('BrowserStack')
    expect(view.textContent).toContain('provider-specific JSON keyed by provider name')

    await act(async () => {
      findDocumentButton('Edit')!.click()
    })
    await flushRender()

    expect(document.body.textContent).toContain('Edit openai')
    expect(document.body.textContent).toContain('Apply Provider Changes')
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
