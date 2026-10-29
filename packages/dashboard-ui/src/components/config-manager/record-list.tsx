// Delete is one undoable write; focus moves to the next row, else the previous, else Add.

import { useEffect, useId, useRef, useState, type FocusEvent, type ReactNode, type RefObject } from "react"
import { ChevronRight, CircleAlert, Trash2 } from "lucide-react"
import type { ConfigChange } from "@vostride/agent-qa-schema"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useConfigAutosaveContext, type ConfigFieldRef } from "@/hooks/use-config-autosave"
import type { ExplicitActionKind } from "@/lib/config-tabs"
import { cn } from "@/lib/utils"

export type RecordAttr = "target" | "device"

function rowsIn(list: HTMLElement | null, attr: RecordAttr): HTMLElement[] {
  return Array.from(list?.querySelectorAll<HTMLElement>(`[data-${attr}]`) ?? [])
}

function headerOf(row: HTMLElement | undefined): HTMLElement | null {
  return row?.querySelector<HTMLElement>("[data-row-header]") ?? null
}

export function focusRecordRow(list: HTMLElement | null, attr: RecordAttr, name: string): boolean {
  const header = headerOf(rowsIn(list, attr).find((row) => row.getAttribute(`data-${attr}`) === name))
  header?.focus()
  return header !== null
}

interface RecordDeletesOptions {
  kind: Extract<ExplicitActionKind, "delete-target" | "delete-device">
  attr: RecordAttr
  list: RefObject<HTMLElement | null>
  addButton: RefObject<HTMLButtonElement | null>
}

/** Rows being deleted, the delete action itself, and focus after a delete and after its Undo. */
export function useRecordDeletes({ kind, attr, list, addButton }: RecordDeletesOptions) {
  const autosave = useConfigAutosaveContext()
  const [removing, setRemoving] = useState<ReadonlySet<string>>(new Set())
  const restored = autosave.restored
  // An Undo from before this list mounted (a tab change since) never moves focus.
  const seenSeq = useRef(restored?.seq)

  useEffect(() => {
    if (restored === undefined || restored.seq === seenSeq.current) return
    seenSeq.current = restored.seq
    if (restored.kind === kind) focusRecordRow(list.current, attr, restored.name)
  }, [restored, kind, attr, list])

  function focusAfterRemoving(name: string) {
    const rows = rowsIn(list.current, attr)
    const index = rows.findIndex((row) => row.getAttribute(`data-${attr}`) === name)
    const neighbour = headerOf(rows[index + 1]) ?? headerOf(rows[index - 1])
    ;(neighbour ?? addButton.current)?.focus()
  }

  async function remove(name: string, path: ConfigChange["path"]) {
    focusAfterRemoving(name)
    setRemoving((current) => new Set(current).add(name))
    await autosave.runExplicit([{ op: "unset", path }], { kind, name })
    setRemoving((current) => {
      const next = new Set(current)
      next.delete(name)
      return next
    })
  }

  return { removing, remove }
}

/** Focuses a just-added row once the landed write shows it. */
export function useFocusNewRow(list: RefObject<HTMLElement | null>, attr: RecordAttr, names: readonly string[]) {
  const pending = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (pending.current !== undefined && focusRecordRow(list.current, attr, pending.current)) {
      pending.current = undefined
    }
  })
  return (name: string) => {
    pending.current = name
    if (names.includes(name)) focusRecordRow(list.current, attr, name)
  }
}

interface RecordRowProps {
  attr: RecordAttr
  name: string
  summary: string
  open: boolean
  onToggle: () => void
  deleteName: string
  onDelete: () => void
  children: ReactNode
}

export function RecordRow({ attr, name, summary, open, onToggle, deleteName, onDelete, children }: RecordRowProps) {
  const panelId = useId()
  const dataAttr = { [`data-${attr}`]: name } as Record<string, string>
  return (
    <li {...dataAttr}>
      <div className="flex items-start gap-2">
        <button
          type="button"
          data-row-header
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          onClick={onToggle}
          className="grid min-h-12 min-w-0 flex-1 grid-cols-[0.75rem_minmax(0,1fr)] gap-x-2 rounded-sm py-2 text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <span className="flex h-[1lh] items-center text-sm">
            <ChevronRight className={cn("size-3 text-muted-foreground", open && "rotate-90")} aria-hidden="true" />
          </span>
          <span className="min-w-0 space-y-1">
            <span className="block font-mono text-sm font-medium wrap-anywhere">{name}</span>
            <span className="block text-xs text-muted-foreground wrap-anywhere">{summary}</span>
          </span>
        </button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={deleteName}
          className="mt-2 hover:text-destructive"
          onClick={onDelete}
        >
          <Trash2 className="size-3.5" aria-hidden="true" />
        </Button>
      </div>
      {open ? (
        <div id={panelId} className="grid grid-cols-[0.75rem_minmax(0,1fr)] gap-x-2 pb-4">
          <div className="col-start-2 min-w-0 space-y-4">{children}</div>
        </div>
      ) : null}
    </li>
  )
}

function restoreDraft<T extends Record<string, string>>(raw: string, empty: T): T | undefined {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined
    const draft = { ...empty }
    for (const key of Object.keys(empty) as (keyof T)[]) {
      const value = (parsed as Record<string, unknown>)[key as string]
      if (typeof value === "string") draft[key] = value as T[keyof T]
    }
    return draft
  } catch {
    return undefined
  }
}

/**
 * An inline add row held as one page draft on the list's own path: the tab shows its dot and the
 * status says Not saved while it is open, and a reload reopens it with what was typed. Only the
 * row's own write (runExplicit carrying `ref`) or Discard clears it.
 */
export function useHeldDraft<T extends Record<string, string>>(ref: ConfigFieldRef, empty: T) {
  const autosave = useConfigAutosaveContext()
  const raw = autosave.stateOf(ref) === "clean" ? undefined : autosave.valueOf(ref)
  const restored = typeof raw === "string" ? restoreDraft(raw, empty) : undefined
  return {
    restored,
    hold: (draft: T) => autosave.hold(ref, JSON.stringify(draft)),
    discard: () => autosave.discard(ref),
  }
}

/** True when focus is leaving `container` for somewhere outside it (a select's list counts as inside). */
export function leavesGroup(event: FocusEvent<HTMLElement>): boolean {
  const next = event.relatedTarget
  if (!(next instanceof Element)) return true
  return !event.currentTarget.contains(next) && next.closest("[data-radix-popper-content-wrapper]") === null
}

interface DraftTextFieldProps {
  id: string
  name: string
  label: string
  value: string
  onChange: (value: string) => void
  onEnter: () => void
  error?: string
  placeholder?: string
  mono?: boolean
  autoFocus?: boolean
}

/** One text field of an add row: the ConfigField look, held in the row's own draft. */
export function DraftTextField({ id, name, label, value, onChange, onEnter, error, placeholder, mono, autoFocus }: DraftTextFieldProps) {
  const errorId = `${id}-error`
  return (
    <div data-draft-field={name} className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        name={name}
        type="text"
        autoComplete="off"
        autoFocus={autoFocus}
        className={cn("w-full max-w-md", mono && "font-mono")}
        placeholder={placeholder}
        value={value}
        aria-invalid={error === undefined ? undefined : true}
        aria-describedby={error === undefined ? undefined : errorId}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault()
            onEnter()
          }
        }}
      />
      {error === undefined ? null : (
        <p id={errorId} data-field-error className="flex items-start gap-1 text-xs text-destructive break-words">
          <span className="flex h-[1lh] shrink-0 items-center">
            <CircleAlert className="size-3" aria-hidden="true" />
          </span>
          {error}
        </p>
      )}
    </div>
  )
}

/** The row's open/closed state, kept per name. */
export function useOpenRows() {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set())
  return {
    isOpen: (name: string) => open.has(name),
    toggle: (name: string) =>
      setOpen((current) => {
        const next = new Set(current)
        if (next.has(name)) next.delete(name)
        else next.add(name)
        return next
      }),
  }
}
