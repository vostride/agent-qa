import { useState } from "react"
import { Plus, Trash2 } from "lucide-react"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import type { ConfigSectionProps } from "./platform-section"

function parseDimensions(raw: unknown): Record<string, string[]> {
  if (!raw || typeof raw !== "object") return {}
  const out: Record<string, string[]> = {}
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    if (Array.isArray(val)) {
      out[key] = val.map(String)
    } else {
      out[key] = []
    }
  }
  return out
}

function computeCount(dimensions: Record<string, string[]>): number {
  const values = Object.values(dimensions)
  if (values.length === 0) return 0
  if (values.some((arr) => arr.length === 0)) return 0
  return values.reduce((acc, arr) => acc * arr.length, 1)
}

interface DimensionRowProps {
  name: string
  values: string[]
  onRename: (oldName: string, newName: string) => void
  onValuesChange: (name: string, values: string[]) => void
  onRemove: (name: string) => void
}

function DimensionRow({
  name,
  values,
  onRename,
  onValuesChange,
  onRemove,
}: DimensionRowProps) {
  const [localName, setLocalName] = useState(name)
  const [localValues, setLocalValues] = useState(values.join(", "))

  return (
    <div className="flex items-center gap-2">
      <Input
        className="w-28 shrink-0"
        placeholder="dimension"
        value={localName}
        onChange={(e) => setLocalName(e.target.value)}
        onBlur={() => {
          const trimmed = localName.trim()
          if (trimmed && trimmed !== name) {
            onRename(name, trimmed)
          } else if (!trimmed) {
            setLocalName(name)
          }
        }}
      />
      <Input
        className="flex-1"
        placeholder="value1, value2, value3"
        value={localValues}
        onChange={(e) => setLocalValues(e.target.value)}
        onBlur={() => {
          const parsed = localValues
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
          onValuesChange(name, parsed)
        }}
      />
      <Button
        variant="ghost"
        size="icon-xs"
        onClick={() => onRemove(name)}
        className="shrink-0 text-muted-foreground hover:text-destructive"
      >
        <Trash2 className="size-3.5" />
      </Button>
    </div>
  )
}

export function MatrixSection({
  getIn,
  onChange,
  onDelete,
}: ConfigSectionProps) {
  const raw = getIn(["matrix", "dimensions"])
  const dimensions = parseDimensions(raw)
  const failFast = getIn(["matrix", "fail-fast"]) as boolean | undefined
  const count = computeCount(dimensions)
  const hasDimensions = Object.keys(dimensions).length > 0
  const hasMatrix = raw !== undefined || failFast !== undefined

  function handleRename(oldName: string, newName: string) {
    const vals = dimensions[oldName] ?? []
    onDelete(["matrix", "dimensions", oldName])
    onChange(["matrix", "dimensions", newName], vals)
  }

  function handleValuesChange(name: string, values: string[]) {
    onChange(["matrix", "dimensions", name], values)
  }

  function handleRemove(name: string) {
    onDelete(["matrix", "dimensions", name])
  }

  function handleAdd() {
    let idx = Object.keys(dimensions).length + 1
    let key = `dim_${idx}`
    while (dimensions[key]) {
      idx++
      key = `dim_${idx}`
    }
    onChange(["matrix", "dimensions", key], [])
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Label>Matrix</Label>
        {hasDimensions && (
          <Badge variant="secondary" className="text-xs">
            Will run {count} combination{count !== 1 ? "s" : ""}
          </Badge>
        )}
      </div>

      {!hasMatrix && !hasDimensions && (
        <p className="text-xs text-muted-foreground">
          Add matrix dimensions to run tests across multiple configurations.
        </p>
      )}

      {hasDimensions && (
        <div className="space-y-2">
          {Object.entries(dimensions).map(([name, values]) => (
            <DimensionRow
              key={name}
              name={name}
              values={values}
              onRename={handleRename}
              onValuesChange={handleValuesChange}
              onRemove={handleRemove}
            />
          ))}
        </div>
      )}

      <Button
        variant="outline"
        size="sm"
        className="gap-1.5"
        onClick={handleAdd}
      >
        <Plus className="size-3.5" />
        Add dimension
      </Button>

      {hasMatrix && (
        <div className="flex items-center justify-between">
          <Label className="text-xs text-muted-foreground">Fail fast</Label>
          <Switch
            size="sm"
            checked={failFast ?? false}
            onCheckedChange={(checked) =>
              onChange(["matrix", "fail-fast"], checked)
            }
          />
        </div>
      )}
    </div>
  )
}
