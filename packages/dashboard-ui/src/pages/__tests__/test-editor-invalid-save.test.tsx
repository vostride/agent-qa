// @vitest-environment jsdom

import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '@/lib/api'
import { routes } from '@/lib/routes'
import TestEditorPage from '@/pages/test-editor'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// G-433-2 / F-433-06 (433 D-03): the walk's YAML, a repeated `name` key on line 3.
const WALK_INVALID_CONTENT = [
  'name: Invalid 433 probe',
  'target: example-web',
  'name: Duplicate name',
  'steps: [Open the page]',
  '',
].join('\n')

const VALID_TEST_ID = 't_amber-birch-coral-delta-ember-falcon-garden-harbor-island-jungle'
const VALID_CONTENT = [`test-id: ${VALID_TEST_ID}`, 'name: Login', 'target: web', 'steps:', '  - Open the page', ''].join('\n')

const LINE_3_ERROR = { message: 'not readable as YAML at line 3, column 1', line: 3, column: 1 }
const INVALID_VERDICT = { valid: false, errors: [LINE_3_ERROR] }

const {
  createTestFileMock,
  updateTestFileMock,
  validateTestContentMock,
  fetchTestFileMock,
  triggerRunMock,
  navigateMock,
  params,
} = vi.hoisted(() => ({
  createTestFileMock: vi.fn(),
  updateTestFileMock: vi.fn(),
  validateTestContentMock: vi.fn(),
  fetchTestFileMock: vi.fn(),
  triggerRunMock: vi.fn(),
  navigateMock: vi.fn(),
  params: { value: {} as { t_id?: string } },
}))

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}))

vi.mock('react-router', () => ({
  useParams: () => params.value,
  useNavigate: () => navigateMock,
  useSearchParams: () => [new URLSearchParams(''), vi.fn()],
}))

vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }))
vi.mock('@/hooks/use-page-title', () => ({ usePageTitle: () => {} }))
vi.mock('@/hooks/use-keyboard-shortcuts', () => ({ useKeyboardShortcuts: () => {} }))
vi.mock('@/hooks/use-variable-suggestions', () => ({
  useVariableSuggestions: () => ({ suggestions: [], isLoading: false }),
}))
vi.mock('@/hooks/use-target-details', () => ({
  useTargetDetails: () => ({
    targets: {},
    globalUse: [],
    isLoading: false,
  }),
}))
vi.mock('@/hooks/use-live-editor', () => ({
  useLiveEditor: () => ({
    connectionState: 'idle',
    steps: [],
    setupHooks: [],
    teardownHooks: [],
    currentUrl: null,
    pendingNavigation: null,
    error: null,
    executeStepByIndex: vi.fn(),
    executeHookById: vi.fn(),
    cancelStep: vi.fn(),
    refreshPage: vi.fn(),
    goBack: vi.fn(),
    goForward: vi.fn(),
    navigate: vi.fn(),
    runAll: vi.fn(),
    cancelRunAll: vi.fn(),
    terminateSession: vi.fn(),
    runningStepIndex: null,
    runningStepId: null,
    sessionId: null,
    isTerminated: false,
    sessionGone: false,
    deviceLogs: [],
    platform: 'web',
    ariaTree: null,
    requestAriaTree: vi.fn(),
    isRunningAll: false,
    isStoppingRunAll: false,
  }),
}))

vi.mock('@/components/test-navbar', () => ({
  TestNavbar: ({ onSave, onValidate, onRun }: { onSave: () => void; onValidate: () => void; onRun: () => void }) => (
    <div>
      <button type="button" data-action="validate" onClick={onValidate}>Validate</button>
      <button type="button" data-action="save" onClick={onSave}>Save</button>
      <button type="button" data-action="run" onClick={() => onRun()}>Run</button>
    </div>
  ),
}))
vi.mock('@/components/visual-builder', () => ({ VisualBuilder: () => <div data-testid="visual-builder" /> }))
vi.mock('@/components/monaco-editor', () => ({
  MonacoEditor: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => (
    <textarea data-testid="yaml" value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}))
vi.mock('@/components/test-settings-panel', () => ({ TestSettingsPanel: () => <div /> }))
vi.mock('@/components/run-results-panel', () => ({ RunResultsPanel: () => <div /> }))
vi.mock('@/components/live-session-pane', () => ({ LiveSessionPane: () => <div /> }))
vi.mock('@/components/page-skeleton', () => ({ EditorSkeleton: () => <div /> }))
vi.mock('@/components/empty-state', () => ({ EmptyState: () => <div /> }))
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactElement }) => children,
  TooltipTrigger: ({ children }: { children: ReactElement }) => children,
  TooltipContent: ({ children }: { children: ReactElement }) => children,
}))
vi.mock('@/components/ui/resizable', () => ({
  ResizablePanelGroup: ({ children }: { children: ReactElement | ReactElement[] }) => <div>{children}</div>,
  ResizablePanel: ({ children }: { children: ReactElement | ReactElement[] }) => <div>{children}</div>,
  ResizableHandle: () => <div />,
}))
vi.mock('@/components/ui/tabs', () => ({
  Tabs: ({ children }: { children: ReactElement | ReactElement[] }) => <div>{children}</div>,
  TabsList: ({ children }: { children: ReactElement | ReactElement[] }) => <div>{children}</div>,
  TabsTrigger: ({ children }: { children: ReactElement | ReactElement[] }) => <button type="button">{children}</button>,
  TabsContent: ({ children }: { children: ReactElement | ReactElement[] }) => <div>{children}</div>,
}))
vi.mock('@/components/ui/sheet', () => ({
  Sheet: ({ children }: { children: ReactElement | ReactElement[] }) => <div>{children}</div>,
  SheetContent: ({ children }: { children: ReactElement | ReactElement[] }) => <div>{children}</div>,
  SheetHeader: ({ children }: { children: ReactElement | ReactElement[] }) => <div>{children}</div>,
  SheetTitle: ({ children }: { children: ReactElement | ReactElement[] }) => <div>{children}</div>,
  SheetDescription: ({ children }: { children: ReactElement | ReactElement[] }) => <div>{children}</div>,
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    fetchConfig: vi.fn().mockResolvedValue({
      config: { workspace: { testMatch: ['**/*.yaml'] } },
    }),
    fetchTestFile: fetchTestFileMock,
    createTestFile: createTestFileMock,
    createLiveEditorSession: vi.fn(),
    fetchAuthStates: vi.fn().mockResolvedValue({ authStates: [] }),
    updateTestFile: updateTestFileMock,
    validateTestContent: validateTestContentMock,
    triggerRun: triggerRunMock,
  }
})

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  params.value = {}
  createTestFileMock.mockReset().mockResolvedValue({ path: 'tests/invalid-433.yaml', created: true })
  updateTestFileMock.mockReset().mockResolvedValue({ path: 'tests/login.yaml', updated: true })
  validateTestContentMock.mockReset().mockResolvedValue(INVALID_VERDICT)
  fetchTestFileMock.mockReset().mockResolvedValue({ path: 'tests/login.yaml', content: VALID_CONTENT })
  triggerRunMock.mockReset().mockResolvedValue({ runId: 'r_run' })
  navigateMock.mockReset()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
  document.body.innerHTML = ''
  vi.clearAllMocks()
})

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve()
  })
}

async function renderPage(): Promise<void> {
  await act(async () => {
    root.render(<TestEditorPage />)
  })
  await flush()
}

function setValue(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = element instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(element, value)
  element.dispatchEvent(new Event('input', { bubbles: true }))
}

async function typeYaml(content: string): Promise<void> {
  const textarea = container.querySelector('textarea[data-testid="yaml"]') as HTMLTextAreaElement | null
  expect(textarea).not.toBeNull()
  await act(async () => { setValue(textarea!, content) })
}

async function typeFilename(filename: string): Promise<void> {
  const input = container.querySelector('input[placeholder="my-test.yaml"]') as HTMLInputElement | null
  expect(input).not.toBeNull()
  await act(async () => { setValue(input!, filename) })
}

async function press(action: 'validate' | 'save' | 'run'): Promise<void> {
  await act(async () => {
    ;(container.querySelector(`button[data-action="${action}"]`) as HTMLButtonElement).click()
  })
  await flush()
}

async function validateShows(): Promise<string> {
  const { toast } = await import('sonner')
  vi.mocked(toast.error).mockClear()
  await press('validate')
  const shown = vi.mocked(toast.error).mock.calls.map(([message]) => String(message))
  expect(shown).toHaveLength(1)
  expect(shown[0]).toContain('Line 3')
  vi.mocked(toast.error).mockClear()
  return shown[0]
}

async function successMessages(): Promise<string[]> {
  const { toast } = await import('sonner')
  return vi.mocked(toast.success).mock.calls.map(([message]) => String(message))
}

async function errorMessages(): Promise<string[]> {
  const { toast } = await import('sonner')
  return vi.mocked(toast.error).mock.calls.map(([message]) => String(message))
}

describe('the test editor refuses to save an invalid test', () => {
  it('create mode does not write, celebrate or navigate', async () => {
    await renderPage()
    await typeFilename('tests/invalid-433.yaml')
    await typeYaml(WALK_INVALID_CONTENT)
    const validateMessage = await validateShows()

    await press('save')

    expect.soft(createTestFileMock).not.toHaveBeenCalled()
    expect.soft(await errorMessages()).toEqual([validateMessage])
    expect.soft(await successMessages()).not.toContain('Test file created')
    expect.soft(navigateMock).not.toHaveBeenCalled()
  })

  it('a server refusal is shown, not celebrated', async () => {
    validateTestContentMock.mockResolvedValue({ valid: true, errors: [] })
    createTestFileMock.mockRejectedValue(
      new ApiError(400, 'Bad Request', { error: 'invalid_test_file', errors: [LINE_3_ERROR] }),
    )
    await renderPage()
    await typeFilename('tests/invalid-433.yaml')
    await typeYaml(WALK_INVALID_CONTENT)

    await press('save')

    expect(await errorMessages()).toEqual(['Line 3: not readable as YAML at line 3, column 1'])
    expect(await successMessages()).toEqual([])
    expect(navigateMock).not.toHaveBeenCalled()
  })

  it('edit mode does not save invalid content', async () => {
    params.value = { t_id: VALID_TEST_ID }
    await renderPage()
    await typeYaml(WALK_INVALID_CONTENT)
    const validateMessage = await validateShows()

    await press('save')

    expect(updateTestFileMock).not.toHaveBeenCalled()
    expect(await errorMessages()).toEqual([validateMessage])
    expect(await successMessages()).not.toContain('Saved')
    expect(navigateMock).not.toHaveBeenCalled()
  })

  it('Run saves first and starts nothing on invalid content', async () => {
    params.value = { t_id: VALID_TEST_ID }
    await renderPage()
    await typeYaml(WALK_INVALID_CONTENT)
    const validateMessage = await validateShows()

    await press('run')

    expect(updateTestFileMock).not.toHaveBeenCalled()
    expect(triggerRunMock).not.toHaveBeenCalled()
    expect(await errorMessages()).toEqual([validateMessage])
    expect(await successMessages()).not.toContain('Run started')
  })

  it('valid content still creates and opens the viewer', async () => {
    validateTestContentMock.mockResolvedValue({ valid: true, errors: [] })
    await renderPage()
    await typeFilename('tests/login.yaml')
    await typeYaml(VALID_CONTENT)

    await press('save')

    expect(createTestFileMock).toHaveBeenCalledWith('tests/login.yaml', VALID_CONTENT)
    expect(await successMessages()).toContain('Test file created')
    expect(navigateMock).toHaveBeenCalledTimes(1)
    expect(navigateMock).toHaveBeenCalledWith(routes.testView(VALID_TEST_ID))
    expect(navigateMock).not.toHaveBeenCalledWith(routes.testView(''))
  })
})
