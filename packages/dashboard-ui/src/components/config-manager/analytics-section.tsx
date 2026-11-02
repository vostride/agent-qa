// Privacy is a switch whose off state removes the key, because the schema allows it only as true.

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react"
import { Plus, Trash } from "lucide-react"
import type { ConfigChange, ConfigPathSegment } from "@vostride/agent-qa-schema"

import { ConfigField } from "@/components/config-manager/config-field"
import { SecretValue } from "@/components/config-manager/secret-value"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { useConfigAutosaveContext } from "@/hooks/use-config-autosave"
import {
  ADD_ATTRIBUTE_LABEL,
  ATTRIBUTE_FIELD_LABELS,
  ATTRIBUTE_PATTERN_TAG,
  DISCARD_SETTING_LABEL,
  INVALID_ATTRIBUTE_PATTERN_ERROR,
  MATCH_AS_PATTERN_LABEL,
  NO_ATTRIBUTES_TEXT,
  PASS_RATE_SCOPE_HELP,
  PRIVACY_FIELD_HELP,
  PRIVACY_FIELD_LABELS,
  SAVE_SETTING_LABEL,
  attributeValueLabel,
  removeAttributeName,
} from "@/lib/config-copy"

interface AnalyticsSectionProps {
  config: Record<string, unknown>
  onConfigChange: () => void
}

const ATTRIBUTES_PATH = ["analytics", "passRateScope", "attributes"] as const
const VALUE_PATTERN = "analytics.passRateScope.attributes.*"
const REGEX_PATTERN = "analytics.passRateScope.attributes.*.regex"

interface AttributeRow {
  key: string
  pattern: boolean
  segments: ConfigPathSegment[]
  maskedText: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function maskedTextOf(value: unknown): string {
  if (typeof value === "string") return value
  if (value === null || value === undefined) return ""
  return typeof value === "object" ? JSON.stringify(value) : String(value)
}

function attributesOf(config: Record<string, unknown>): AttributeRow[] {
  const analytics = isRecord(config.analytics) ? config.analytics : {}
  const scope = isRecord(analytics.passRateScope) ? analytics.passRateScope : {}
  const attributes = isRecord(scope.attributes) ? scope.attributes : {}
  return Object.entries(attributes).map(([key, value]) =>
    isRecord(value) && "regex" in value
      ? { key, pattern: true, segments: [...ATTRIBUTES_PATH, key, "regex"], maskedText: maskedTextOf(value.regex) }
      : { key, pattern: false, segments: [...ATTRIBUTES_PATH, key], maskedText: maskedTextOf(value) },
  )
}

function isValidPattern(value: string): boolean {
  try {
    new RegExp(value)
    return true
  } catch {
    return false
  }
}

export function AnalyticsSection({ config }: AnalyticsSectionProps) {
  const autosave = useConfigAutosaveContext()
  const [removing, setRemoving] = useState<ReadonlySet<string>>(new Set())
  const [adding, setAdding] = useState(false)
  const listRef = useRef<HTMLUListElement>(null)
  const addButton = useRef<HTMLButtonElement>(null)
  const focusAddNext = useRef(false)

  useEffect(() => {
    if (!adding && focusAddNext.current) {
      focusAddNext.current = false
      addButton.current?.focus()
    }
  }, [adding])

  const all = attributesOf(config)
  const rows = all.filter((row) => !removing.has(row.key))

  function focusAfterRemoving(key: string) {
    const items = Array.from(listRef.current?.children ?? []) as HTMLElement[]
    const index = items.findIndex((item) => item.dataset.passRateAttribute === key)
    const neighbour = items[index + 1] ?? items[index - 1]
    const target = neighbour?.querySelector("button") ?? addButton.current
    target?.focus()
  }

  async function remove(key: string) {
    focusAfterRemoving(key)
    setRemoving((current) => new Set(current).add(key))
    await autosave.runExplicit([{ op: "unset", path: [...ATTRIBUTES_PATH, key] }])
    setRemoving((current) => {
      const next = new Set(current)
      next.delete(key)
      return next
    })
  }

  function closeAdd() {
    focusAddNext.current = true
    setAdding(false)
  }

  return (
    <>
      <div data-field-list="analytics.passRateScope.attributes" className="space-y-3">
        <p className="text-xs text-muted-foreground break-words">{PASS_RATE_SCOPE_HELP}</p>
        {rows.length > 0 ? (
          <ul ref={listRef} className="space-y-2">
            {rows.map((row) => (
              <li
                key={row.key}
                data-pass-rate-attribute={row.key}
                className="grid items-center gap-1 sm:grid-cols-[minmax(8rem,auto)_1fr_auto] sm:gap-3"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <span className="min-w-0 font-mono text-xs wrap-anywhere">{row.key}</span>
                  {row.pattern ? <span className="text-xs text-muted-foreground">{ATTRIBUTE_PATTERN_TAG}</span> : null}
                </div>
                <SecretValue
                  field={{ segments: row.segments, pattern: row.pattern ? REGEX_PATTERN : VALUE_PATTERN }}
                  label={attributeValueLabel(row.key)}
                  maskedText={row.maskedText}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={removeAttributeName(row.key)}
                  className="hover:text-destructive"
                  onClick={() => void remove(row.key)}
                >
                  <Trash className="size-3.5" aria-hidden="true" />
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
        {adding ? <AddAttribute takenKeys={all.map((row) => row.key)} onClose={closeAdd} /> : null}
        {adding ? null : (
          <div className="flex flex-wrap items-center gap-3">
            {rows.length === 0 ? <p className="text-sm text-muted-foreground">{NO_ATTRIBUTES_TEXT}</p> : null}
            <Button ref={addButton} type="button" variant="outline" size="sm" onClick={() => setAdding(true)}>
              <Plus className="size-3.5" aria-hidden="true" />
              {ADD_ATTRIBUTE_LABEL}
            </Button>
          </div>
        )}
      </div>
      <ConfigField
        field={{ segments: ["analytics", "privacy"], tab: "project", pattern: "analytics.privacy" }}
        label={PRIVACY_FIELD_LABELS.privacy}
        kind="switch"
        help={PRIVACY_FIELD_HELP.privacy}
        unsetWhenOff
      />
    </>
  )
}

function AddAttribute({ takenKeys, onClose }: { takenKeys: readonly string[]; onClose: () => void }) {
  const autosave = useConfigAutosaveContext()
  const patternId = useId()
  const errorId = useId()
  const [key, setKey] = useState("")
  const [value, setValue] = useState("")
  const [pattern, setPattern] = useState(false)
  const [saving, setSaving] = useState(false)
  const name = key.trim()
  const invalidPattern = pattern && value !== "" && !isValidPattern(value)
  const ready = name !== "" && value !== "" && !takenKeys.includes(name) && !invalidPattern

  async function save() {
    if (!ready || saving) return
    setSaving(true)
    const change: ConfigChange = {
      op: "set",
      path: [...ATTRIBUTES_PATH, name],
      value: pattern ? { regex: value } : value,
    }
    const landed = await autosave.runExplicit([change])
    setSaving(false)
    if (landed) onClose()
  }

  function keyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault()
      void save()
    } else if (event.key === "Escape") {
      event.preventDefault()
      onClose()
    }
  }

  return (
    <div data-pass-rate-attribute-draft className="space-y-2">
      <div className="flex max-w-md flex-wrap items-center gap-1">
        <Input
          type="text"
          autoComplete="off"
          autoFocus
          aria-label={ATTRIBUTE_FIELD_LABELS.key}
          placeholder={ATTRIBUTE_FIELD_LABELS.key}
          value={key}
          onChange={(event) => setKey(event.target.value)}
          onKeyDown={keyDown}
          className="h-8 w-36 font-mono"
        />
        <Input
          type="password"
          autoComplete="off"
          aria-label={ATTRIBUTE_FIELD_LABELS.value}
          aria-invalid={invalidPattern ? true : undefined}
          aria-describedby={invalidPattern ? errorId : undefined}
          placeholder={ATTRIBUTE_FIELD_LABELS.value}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={keyDown}
          className="h-8 min-w-0 flex-1 font-mono"
        />
      </div>
      <div className="flex items-center gap-2">
        <Switch id={patternId} checked={pattern} onCheckedChange={setPattern} />
        <Label htmlFor={patternId}>{MATCH_AS_PATTERN_LABEL}</Label>
      </div>
      {invalidPattern ? (
        <p id={errorId} className="text-xs text-destructive">
          {INVALID_ATTRIBUTE_PATTERN_ERROR}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-1">
        <Button type="button" variant="outline" size="sm" disabled={!ready || saving} onClick={() => void save()}>
          {SAVE_SETTING_LABEL}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          {DISCARD_SETTING_LABEL}
        </Button>
      </div>
    </div>
  )
}
