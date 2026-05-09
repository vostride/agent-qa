import { useState } from "react"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Separator } from "@/components/ui/separator"
import type { ConfigSectionProps } from "./platform-section"

const HEALING_STRATEGIES = [
  { value: "full-replan", label: "Full Replan" },
  { value: "selector-resolution", label: "Selector Resolution" },
  { value: "two-tier", label: "Two Tier" },
]

function NumberField({
  label,
  value,
  placeholder,
  onChange,
  onClear,
}: {
  label: string
  value: unknown
  placeholder: string
  onChange: (v: number) => void
  onClear: () => void
}) {
  const [localValue, setLocalValue] = useState(
    value != null ? String(value) : "",
  )

  const displayed = value != null ? String(value) : ""
  const current = localValue !== displayed ? localValue : displayed

  return (
    <div className="space-y-1">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <Input
        type="number"
        placeholder={placeholder}
        value={current}
        onChange={(e) => setLocalValue(e.target.value)}
        onBlur={(e) => {
          const raw = e.target.value.trim()
          if (raw === "") {
            onClear()
            setLocalValue("")
            return
          }
          const parsed = Number(raw)
          if (!isNaN(parsed)) {
            onChange(parsed)
            setLocalValue(String(parsed))
          }
        }}
      />
    </div>
  )
}

export function TimeoutSection({
  getIn,
  onChange,
  onDelete,
}: ConfigSectionProps) {
  const stepTimeout = getIn(["config", "timeouts", "step"])
  const testTimeout = getIn(["config", "timeouts", "test"])
  const navTimeout = getIn(["config", "timeouts", "navigation"])

  const healingStrategy = getIn(["config", "healing", "strategy"]) as
    | string
    | undefined
  const maxAttempts = getIn(["config", "healing", "maxAttempts"])
  const requireStateDiff = getIn(["config", "healing", "requireStateDiff"]) as
    | boolean
    | undefined

  const retries = getIn(["config", "retries"])

  return (
    <div className="space-y-6">
      {/* Timeouts */}
      <div className="space-y-4">
        <Label>Timeouts</Label>
        <NumberField
          label="Step timeout (ms)"
          value={stepTimeout}
          placeholder="30000"
          onChange={(v) => onChange(["config", "timeouts", "step"], v)}
          onClear={() => onDelete(["config", "timeouts", "step"])}
        />
        <NumberField
          label="Test timeout (ms)"
          value={testTimeout}
          placeholder="300000"
          onChange={(v) => onChange(["config", "timeouts", "test"], v)}
          onClear={() => onDelete(["config", "timeouts", "test"])}
        />
        <NumberField
          label="Navigation timeout (ms)"
          value={navTimeout}
          placeholder="10000"
          onChange={(v) => onChange(["config", "timeouts", "navigation"], v)}
          onClear={() => onDelete(["config", "timeouts", "navigation"])}
        />
      </div>

      <Separator />

      {/* Healing */}
      <div className="space-y-4">
        <Label>Healing</Label>
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">Strategy</Label>
          <Select
            value={healingStrategy ?? ""}
            onValueChange={(v) =>
              onChange(["config", "healing", "strategy"], v)
            }
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="full-replan" />
            </SelectTrigger>
            <SelectContent>
              {HEALING_STRATEGIES.map((s) => (
                <SelectItem key={s.value} value={s.value}>
                  {s.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <NumberField
          label="Max attempts"
          value={maxAttempts}
          placeholder="3"
          onChange={(v) => onChange(["config", "healing", "maxAttempts"], v)}
          onClear={() => onDelete(["config", "healing", "maxAttempts"])}
        />

        <div className="flex items-center justify-between">
          <Label className="text-xs text-muted-foreground">
            Require state diff
          </Label>
          <Switch
            size="sm"
            checked={requireStateDiff ?? true}
            onCheckedChange={(checked) =>
              onChange(["config", "healing", "requireStateDiff"], checked)
            }
          />
        </div>
      </div>

      <Separator />

      {/* Retries */}
      <div className="space-y-4">
        <NumberField
          label="Retries"
          value={retries}
          placeholder="0"
          onChange={(v) => onChange(["config", "retries"], v)}
          onClear={() => onDelete(["config", "retries"])}
        />
      </div>
    </div>
  )
}
