import { useState } from "react"
import { Loader2, Plus, Trash2 } from "lucide-react"
import { toast } from "sonner"

import { updateSettings } from "@/lib/api"
import {
  ConfigLineNotice,
  ConfigSectionBody,
  ConfigSectionHeader,
  ConfigSectionShell,
} from "@/components/config-manager/config-section-shell"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

type AttributeMode = "exact" | "regex"

interface AttributeRow {
  id: string
  key: string
  mode: AttributeMode
  value: string
}

interface AnalyticsSectionProps {
  config: Record<string, unknown>
  onConfigChange: () => void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function getInitialRows(config: Record<string, unknown>): AttributeRow[] {
  const analytics = isRecord(config.analytics) ? config.analytics : {}
  const passRateScope = isRecord(analytics.passRateScope) ? analytics.passRateScope : {}
  const attributes = isRecord(passRateScope.attributes) ? passRateScope.attributes : {}

  const rows: AttributeRow[] = []
  for (const [index, [key, rawValue]] of Object.entries(attributes).entries()) {
    if (typeof rawValue === "string") {
      rows.push({ id: `existing-${index}`, key, mode: "exact", value: rawValue })
      continue
    }
    if (isRecord(rawValue) && typeof rawValue.regex === "string") {
      rows.push({ id: `existing-${index}`, key, mode: "regex", value: rawValue.regex })
    }
  }
  return rows
}

function buildPassRateScope(rows: AttributeRow[]) {
  const attributes: Record<string, string | { regex: string }> = {}
  const seenKeys = new Set<string>()

  for (const row of rows) {
    const key = row.key.trim()
    const value = row.value.trim()
    const hasAnyValue = key.length > 0 || value.length > 0
    if (!hasAnyValue) continue
    if (!key) return { error: "Attribute key is required." }
    if (!value) return { error: `Value is required for ${key}.` }
    if (seenKeys.has(key)) return { error: `Duplicate attribute key: ${key}` }
    if (row.mode === "regex") {
      try {
        new RegExp(value)
      } catch {
        return { error: `Invalid regex for ${key}.` }
      }
      attributes[key] = { regex: value }
    } else {
      attributes[key] = value
    }
    seenKeys.add(key)
  }

  return { value: { attributes } }
}

export function AnalyticsSection({ config, onConfigChange }: AnalyticsSectionProps) {
  const [rows, setRows] = useState<AttributeRow[]>(() => getInitialRows(config))
  const [saving, setSaving] = useState(false)

  function updateRow(id: string, patch: Partial<Omit<AttributeRow, "id">>) {
    setRows((current) => current.map((row) => row.id === id ? { ...row, ...patch } : row))
  }

  function addRow() {
    setRows((current) => [
      ...current,
      { id: `new-${Date.now()}-${current.length}`, key: "", mode: "exact", value: "" },
    ])
  }

  function removeRow(id: string) {
    setRows((current) => current.filter((row) => row.id !== id))
  }

  async function handleSave() {
    const result = buildPassRateScope(rows)
    if ("error" in result) {
      toast.error(result.error)
      return
    }

    setSaving(true)
    try {
      await updateSettings({
        "analytics.passRateScope": result.value,
      })
      onConfigChange()
      toast.success("Configuration saved")
    } catch {
      toast.error("Failed to save configuration")
    } finally {
      setSaving(false)
    }
  }

  return (
    <ConfigSectionShell>
      <ConfigSectionHeader>
        <h2 className="text-base font-semibold">Pass Rate Scope</h2>
        <p className="text-sm text-muted-foreground">Choose run attributes for scoped pass rate, flaky score, and test/suite analytics values.</p>
      </ConfigSectionHeader>
      <ConfigSectionBody>
        {rows.length === 0 ? (
          <ConfigLineNotice className="border-dashed">
            No scoped attributes configured. Add at least one attribute to enable scoped analytics.
          </ConfigLineNotice>
        ) : (
          <div className="overflow-hidden border border-border">
            <div className="hidden grid-cols-[minmax(160px,1fr)_120px_minmax(160px,1fr)_44px] gap-3 border-b border-border px-3 py-2 text-xs text-muted-foreground md:grid">
              <span>Key</span>
              <span>Match</span>
              <span>Value</span>
              <span />
            </div>
            <div className="divide-y divide-border">
              {rows.map((row) => (
                <div
                  key={row.id}
                  className="grid grid-cols-1 items-end gap-3 px-3 py-3 md:grid-cols-[minmax(160px,1fr)_120px_minmax(160px,1fr)_44px]"
                >
                  <div className="space-y-2">
                    <Label htmlFor={`analytics-scope-key-${row.id}`} className="sr-only">Attribute key</Label>
                    <Input
                      id={`analytics-scope-key-${row.id}`}
                      data-testid="analytics-scope-key"
                      value={row.key}
                      placeholder="git.branch"
                      onChange={(event) => updateRow(row.id, { key: event.target.value })}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor={`analytics-scope-mode-${row.id}`} className="sr-only">Attribute match mode</Label>
                    <Select
                      value={row.mode}
                      onValueChange={(value) => updateRow(row.id, { mode: value as AttributeMode })}
                    >
                      <SelectTrigger id={`analytics-scope-mode-${row.id}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="exact">Exact</SelectItem>
                        <SelectItem value="regex">Regex</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor={`analytics-scope-value-${row.id}`} className="sr-only">Attribute value</Label>
                    <Input
                      id={`analytics-scope-value-${row.id}`}
                      data-testid="analytics-scope-value"
                      value={row.value}
                      placeholder={row.mode === "regex" ? "^(main|master)$" : "master"}
                      onChange={(event) => updateRow(row.id, { value: event.target.value })}
                    />
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => removeRow(row.id)}
                    aria-label={`Remove ${row.key || "attribute"}`}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" onClick={addRow}>
            <Plus className="size-4" />
            Add Attribute
          </Button>
          <Button type="button" size="sm" onClick={handleSave} disabled={saving}>
            {saving ? <Loader2 className="size-4 animate-spin" /> : "Save Changes"}
          </Button>
        </div>
      </ConfigSectionBody>
    </ConfigSectionShell>
  )
}
