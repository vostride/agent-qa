import { useRef, useCallback, useMemo } from 'react'
import { AlertCircle, Plus, Info, Webhook, CircleDashed, CheckCircle2, AlertTriangle, Play } from 'lucide-react'
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
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { StepCardEditor } from '@/components/step-card-editor'
import type { StepCardLiveStatus } from '@/components/step-card-editor'
import { TestHookListField } from '@/components/test-hook-token-field'
import { useTestHookCatalog } from '@/components/test-hooks-form'
import type { EditorStep, LiveHookExecution } from '@/hooks/use-live-editor'
import type { VariableSuggestion } from '@/hooks/use-variable-suggestions'
import type { Selection } from '@/lib/selection'
import { TestMetadataForm } from '@/components/test-metadata-form'
import {
  yamlToFormState,
  updateYamlField,
  updateYamlStep,
  updateYamlStepOverride,
  deleteYamlStep,
  addYamlStep,
  reorderYamlList,
  type TestFormState,
} from '@/lib/test-yaml-serializer'
import { cn } from '@/lib/utils'

interface VisualBuilderProps {
  content: string
  onChange: (yaml: string) => void
  isCreateMode?: boolean
  disabled?: boolean
  showLiveStepActions?: boolean
  canRunLiveStep?: boolean
  canRunLiveHook?: boolean
  liveEditorSteps?: EditorStep[]
  draftStepIds?: string[]
  liveSetupHooks?: LiveHookExecution[]
  liveTeardownHooks?: LiveHookExecution[]
  onRunLiveStep?: (index: number) => void
  onCancelLiveStep?: (index: number) => void
  onRunLiveHook?: (phase: 'setup' | 'teardown', hookId: string) => void
  openStepSettingsId?: string | null
  onOpenStepSettingsChange?: (stepId: string | null) => void
  selection?: Selection | null
  onSelect?: (selection: Selection | null) => void
  variableSuggestions?: VariableSuggestion[]
}

function HookStatusIcon({ status }: { status: LiveHookExecution['status'] }) {
  switch (status) {
    case 'running':
      return <CircleDashed className="size-3.5 text-primary" />
    case 'passed':
      return <CheckCircle2 className="size-3.5 text-emerald-500" />
    case 'failed':
      return <AlertTriangle className="size-3.5 text-destructive" />
    default:
      return <Webhook className="size-3.5 text-muted-foreground" />
  }
}

function LiveHookSection({
  phase,
  title,
  hooks,
  selection,
  onSelect,
  canRunHook = false,
  onRunHook,
}: {
  phase: 'setup' | 'teardown'
  title: string
  hooks: LiveHookExecution[]
  selection: Selection | null
  onSelect?: (selection: Selection | null) => void
  canRunHook?: boolean
  onRunHook?: (phase: 'setup' | 'teardown', hookId: string) => void
}) {
  if (hooks.length === 0) return null

  return (
    <div data-live-hook-section={phase} className="space-y-1.5">
      <span className="text-xs font-medium text-muted-foreground">{title}</span>
      <div className="space-y-1.5">
        {hooks.map((hook) => (
          <div
            key={hook.id}
            className={cn(
              'relative overflow-hidden flex items-center gap-2 rounded-md border bg-muted/15 px-3 py-2 transition-colors',
              hook.status === 'running'
                ? 'live-running-surface border-border/60 bg-primary/5'
                : selection?.type === 'hook' && selection.hookId === hook.id
                  ? 'border-primary/20 bg-primary/10 ring-1 ring-primary/30'
                  : 'border-border/60 hover:border-border hover:bg-muted/25',
            )}
          >
            <button
              type="button"
              onClick={() => onSelect?.({ type: 'hook', hookId: hook.id })}
              className="flex min-w-0 flex-1 items-center gap-2 text-left"
            >
              <HookStatusIcon status={hook.status} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{hook.name}</div>
                <div className="truncate font-mono text-[11px] text-muted-foreground">
                  {hook.id}
                </div>
                <div className="text-[11px] text-muted-foreground">
                  {hook.status === 'pending'
                    ? 'Waiting for session lifecycle'
                    : hook.status === 'running'
                      ? 'Running hook'
                      : hook.status === 'passed'
                        ? 'Completed'
                        : (hook.error ?? 'Hook failed')}
                </div>
              </div>
            </button>

            {canRunHook && (
              <Button
                type="button"
                variant="outline"
                size="xs"
                className="shrink-0"
                onClick={(event) => {
                  event.stopPropagation()
                  onSelect?.({ type: 'hook', hookId: hook.id })
                  onRunHook?.(hook.phase, hook.id)
                }}
                disabled={hook.status === 'running' || !onRunHook}
              >
                <Play className="size-3" />
                Run
              </Button>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

export function VisualBuilder({
  content,
  onChange,
  isCreateMode,
  disabled = false,
  showLiveStepActions = false,
  canRunLiveStep = false,
  canRunLiveHook = false,
  liveEditorSteps,
  draftStepIds,
  liveSetupHooks,
  liveTeardownHooks,
  onRunLiveStep,
  onCancelLiveStep,
  onRunLiveHook,
  openStepSettingsId,
  onOpenStepSettingsChange,
  selection,
  onSelect,
  variableSuggestions,
}: VisualBuilderProps) {
  const lastValidRef = useRef<TestFormState | null>(null)
  const { hooks, warningCopy } = useTestHookCatalog()
  const hookLabels = useMemo(
    () => Object.fromEntries(hooks.map((hook) => [hook.id, hook.name])),
    [hooks],
  )

  const formState = yamlToFormState(content)
  const yamlError = formState === null
  const display = formState ?? lastValidRef.current

  if (formState) {
    lastValidRef.current = formState
  }

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  )

  const handleMetadataChange = useCallback(
    (field: string, value: string | string[]) => {
      const newYaml = updateYamlField(content, [field], value)
      onChange(newYaml)
    },
    [content, onChange],
  )

  const handleStepChange = useCallback(
    (index: number, newValue: string) => {
      const newYaml = updateYamlStep(content, index, newValue)
      onChange(newYaml)
    },
    [content, onChange],
  )

  const handleStepOverrideChange = useCallback(
    (index: number, field: string, value: unknown) => {
      const newYaml = updateYamlStepOverride(content, index, field, value)
      onChange(newYaml)
    },
    [content, onChange],
  )

  const handleStepDelete = useCallback(
    (index: number) => {
      const newYaml = deleteYamlStep(content, index)
      onChange(newYaml)
    },
    [content, onChange],
  )

  const handleAddStep = useCallback(() => {
    const newYaml = addYamlStep(content)
    onChange(newYaml)
  }, [content, onChange])

  const stepIds = useMemo(
    () => display?.steps.map((_, i) =>
      draftStepIds?.[i]
      ?? liveEditorSteps?.[i]?.id
      ?? `draft-step-${i}`,
    ) ?? [],
    [display?.steps, draftStepIds, liveEditorSteps],
  )

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      if (disabled || yamlError) return
      const { active, over } = event
      if (!over || active.id === over.id) return

      const oldIndex = stepIds.indexOf(String(active.id))
      const newIndex = stepIds.indexOf(String(over.id))

      if (oldIndex === -1 || newIndex === -1) return

      const reorderedYaml = reorderYamlList(content, 'steps', oldIndex, newIndex)
      if (reorderedYaml !== content) {
        onChange(reorderedYaml)
      }
    },
    [content, disabled, onChange, stepIds, yamlError],
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

        {display ? (
          <>
            <TestMetadataForm
              name={display.name}
              testId={display.testId}
              target={display.target}
              context={display.context}
              isCreateMode={isCreateMode ?? false}
              onChange={handleMetadataChange}
              disabled={disabled || yamlError}
            />

            <div className="space-y-3 rounded-md border bg-card/20 p-3">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <Webhook className="size-4 text-muted-foreground" />
                  <span className="text-xs font-medium text-muted-foreground">Hooks</span>
                </div>

                <span className="text-[10px] text-muted-foreground/50">
                  {display.setup.length + display.teardown.length} {display.setup.length + display.teardown.length === 1 ? 'hook' : 'hooks'}
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
                  suggestions={hooks}
                  disabled={disabled || yamlError}
                  placeholder="Search hook names or paste an h_ ID"
                  onChange={(values) => handleMetadataChange('setup', values)}
                />

                <TestHookListField
                  phase="teardown"
                  label="Teardown"
                  values={display.teardown}
                  suggestions={hooks}
                  disabled={disabled || yamlError}
                  placeholder="Search hook names or paste an h_ ID"
                  onChange={(values) => handleMetadataChange('teardown', values)}
                />
              </div>
            </div>

            <div className="space-y-1.5">
              {showLiveStepActions && (
                <LiveHookSection
                  phase="setup"
                  title="Setup Run Status"
                  hooks={liveSetupHooks ?? []}
                  selection={selection ?? null}
                  onSelect={onSelect}
                  canRunHook={false}
                  onRunHook={onRunLiveHook}
                />
              )}

              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground flex items-center gap-1">
                  Steps
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Info className="h-3 w-3 text-muted-foreground/40 hover:text-muted-foreground/70 transition-colors cursor-help" />
                    </TooltipTrigger>
                    <TooltipContent className="max-w-[250px] text-[13px]">
                      Plain-English instructions the AI agent executes in order. Each step is interpreted and acted upon independently.
                    </TooltipContent>
                  </Tooltip>
                </span>
                <span className="text-[10px] text-muted-foreground/50">
                  {display.steps.length} {display.steps.length === 1 ? 'step' : 'steps'}
                </span>
              </div>

              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragEnd={handleDragEnd}
              >
                <SortableContext
                  items={stepIds}
                  strategy={verticalListSortingStrategy}
                >
                  <div className="space-y-1.5">
                    {display.steps.map((step, i) => (
                      (() => {
                        const liveStep = liveEditorSteps?.[i]
                        const stepId = stepIds[i] ?? liveStep?.id ?? `draft-step-${i}`
                        const selectedSubActionIndex = selection?.type === 'subaction' && selection.stepId === stepId
                          ? selection.subIndex
                          : null
                        const isSelected = selection?.type === 'step'
                          ? selection.stepId === stepId
                          : selection?.type === 'subaction'
                            ? selection.stepId === stepId
                            : false
                        const liveStatus: StepCardLiveStatus = liveStep?.status ?? 'idle'

                        return (
                          <StepCardEditor
                            key={stepId}
                            id={stepId}
                            index={i}
                            value={step.text}
                            overrides={step.overrides}
                            onChange={handleStepChange}
                            onOverrideChange={handleStepOverrideChange}
                            onDelete={handleStepDelete}
                            disabled={disabled || yamlError}
                            liveStatus={liveStatus}
                            showLiveControls={showLiveStepActions}
                            canRunLiveStep={canRunLiveStep && !!step.text.trim()}
                            onRunLiveStep={onRunLiveStep}
                            onCancelLiveStep={onCancelLiveStep}
                            stepError={liveStep?.error}
                            isSettingsOpen={openStepSettingsId === stepId}
                            onToggleSettings={(nextStepId) =>
                              onOpenStepSettingsChange?.(
                                openStepSettingsId === nextStepId ? null : nextStepId,
                              )
                            }
                            isSelected={isSelected}
                            onSelectStep={(selectedStepId) => onSelect?.({ type: 'step', stepId: selectedStepId })}
                            subActions={liveStep?.subActionsData ?? null}
                            selectedSubActionIndex={selectedSubActionIndex}
                            onSelectSubAction={(selectedStepId, subIndex) =>
                              onSelect?.({ type: 'subaction', stepId: selectedStepId, subIndex })
                            }
                            suggestions={variableSuggestions}
                            hookLabels={hookLabels}
                          />
                        )
                      })()
                    ))}
                  </div>
                </SortableContext>
              </DndContext>

              <Button
                variant="outline"
                size="sm"
                className="w-full mt-2 text-xs"
                onClick={handleAddStep}
                disabled={disabled || yamlError}
              >
                <Plus className="size-3.5" />
                Add Step
              </Button>

              {showLiveStepActions && (
                <LiveHookSection
                  phase="teardown"
                  title="Teardown Run Status"
                  hooks={liveTeardownHooks ?? []}
                  selection={selection ?? null}
                  onSelect={onSelect}
                  canRunHook={canRunLiveHook}
                  onRunHook={onRunLiveHook}
                />
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
