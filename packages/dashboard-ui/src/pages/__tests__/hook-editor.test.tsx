// @vitest-environment jsdom

import { Children, act, cloneElement, isValidElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import HookEditorPage from '@/pages/hook-editor'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const navigateSpy = vi.fn()
const {
  fetchHookDetailMock,
  createHookMock,
  updateHookMock,
  deleteHookMock,
  generateHookIdMock,
  useHookRunSessionMock,
} = vi.hoisted(() => ({
  fetchHookDetailMock: vi.fn(),
  createHookMock: vi.fn(),
  updateHookMock: vi.fn(),
  deleteHookMock: vi.fn(),
  generateHookIdMock: vi.fn(),
  useHookRunSessionMock: vi.fn(),
}))

let latestMonacoProps: Record<string, unknown> | null = null

vi.mock('react-router', async () => {
  const actual = await vi.importActual<typeof import('react-router')>('react-router')
  return {
    ...actual,
    useNavigate: () => navigateSpy,
  }
})

vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {
    status: number
    payload: Record<string, unknown> | null

    constructor(status: number, message: string, payload: Record<string, unknown> | null = null) {
      super(message)
      this.status = status
      this.payload = payload
    }
  },
  fetchHookDetail: fetchHookDetailMock,
  createHook: createHookMock,
  updateHook: updateHookMock,
  deleteHook: deleteHookMock,
}))
vi.mock('@/lib/generate-hook-id', () => ({
  generateHookId: generateHookIdMock,
}))

vi.mock('@/hooks/use-page-title', () => ({ usePageTitle: () => {} }))
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }))
vi.mock('@/hooks/use-hook-run-session', () => ({ useHookRunSession: useHookRunSessionMock }))
vi.mock('@/components/page-skeleton', () => ({ EditorSkeleton: () => <div data-testid="skeleton" /> }))
vi.mock('@/components/empty-state', () => ({
  EmptyState: ({ title, description }: { title: string; description: string }) => (
    <div>
      <div>{title}</div>
      <div>{description}</div>
    </div>
  ),
}))
vi.mock('@/components/hook-navbar', () => ({
  HookNavbar: (props: {
    onSave?: () => void
    onRun?: () => void
    onDelete?: () => void
    isCreateMode?: boolean
    runDisabled?: boolean
  }) => (
    <div>
      <button type="button" data-testid="hook-save" onClick={props.onSave}>Save</button>
      {!props.isCreateMode && props.onRun ? (
        <button type="button" data-testid="hook-run" disabled={Boolean(props.runDisabled)} onClick={props.onRun}>Run Hook</button>
      ) : null}
      {!props.isCreateMode && props.onDelete ? (
        <button type="button" data-testid="hook-delete" onClick={props.onDelete}>Delete</button>
      ) : null}
    </div>
  ),
}))
vi.mock('@/components/hook-workspace-shell', () => ({
  HookWorkspaceShell: ({
    leftPane,
    rightTopPane,
    rightBottomPane,
  }: {
    leftPane: ReactNode
    rightTopPane: ReactNode
    rightBottomPane: ReactNode
  }) => (
    <div>
      <div data-testid="left-pane">{leftPane}</div>
      <div data-testid="right-top-pane">{rightTopPane}</div>
      <div data-testid="right-bottom-pane">{rightBottomPane}</div>
    </div>
  ),
}))
vi.mock('@/components/hook-run-workbench', () => ({
  HookRunWorkbench: ({
    runDisabledReason,
  }: {
    runDisabledReason: string | null
  }) => (
    <div data-testid="hook-run-workbench">
      <div>Input</div>
      <div>Run logs</div>
      <div>Workspace env</div>
      <div>Runtime variables</div>
      {runDisabledReason ? <div>{runDisabledReason}</div> : null}
    </div>
  ),
}))
vi.mock('@/components/hook-delete-dialog', () => ({
  HookDeleteDialog: ({
    open,
    blockedReferences,
    deleteError,
    onDelete,
    onForceDelete,
  }: {
    open: boolean
    blockedReferences: Array<{ label: string; path: string }>
    deleteError: string | null
    onDelete: () => void
    onForceDelete: () => void
  }) => (
    open ? (
      <div data-testid="hook-delete-dialog">
        <div>{blockedReferences.length > 0 ? 'Hook is still in use' : 'Delete hook?'}</div>
        {deleteError ? <div>{deleteError}</div> : null}
        {blockedReferences.map((reference) => (
          <div key={reference.path}>{reference.label} {reference.path}</div>
        ))}
        <button type="button" onClick={blockedReferences.length > 0 ? onForceDelete : onDelete}>
          {blockedReferences.length > 0 ? 'Force Delete' : 'Delete Hook'}
        </button>
      </div>
    ) : null
  ),
}))
vi.mock('@/components/hook-run-result-panel', () => ({
  HookRunResultPanel: ({ selectedRun }: { selectedRun: unknown }) => (
    <div data-testid="hook-run-result-panel">
      {selectedRun ? 'Selected run' : 'No run selected'}
    </div>
  ),
}))
vi.mock('@/components/monaco-editor', () => ({
  MonacoEditor: (props: Record<string, unknown>) => {
    latestMonacoProps = props
    return <div data-testid="monaco-editor">{String(props.language)}</div>
  },
}))
vi.mock('@/components/ui/button', () => ({
  Button: ({
    children,
    onClick,
    disabled,
    'aria-label': ariaLabel,
  }: {
    children: ReactNode
    onClick?: () => void
    disabled?: boolean
    'aria-label'?: string
  }) => (
    <button type="button" disabled={disabled} onClick={onClick} aria-label={ariaLabel}>
      {children}
    </button>
  ),
}))
vi.mock('@/components/ui/input', () => ({
  Input: ({
    value,
    onChange,
    placeholder,
    id,
    readOnly,
    disabled,
    'aria-label': ariaLabel,
  }: {
    value?: string
    onChange?: (event: React.ChangeEvent<HTMLInputElement>) => void
    placeholder?: string
    id?: string
    readOnly?: boolean
    disabled?: boolean
    'aria-label'?: string
  }) => (
    <input
      id={id}
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      readOnly={readOnly}
      disabled={disabled}
      aria-label={ariaLabel}
    />
  ),
}))
vi.mock('@/components/ui/label', () => ({
  Label: ({ children, htmlFor }: { children: ReactNode; htmlFor?: string }) => <label htmlFor={htmlFor}>{children}</label>,
}))
vi.mock('@/components/ui/switch', () => ({
  Switch: ({
    checked,
    onCheckedChange,
    id,
  }: {
    checked?: boolean
    onCheckedChange?: (value: boolean) => void
    id?: string
  }) => (
    <button type="button" id={id} onClick={() => onCheckedChange?.(!checked)}>
      {checked ? 'network:on' : 'network:off'}
    </button>
  ),
}))
vi.mock('@/components/ui/badge', () => ({
  Badge: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}))
vi.mock('@/components/ui/card', () => ({
  Card: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CardHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CardTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CardContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))
vi.mock('@/components/ui/select', () => ({
  Select: ({
    children,
    onValueChange,
  }: {
    children: ReactNode
    onValueChange?: (value: string) => void
  }) => (
    <div>
      {Children.map(children, (child) => {
        if (!isValidElement(child)) return child
        return cloneElement(child as any, { __onValueChange: onValueChange })
      })}
    </div>
  ),
  SelectTrigger: ({ children }: { children: ReactNode }) => <button type="button">{children}</button>,
  SelectValue: ({ placeholder }: { placeholder?: string }) => <span>{placeholder}</span>,
  SelectContent: ({
    children,
    __onValueChange,
  }: {
    children: ReactNode
    __onValueChange?: (value: string) => void
  }) => (
    <div>
      {Children.map(children, (child) => {
        if (!isValidElement(child)) return child
        return cloneElement(child as any, { __onValueChange })
      })}
    </div>
  ),
  SelectItem: ({
    children,
    value,
    __onValueChange,
  }: {
    children: ReactNode
    value: string
    __onValueChange?: (value: string) => void
  }) => (
    <button type="button" data-select-value={value} onClick={() => __onValueChange?.(value)}>
      {children}
    </button>
  ),
}))
describe('HookEditorPage', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    latestMonacoProps = null
    navigateSpy.mockReset()
    fetchHookDetailMock.mockReset()
    createHookMock.mockReset()
    updateHookMock.mockReset()
    deleteHookMock.mockReset()
    generateHookIdMock.mockReset()
    generateHookIdMock.mockReturnValue('h_alpha-bravo-cinder-delta-ember-falcon-garden-harbor-island-jungle')
    useHookRunSessionMock.mockReset()
    useHookRunSessionMock.mockReturnValue({
      baselineVariables: [{ key: 'BASE_URL', value: 'https://example.com' }],
      baselineFilePath: '.env',
      baselineInfo: null,
      isBaselineLoading: false,
      overrideRows: [],
      overridingRowIds: new Set<string>(),
      recentRuns: [],
      selectedRunId: null,
      selectedRun: null,
      isRunning: false,
      runError: null,
      addOverrideRow: vi.fn(),
      updateOverrideRow: vi.fn(),
      removeOverrideRow: vi.fn(),
      selectRun: vi.fn(),
      clearRunError: vi.fn(),
      submitRun: vi.fn(),
    })
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  async function renderAt(url: string) {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    act(() => {
      root.render(
        <MemoryRouter initialEntries={[url]}>
          <Routes>
            <Route path="/hooks/new" element={<HookEditorPage />} />
            <Route path="/hook/:id/edit" element={<HookEditorPage />} />
          </Routes>
        </MemoryRouter>,
      )
    })

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  async function setInputValue(input: HTMLInputElement | null, value: string) {
    await act(async () => {
      if (!input) return
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      valueSetter?.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
      await Promise.resolve()
    })
  }

  it('uses Bun-first TypeScript authoring defaults, shows a generated hook ID, and preserves it on create', async () => {
    generateHookIdMock
      .mockReturnValueOnce('h_alpha-bravo-cinder-delta-ember-falcon-garden-harbor-island-jungle')
      .mockReturnValueOnce('h_beta-cinder-dawn-ember-falcon-garden-harbor-island-jungle-kestrel')
      .mockReturnValue('h_beta-cinder-dawn-ember-falcon-garden-harbor-island-jungle-kestrel')

    createHookMock.mockImplementation(async (payload: any) => ({
      hook: {
        id: payload.hook.id,
        name: payload.hook.name,
        runtime: payload.hook.runtime,
        file: payload.hook.file,
        timeout: 30000,
        network: payload.hook.network,
        fileMissing: false,
      },
      source: payload.source,
      fieldErrors: [],
    }))

    await renderAt('/hooks/new')

    expect(container.querySelector('[data-testid="left-pane"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="right-top-pane"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="right-bottom-pane"]')).not.toBeNull()
    expect(container.textContent).toContain('Bun')
    expect(container.textContent).not.toContain('TypeScript')
    expect(container.textContent).toContain('Hook name')
    expect(container.textContent).toContain('Hook ID')
    expect(container.textContent).toContain('Runtime')
    expect(container.textContent).toContain('File path')
    expect(container.textContent).toContain('Timeout')
    expect(container.textContent).toContain('Network')
    expect(container.textContent).toContain('Input')
    expect(container.textContent).toContain('Run logs')
    expect(container.textContent).toContain('Save this hook to run the latest changes.')
    expect((container.querySelector('#hook-name') as HTMLInputElement | null)?.placeholder).toBe('Capture auth session')
    expect((container.querySelector('#hook-id') as HTMLInputElement | null)?.value).toBe(
      'h_alpha-bravo-cinder-delta-ember-falcon-garden-harbor-island-jungle',
    )
    expect(container.querySelector('[data-testid="hook-run"]')).toBeNull()
    expect((container.querySelector('#hook-timeout') as HTMLInputElement | null)?.placeholder).toBe('5s')
    expect(container.textContent).toContain('Examples: 5s, 10m, 250ms')

    await act(async () => {
      const regenerateButton = Array.from(container.querySelectorAll('button')).find(
        (button) => button.getAttribute('aria-label') === 'Generate new hook ID',
      )
      regenerateButton?.click()
      await Promise.resolve()
    })

    expect((container.querySelector('#hook-id') as HTMLInputElement | null)?.value).toBe(
      'h_beta-cinder-dawn-ember-falcon-garden-harbor-island-jungle-kestrel',
    )

    await act(async () => {
      const bunButton = Array.from(container.querySelectorAll('button')).find(
        (button) => button.textContent === 'Bun',
      )
      bunButton?.click()
      await Promise.resolve()
    })

    expect(latestMonacoProps?.language).toBe('typescript')
    expect((container.querySelector('#hook-file') as HTMLInputElement | null)?.value).toBe('./hooks/new-hook.ts')
    expect(container.textContent).toContain('Source')
    expect(container.textContent).toContain('TypeScript')
    expect(String(latestMonacoProps?.value ?? '')).toContain('/tmp/agent-qa.env')

    await act(async () => {
      ;(container.querySelector('[data-testid="hook-save"]') as HTMLButtonElement | null)?.click()
      await Promise.resolve()
    })

    expect(createHookMock).toHaveBeenCalledWith(
      expect.objectContaining({
        hook: expect.objectContaining({
          id: 'h_beta-cinder-dawn-ember-falcon-garden-harbor-island-jungle-kestrel',
          runtime: 'bun',
          file: './hooks/new-hook.ts',
        }),
        source: expect.stringContaining('/tmp/agent-qa.env'),
      }),
    )
    expect(navigateSpy).toHaveBeenCalledWith(
      '/hook/h_beta-cinder-dawn-ember-falcon-garden-harbor-island-jungle-kestrel/edit',
      { replace: true },
    )
  })

  it('renders editor workstation parity and disables execution until unsaved changes are saved', async () => {
    fetchHookDetailMock.mockResolvedValue({
      hook: {
        id: 'h_alpha',
        name: 'Login Hook',
        runtime: 'node',
        file: './hooks/login.js',
        timeout: 30000,
        network: true,
        fileMissing: true,
      },
      source: 'module.exports = async function hook() {}\n',
      fieldErrors: [
        {
          field: 'file',
          code: 'file_missing',
          message: 'Hook file missing',
        },
      ],
    })

    await renderAt('/hook/h_alpha/edit')

    expect(container.querySelector('[data-testid="left-pane"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="right-top-pane"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="right-bottom-pane"]')).not.toBeNull()
    expect(container.textContent).toContain('Hook name')
    expect(container.textContent).toContain('Runtime')
    expect(container.textContent).toContain('File path')
    expect(container.textContent).toContain('Timeout')
    expect(container.textContent).toContain('Network')
    expect(container.textContent).toContain('Hook file missing')
    expect(container.textContent).toContain('Delete')

    await setInputValue(container.querySelector('#hook-name') as HTMLInputElement | null, 'Login Hook Updated')

    expect(container.textContent).toContain('Save this hook to run the latest changes.')
    expect(
      Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Run Hook')?.disabled,
    ).toBe(true)
  })

  it('shows blocked delete references in the shared modal and force deletes only after explicit confirmation', async () => {
    fetchHookDetailMock.mockResolvedValue({
      hook: {
        id: 'h_alpha',
        name: 'Login Hook',
        runtime: 'node',
        file: './hooks/login.js',
        timeout: 30000,
        network: true,
        fileMissing: false,
      },
      source: 'module.exports = async function hook() {}\n',
      fieldErrors: [],
    })

    const ApiErrorCtor = (await import('@/lib/api')).ApiError

    deleteHookMock.mockRejectedValueOnce(
      new ApiErrorCtor(409, 'hook_in_use', {
        error: 'hook_in_use',
        references: [
          {
            kind: 'suite',
            label: 'Smoke suite',
            path: 'suites/smoke.suite.yaml',
            context: 'teardown',
          },
        ],
      }),
    )
    deleteHookMock.mockResolvedValueOnce({ deleted: true, references: [] })

    await renderAt('/hook/h_alpha/edit')

    await act(async () => {
      const deleteButton = container.querySelector('[data-testid="hook-delete"]') as HTMLButtonElement | null
      deleteButton?.click()
      await Promise.resolve()
    })

    expect(container.querySelector('[data-testid="hook-delete-dialog"]')).not.toBeNull()

    await act(async () => {
      const confirmDeleteButton = Array.from(container.querySelectorAll('button')).find(
        (button) => button.textContent === 'Delete Hook',
      )
      confirmDeleteButton?.click()
      await Promise.resolve()
    })

    expect(deleteHookMock).toHaveBeenNthCalledWith(1, 'h_alpha', { force: false })
    expect(container.textContent).toContain('Hook is still in use')
    expect(container.textContent).toContain('Smoke suite')
    expect(container.textContent).toContain('suites/smoke.suite.yaml')

    await act(async () => {
      const forceDeleteButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Force Delete')
      forceDeleteButton?.click()
      await Promise.resolve()
    })

    expect(deleteHookMock).toHaveBeenNthCalledWith(2, 'h_alpha', { force: true })
    expect(navigateSpy).toHaveBeenCalledWith('/hooks')
  })
})
