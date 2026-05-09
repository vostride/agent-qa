import { useRef, useCallback, useState, useEffect, useMemo } from 'react'
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  Info,
  Loader2,
  Plus,
  PlayCircle,
  Square,
  Webhook,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { TestHookListField } from '@/components/test-hook-token-field'
import { useTestHookCatalog } from '@/components/test-hooks-form'
import { SuiteMetadataForm } from '@/components/suite-metadata-form'
import { SuiteTestRow } from '@/components/suite-test-row'
import { SuiteTestPicker } from '@/components/suite-test-picker'
import { cn } from '@/lib/utils'
import type { VariableSuggestion } from '@/hooks/use-variable-suggestions'
import type { EditorTest, LiveHookExecution } from '@/hooks/use-live-editor'
import type { Selection } from '@/lib/selection'
import {
  suiteYamlToFormState,
  updateSuiteField,
  addSuiteTest,
  removeSuiteTest,
  reorderSuiteTests,
  type SuiteFormState,
  type SuiteTestEntry,
} from '@/lib/suite-yaml-serializer'
import { fetchTestFiles, type TestFileInfo } from '@/lib/api'

interface SuiteVisualBuilderProps {
  content: string
  onChange: (yaml: string) => void
  disabled?: boolean
  suggestions: VariableSuggestion[]
  isCreateMode?: boolean

  // Live mode additions (all optional — back-compat-safe)
  liveMode?: boolean
  liveTests?: EditorTest[]
  liveSetupHooks?: LiveHookExecution[]
  liveTeardownHooks?: LiveHookExecution[]
  runningTestIndex?: number | null
  canRunTest?: boolean
  canRunAll?: boolean
  isRunningAll?: boolean
  isStoppingRunAll?: boolean
  onRunTest?: (index: number) => void
  onCancelTest?: (index: number) => void
  onRunAll?: () => void
  onStopAll?: () => void
  onRunLiveHook?: (phase: 'setup' | 'teardown', hookId: string) => void
  setupHooksStale?: boolean
  onRestartSession?: () => void
  selection?: Selection | null
  onSelect?: (selection: Selection | null) => void
}

function InfoTip({ text }: { text: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Info className="h-3 w-3 text-muted-foreground/40 hover:text-muted-foreground/70 transition-colors cursor-help" />
      </TooltipTrigger>
      <TooltipContent className="max-w-[250px] text-[13px]">{text}</TooltipContent>
    </Tooltip>
  )
}

function HookStatusIcon({ status }: { status: LiveHookExecution['status'] }) {
  switch (status) {
    case 'running': return <CircleDashed className="size-3.5 text-primary" />
    case 'passed':  return <CheckCircle2 className="size-3.5 text-emerald-500" />
    case 'failed':  return <AlertTriangle className="size-3.5 text-destructive" />
    default:        return <Webhook className="size-3.5 text-muted-foreground" />
  }
}

function isActiveTestStatus(status: EditorTest['status'] | null | undefined): boolean {
  return status === 'running' || status === 'cancelling'
}

function isActiveStepStatus(
  status: EditorTest['liveSteps'][number]['status'] | null | undefined,
): boolean {
  return status === 'running' || status === 'cancelling'
}

function isActiveHookStatus(status: LiveHookExecution['status'] | null | undefined): boolean {
  return status === 'running'
}

function hasActiveHooks(hooks: LiveHookExecution[]): boolean {
  return hooks.some((hook) => isActiveHookStatus(hook.status))
}

function hasActiveLiveTest(test: EditorTest): boolean {
  return isActiveTestStatus(test.status)
    || test.runningStepIndex !== null
    || test.liveSteps.some((step) => isActiveStepStatus(step.status))
    || hasActiveHooks(test.perTestSetupHooks)
    || hasActiveHooks(test.perTestTeardownHooks)
}

function LiveHookList({
  title,
  hooks,
  selection,
  onSelect,
}: {
  title: string
  hooks: LiveHookExecution[]
  selection: Selection | null | undefined
  onSelect?: (selection: Selection | null) => void
}) {
  if (hooks.length === 0) return null
  return (
    <div className="space-y-1">
      <div className="text-[10px] uppercase tracking-wider font-medium text-muted-foreground">
        {title}
      </div>
      <ul className="space-y-1">
        {hooks.map((hook) => {
          const isSelected = selection?.type === 'suite-hook' && selection.hookId === hook.id
          return (
            <li key={hook.id}>
              <button
                type="button"
                onClick={() => onSelect?.({ type: 'suite-hook', phase: hook.phase, hookId: hook.id })}
                className={cn(
                  'relative flex w-full items-center gap-2 overflow-hidden rounded-md border px-3 py-1.5 text-left transition-colors',
                  hook.status === 'running'
                    ? 'live-running-surface border-border/60 bg-primary/5'
                    : isSelected
                      ? 'border-primary/20 bg-primary/10 ring-1 ring-primary/30'
                      : 'border-border/60 bg-card/40 hover:bg-card/60',
                )}
              >
                <HookStatusIcon status={hook.status} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm">{hook.name}</div>
                  <div className="truncate font-mono text-[11px] text-muted-foreground">
                    {hook.id}
                  </div>
                </div>
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

export function SuiteVisualBuilder({
  content,
  onChange,
  disabled = false,
  suggestions,
  isCreateMode = false,
  liveMode = false,
  liveTests = [],
  liveSetupHooks = [],
  liveTeardownHooks = [],
  runningTestIndex = null,
  canRunTest = true,
  canRunAll = false,
  isRunningAll = false,
  isStoppingRunAll = false,
  onRunTest,
  onCancelTest,
  onRunAll,
  onStopAll,
  onRunLiveHook: _onRunLiveHook,
  setupHooksStale = false,
  onRestartSession,
  selection = null,
  onSelect,
}: SuiteVisualBuilderProps) {
  const lastValidRef = useRef<SuiteFormState | null>(null)
  const { hooks: hookSuggestions, warningCopy } = useTestHookCatalog()
  const hookCatalogEntries = hookSuggestions ?? []
  const hookLabels = useMemo(
    () => Object.fromEntries(hookCatalogEntries.map((hook) => [hook.id, hook.name])),
    [hookCatalogEntries],
  )
  const [availableTests, setAvailableTests] = useState<TestFileInfo[]>([])
  const [showTestPicker, setShowTestPicker] = useState<boolean>(false)

  useEffect(() => {
    fetchTestFiles()
      .then((d) => setAvailableTests(d.files))
      .catch(() => {})
  }, [])

  // Close the picker on Escape while it's visible (Gap 3 UAT requirement)
  useEffect(() => {
    if (!showTestPicker) return
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setShowTestPicker(false)
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [showTestPicker])

  const formState = suiteYamlToFormState(content)
  const yamlError = formState === null
  const display = formState ?? lastValidRef.current
  if (formState) lastValidRef.current = formState

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const handleMetadataChange = useCallback(
    (field: string, value: string | string[]) => {
      onChange(updateSuiteField(content, [field], value))
    },
    [content, onChange],
  )

  const handleAddTest = useCallback(
    (entry: SuiteTestEntry) => {
      onChange(addSuiteTest(content, entry))
    },
    [content, onChange],
  )

  const handleRemoveTest = useCallback(
    (index: number) => {
      onChange(removeSuiteTest(content, index))
    },
    [content, onChange],
  )

  const testIds = display?.tests.map((_, i) => `test-${i}`) ?? []
  const runAllLocked = liveMode && (isRunningAll || isStoppingRunAll)
  const hasActiveSuiteExecution = liveMode && (
    runningTestIndex !== null
    || liveTests.some((test) => hasActiveLiveTest(test))
    || hasActiveHooks(liveSetupHooks)
    || hasActiveHooks(liveTeardownHooks)
  )
  const queueReorderLocked = runAllLocked || hasActiveSuiteExecution
  const queueActionLocked = runAllLocked
  const hookControlsDisabled = disabled || yamlError || queueReorderLocked

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      if (disabled || yamlError || queueReorderLocked) return
      const { active, over } = event
      if (!over || active.id === over.id) return
      const oldIndex = parseInt(String(active.id).replace('test-', ''), 10)
      const newIndex = parseInt(String(over.id).replace('test-', ''), 10)
      if (Number.isNaN(oldIndex) || Number.isNaN(newIndex)) return
      const reorderedYaml = reorderSuiteTests(content, oldIndex, newIndex)
      if (reorderedYaml !== content) onChange(reorderedYaml)
    },
    [content, disabled, onChange, queueReorderLocked, yamlError],
  )

  return (
    <div className="flex flex-col">
      <div className="space-y-4 p-4">
        {yamlError && (
          <div className="flex items-center gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
            <AlertCircle className="size-4 shrink-0" />
            <span>YAML has errors — builder shows last valid state</span>
          </div>
        )}

        {liveMode && setupHooksStale && (
          <div className="flex flex-wrap items-start justify-between gap-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
            <div className="flex min-w-0 flex-1 items-start gap-2">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <span>Setup hooks changed — restart session to re-apply the latest setup and teardown hooks.</span>
            </div>
            {onRestartSession && (
              <Button type="button" size="sm" className="shrink-0" onClick={onRestartSession}>
                Restart Live Session
              </Button>
            )}
          </div>
        )}

        {display ? (
          <>
            <SuiteMetadataForm
              name={display.name}
              suiteId={display.suiteId}
              target={display.target}
              context={display.context}
              isCreateMode={isCreateMode}
              suggestions={suggestions}
              hookLabels={hookLabels}
              onChange={handleMetadataChange}
              disabled={disabled || yamlError}
            />

            {liveMode && (
              <LiveHookList
                title="Setup Hooks (Live)"
                hooks={liveSetupHooks}
                selection={selection}
                onSelect={onSelect}
              />
            )}

            <div className="space-y-3 rounded-md border bg-card/20 p-3">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <Webhook className="size-4 text-muted-foreground" />
                  <span className="text-xs font-medium text-muted-foreground">Hooks</span>
                </div>
                <span className="text-[10px] text-muted-foreground/50">
                  {display.setup.length + display.teardown.length}{' '}
                  {display.setup.length + display.teardown.length === 1 ? 'hook' : 'hooks'}
                </span>
              </div>
              {warningCopy && (
                <div className="flex gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                  <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
                  <div className="space-y-0.5">
                    <p className="font-medium">{warningCopy.title}</p>
                    <p>{warningCopy.body}</p>
                  </div>
                </div>
              )}
              <div className="space-y-3">
                <p className="text-[11px] text-muted-foreground">
                  Search hook names or paste an h_ ID. Saved as stable ID in YAML. Inline runHook uses the stable hook ID.
                </p>
                <TestHookListField
                  phase="setup"
                  label="Setup"
                  values={display.setup}
                  suggestions={hookCatalogEntries}
                  disabled={hookControlsDisabled}
                  placeholder="Search hook names or paste an h_ ID"
                  onChange={(values) => handleMetadataChange('setup', values)}
                />
                <TestHookListField
                  phase="teardown"
                  label="Teardown"
                  values={display.teardown}
                  suggestions={hookCatalogEntries}
                  disabled={hookControlsDisabled}
                  placeholder="Search hook names or paste an h_ ID"
                  onChange={(values) => handleMetadataChange('teardown', values)}
                />
              </div>
            </div>

            {liveMode && (
              <LiveHookList
                title="Teardown Hooks (Live)"
                hooks={liveTeardownHooks}
                selection={selection}
                onSelect={onSelect}
              />
            )}

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground flex items-center gap-1">
                  Tests in Suite{' '}
                  <InfoTip text="Tests run in the order shown. Drag to reorder. The suite fails fast if any referenced test is missing at save." />
                </span>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-muted-foreground/50">
                    {display.tests.length} {display.tests.length === 1 ? 'test' : 'tests'}
                  </span>
                  {liveMode && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={isRunningAll ? onStopAll : onRunAll}
                      disabled={isStoppingRunAll || (!isRunningAll && !canRunAll)}
                    >
                      {isStoppingRunAll ? (
                        <>
                          <Loader2 className="size-3.5 animate-spin" />
                          Stopping...
                        </>
                      ) : isRunningAll ? (
                        <>
                          <Square className="size-3.5" />
                          Stop Run All
                        </>
                      ) : (
                        <>
                          <PlayCircle className="size-3.5" />
                          Run All Tests
                        </>
                      )}
                    </Button>
                  )}
                </div>
              </div>
              {display.tests.length === 0 ? (
                <p className="text-sm text-muted-foreground">No tests added yet. Use the picker below.</p>
              ) : (
                <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                  <SortableContext items={testIds} strategy={verticalListSortingStrategy}>
                    <div className="space-y-1.5">
                      {display.tests.map((entry, i) => {
                        const tf = availableTests.find((t) => t.path === entry.test)
                        const name = tf?.name ?? entry.test.split('/').pop() ?? entry.test
                        const isMissing = availableTests.length > 0 && !tf
                        const liveTest = liveMode ? liveTests[i] : undefined
                        const rowCanRun = liveMode
                          ? canRunTest && runningTestIndex === null && !queueActionLocked
                          : true
                        return (
                          <SuiteTestRow
                            key={`test-${i}`}
                            id={`test-${i}`}
                            name={name}
                            path={entry.test}
                            testId={entry.id}
                            isMissing={isMissing}
                            onRemove={() => handleRemoveTest(i)}
                            disabled={disabled || yamlError}
                            actionsLocked={queueActionLocked}
                            sortableDisabled={queueReorderLocked}
                            liveMode={liveMode}
                            liveStatus={liveTest?.status}
                            liveDuration={liveTest?.duration}
                            liveError={liveTest?.error ?? null}
                            liveSteps={liveTest?.liveSteps ?? []}
                            runningStepIndex={liveTest?.runningStepIndex ?? null}
                            perTestSetupHooks={liveTest?.perTestSetupHooks ?? []}
                            perTestTeardownHooks={liveTest?.perTestTeardownHooks ?? []}
                            canRunTest={rowCanRun}
                            onRunTest={liveMode && onRunTest ? () => onRunTest(i) : undefined}
                            onCancelTest={liveMode && onCancelTest ? () => onCancelTest(i) : undefined}
                            testIndex={i}
                            selection={selection}
                            onSelect={onSelect}
                          />
                        )
                      })}
                    </div>
                  </SortableContext>
                </DndContext>
              )}
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground">Available Tests</span>
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  onClick={() => setShowTestPicker((v) => !v)}
                  disabled={disabled || yamlError || queueActionLocked}
                  aria-expanded={showTestPicker}
                  aria-controls="suite-test-picker-region"
                >
                  <Plus className="size-3" />
                  {showTestPicker ? 'Hide picker' : 'Add new test'}
                </Button>
              </div>
              {showTestPicker && (
                <div id="suite-test-picker-region">
                  <SuiteTestPicker
                    availableTests={availableTests}
                    onAdd={handleAddTest}
                    disabled={disabled || yamlError || queueActionLocked}
                  />
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
            Enter valid YAML to use the visual builder
          </div>
        )}
      </div>
    </div>
  )
}
