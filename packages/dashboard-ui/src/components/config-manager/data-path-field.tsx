// Typing never saves: the path is held as a draft and only Apply writes it, once, undoably.

import { useEffect, useRef } from "react"
import { CircleAlert } from "lucide-react"
import type { ConfigChange, ConfigPathSegment } from "@vostride/agent-qa-schema"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  configFieldControlId,
  configFieldKeyOf,
  useConfigAutosaveContext,
  type ConfigFieldRef,
} from "@/hooks/use-config-autosave"
import {
  APPLY_CONSEQUENCES,
  APPLY_LABEL,
  KEEP_CURRENT_PATH_LABEL,
  applyActionName,
  keepPathName,
  type DataPathKey,
} from "@/lib/config-copy"
import type { ConfigTab, ExplicitActionKind } from "@/lib/config-tabs"

export interface DataPathTarget {
  segments: readonly ConfigPathSegment[]
  tab: ConfigTab
  pattern: DataPathKey
}

export interface DataPathFieldProps {
  field: DataPathTarget
  label: string
  explicitKind: Extract<ExplicitActionKind, `change-${string}`>
  help?: string
  placeholder?: string
}

export function DataPathField({ field, label, explicitKind, help, placeholder }: DataPathFieldProps) {
  const autosave = useConfigAutosaveContext()
  const input = useRef<HTMLInputElement>(null)
  const mounted = useRef(false)
  const ref: ConfigFieldRef = { segments: field.segments, tab: field.tab }
  const controlId = configFieldControlId(configFieldKeyOf(field.segments))
  const helpId = `${controlId}-help`
  const consequenceId = `${controlId}-consequence`
  const errorId = `${controlId}-error`
  const value = autosave.valueOf(ref)
  const text = typeof value === "string" ? value : ""
  const fieldState = autosave.stateOf(ref)
  const error = autosave.errorOf(ref)
  const pending = fieldState !== "clean"
  const saving = fieldState === "saving"

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const describedBy = [
    help === undefined ? null : helpId,
    pending ? consequenceId : null,
    error === undefined ? null : errorId,
  ]
    .filter((id): id is string => id !== null)
    .join(" ")

  async function apply() {
    const path = [...field.segments]
    const typed = text.trim()
    const change: ConfigChange = typed === "" ? { op: "unset", path } : { op: "set", path, value: typed }
    const landed = await autosave.runExplicit([change], { kind: explicitKind, name: label }, [ref])
    if (landed && mounted.current) input.current?.focus()
  }

  function keepCurrentPath() {
    autosave.discard(ref)
    input.current?.focus()
  }

  return (
    <div data-config-field data-field-path={field.pattern} data-apply-state={pending ? "pending" : "clean"} className="space-y-2">
      <Label htmlFor={controlId}>{label}</Label>
      <div className="flex max-w-md flex-wrap items-center gap-2">
        <Input
          ref={input}
          id={controlId}
          type="text"
          className="min-w-0 flex-1"
          placeholder={placeholder}
          value={text}
          onChange={(event) => autosave.hold(ref, event.target.value)}
          onFocus={() => autosave.setFocusedField(ref)}
          onBlur={() => autosave.setFocusedField(undefined)}
          aria-invalid={error === undefined ? undefined : true}
          aria-describedby={describedBy === "" ? undefined : describedBy}
        />
        {pending ? (
          <>
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-apply-path
              aria-label={applyActionName(label)}
              disabled={saving}
              onClick={() => void apply()}
            >
              {APPLY_LABEL}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              aria-label={keepPathName(label)}
              disabled={saving}
              onClick={keepCurrentPath}
            >
              {KEEP_CURRENT_PATH_LABEL}
            </Button>
          </>
        ) : null}
      </div>
      {help === undefined ? null : (
        <p id={helpId} data-field-help className="text-xs text-muted-foreground break-words">
          {help}
        </p>
      )}
      {pending ? (
        <p id={consequenceId} data-apply-consequence className="text-xs text-muted-foreground break-words">
          {APPLY_CONSEQUENCES[field.pattern]}
        </p>
      ) : null}
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
