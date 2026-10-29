// @vitest-environment jsdom

// The remaining MCP and dashboard controls still save through the page's autosave transaction.

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DashboardSection } from '@/components/config-manager/dashboard-section'
import { McpSection } from '@/components/config-manager/mcp-section'
import { RunsSection } from '@/components/config-manager/runs-section'
import {
  ConfigAutosaveProvider,
  configFieldControlId,
  configFieldKeyOf,
  useConfigAutosave,
} from '@/hooks/use-config-autosave'
import { applyConfigChanges, fetchConfig, fetchConfigRevision } from '@/lib/api'
import * as copy from '@/lib/config-copy'
import { CONFIG_SECTION_IDS, EXPLICIT_ACTION_KINDS } from '@/lib/config-tabs'

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  fetchConfig: vi.fn(),
  fetchConfigRevision: vi.fn(),
  applyConfigChanges: vi.fn(),
  undoConfigAction: vi.fn(),
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const CONFIG_PATH = '/work/agent-qa.config.yaml'
const HERE = dirname(fileURLToPath(import.meta.url))

const records = {
  services: {
    mcp: { enabled: true, port: 3471 },
    dashboard: { port: 3470 },
  },
}

function answer(config: Record<string, unknown>) {
  return { config, provider: null, revision: 'rev-1', file: { path: CONFIG_PATH, lines: [] } }
}

function Harness() {
  const autosave = useConfigAutosave()
  if (autosave.load.kind !== 'ready') return null
  return (
    <ConfigAutosaveProvider value={autosave}>
      <section data-config-section="mcp">
        <McpSection />
      </section>
      <section data-config-section="dashboard">
        <DashboardSection />
      </section>
      <section data-config-section="runs">
        <RunsSection />
      </section>
    </ConfigAutosaveProvider>
  )
}

let container: HTMLDivElement | null = null
let root: Root | null = null

async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
}

async function mount() {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(<Harness />)
  })
  await flush()
}

async function unmount() {
  if (root) {
    await act(async () => root!.unmount())
  }
  root = null
  container?.remove()
  container = null
}

function section(id: 'mcp' | 'dashboard' | 'runs') {
  return container?.querySelector(`[data-config-section="${id}"]`) as HTMLElement | null
}

function fieldPaths(scope: HTMLElement | null): string[] {
  return (Array.from(scope?.querySelectorAll('[data-field-path]') ?? []) as HTMLElement[])
    .map((element) => element.getAttribute('data-field-path')!)
}

function control<T extends HTMLElement = HTMLInputElement>(segments: readonly string[]) {
  return document.getElementById(configFieldControlId(configFieldKeyOf(segments))) as T | null
}

async function typeAndBlur(input: HTMLInputElement | null, value: string) {
  expect(input).not.toBeNull()
  await act(async () => {
    input!.focus()
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    setter?.call(input!, value)
    input!.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await flush()
  await act(async () => {
    input!.blur()
  })
  await flush()
}

function writeCalls() {
  return vi.mocked(applyConfigChanges).mock.calls.map((call) => call[0])
}

beforeEach(() => {
  vi.useFakeTimers()
  localStorage.clear()
  vi.mocked(fetchConfig).mockResolvedValue(answer(records) as never)
  vi.mocked(fetchConfigRevision).mockResolvedValue({ revision: 'rev-1' })
  vi.mocked(applyConfigChanges).mockResolvedValue({ revision: 'rev-2' } as never)
})

afterEach(async () => {
  await unmount()
  vi.clearAllMocks()
  vi.useRealTimers()
  localStorage.clear()
})

describe('no token controls', () => {
  it('the MCP and dashboard sections render their fields and no token list, row, add row or stdio switch', async () => {
    await mount()

    expect(fieldPaths(section('mcp'))).toEqual(['services.mcp.enabled', 'services.mcp.port'])
    expect(fieldPaths(section('dashboard'))).toEqual([
      'services.dashboard.port',
      'services.dashboard.host',
      'services.dashboard.dbPath',
      'services.dashboard.artifactsDir',
      'services.dashboard.baseUrl',
      'services.dashboard.workspace',
    ])
    expect(fieldPaths(section('runs'))).toEqual(['use.parallel', 'use.workers', 'use.buildTag'])
    for (const id of ['mcp', 'dashboard', 'runs'] as const) {
      const scope = section(id)!
      expect(scope.querySelector('[data-token-row]'), id).toBeNull()
      expect(scope.querySelector('[data-token-draft]'), id).toBeNull()
      expect(scope.querySelector('[data-field-list]'), id).toBeNull()
      expect(scope.querySelector('[data-field-path*="tokens"]'), id).toBeNull()
      expect(scope.querySelector('[data-field-path*="stdio"]'), id).toBeNull()
      expect(scope.querySelector('[data-field-path*="trustScope"]'), id).toBeNull()
      expect(Array.from(scope.querySelectorAll('button')).map((b) => b.textContent?.trim()), id).not.toContain('Add token')
      expect(scope.textContent, id).not.toMatch(/access tokens|token scopes|trust scope/i)
    }
  })

  it('the token list module, its copy, its section and its delete actions are gone', () => {
    expect(existsSync(join(HERE, '..', 'token-list.tsx'))).toBe(false)
    const retiredCopy = [
      'ACCESS_TOKENS_HEADING', 'ADD_TOKEN_LABEL', 'NO_TOKENS_TEXT', 'tokenEnvLine', 'TOKEN_FIELD_LABELS',
      'DISCARD_TOKEN_LABEL', 'TOKEN_NAME_REQUIRED_ERROR', 'TOKEN_ENV_VAR_REQUIRED_ERROR', 'tokenNameTakenError',
      'SCOPES_LABEL', 'FUNCTION_SCOPE_LABELS', 'SCOPE_REQUIRED_ERROR', 'TRUST_SCOPE_LEGEND', 'TRUST_SCOPE_HELP',
      'TRUST_SCOPE_LABELS',
    ]
    expect(retiredCopy.filter((name) => name in copy)).toEqual([])
    expect(Object.keys(copy.MCP_FIELD_LABELS)).toEqual(['enabled', 'port'])
    expect(Object.keys(copy.MCP_FIELD_HELP)).toEqual(['enabled'])
    expect(copy.MCP_FIELD_HELP.enabled).not.toMatch(/token/i)
    expect(CONFIG_SECTION_IDS as readonly string[]).not.toContain('run-service-tokens')
    expect(EXPLICIT_ACTION_KINDS as readonly string[]).not.toContain('delete-mcp-token')
    expect(EXPLICIT_ACTION_KINDS as readonly string[]).not.toContain('delete-run-service-token')
  })

  it('a retained MCP control still saves through the autosave transaction', async () => {
    await mount()

    await typeAndBlur(control(['services', 'mcp', 'port']), '4000')
    await typeAndBlur(control(['services', 'dashboard', 'port']), '4100')

    expect(writeCalls()).toEqual([
      [{ op: 'set', path: ['services', 'mcp', 'port'], value: 4000 }],
      [{ op: 'set', path: ['services', 'dashboard', 'port'], value: 4100 }],
    ])
  })
})
