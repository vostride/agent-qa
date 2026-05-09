// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useVariableSuggestions } from '../use-variable-suggestions'

const HOOK_ID = 'h_amber-birch-coral-delta-ember-falcon-garden-harbor-island-jungle'

const {
  fetchEnvVarKeysMock,
  fetchHookCatalogMock,
  fetchCapturedVarNamesMock,
} = vi.hoisted(() => ({
  fetchEnvVarKeysMock: vi.fn(),
  fetchHookCatalogMock: vi.fn(),
  fetchCapturedVarNamesMock: vi.fn(),
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    fetchEnvVarKeys: fetchEnvVarKeysMock,
    fetchHookCatalog: fetchHookCatalogMock,
    fetchCapturedVarNames: fetchCapturedVarNamesMock,
  }
})

function Harness({ testId }: { testId: string | null }) {
  const { suggestions, isLoading } = useVariableSuggestions(testId)
  return createElement(
    'div',
    null,
    createElement('div', { 'data-testid': 'loading' }, String(isLoading)),
    createElement('pre', { 'data-testid': 'suggestions' }, JSON.stringify(suggestions)),
  )
}

let container: HTMLDivElement | null = null
let root: Root | null = null

beforeEach(() => {
  fetchEnvVarKeysMock.mockReset()
  fetchHookCatalogMock.mockReset()
  fetchCapturedVarNamesMock.mockReset()

  fetchEnvVarKeysMock.mockResolvedValue({ keys: ['BASE_URL'] })
  fetchHookCatalogMock.mockResolvedValue({
    hooks: [
      { id: HOOK_ID, name: 'login', runtime: 'node', file: '/tmp/login.js', timeout: 30_000, network: true },
    ],
    filePath: 'hooks.yaml',
    errors: [],
    missing: false,
  })
  fetchCapturedVarNamesMock.mockResolvedValue({ names: ['AUTH_TOKEN'] })

  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => {
    root?.unmount()
  })
  container?.remove()
  container = null
  root = null
})

async function render(testId: string | null): Promise<HTMLElement> {
  const currentRoot = root
  const currentContainer = container
  if (!currentRoot || !currentContainer) {
    throw new Error('Test root not initialized')
  }

  await act(async () => {
    currentRoot.render(createElement(Harness, { testId }))
  })
  await act(async () => {
    await Promise.resolve()
  })
  await act(async () => {
    await Promise.resolve()
  })

  return currentContainer
}

describe('useVariableSuggestions', () => {
  it('returns runHook suggestions with readable names plus canonical hook IDs', async () => {
    const rootElement = await render('t_login')
    const suggestions = JSON.parse(
      rootElement.querySelector('[data-testid="suggestions"]')?.textContent ?? '[]',
    ) as Array<Record<string, string>>

    const runHook = suggestions.find((suggestion) => suggestion.namespace === 'runHook')

    expect(runHook).toMatchObject({
      namespace: 'runHook',
      name: 'login',
      label: 'hook',
      insertValue: HOOK_ID,
      description: HOOK_ID,
    })
    expect(suggestions.some((suggestion) => suggestion.namespace === 'env' && suggestion.name === 'BASE_URL')).toBe(true)
    expect(suggestions.some((suggestion) => suggestion.namespace === 'capture' && suggestion.name === 'AUTH_TOKEN')).toBe(true)
  })
})
