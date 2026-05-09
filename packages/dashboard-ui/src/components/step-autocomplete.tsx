import { type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { pillBgColor } from '@/components/run-detail/step-name-pills'
import type { VariableSuggestion } from '@/hooks/use-variable-suggestions'
import { cn } from '@/lib/utils'

interface AutocompleteContext {
  active: boolean
  namespace: string | null
  query: string
  startPos: number
}

function getAutocompleteContext(text: string, cursorPos: number): AutocompleteContext | null {
  const before = text.slice(0, cursorPos)
  const nsMatch = before.match(/\{\{(\w+):(\w*)$/)
  if (nsMatch) {
    return {
      active: true,
      namespace: nsMatch[1],
      query: nsMatch[2],
      startPos: cursorPos - nsMatch[0].length,
    }
  }
  const openMatch = before.match(/\{\{(\w*)$/)
  if (openMatch) {
    return {
      active: true,
      namespace: null,
      query: openMatch[1],
      startPos: cursorPos - openMatch[0].length,
    }
  }
  return null
}

function dotColor(namespace: string): string {
  switch (namespace) {
    case 'env': return 'bg-blue-500'
    case 'capture': return 'bg-emerald-500'
    case 'runHook': return 'bg-orange-600'
    case 'runJS': return 'bg-yellow-500'
    case 'hook': return 'bg-orange-500'
    default: return 'bg-accent'
  }
}

interface UseStepAutocompleteOpts {
  text: string
  cursorPos: number
  suggestions: VariableSuggestion[]
  onInsert: (fullSyntax: string, startPos: number, endPos: number) => void
  anchorRef: React.RefObject<HTMLElement | null>
}

interface UseStepAutocompleteResult {
  visible: boolean
  setVisible: (v: boolean) => void
  handleKeyDown: (event: React.KeyboardEvent) => boolean
  dropdown: ReactNode
}

export function useStepAutocomplete({
  text,
  cursorPos,
  suggestions,
  onInsert,
  anchorRef,
}: UseStepAutocompleteOpts): UseStepAutocompleteResult {
  const [visible, setVisible] = useState(false)
  const [highlightedIndex, setHighlightedIndex] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number; width: number }>({ top: 0, left: 0, width: 0 })

  const ctx = useMemo(() => getAutocompleteContext(text, cursorPos), [text, cursorPos])

  useEffect(() => {
    setVisible(ctx !== null && ctx.active)
  }, [ctx])

  const filtered = useMemo(() => {
    if (!ctx) return []
    const q = ctx.query.toLowerCase()
    return suggestions
      .filter((s) => {
        if (ctx.namespace && s.namespace !== ctx.namespace) return false
        return (
          q.length === 0
          || s.name.toLowerCase().includes(q)
          || s.insertValue?.toLowerCase().includes(q)
          || s.description?.toLowerCase().includes(q)
        )
      })
      .slice(0, 12)
  }, [ctx, suggestions])

  useEffect(() => {
    setHighlightedIndex((current) =>
      filtered.length === 0 ? 0 : Math.min(current, filtered.length - 1),
    )
  }, [filtered])

  useEffect(() => {
    const list = listRef.current
    if (!list) return
    const item = list.children[highlightedIndex] as HTMLElement | undefined
    if (item) item.scrollIntoView({ block: 'nearest' })
  }, [highlightedIndex])

  const updatePos = useCallback(() => {
    const el = anchorRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    setPos({ top: rect.bottom + 4, left: rect.left, width: rect.width })
  }, [anchorRef])

  useLayoutEffect(() => {
    if (visible) updatePos()
  }, [visible, updatePos])

  const handleSelect = (suggestion: VariableSuggestion) => {
    if (!ctx) return
    const insertValue = suggestion.insertValue ?? suggestion.name
    const fullSyntax = suggestion.namespace === 'runHook'
      ? `{{runHook:"${insertValue}"}}`
      : `{{${suggestion.namespace}:${insertValue}}}`
    onInsert(fullSyntax, ctx.startPos, cursorPos)
    setVisible(false)
  }

  const handleKeyDown = (event: React.KeyboardEvent): boolean => {
    if (!visible || filtered.length === 0) {
      if (event.key === 'Escape' && visible) {
        event.preventDefault()
        setVisible(false)
        return true
      }
      return false
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setHighlightedIndex((c) => (c + 1) % filtered.length)
      return true
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setHighlightedIndex((c) => (c === 0 ? filtered.length - 1 : c - 1))
      return true
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      const item = filtered[highlightedIndex]
      if (item) handleSelect(item)
      return true
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      setVisible(false)
      return true
    }
    return false
  }

  const dropdown: ReactNode = visible && ctx ? createPortal(
    <div
      className="fixed z-50"
      style={{ top: pos.top, left: pos.left, width: pos.width }}
    >
      <div className="rounded-md border bg-popover shadow-md">
        {filtered.length > 0 ? (
          <div ref={listRef} className="max-h-[200px] overflow-y-auto p-1" role="listbox">
            {filtered.map((suggestion, index) => (
              <button
                key={`${suggestion.namespace}:${suggestion.name}`}
                type="button"
                role="option"
                aria-selected={index === highlightedIndex}
                className={cn(
                  'flex w-full items-center gap-2 rounded-sm px-3 py-2 text-left text-sm cursor-pointer',
                  index === highlightedIndex
                    ? 'bg-accent text-accent-foreground'
                    : 'hover:bg-accent/50',
                )}
                onMouseDown={(event) => {
                  event.preventDefault()
                  handleSelect(suggestion)
                }}
                onMouseEnter={() => setHighlightedIndex(index)}
              >
                <span className={cn('size-2 shrink-0 rounded-full', dotColor(suggestion.namespace))} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm text-foreground">
                    {suggestion.name}
                  </div>
                  {suggestion.namespace === 'runHook' && suggestion.insertValue && (
                    <div className="truncate font-mono text-[11px] text-muted-foreground">
                      {suggestion.insertValue}
                    </div>
                  )}
                </div>
                <span className="ml-auto text-[11px] text-muted-foreground">{suggestion.namespace}</span>
              </button>
            ))}
          </div>
        ) : (
          <div className="px-3 py-2 text-sm italic text-muted-foreground text-center">
            No matches
          </div>
        )}
      </div>
    </div>,
    document.body,
  ) : null

  return { visible, setVisible, handleKeyDown, dropdown }
}
