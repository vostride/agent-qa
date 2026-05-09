import { useRef, useEffect, useCallback, useMemo, useState } from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import {
  GripVertical,
  X,
  SlidersHorizontal,
  Loader2,
  Play,
  Square,
  CheckCircle2,
  AlertTriangle,
  CircleDashed,
} from 'lucide-react'
import {
  AlertDialog,
  AlertDialogTrigger,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { StepPillPreview, hasTemplateVars } from '@/components/step-pill-preview'
import { useStepAutocomplete } from '@/components/step-autocomplete'
import type { VariableSuggestion } from '@/hooks/use-variable-suggestions'
import type { SubActionData } from '@/lib/api'
import type { StepOverrides } from '@/lib/test-yaml-serializer'
import { cn } from '@/lib/utils'

export type StepCardLiveStatus =
  | 'idle'
  | 'running'
  | 'cancelling'
  | 'passed'
  | 'failed'
  | 'cancelled'

interface StepCardEditorProps {
  id: string
  index: number
  value: string
  overrides: StepOverrides
  onChange: (index: number, newValue: string) => void
  onOverrideChange: (index: number, field: string, value: unknown) => void
  onDelete: (index: number) => void
  disabled?: boolean
  liveStatus?: StepCardLiveStatus
  showLiveControls?: boolean
  canRunLiveStep?: boolean
  onRunLiveStep?: (index: number) => void
  onCancelLiveStep?: (index: number) => void
  stepError?: string
  isSettingsOpen?: boolean
  onToggleSettings?: (stepId: string) => void
  isSelected?: boolean
  onSelectStep?: (stepId: string) => void
  subActions?: SubActionData[] | null
  selectedSubActionIndex?: number | null
  onSelectSubAction?: (stepId: string, subIndex: number) => void
  suggestions?: VariableSuggestion[]
  hookLabels?: Record<string, string>
}

const LIVE_STATUS_META: Record<Exclude<StepCardLiveStatus, 'idle'>, { label: string; badgeClass: string; cardClass: string }> = {
  running: {
    label: 'Running',
    badgeClass: 'border-primary/30 bg-primary/10 text-primary',
    cardClass: 'live-running-surface border-border/60 bg-primary/5',
  },
  cancelling: {
    label: 'Cancelling',
    badgeClass: 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400',
    cardClass: 'border-amber-500/30 bg-amber-500/5',
  },
  passed: {
    label: 'Passed',
    badgeClass: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
    cardClass: 'border-emerald-500/25 bg-emerald-500/[0.03]',
  },
  failed: {
    label: 'Failed',
    badgeClass: 'border-destructive/30 bg-destructive/10 text-destructive',
    cardClass: 'border-destructive/25 bg-destructive/[0.03]',
  },
  cancelled: {
    label: 'Cancelled',
    badgeClass: 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400',
    cardClass: 'border-amber-500/25 bg-amber-500/[0.03]',
  },
}

function formatOverrideSummary(overrides: StepOverrides): string | null {
  const parts: string[] = []
  if (overrides.timeout) parts.push(`TIMEOUT: ${overrides.timeout.toUpperCase()}`)
  if (overrides.retries != null) parts.push(`RETRIES: ${overrides.retries}`)
  if (overrides.screenshot != null) parts.push(`SCREENSHOT: ${overrides.screenshot ? 'ON' : 'OFF'}`)
  if (overrides.maxAttempts != null) parts.push(`MAX ATTEMPTS: ${overrides.maxAttempts}`)
  return parts.length > 0 ? parts.join(' · ') : null
}

function isInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return Boolean(target.closest('button, textarea, input, select, label, [role="switch"]'))
}

function SubActionStatusIcon({ result }: { result: SubActionData['result'] }) {
  switch (result) {
    case 'success':
      return <CheckCircle2 className="size-3.5 text-emerald-500" />
    case 'failure':
      return <AlertTriangle className="size-3.5 text-destructive" />
    default:
      return <CircleDashed className="size-3.5 text-muted-foreground" />
  }
}

function LiveStatusIcon({ status }: { status: Exclude<StepCardLiveStatus, 'idle'> }) {
  switch (status) {
    case 'running':
      return <Loader2 className="size-3.5 animate-spin text-primary" />
    case 'cancelling':
      return <Loader2 className="size-3.5 animate-spin text-amber-500" />
    case 'passed':
      return <CheckCircle2 className="size-3.5 text-emerald-500" />
    case 'failed':
      return <AlertTriangle className="size-3.5 text-destructive" />
    case 'cancelled':
      return <CircleDashed className="size-3.5 text-amber-500" />
  }
}

function formatSubActionLabel(subAction: SubActionData): string {
  if (!subAction.plannedAction) return `Sub-action ${subAction.index + 1}`

  try {
    const parsed = typeof subAction.plannedAction === 'string'
      ? JSON.parse(subAction.plannedAction)
      : subAction.plannedAction

    if (parsed && typeof parsed === 'object') {
      const type = (parsed as Record<string, string>).type || (parsed as Record<string, string>).action || ''
      const target = (parsed as Record<string, string>).target || (parsed as Record<string, string>).selector || (parsed as Record<string, string>).ref || ''
      const label = [type, target].filter(Boolean).join(' ')
      if (label) return label
    }
  } catch {
    if (typeof subAction.plannedAction === 'string') {
      return subAction.plannedAction
    }
  }

  return `Sub-action ${subAction.index + 1}`
}

export function StepCardEditor({
  id,
  index,
  value,
  overrides,
  onChange,
  onOverrideChange,
  onDelete,
  disabled = false,
  liveStatus = 'idle',
  showLiveControls = false,
  canRunLiveStep = false,
  onRunLiveStep,
  onCancelLiveStep,
  stepError,
  isSettingsOpen = false,
  onToggleSettings,
  isSelected = false,
  onSelectStep,
  subActions,
  selectedSubActionIndex = null,
  onSelectSubAction,
  suggestions = [],
  hookLabels = {},
}: StepCardEditorProps) {
  const isExecutingLiveStep = liveStatus === 'running' || liveStatus === 'cancelling'
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id, disabled: disabled || isExecutingLiveStep })

  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [cursorPos, setCursorPos] = useState(0)

  const handleAutocompleteInsert = useCallback((fullSyntax: string, startPos: number, endPos: number) => {
    const newValue = value.slice(0, startPos) + fullSyntax + value.slice(endPos)
    onChange(index, newValue)
    requestAnimationFrame(() => {
      const el = textareaRef.current
      if (el) {
        const newCursorPos = startPos + fullSyntax.length
        el.selectionStart = newCursorPos
        el.selectionEnd = newCursorPos
        el.focus()
      }
    })
  }, [value, onChange, index])

  const autocomplete = useStepAutocomplete({
    text: value,
    cursorPos,
    suggestions,
    anchorRef: textareaRef,
    onInsert: handleAutocompleteInsert,
  })
  const suggestionHookLabels = useMemo(
    () => Object.fromEntries(
      suggestions
        .filter((suggestion) => suggestion.namespace === 'runHook' && suggestion.insertValue)
        .map((suggestion) => [suggestion.insertValue as string, suggestion.name]),
    ),
    [suggestions],
  )
  const resolvedHookLabels = useMemo(
    () => ({ ...hookLabels, ...suggestionHookLabels }),
    [hookLabels, suggestionHookLabels],
  )

  const summary = formatOverrideSummary(overrides)
  const hasOverrides = summary !== null
  const liveMeta = liveStatus === 'idle' ? null : LIVE_STATUS_META[liveStatus]
  const utilityActionsVisible = isSelected || isSettingsOpen || isExecutingLiveStep

  const autoResize = useCallback(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = '0'
    el.style.height = `${el.scrollHeight}px`
  }, [])

  useEffect(() => { autoResize() }, [value, autoResize])

  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    const ro = new ResizeObserver(() => autoResize())
    ro.observe(el.parentElement ?? el)
    return () => ro.disconnect()
  }, [autoResize])

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 10 : undefined,
  } as const

  const handleSelectStep = useCallback((target: EventTarget | null) => {
    if (!onSelectStep || isInteractiveTarget(target)) return
    onSelectStep(id)
  }, [id, onSelectStep])

  return (
    <div
      ref={setNodeRef}
      style={style}
      onClick={(event) => handleSelectStep(event.target)}
      className={cn(
        'group/step relative overflow-hidden rounded-md border bg-card/60 transition-colors',
        'hover:bg-card',
        isDragging && 'shadow-lg ring-2 ring-primary/20',
        liveMeta?.cardClass,
        isSelected && 'ring-2 ring-primary/35 ring-offset-1 ring-offset-background bg-primary/[0.04]',
        disabled && 'pointer-events-none opacity-60',
      )}
    >
      <div className="flex items-start gap-2 px-3 py-2">
        <button
          type="button"
          className="mt-0.5 flex shrink-0 items-center p-0.5 text-muted-foreground/40 hover:text-muted-foreground cursor-grab active:cursor-grabbing touch-none disabled:cursor-not-allowed"
          aria-label={`Reorder step ${index + 1}`}
          disabled={disabled || isExecutingLiveStep}
          {...attributes}
          {...listeners}
        >
          <GripVertical className="size-3.5" />
        </button>

        <span className="mt-[3px] shrink-0 text-[11px] tabular-nums text-muted-foreground/50">
          #{index + 1}
        </span>

        <div className="min-w-0 flex-1 space-y-1">
          {liveStatus !== 'idle' && liveMeta && (
            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <LiveStatusIcon status={liveStatus} />
              <span className="font-medium">{liveMeta.label}</span>
            </div>
          )}
          <div className="relative">
            <textarea
              ref={textareaRef}
              value={value}
              onChange={(event) => {
                onChange(index, event.target.value)
                setCursorPos(event.target.selectionStart ?? 0)
                autoResize()
              }}
              onKeyDown={(event) => {
                if (autocomplete.handleKeyDown(event)) return
              }}
              onBlur={() => { setTimeout(() => autocomplete.setVisible(false), 150) }}
              placeholder="Describe what this step should do..."
              disabled={disabled || isExecutingLiveStep}
              rows={1}
              className="min-w-0 w-full resize-none overflow-hidden border-none bg-transparent p-0 text-sm text-foreground outline-none placeholder:text-muted-foreground/40"
              aria-haspopup={autocomplete.visible ? 'listbox' : undefined}
              aria-expanded={autocomplete.visible || undefined}
            />
            {autocomplete.dropdown}
          </div>
          {hasTemplateVars(value) && <StepPillPreview text={value} hookLabels={resolvedHookLabels} />}

          {(hasOverrides || isSettingsOpen) && (
            <div className="flex min-w-0 items-center gap-1 text-muted-foreground/70">
              <SlidersHorizontal className="size-3 shrink-0" />
              <span className="truncate text-[11px] font-mono uppercase tracking-wide">
                {summary ?? 'Step settings open'}
              </span>
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-start gap-2">
          <div
            className={cn(
              'mt-0.5 flex shrink-0 items-center gap-1 transition-opacity',
              utilityActionsVisible
                ? 'opacity-100'
                : 'opacity-0 pointer-events-none group-hover/step:pointer-events-auto group-hover/step:opacity-100 group-focus-within/step:pointer-events-auto group-focus-within/step:opacity-100',
            )}
          >
            {showLiveControls && (
              isExecutingLiveStep ? (
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  onClick={() => onCancelLiveStep?.(index)}
                  disabled={disabled || !onCancelLiveStep}
                >
                  {liveStatus === 'cancelling' ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    <Square className="size-3" />
                  )}
                  Cancel
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  onClick={() => onRunLiveStep?.(index)}
                  disabled={disabled || !canRunLiveStep || !onRunLiveStep}
                >
                  <Play className="size-3" />
                  Run
                </Button>
              )
            )}
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => onToggleSettings?.(id)}
              disabled={disabled}
              className={cn(
                "shrink-0 text-muted-foreground/70 hover:text-foreground",
                isSettingsOpen && "bg-muted/60 text-foreground",
              )}
              aria-label={`Open settings for step ${index + 1}`}
              title="Step settings"
            >
              <SlidersHorizontal className="size-3.5" />
            </Button>

            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  disabled={disabled || isExecutingLiveStep}
                  aria-label={`Delete step ${index + 1}`}
                  title="Delete step"
                  className="text-muted-foreground/70 hover:text-destructive"
                >
                  <X className="size-3.5" />
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent size="sm">
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete step?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Step #{index + 1} will be removed. This cannot be undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction variant="destructive" onClick={() => onDelete(index)}>
                    Delete
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </div>
      </div>

      {isSettingsOpen && (
        <div className="border-t px-3 py-3">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor={`step-${index}-timeout`} className="text-[11px] text-muted-foreground">
                Timeout
              </Label>
              <Input
                id={`step-${index}-timeout`}
                value={overrides.timeout ?? ''}
                onChange={(event) => onOverrideChange(index, 'timeout', event.target.value || undefined)}
                placeholder="e.g. 30s"
                disabled={disabled}
                className="h-8 text-xs"
              />
            </div>

            <div className="space-y-1">
              <Label htmlFor={`step-${index}-retries`} className="text-[11px] text-muted-foreground">
                Retries
              </Label>
              <Input
                id={`step-${index}-retries`}
                type="number"
                min={0}
                value={overrides.retries ?? ''}
                onChange={(event) => onOverrideChange(index, 'retries', event.target.value ? Number(event.target.value) : undefined)}
                placeholder="0"
                disabled={disabled}
                className="h-8 text-xs"
              />
            </div>

            <div className="space-y-1">
              <Label htmlFor={`step-${index}-maxAttempts`} className="text-[11px] text-muted-foreground">
                Max Attempts
              </Label>
              <Input
                id={`step-${index}-maxAttempts`}
                type="number"
                min={1}
                value={overrides.maxAttempts ?? ''}
                onChange={(event) => onOverrideChange(index, 'maxAttempts', event.target.value ? Number(event.target.value) : undefined)}
                placeholder="1"
                disabled={disabled}
                className="h-8 text-xs"
              />
            </div>

            <div className="space-y-1">
              <Label className="text-[11px] text-muted-foreground">
                Screenshot
              </Label>
              <div className="flex h-8 items-center">
                <Switch
                  checked={overrides.screenshot ?? false}
                  onCheckedChange={(checked) => onOverrideChange(index, 'screenshot', checked ? true : undefined)}
                  disabled={disabled}
                />
              </div>
            </div>
          </div>
        </div>
      )}

      {subActions && subActions.length > 0 && (
        <div className="border-t px-3 py-2">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Sub-actions
            </span>
            <Badge variant="outline" className="text-[10px]">
              {subActions.length}
            </Badge>
          </div>
          <div className="space-y-1">
            {subActions.map((subAction, subIndex) => (
              <button
                key={`${id}-sub-${subIndex}`}
                type="button"
                onClick={() => onSelectSubAction?.(id, subIndex)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-md border px-2.5 py-2 text-left text-xs transition-colors',
                  selectedSubActionIndex === subIndex
                    ? 'border-primary/40 bg-primary/10 text-foreground'
                    : 'border-border/60 bg-background/70 text-muted-foreground hover:border-border hover:text-foreground',
                )}
              >
                <SubActionStatusIcon result={subAction.result} />
                <span className="shrink-0 text-[11px] text-muted-foreground">
                  #{subIndex + 1}
                </span>
                <span className="min-w-0 flex-1 truncate">
                  {formatSubActionLabel(subAction)}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {liveStatus === 'failed' && (
        <div className="border-t px-3 py-2 text-xs text-destructive">
          {stepError || 'Step failed. Select the step to inspect reasoning, env, network, or console output.'}
        </div>
      )}
    </div>
  )
}
