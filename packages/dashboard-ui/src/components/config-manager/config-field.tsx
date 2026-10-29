// Every leaf renders here, so every leaf gets the same label, help, error and draft treatment.

import type { KeyboardEvent } from "react"
import { CircleAlert } from "lucide-react"
import type { ConfigPathSegment } from "@vostride/agent-qa-schema"

import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { parseConfigNumberInput } from "@/components/config-manager/numeric-input"
import {
  configFieldControlId,
  configFieldKeyOf,
  useConfigAutosaveContext,
  type ConfigFieldParse,
  type ConfigFieldRef,
} from "@/hooks/use-config-autosave"
import { listToText, parseDurationInput, textToList } from "@/lib/config-fields"
import type { ConfigTab } from "@/lib/config-tabs"
import { cn } from "@/lib/utils"

export type ConfigFieldKind = "text" | "number" | "duration" | "switch" | "select" | "list"

export interface ConfigFieldTarget {
  segments: readonly ConfigPathSegment[]
  tab: ConfigTab
  /** The leaf's schema pattern, for example use.timeout.step or registry.llms[].model. */
  pattern: string
}

export interface ConfigFieldOption {
  value: string
  label: string
}

export interface ConfigNumberRules {
  min?: number
  max?: number
  integer?: boolean
}

export interface ConfigFieldProps {
  field: ConfigFieldTarget
  label: string
  kind: ConfigFieldKind
  help?: string
  placeholder?: string
  /** A switch's effective default position while the leaf is unset. */
  defaultChecked?: boolean
  /** Turning the switch off removes the key, for a leaf the schema allows only as true. */
  unsetWhenOff?: boolean
  options?: readonly ConfigFieldOption[]
  number?: ConfigNumberRules
  parse?: (raw: string) => ConfigFieldParse
}

const UNSET: ConfigFieldParse = { valid: true, unset: true }

function parseText(kind: ConfigFieldKind, raw: string, label: string, rules: ConfigNumberRules | undefined): ConfigFieldParse {
  switch (kind) {
    case "duration":
      return raw.trim() === "" ? UNSET : parseDurationInput(raw)
    case "number": {
      if (raw.trim() === "") return UNSET
      const parsed = parseConfigNumberInput(raw, { label, ...rules })
      return parsed.error === null ? { valid: true, value: parsed.value } : { valid: false, error: parsed.error }
    }
    case "list": {
      const items = textToList(raw)
      return items.length === 0 ? UNSET : { valid: true, value: items }
    }
    default:
      return raw === "" ? UNSET : { valid: true, value: raw }
  }
}

function textOf(kind: ConfigFieldKind, value: unknown): string {
  if (typeof value === "string") return value
  if (kind === "list") return listToText(value)
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  return ""
}

export function ConfigField({
  field,
  label,
  kind,
  help,
  placeholder,
  defaultChecked = false,
  unsetWhenOff = false,
  options = [],
  number,
  parse,
}: ConfigFieldProps) {
  const autosave = useConfigAutosaveContext()
  const ref: ConfigFieldRef = { segments: field.segments, tab: field.tab }
  const controlId = configFieldControlId(configFieldKeyOf(field.segments))
  const helpId = `${controlId}-help`
  const errorId = `${controlId}-error`
  const value = autosave.valueOf(ref)
  const fieldState = autosave.stateOf(ref)
  const error = autosave.errorOf(ref)
  const describedBy = [help === undefined ? null : helpId, error === undefined ? null : errorId]
    .filter((id): id is string => id !== null)
    .join(" ")
  const aria = {
    "aria-invalid": error === undefined ? undefined : true,
    "aria-describedby": describedBy === "" ? undefined : describedBy,
  } as const

  function editText(raw: string) {
    autosave.edit(ref, raw, parse ? parse(raw) : parseText(kind, raw, label, number))
  }

  function settleNow(raw: unknown, parsed: ConfigFieldParse) {
    autosave.edit(ref, raw, parsed)
    autosave.settle(ref)
  }

  function focus() {
    autosave.setFocusedField(ref)
  }

  // Focus is released first: the hook drops a clean entry only while nothing is pending on it,
  // and the settle below is what makes this field's change pending.
  function blur() {
    autosave.setFocusedField(undefined)
    autosave.settle(ref)
  }

  function settleOnEnter(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") autosave.settle(ref)
  }

  const helpLine =
    help === undefined ? null : (
      <p id={helpId} data-field-help className="text-xs text-muted-foreground break-words">
        {help}
      </p>
    )
  const errorLine =
    error === undefined ? null : (
      <p id={errorId} data-field-error className="flex items-start gap-1 text-xs text-destructive break-words">
        <span className="flex h-[1lh] shrink-0 items-center">
          <CircleAlert className="size-3" aria-hidden="true" />
        </span>
        {error}
      </p>
    )

  if (kind === "switch") {
    const checked = typeof value === "boolean" ? value : defaultChecked
    return (
      <div data-config-field data-field-path={field.pattern} data-field-state={fieldState} className="space-y-2">
        <div className="flex max-w-md items-center justify-between gap-4">
          <div className="space-y-0.5">
            <Label htmlFor={controlId}>{label}</Label>
            {helpLine}
          </div>
          <Switch
            id={controlId}
            checked={checked}
            onCheckedChange={(next) => settleNow(next, next || !unsetWhenOff ? { valid: true, value: next } : UNSET)}
            onFocus={focus}
            onBlur={() => autosave.setFocusedField(undefined)}
            {...aria}
          />
        </div>
        {errorLine}
      </div>
    )
  }

  let control
  if (kind === "select") {
    control = (
      <Select
        value={typeof value === "string" ? value : ""}
        onValueChange={(next) => settleNow(next, parse ? parse(next) : { valid: true, value: next })}
      >
        <SelectTrigger
          id={controlId}
          className="w-full max-w-md"
          onFocus={focus}
          onBlur={() => autosave.setFocusedField(undefined)}
          {...aria}
        >
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    )
  } else if (kind === "list") {
    control = (
      <Textarea
        id={controlId}
        className="w-full max-w-md"
        placeholder={placeholder}
        value={textOf(kind, value)}
        onChange={(event) => editText(event.target.value)}
        onFocus={focus}
        onBlur={blur}
        {...aria}
      />
    )
  } else {
    control = (
      <Input
        id={controlId}
        type="text"
        inputMode={kind === "number" ? "decimal" : undefined}
        className={cn(kind === "number" || kind === "duration" ? "w-32 tabular-nums" : "w-full max-w-md")}
        placeholder={placeholder}
        value={textOf(kind, value)}
        onChange={(event) => editText(event.target.value)}
        onFocus={focus}
        onBlur={blur}
        onKeyDown={settleOnEnter}
        {...aria}
      />
    )
  }

  return (
    <div data-config-field data-field-path={field.pattern} data-field-state={fieldState} className="space-y-2">
      <Label htmlFor={controlId}>{label}</Label>
      {control}
      {helpLine}
      {errorLine}
    </div>
  )
}
