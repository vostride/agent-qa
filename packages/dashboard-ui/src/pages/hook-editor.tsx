import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { AlertTriangle, RefreshCw } from 'lucide-react'

import { HookDeleteDialog } from '@/components/hook-delete-dialog'
import { HookNavbar } from '@/components/hook-navbar'
import { HookRunResultPanel } from '@/components/hook-run-result-panel'
import { HookRunWorkbench } from '@/components/hook-run-workbench'
import { HookWorkspaceShell } from '@/components/hook-workspace-shell'
import { MonacoEditor } from '@/components/monaco-editor'
import { EmptyState } from '@/components/empty-state'
import { EditorSkeleton } from '@/components/page-skeleton'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { useHookRunSession } from '@/hooks/use-hook-run-session'
import { useIsMobile } from '@/hooks/use-mobile'
import { usePageTitle } from '@/hooks/use-page-title'
import {
  ApiError,
  createHook,
  deleteHook,
  fetchHookDetail,
  type HookDeleteReference,
  type HookFieldError,
  type HookMutationRequest,
  type HookRuntime,
  updateHook,
} from '@/lib/api'
import { generateHookId } from '@/lib/generate-hook-id'
import { HOOK_RUNTIME_OPTIONS, buildHookDraft, getHookRuntimeMeta, runtimeToLanguage } from '@/lib/hook-runtime'
import { routes } from '@/lib/routes'
import { cn } from '@/lib/utils'

function InlineNotice({
  title,
  body,
  tone = 'warning',
  children,
}: {
  title: string
  body: string
  tone?: 'warning' | 'error' | 'neutral'
  children?: ReactNode
}) {
  const toneClassName = tone === 'error'
    ? 'border-destructive/30 bg-destructive/10'
    : tone === 'neutral'
      ? 'border-border bg-muted/40'
      : 'border-amber-500/30 bg-amber-500/10'

  return (
    <div className={`rounded-sm border px-4 py-3 text-sm ${toneClassName}`}>
      <div className="font-medium text-foreground">{title}</div>
      <div className="mt-1 text-muted-foreground">{body}</div>
      {children ? <div className="mt-3">{children}</div> : null}
    </div>
  )
}

function formatTimeoutInput(timeoutMs: number): string {
  if (timeoutMs === 0) {
    return '0ms'
  }

  const timeoutUnits = [
    { suffix: 'd', value: 86_400_000 },
    { suffix: 'h', value: 3_600_000 },
    { suffix: 'm', value: 60_000 },
    { suffix: 's', value: 1_000 },
  ] as const

  for (const unit of timeoutUnits) {
    if (timeoutMs % unit.value === 0) {
      return `${timeoutMs / unit.value}${unit.suffix}`
    }
  }

  return `${timeoutMs}ms`
}

function serializeHookDraft(input: {
  name: string
  runtime: HookRuntime
  file: string
  timeout: string
  network: boolean
  source: string
}): string {
  return JSON.stringify({
    name: input.name,
    runtime: input.runtime,
    file: input.file,
    timeout: input.timeout,
    network: input.network,
    source: input.source,
  })
}

function getFieldError(fieldErrors: HookFieldError[], field: HookFieldError['field']): HookFieldError | null {
  return fieldErrors.find((error) => error.field === field) ?? null
}

function isHookFieldErrorArray(value: unknown): value is HookFieldError[] {
  return Array.isArray(value)
}

function formatMonacoLanguageLabel(language: string): string {
  switch (language) {
    case 'javascript':
      return 'JavaScript'
    case 'typescript':
      return 'TypeScript'
    case 'python':
      return 'Python'
    case 'shell':
      return 'Shell'
    default:
      return language
  }
}

export default function HookEditorPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const isMobile = useIsMobile()
  const isCreateMode = !id
  const routeHookId = id ?? ''
  const defaultDraft = useMemo(() => buildHookDraft('node'), [])
  const createModeHookIdRef = useRef(isCreateMode ? generateHookId() : routeHookId)

  const [hookId, setHookId] = useState(createModeHookIdRef.current)
  const [name, setName] = useState('')
  const [runtime, setRuntime] = useState<HookRuntime>('node')
  const [file, setFile] = useState(defaultDraft.file)
  const [timeout, setTimeout] = useState('30s')
  const [network, setNetwork] = useState(true)
  const [source, setSource] = useState(defaultDraft.source)
  const [fieldErrors, setFieldErrors] = useState<HookFieldError[]>([])
  const [isLoading, setIsLoading] = useState(!isCreateMode)
  const [notFound, setNotFound] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [blockedDeleteReferences, setBlockedDeleteReferences] = useState<HookDeleteReference[]>([])
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [initialSnapshot, setInitialSnapshot] = useState(() =>
    serializeHookDraft({
      name: '',
      runtime: 'node',
      file: defaultDraft.file,
      timeout: '30s',
      network: true,
      source: defaultDraft.source,
    }),
  )
  const autoFileRef = useRef(defaultDraft.file)
  const autoSourceRef = useRef(defaultDraft.source)

  const pageTitle = isCreateMode ? 'New Hook' : (name.trim() || 'Hook')
  usePageTitle(pageTitle)

  const unsaved = serializeHookDraft({ name, runtime, file, timeout, network, source }) !== initialSnapshot
  const fileMissingWarning = fieldErrors.find((error) => error.code === 'file_missing') ?? null
  const runSession = useHookRunSession({ hookId })
  const monacoLanguage = runtimeToLanguage(runtime)
  const monacoLanguageLabel = formatMonacoLanguageLabel(monacoLanguage)
  const runDisabledReason = useMemo(() => {
    if (isCreateMode || !hookId || unsaved) {
      return 'Save this hook to run the latest changes.'
    }
    if (fieldErrors.length > 0) {
      return fieldErrors.map((error) => error.message).join(' ')
    }
    return null
  }, [fieldErrors, hookId, isCreateMode, unsaved])

  useEffect(() => {
    if (isCreateMode) {
      setHookId(createModeHookIdRef.current)
      setNotFound(false)
      return
    }

    let cancelled = false
    setIsLoading(true)

    fetchHookDetail(routeHookId)
      .then((response) => {
        if (cancelled) return
        const nextTimeout = formatTimeoutInput(response.hook.timeout)
        const nextSource = response.source ?? ''

        setHookId(response.hook.id)
        setName(response.hook.name)
        setRuntime(response.hook.runtime)
        setFile(response.hook.file)
        setTimeout(nextTimeout)
        setNetwork(response.hook.network)
        setSource(nextSource)
        setFieldErrors(response.fieldErrors)
        setSaveError(null)
        setDeleteError(null)
        setBlockedDeleteReferences([])
        setNotFound(false)
        setInitialSnapshot(
          serializeHookDraft({
            name: response.hook.name,
            runtime: response.hook.runtime,
            file: response.hook.file,
            timeout: nextTimeout,
            network: response.hook.network,
            source: nextSource,
          }),
        )
        autoFileRef.current = response.hook.file
        autoSourceRef.current = nextSource
      })
      .catch((error: unknown) => {
        if (cancelled) return
        if (error instanceof ApiError && error.status === 404) {
          setNotFound(true)
          return
        }
        setSaveError(error instanceof Error ? error.message : 'Failed to load hook')
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [isCreateMode, routeHookId])

  function handleRuntimeChange(nextRuntime: HookRuntime) {
    if (isCreateMode) {
      const nextDraft = buildHookDraft(nextRuntime, name)
      if (file === autoFileRef.current || !file.trim()) {
        setFile(nextDraft.file)
      }
      if (source === autoSourceRef.current || !source.trim()) {
        setSource(nextDraft.source)
      }
      autoFileRef.current = nextDraft.file
      autoSourceRef.current = nextDraft.source
    }
    setRuntime(nextRuntime)
  }

  function handleNameChange(nextName: string) {
    setName(nextName)
    if (!isCreateMode) return

    const nextDraft = buildHookDraft(runtime, nextName)
    if (file === autoFileRef.current || !file.trim()) {
      setFile(nextDraft.file)
    }
    autoFileRef.current = nextDraft.file
  }

  function handleRegenerateHookId() {
    if (!isCreateMode) return
    const nextHookId = generateHookId()
    createModeHookIdRef.current = nextHookId
    setHookId(nextHookId)
  }

  async function handleSave() {
    setIsSaving(true)
    setSaveError(null)
    setDeleteError(null)
    setBlockedDeleteReferences([])

    const payload: HookMutationRequest = {
      hook: {
        id: hookId,
        name: name.trim(),
        runtime,
        file: file.trim(),
        timeout: timeout.trim(),
        network,
      },
      source,
    }

    try {
      const response = isCreateMode
        ? await createHook(payload)
        : await updateHook(hookId, payload)

      const nextTimeout = formatTimeoutInput(response.hook.timeout)
      const nextSource = response.source ?? source

      setHookId(response.hook.id)
      setName(response.hook.name)
      setRuntime(response.hook.runtime)
      setFile(response.hook.file)
      setTimeout(nextTimeout)
      setNetwork(response.hook.network)
      setSource(nextSource)
      setFieldErrors(response.fieldErrors)
      setInitialSnapshot(
        serializeHookDraft({
          name: response.hook.name,
          runtime: response.hook.runtime,
          file: response.hook.file,
          timeout: nextTimeout,
          network: response.hook.network,
          source: nextSource,
        }),
      )
      autoFileRef.current = response.hook.file
      autoSourceRef.current = nextSource

      if (isCreateMode) {
        navigate(routes.hookEdit(response.hook.id), { replace: true })
      }
    } catch (error: unknown) {
      if (error instanceof ApiError) {
        const errorName = error.payload?.error
        const payloadFieldErrors = error.payload?.fieldErrors
        if (errorName === 'validation_failed' && isHookFieldErrorArray(payloadFieldErrors)) {
          setFieldErrors(payloadFieldErrors)
          setSaveError("Couldn't save this hook. Fix the highlighted issues and try again.")
        } else {
          setSaveError(error.message)
        }
      } else {
        setSaveError(error instanceof Error ? error.message : 'Failed to save hook')
      }
    } finally {
      setIsSaving(false)
    }
  }

  async function performDelete(force = false) {
    if (isCreateMode || !hookId) return

    setIsDeleting(true)
    setDeleteError(null)

    try {
      await deleteHook(hookId, { force })
      navigate(routes.hooks)
    } catch (error: unknown) {
      if (error instanceof ApiError) {
        const errorName = error.payload?.error
        const references = error.payload?.references

        if (errorName === 'hook_in_use' && Array.isArray(references)) {
          setBlockedDeleteReferences(references as HookDeleteReference[])
          return
        }

        setDeleteError(error.message)
      } else {
        setDeleteError(error instanceof Error ? error.message : 'Failed to delete hook')
      }
    } finally {
      setIsDeleting(false)
    }
  }

  function openDeleteDialog() {
    setDeleteError(null)
    setBlockedDeleteReferences([])
    setDeleteDialogOpen(true)
  }

  function handleDeleteDialogChange(open: boolean) {
    setDeleteDialogOpen(open)
    if (!open) {
      setDeleteError(null)
      setBlockedDeleteReferences([])
    }
  }

  async function handleRun() {
    if (runDisabledReason) {
      return
    }

    await runSession.submitRun()
  }

  if (isLoading) {
    return <EditorSkeleton />
  }

  if (notFound) {
    return (
      <EmptyState
        icon={AlertTriangle}
        title="Hook not found"
        description="This hook doesn't exist or could not be loaded."
        actionLabel="View All Hooks"
        onAction={() => navigate(routes.hooks)}
      />
    )
  }

  const nameError = getFieldError(fieldErrors, 'name')
  const runtimeError = getFieldError(fieldErrors, 'runtime')
  const fileError = getFieldError(fieldErrors, 'file')
  const timeoutError = getFieldError(fieldErrors, 'timeout')
  const networkError = getFieldError(fieldErrors, 'network')
  const leftPaneContent = (
    <div
      className={cn(
        'p-3',
        isMobile ? 'space-y-3' : 'flex h-full min-h-0 flex-col gap-3 overflow-hidden',
      )}
    >
      <div className="space-y-3 shrink-0">
        {saveError ? (
          <InlineNotice title="Couldn't save this hook." body={saveError} tone="error" />
        ) : null}

        {fileMissingWarning ? (
          <InlineNotice
            title="Hook file missing"
            body="This hook is still registered, but its source file can't be found. Update the path or recreate the file, then save again."
          />
        ) : null}

        <section className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="hook-name">Hook name</Label>
            <Input
              id="hook-name"
              value={name}
              onChange={(event) => handleNameChange(event.currentTarget.value)}
              placeholder="Capture auth session"
              aria-invalid={Boolean(nameError)}
            />
            {nameError ? <p className="text-xs text-destructive">{nameError.message}</p> : null}
          </div>

          {isCreateMode ? (
            <div className="space-y-1.5">
              <Label htmlFor="hook-id">Hook ID</Label>
              <div className="flex items-center gap-2">
                <Input
                  id="hook-id"
                  value={hookId}
                  readOnly
                  disabled
                  aria-label="Hook ID"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={handleRegenerateHookId}
                  aria-label="Generate new hook ID"
                >
                  <RefreshCw className="size-3.5" />
                </Button>
              </div>
            </div>
          ) : null}

          <div className="space-y-1.5">
            <Label htmlFor="hook-file">File path</Label>
            <Input
              id="hook-file"
              value={file}
              onChange={(event) => setFile(event.currentTarget.value)}
              placeholder="./hooks/login.js"
              aria-invalid={Boolean(fileError)}
            />
            {fileError ? <p className="text-xs text-destructive">{fileError.message}</p> : null}
          </div>

          <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,0.8fr)_minmax(0,0.8fr)]">
            <div className="space-y-1.5">
              <Label htmlFor="hook-runtime">Runtime</Label>
              <Select value={runtime} onValueChange={(value) => handleRuntimeChange(value as HookRuntime)}>
                <SelectTrigger id="hook-runtime" aria-invalid={Boolean(runtimeError)}>
                  <SelectValue placeholder="Runtime" />
                </SelectTrigger>
                <SelectContent>
                  {HOOK_RUNTIME_OPTIONS.map((runtimeOption) => (
                    <SelectItem key={runtimeOption} value={runtimeOption}>
                      {getHookRuntimeMeta(runtimeOption).label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {runtimeError ? <p className="text-xs text-destructive">{runtimeError.message}</p> : null}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="hook-timeout">Timeout</Label>
              <Input
                id="hook-timeout"
                value={timeout}
                onChange={(event) => setTimeout(event.currentTarget.value)}
                placeholder="5s"
                aria-invalid={Boolean(timeoutError)}
              />
              <p className="text-xs text-muted-foreground">Examples: 5s, 10m, 250ms</p>
              {timeoutError ? <p className="text-xs text-destructive">{timeoutError.message}</p> : null}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="hook-network">Network</Label>
              <div className="flex h-10 items-center justify-between rounded-sm border bg-background/70 px-3">
                <span className="text-sm text-foreground">{network ? 'Enabled' : 'Disabled'}</span>
                <Switch
                  id="hook-network"
                  checked={network}
                  onCheckedChange={setNetwork}
                  aria-invalid={Boolean(networkError)}
                />
              </div>
              {networkError ? <p className="text-xs text-destructive">{networkError.message}</p> : null}
            </div>
          </div>
        </section>
      </div>

      <section
        className={cn(
          'space-y-2',
          isMobile ? '' : 'flex min-h-[300px] flex-1 flex-col overflow-hidden',
        )}
      >
        <div className="flex items-center gap-2">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Source</div>
          <span className="rounded-sm border px-1.5 py-0.5 text-[11px] text-muted-foreground">
            {monacoLanguageLabel}
          </span>
        </div>
        <MonacoEditor
          value={source}
          onChange={setSource}
          onSave={handleSave}
          language={monacoLanguage}
          className={cn(
            'rounded-sm',
            isMobile ? 'h-[360px] min-h-[320px]' : 'h-full min-h-[300px] flex-1',
          )}
        />
      </section>
    </div>
  )

  const leftPane = isMobile
    ? <ScrollArea className="h-full">{leftPaneContent}</ScrollArea>
    : leftPaneContent
  const rightTopPane = (
    <HookRunWorkbench
      baselineCount={runSession.baselineVariables.length}
      baselineFilePath={runSession.baselineFilePath}
      baselineInfo={runSession.baselineInfo}
      isBaselineLoading={runSession.isBaselineLoading}
      overrideRows={runSession.overrideRows}
      overridingRowIds={runSession.overridingRowIds}
      recentRuns={runSession.recentRuns}
      selectedRunId={runSession.selectedRunId}
      isRunning={runSession.isRunning}
      runDisabledReason={runDisabledReason}
      runError={runSession.runError}
      onAddOverride={() => runSession.addOverrideRow()}
      onUpdateOverride={runSession.updateOverrideRow}
      onRemoveOverride={runSession.removeOverrideRow}
      onRun={() => { void handleRun() }}
      onSelectRun={runSession.selectRun}
    />
  )
  const rightBottomPane = <HookRunResultPanel selectedRun={runSession.selectedRun} />

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <HookNavbar
        hookName={name.trim() || 'New Hook'}
        isCreateMode={isCreateMode}
        mode="edit"
        hookHref={!isCreateMode ? routes.hookView(hookId) : undefined}
        editHref={!isCreateMode ? routes.hookEdit(hookId) : undefined}
        unsaved={unsaved}
        isSaving={isSaving}
        isRunning={runSession.isRunning}
        isDeleting={isDeleting}
        onSave={handleSave}
        onRun={!isCreateMode ? () => { void handleRun() } : undefined}
        runDisabled={!!runDisabledReason}
        onDelete={!isCreateMode ? openDeleteDialog : undefined}
      />

      <HookWorkspaceShell
        isMobile={isMobile}
        leftPane={leftPane}
        rightTopPane={rightTopPane}
        rightBottomPane={rightBottomPane}
      />

      {!isCreateMode ? (
        <HookDeleteDialog
          open={deleteDialogOpen}
          onOpenChange={handleDeleteDialogChange}
          hook={{
            id: hookId,
            name: name.trim() || 'Hook',
            runtime,
            file,
          }}
          isDeleting={isDeleting}
          deleteError={deleteError}
          blockedReferences={blockedDeleteReferences}
          onDelete={() => { void performDelete(false) }}
          onForceDelete={() => { void performDelete(true) }}
        />
      ) : null}
    </div>
  )
}
