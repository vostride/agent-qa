import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router'
import { AlertTriangle, Wrench } from 'lucide-react'

import { HookDeleteDialog } from '@/components/hook-delete-dialog'
import { HookNavbar } from '@/components/hook-navbar'
import { HookRunResultPanel } from '@/components/hook-run-result-panel'
import { HookRunWorkbench } from '@/components/hook-run-workbench'
import { HookWorkspaceShell } from '@/components/hook-workspace-shell'
import { MonacoEditor } from '@/components/monaco-editor'
import { EmptyState } from '@/components/empty-state'
import { EditorSkeleton } from '@/components/page-skeleton'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useHookRunSession } from '@/hooks/use-hook-run-session'
import { useIsMobile } from '@/hooks/use-mobile'
import { useKeyboardShortcuts } from '@/hooks/use-keyboard-shortcuts'
import { usePageTitle } from '@/hooks/use-page-title'
import { ApiError, deleteHook, fetchHookDetail, type HookDeleteReference, type HookDetailResponse } from '@/lib/api'
import { getHookRuntimeMeta, runtimeToLanguage } from '@/lib/hook-runtime'
import { routes } from '@/lib/routes'
import { cn, formatDuration } from '@/lib/utils'

const VALID_HOOK_VIEWER_TABS = ['overview', 'source', 'run'] as const

type HookViewerTab = (typeof VALID_HOOK_VIEWER_TABS)[number]

function isHookViewerTab(value: string | null): value is HookViewerTab {
  return value !== null && (VALID_HOOK_VIEWER_TABS as readonly string[]).includes(value)
}

function normalizeHookViewerTab(searchParams: URLSearchParams): HookViewerTab {
  const tab = searchParams.get('tab')
  return isHookViewerTab(tab) ? tab : 'overview'
}

function InlineNotice({
  title,
  body,
  tone = 'warning',
}: {
  title: string
  body: string
  tone?: 'warning' | 'error' | 'neutral'
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
    </div>
  )
}

function HookStatusBadge({ fileMissing }: { fileMissing: boolean }) {
  if (fileMissing) {
    return (
      <Badge variant="outline" className="border-amber-500/30 text-amber-600">
        File missing
      </Badge>
    )
  }

  return (
    <Badge variant="outline" className="border-emerald-500/30 text-emerald-600">
      Ready
    </Badge>
  )
}

function RailField({
  label,
  value,
  mono = false,
}: {
  label: string
  value: React.ReactNode
  mono?: boolean
}) {
  return (
    <div className="space-y-1.5">
      <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={mono ? 'font-mono text-xs text-foreground break-all' : 'text-sm text-foreground'}>
        {value}
      </div>
    </div>
  )
}

export default function HookViewerPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const hookId = id ?? ''
  const isMobile = useIsMobile()
  const [detail, setDetail] = useState<HookDetailResponse | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [blockedDeleteReferences, setBlockedDeleteReferences] = useState<HookDeleteReference[]>([])
  const [isDeleting, setIsDeleting] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const sourceSectionRef = useRef<HTMLDivElement | null>(null)
  const runSectionRef = useRef<HTMLDivElement | null>(null)
  const initialLegacyTabRef = useRef<HookViewerTab | null>(
    searchParams.has('tab') ? normalizeHookViewerTab(searchParams) : null,
  )

  const runSession = useHookRunSession({ hookId })

  useEffect(() => {
    if (searchParams.has('tab')) {
      const next = new URLSearchParams(searchParams)
      next.delete('tab')
      setSearchParams(next, { replace: true })
    }
  }, [searchParams, setSearchParams])

  useEffect(() => {
    let cancelled = false

    setIsLoading(true)
    setNotFound(false)
    setLoadError(null)

    fetchHookDetail(hookId)
      .then((response) => {
        if (cancelled) return
        setDetail(response)
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setDetail(null)
        if (error instanceof ApiError && error.status === 404) {
          setNotFound(true)
          return
        }
        setLoadError(error instanceof Error ? error.message : 'Failed to load hook')
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [hookId])

  const hookName = detail?.hook.name ?? 'Hook'
  usePageTitle(hookName)

  const runtimeMeta = useMemo(
    () => (detail ? getHookRuntimeMeta(detail.hook.runtime) : null),
    [detail],
  )
  const RuntimeIcon = runtimeMeta?.icon

  const fileMissing = detail?.fieldErrors.some((error) => error.code === 'file_missing') ?? false
  const otherFieldErrors = detail?.fieldErrors.filter((error) => error.code !== 'file_missing') ?? []
  const runDisabledReason = useMemo(() => {
    if (!detail) return 'Hook details are still loading.'
    if (detail.fieldErrors.length === 0) return null
    return detail.fieldErrors.map((error) => error.message).join(' ')
  }, [detail])

  const handleRunAction = useCallback(async () => {
    runSectionRef.current?.scrollIntoView?.({ block: 'start' })
    if (runDisabledReason) {
      return
    }
    await runSession.submitRun()
  }, [runDisabledReason, runSession])

  const openDeleteDialog = useCallback(() => {
    setDeleteError(null)
    setBlockedDeleteReferences([])
    setDeleteDialogOpen(true)
  }, [])

  const handleDeleteDialogChange = useCallback((open: boolean) => {
    setDeleteDialogOpen(open)
    if (!open) {
      setDeleteError(null)
      setBlockedDeleteReferences([])
    }
  }, [])

  const performDelete = useCallback(async (force = false) => {
    if (!hookId) return

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
  }, [hookId, navigate])

  const editRoute = routes.hookEdit(hookId)

  useKeyboardShortcuts({
    e: () => {
      if (detail) navigate(editRoute)
    },
    r: () => { void handleRunAction() },
    'shift+?': () => setShortcutsOpen((current) => !current),
  })

  useEffect(() => {
    if (!detail || !initialLegacyTabRef.current) {
      return
    }

    if (initialLegacyTabRef.current === 'source') {
      sourceSectionRef.current?.scrollIntoView?.({ block: 'start' })
    }
    if (initialLegacyTabRef.current === 'run') {
      runSectionRef.current?.scrollIntoView?.({ block: 'start' })
    }

    initialLegacyTabRef.current = null
  }, [detail])

  if (isLoading) {
    return <EditorSkeleton />
  }

  if (notFound) {
    return (
      <EmptyState
        icon={Wrench}
        title="Hook not found"
        description="This hook doesn't exist or could not be loaded."
        actionLabel="View All Hooks"
        onAction={() => navigate(routes.hooks)}
      />
    )
  }

  if (!detail) {
    return (
      <EmptyState
        icon={AlertTriangle}
        title="Hook couldn't be loaded"
        description={loadError ?? 'This hook could not be loaded right now.'}
        actionLabel="View All Hooks"
        onAction={() => navigate(routes.hooks)}
      />
    )
  }

  const leftPaneContent = (
    <div
      className={cn(
        'p-3',
        isMobile ? 'space-y-3' : 'flex h-full min-h-0 flex-col gap-3 overflow-hidden',
      )}
    >
      <div className="space-y-3 shrink-0">
        {loadError ? (
          <InlineNotice title="Hook could not be loaded" body={loadError} tone="error" />
        ) : null}
        {fileMissing ? (
          <InlineNotice
            title="Hook file missing"
            body="This hook is still registered, but its source file can't be found. Update the path or recreate the file, then save again."
          />
        ) : null}
        {otherFieldErrors.length > 0 ? (
          <InlineNotice
            title="Hook has recoverable authoring issues"
            body={otherFieldErrors.map((error) => error.message).join(' ')}
          />
        ) : null}

        <section className="space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Hook</div>
              <div className="text-base font-semibold text-foreground">{detail.hook.name}</div>
            </div>
            <HookStatusBadge fileMissing={fileMissing} />
          </div>

          <div className="grid gap-x-5 gap-y-3 sm:grid-cols-2">
            <RailField label="File" value={detail.hook.file} mono />
            <RailField label="Hook ID" value={detail.hook.id} mono />
            <RailField
              label="Runtime"
              value={(
                <div className="flex items-center gap-2">
                  {RuntimeIcon ? <RuntimeIcon className="h-4 w-4 text-muted-foreground" /> : null}
                  <span>{runtimeMeta?.label ?? detail.hook.runtime}</span>
                </div>
              )}
            />
            <RailField label="Timeout" value={formatDuration(detail.hook.timeout)} />
            <RailField label="Network" value={detail.hook.network ? 'Enabled' : 'Disabled'} />
            <RailField label="Health" value={<HookStatusBadge fileMissing={fileMissing} />} />
          </div>
        </section>
      </div>

      <section
        ref={sourceSectionRef}
        className={cn(
          'space-y-2',
          isMobile ? '' : 'flex min-h-[300px] flex-1 flex-col overflow-hidden',
        )}
      >
        <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Source</div>
        {detail.source ? (
          <MonacoEditor
            value={detail.source}
            onChange={() => {}}
            readOnly
            language={runtimeToLanguage(detail.hook.runtime)}
            className={cn(
              'rounded-sm',
              isMobile ? 'h-[360px] min-h-[320px]' : 'h-full min-h-[300px] flex-1',
            )}
          />
        ) : (
          <div
            className={cn(
              'flex items-center justify-center rounded-sm border border-dashed px-6 py-12 text-center',
              isMobile ? 'min-h-[320px]' : 'min-h-[300px] flex-1',
            )}
          >
            <div>
              <AlertTriangle className="mx-auto h-5 w-5 text-muted-foreground" />
              <div className="mt-3 text-sm font-medium text-foreground">No hook source found for this record.</div>
              <div className="mt-1 text-sm text-muted-foreground">
                Update the path or recreate the file in edit mode.
              </div>
            </div>
          </div>
        )}
      </section>
    </div>
  )

  const leftPane = isMobile
    ? <ScrollArea className="h-full">{leftPaneContent}</ScrollArea>
    : leftPaneContent

  const runWorkbenchPanel = (
    <div ref={runSectionRef} className="h-full">
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
        onRun={() => { void handleRunAction() }}
        onSelectRun={runSession.selectRun}
      />
    </div>
  )

  const runResultPanel = <HookRunResultPanel selectedRun={runSession.selectedRun} />

  return (
    <TooltipProvider>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <HookNavbar
          hookName={detail.hook.name}
          isCreateMode={false}
          mode="view"
          hookHref={routes.hookView(detail.hook.id)}
          editHref={routes.hookEdit(detail.hook.id)}
          isRunning={runSession.isRunning}
          onRun={() => { void handleRunAction() }}
          runDisabled={!!runDisabledReason}
          onDelete={openDeleteDialog}
          isDeleting={isDeleting}
          shortcutsOpen={shortcutsOpen}
          onToggleShortcuts={() => setShortcutsOpen((current) => !current)}
        />

        <HookWorkspaceShell
          isMobile={isMobile}
          leftPane={leftPane}
          rightTopPane={runWorkbenchPanel}
          rightBottomPane={runResultPanel}
        />

        <HookDeleteDialog
          open={deleteDialogOpen}
          onOpenChange={handleDeleteDialogChange}
          hook={{
            id: detail.hook.id,
            name: detail.hook.name,
            runtime: detail.hook.runtime,
            file: detail.hook.file,
          }}
          isDeleting={isDeleting}
          deleteError={deleteError}
          blockedReferences={blockedDeleteReferences}
          onDelete={() => { void performDelete(false) }}
          onForceDelete={() => { void performDelete(true) }}
        />
      </div>
    </TooltipProvider>
  )
}
