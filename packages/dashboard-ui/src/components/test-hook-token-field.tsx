import { useEffect, useMemo, useRef, useState } from 'react'
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
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { GripVertical, Plus, X } from 'lucide-react'

import type { HookCatalogEntry } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'

type HookPhase = 'setup' | 'teardown'

interface TestHookListFieldProps {
  phase: HookPhase
  label: string
  values: string[]
  suggestions: HookCatalogEntry[]
  onChange: (nextValues: string[]) => void
  disabled?: boolean
  placeholder?: string
}

interface SortableHookRowProps {
  id: string
  value: string
  hook: HookCatalogEntry | null
  isKnown: boolean
  disabled: boolean
  onRemove: () => void
}

const CANONICAL_HOOK_ID_RE = /^h_[a-z0-9]+(?:-[a-z0-9]+){9}$/

function splitHookValues(raw: string): string[] {
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
}

function getEmptyStateLabel(phase: HookPhase): string {
  return phase === 'setup' ? 'No setup hooks' : 'No teardown hooks'
}

function buildHookId(phase: HookPhase, value: string): string {
  return `${phase}:${value}`
}

function SortableHookRow({
  id,
  value,
  hook,
  isKnown,
  disabled,
  onRemove,
}: SortableHookRowProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id, disabled })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.55 : 1,
    zIndex: isDragging ? 10 : undefined,
  } as const

  const displayName = hook?.name ?? value

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        'flex items-start gap-2 rounded-md border bg-card/60 px-3 py-2 transition-colors',
        'hover:bg-card',
        isDragging && 'shadow-lg ring-2 ring-primary/20',
        isKnown
          ? 'border-border/70'
          : 'border-amber-500/30 bg-amber-500/[0.06]',
        disabled && 'opacity-60',
      )}
    >
      <button
        type="button"
        className="mt-0.5 flex shrink-0 items-center p-0.5 text-muted-foreground/40 hover:text-muted-foreground cursor-grab active:cursor-grabbing touch-none disabled:cursor-not-allowed"
        aria-label={`Reorder ${displayName}`}
        disabled={disabled}
        {...attributes}
        {...listeners}
      >
        <GripVertical className="size-3.5" />
      </button>

      <div className="min-w-0 flex-1 space-y-0.5">
        <div
          data-hook-row-name
          className="truncate text-sm font-medium text-foreground"
        >
          {displayName}
        </div>
        <div
          data-hook-row-id
          className="truncate font-mono text-[11px] text-muted-foreground"
        >
          {value}
        </div>
        <div
          className={cn(
            'text-[11px]',
            isKnown
              ? 'text-muted-foreground'
              : 'text-amber-700 dark:text-amber-300',
          )}
        >
          {isKnown ? 'Saved as stable ID' : 'Saved as stable ID - Not found in configured hooks file'}
        </div>
      </div>

      <div className="flex shrink-0 items-center">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground"
          onClick={onRemove}
          disabled={disabled}
          aria-label={`Remove ${displayName}`}
        >
          <X className="size-3.5" />
        </Button>
      </div>
    </div>
  )
}

export function TestHookListField({
  phase,
  label,
  values,
  suggestions,
  onChange,
  disabled = false,
  placeholder = 'Search hook names or paste an h_ ID',
}: TestHookListFieldProps) {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [inputValue, setInputValue] = useState('')
  const [isComposerOpen, setIsComposerOpen] = useState(false)
  const [highlightedIndex, setHighlightedIndex] = useState(0)
  const [composerError, setComposerError] = useState<string | null>(null)

  const suggestionsById = useMemo(
    () => new Map(suggestions.map((suggestion) => [suggestion.id, suggestion])),
    [suggestions],
  )
  const suggestionsByName = useMemo(
    () => new Map(suggestions.map((suggestion) => [suggestion.name.toLowerCase(), suggestion])),
    [suggestions],
  )

  const filteredSuggestions = useMemo(() => {
    const query = inputValue.trim().toLowerCase()
    return suggestions
      .filter((suggestion) => !values.includes(suggestion.id))
      .filter((suggestion) =>
        query.length === 0
        || suggestion.name.toLowerCase().includes(query)
        || suggestion.id.toLowerCase().includes(query),
      )
      .slice(0, 8)
  }, [inputValue, suggestions, values])

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  )

  useEffect(() => {
    if (!isComposerOpen) return
    inputRef.current?.focus()
  }, [isComposerOpen])

  useEffect(() => {
    if (!isComposerOpen) {
      setHighlightedIndex(0)
      return
    }

    if (filteredSuggestions.length === 0) {
      setHighlightedIndex(0)
      return
    }

    setHighlightedIndex((current) => Math.min(current, filteredSuggestions.length - 1))
  }, [filteredSuggestions, isComposerOpen])

  function closeComposer(): void {
    setInputValue('')
    setIsComposerOpen(false)
    setHighlightedIndex(0)
    setComposerError(null)
  }

  function resolveHookToken(token: string): string | null {
    const trimmed = token.trim()
    if (!trimmed) return null
    if (suggestionsById.has(trimmed)) return trimmed

    const byName = suggestionsByName.get(trimmed.toLowerCase())
    if (byName) return byName.id

    if (CANONICAL_HOOK_ID_RE.test(trimmed)) return trimmed
    return null
  }

  function commitValues(raw: string, selectedSuggestion?: HookCatalogEntry): void {
    const nextTokens = splitHookValues(raw)
    if (nextTokens.length === 0) return

    const resolvedTokens = nextTokens.map((token) =>
      nextTokens.length === 1 && selectedSuggestion
        ? selectedSuggestion.id
        : resolveHookToken(token),
    )

    if (resolvedTokens.some((token) => token === null)) {
      setComposerError('Search hook names or paste an h_ ID')
      return
    }

    const existing = new Set(values)
    const additions = resolvedTokens.filter((token): token is string => {
      if (!token || existing.has(token)) return false
      existing.add(token)
      return true
    })

    if (additions.length === 0) {
      setInputValue('')
      setComposerError(null)
      return
    }

    onChange([...values, ...additions])
    closeComposer()
  }

  function removeValue(index: number): void {
    onChange(values.filter((_, valueIndex) => valueIndex !== index))
  }

  function handleDragEnd(event: DragEndEvent): void {
    if (disabled) return

    const { active, over } = event
    if (!over || active.id === over.id) return

    const [activePhase, activeValue] = String(active.id).split(':')
    const [overPhase, overValue] = String(over.id).split(':')

    if (activePhase !== phase || overPhase !== phase) return

    const oldIndex = values.indexOf(activeValue)
    const newIndex = values.indexOf(overValue)

    if (oldIndex === -1 || newIndex === -1 || oldIndex === newIndex) return
    onChange(arrayMove(values, oldIndex, newIndex))
  }

  return (
    <div data-hook-section={phase} className="space-y-2.5">
      <div className="flex items-center justify-between gap-3">
        <Label className="text-xs font-medium text-muted-foreground">{label}</Label>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-muted-foreground/50">
            {values.length} {values.length === 1 ? 'hook' : 'hooks'}
          </span>
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={() => setIsComposerOpen(true)}
            disabled={disabled}
          >
            <Plus className="size-3" />
            Add Hook
          </Button>
        </div>
      </div>

      {values.length === 0 && !isComposerOpen ? (
        <div className="rounded-md border border-dashed bg-background/50 px-3 py-3 text-xs text-muted-foreground">
          {getEmptyStateLabel(phase)}
        </div>
      ) : null}

      {isComposerOpen ? (
        <div className="rounded-md border border-dashed bg-background/60 p-3 ring-1 ring-primary/15">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <input
              ref={inputRef}
              value={inputValue}
              onChange={(event) => {
                setInputValue(event.target.value)
                if (composerError) setComposerError(null)
              }}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown') {
                  event.preventDefault()
                  if (filteredSuggestions.length === 0) return
                  setHighlightedIndex((current) => (current + 1) % filteredSuggestions.length)
                  return
                }

                if (event.key === 'ArrowUp') {
                  event.preventDefault()
                  if (filteredSuggestions.length === 0) return
                  setHighlightedIndex((current) =>
                    current === 0 ? filteredSuggestions.length - 1 : current - 1,
                  )
                  return
                }

                if (event.key === 'Enter' || event.key === ',') {
                  event.preventDefault()
                  const highlightedSuggestion = filteredSuggestions[highlightedIndex]
                  commitValues(inputValue, highlightedSuggestion)
                  return
                }

                if (event.key === 'Escape') {
                  event.preventDefault()
                  closeComposer()
                }
              }}
              placeholder={placeholder}
              disabled={disabled}
              className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/60 disabled:cursor-not-allowed"
            />

            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                const highlightedSuggestion = filteredSuggestions[highlightedIndex]
                commitValues(inputValue, highlightedSuggestion)
              }}
              disabled={disabled || (inputValue.trim().length === 0 && filteredSuggestions.length === 0)}
            >
              <Plus className="size-3.5" />
              Add Hook
            </Button>
          </div>

          {composerError && (
            <div className="mt-2 text-xs text-amber-700 dark:text-amber-300">
              {composerError}
            </div>
          )}

          <div className="mt-2 rounded-md border bg-popover shadow-sm">
            {filteredSuggestions.length > 0 ? (
              <div className="max-h-48 overflow-y-auto p-1">
                {filteredSuggestions.map((suggestion, index) => (
                  <Button
                    key={suggestion.id}
                    type="button"
                    variant="ghost"
                    size="sm"
                    className={cn(
                      'w-full justify-start text-xs',
                      index === highlightedIndex && 'bg-accent text-accent-foreground',
                    )}
                    onMouseDown={(event) => {
                      event.preventDefault()
                      commitValues(suggestion.name, suggestion)
                    }}
                    onMouseEnter={() => setHighlightedIndex(index)}
                  >
                    <div className="min-w-0 text-left">
                      <div className="truncate font-medium">{suggestion.name}</div>
                      <div className="truncate font-mono text-[11px] text-muted-foreground">
                        {suggestion.id}
                      </div>
                    </div>
                  </Button>
                ))}
              </div>
            ) : (
              <div className="px-3 py-2 text-xs text-muted-foreground">
                {inputValue.trim()
                  ? 'Search hook names or paste an h_ ID'
                  : 'No matching hooks.'}
              </div>
            )}
          </div>
        </div>
      ) : null}

      {values.length > 0 ? (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={values.map((value) => buildHookId(phase, value))}
            strategy={verticalListSortingStrategy}
          >
            <div className="space-y-1.5">
              {values.map((value, index) => (
                <SortableHookRow
                  key={buildHookId(phase, value)}
                  id={buildHookId(phase, value)}
                  value={value}
                  hook={suggestionsById.get(value) ?? null}
                  isKnown={suggestionsById.has(value)}
                  disabled={disabled}
                  onRemove={() => removeValue(index)}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      ) : null}
    </div>
  )
}
