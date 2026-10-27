// @vitest-environment jsdom

// Law 7 (accessibility is correctness), PXH-CONF-05 and D-24: on every Config tab, in its open
// states, every control has an accessible name, every glyph is hidden from assistive tech, and
// nothing is a dialog.

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { applyConfigChanges } from '@/lib/api'
import { deleteActionName, undoLine } from '@/lib/config-copy'
import { CONFIG_TABS, type ConfigTab } from '@/lib/config-tabs'
import ConfigPage from '@/pages/config'

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

const { fullConfig } = vi.hoisted(() => ({
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
        dbPath: '.agent-qa/runs.db',
        artifactsDir: '.agent-qa/artifacts',
      },
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
        transport: 'http',
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
    },
    analytics: {
      privacy: true,
      passRateScope: { attributes: { 'git.branch': 'master', 'user.email': { regex: '^ci@' } } },
    },
  },
}))

vi.mock('@/lib/api', () => ({
  fetchAppMetadata: vi.fn().mockResolvedValue({ version: '0.1.13' }),
  fetchConfig: vi.fn().mockResolvedValue({
    config: fullConfig,
    provider: null,
    revision: 'rev-1',
    file: { path: '/work/agent-qa.config.yaml', lines: [] },
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
      'anthropic-compatible': [{ id: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4', vision: true }],
      gemini: [{ id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', vision: true }],
    },
  }),
  fetchLiveModelCatalog: vi.fn().mockResolvedValue({ models: [] }),
  testLLMConnection: vi.fn().mockResolvedValue({ success: true }),
  connectLLM: vi.fn(),
  moveCredential: vi.fn().mockResolvedValue({ moved: true }),
  saveCredential: vi.fn().mockResolvedValue({ saved: true }),
  startPluginAuth: vi.fn(),
  pollPluginAuthResult: vi.fn().mockResolvedValue({ status: 'pending' }),
  exchangePluginAuthCode: vi.fn(),
  deleteAuthCredential: vi.fn(),
}))

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('@/hooks/use-page-title', () => ({ usePageTitle: () => {} }))
vi.mock('@/components/ui/tooltip', () => ({
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

let container: HTMLDivElement | null = null
let root: Root | null = null

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn() as unknown as Element['scrollIntoView']
})

afterEach(() => {
  if (root) {
    act(() => root!.unmount())
  }
  root = null
  container?.remove()
  container = null
  vi.clearAllMocks()
  localStorage.clear()
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
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.click()
  })
  await flushRender()
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

function panel(tab: ConfigTab) {
  return container!.querySelector(`[data-config-panel="${tab}"]`) as HTMLElement
}

function isHidden(element: Element): boolean {
  return element.closest('[aria-hidden="true"], [hidden]') !== null
}

/** Visible text, skipping aria-hidden and hidden descendants. */
function visibleText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? ''
  if (!(node instanceof Element) || isHidden(node)) return ''
  return Array.from(node.childNodes).map(visibleText).join('')
}

/** aria-labelledby, then aria-label, then an associated label (for=id or wrapping), then visible text. */
function accessibleName(element: HTMLElement): string {
  const labelledBy = element.getAttribute('aria-labelledby')
  if (labelledBy) {
    const text = labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id))
      .filter((label): label is HTMLElement => label !== null)
      .map((label) => visibleText(label))
      .join(' ')
      .trim()
    if (text) return text
  }
  const label = element.getAttribute('aria-label')?.trim()
  if (label) return label
  if (element.id) {
    const forLabel = (Array.from(document.querySelectorAll('label')) as HTMLLabelElement[]).find(
      (item) => item.htmlFor === element.id,
    )
    const text = forLabel ? visibleText(forLabel).trim() : ''
    if (text) return text
  }
  const wrapping = element.closest('label')
  if (wrapping) {
    const text = visibleText(wrapping).trim()
    if (text) return text
  }
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(element.tagName)) return ''
  return visibleText(element).trim()
}

const CONTROLS =
  'button, input, select, textarea, [role="switch"], [role="checkbox"], [role="radio"], [role="tab"], [role="combobox"]'

function describeControl(element: HTMLElement): string {
  const data = Array.from(element.attributes)
    .filter((attribute) => attribute.name.startsWith('data-') && attribute.name !== 'data-slot')
    .map((attribute) => `${attribute.name}="${attribute.value}"`)
  const role = element.getAttribute('role')
  const field = element.closest('[data-field-path]')?.getAttribute('data-field-path')
  const section = element.closest('[data-config-section]')?.getAttribute('data-config-section')
  return [
    element.tagName.toLowerCase(),
    ...(role ? [`role="${role}"`] : []),
    ...(element.id ? [`id="${element.id}"`] : []),
    ...data,
    ...(field ? [`in ${field}`] : []),
    ...(section ? [`section ${section}`] : []),
  ].join(' ')
}

function unnamedControls(): string[] {
  return (Array.from(document.body.querySelectorAll(CONTROLS)) as HTMLElement[])
    .filter((element) => !isHidden(element) && element.getAttribute('type') !== 'hidden')
    .filter((element) => accessibleName(element) === '')
    .map(describeControl)
}

function unhiddenGlyphs(): string[] {
  return (Array.from(document.body.querySelectorAll('svg')) as SVGElement[])
    .filter((svg) => svg.closest('[aria-hidden="true"]') === null)
    .map((svg) => {
      const host = svg.parentElement ? describeControl(svg.parentElement) : '?'
      return `svg${svg.getAttribute('class') ? `.${svg.getAttribute('class')!.split(/\s+/).join('.')}` : ''} under ${host}`
    })
}

function dialogs(): string[] {
  return (Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"], [aria-modal]')) as HTMLElement[]).map(
    describeControl,
  )
}

function controlCount(tab: ConfigTab): number {
  return (Array.from(panel(tab).querySelectorAll(CONTROLS)) as HTMLElement[]).filter((element) => !isHidden(element)).length
}

/**
 * Renders one tab and opens what it holds: on Models a model row and the add row with a
 * connection chosen; on every tab each list row, the first SecretValue in Replace mode and each
 * data-path field with a pending path.
 */
async function openTab(tab: ConfigTab) {
  await renderAt(tab === 'models' ? '/config/models?add=anthropic-compatible-key' : `/config/${tab}`)
  const scope = panel(tab)
  expect(scope, tab).not.toBeNull()

  if (tab === 'models') {
    expect(scope.querySelector('[data-field-path^="registry.llms[]"]'), 'the add row is open').not.toBeNull()
    const toggle = scope.querySelector('[data-model-row-toggle]') as HTMLElement | null
    expect(toggle, 'a model row').not.toBeNull()
    await click(toggle!)
    expect(scope.querySelector('[data-model-panel]'), 'the model row is open').not.toBeNull()
  }

  for (const header of Array.from(scope.querySelectorAll('[data-row-header]')) as HTMLElement[]) {
    await click(header)
  }

  const replace = (Array.from(scope.querySelectorAll('[data-secret-field] button')) as HTMLButtonElement[]).find((button) =>
    button.getAttribute('aria-label')?.startsWith('Replace value for'),
  )
  if (replace) {
    await click(replace)
    expect(scope.querySelector('[data-secret-field] input[type="password"]'), `${tab}: a SecretValue in Replace mode`).not.toBeNull()
  }

  for (const input of Array.from(scope.querySelectorAll('[data-apply-state] input')) as HTMLInputElement[]) {
    await act(async () => {
      setInputValue(input, `${input.value}-moved`)
    })
    await flushRender()
  }
  if (tab === 'project') {
    expect(scope.querySelectorAll('[data-apply-state="pending"]').length, 'the data paths are pending').toBeGreaterThanOrEqual(1)
  }
}

async function deleteDevice() {
  vi.mocked(applyConfigChanges).mockResolvedValueOnce({
    revision: 'rev-2',
    undo: { token: 'tok-device', expiresAt: Date.now() + 30_000 },
  } as never)
  await renderAt('/config/targets')
  const remove = (Array.from(panel('targets').querySelectorAll('button')) as HTMLButtonElement[]).find(
    (button) => button.getAttribute('aria-label') === deleteActionName('delete-device', 'iosLocal'),
  )
  expect(remove, 'the device delete button').toBeDefined()
  await click(remove!)
  expect(container!.textContent).toContain(undoLine('delete-device', 'iosLocal'))
}

describe('ConfigPage accessibility', () => {
  it('EVERY-CONTROL-NAMED: on every tab, with its rows, add row, Replace and pending paths open, every control has a name and every glyph is aria-hidden', async () => {
    const roles = new Set<string>()
    for (const tab of CONFIG_TABS) {
      await openTab(tab)
      expect(controlCount(tab), `the witness: ${tab} has controls`).toBeGreaterThan(0)
      for (const element of Array.from(document.body.querySelectorAll('[role]'))) roles.add(element.getAttribute('role')!)
      const unnamed = unnamedControls()
      expect(unnamed, `${tab}: unnamed controls:\n${unnamed.join('\n')}`).toEqual([])
      const glyphs = unhiddenGlyphs()
      expect(glyphs, `${tab}: glyphs not aria-hidden:\n${glyphs.join('\n')}`).toEqual([])
      act(() => root!.unmount())
      root = null
      container!.remove()
      container = null
    }

    expect([...roles], 'the witness: the walk reached each control role').toEqual(
      expect.arrayContaining(['tab', 'switch', 'radio', 'combobox']),
    )

    await deleteDevice()
    const unnamed = unnamedControls()
    expect(unnamed, `after a delete: unnamed controls:\n${unnamed.join('\n')}`).toEqual([])
    expect(unhiddenGlyphs()).toEqual([])
  })

  it('NO-DIALOG-IN-CONFIG: no dialog, alertdialog or aria-modal element renders on any tab, in its open states or after a delete with its Undo line', async () => {
    for (const tab of CONFIG_TABS) {
      await openTab(tab)
      expect(dialogs(), tab).toEqual([])
      act(() => root!.unmount())
      root = null
      container!.remove()
      container = null
    }

    await deleteDevice()
    expect(dialogs(), 'after a delete').toEqual([])
  })
})
