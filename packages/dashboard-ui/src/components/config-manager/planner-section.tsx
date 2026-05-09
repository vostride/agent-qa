import { useState } from "react"
import { toast } from "sonner"
import { Loader2 } from "lucide-react"
import {
  ConfigSectionBody,
  ConfigSectionHeader,
  ConfigSectionShell,
} from "@/components/config-manager/config-section-shell"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { parseConfigNumberInput } from "@/components/config-manager/numeric-input"
import { updateSettings } from "@/lib/api"

interface PlannerSectionProps {
  config: Record<string, unknown>
  onConfigChange: () => void
}

export function PlannerSection({ config, onConfigChange }: PlannerSectionProps) {
  const planner = ((config.use as any)?.planner ?? {}) as {
    maxSubActions?: number
    previousStepCount?: number
  }
  const [maxSubActions, setMaxSubActions] = useState(String(planner.maxSubActions ?? 20))
  const [previousStepCount, setPreviousStepCount] = useState(String(planner.previousStepCount ?? 5))
  const [saving, setSaving] = useState(false)

  async function handleSave() {
    const parsedMaxSubActions = parseConfigNumberInput(maxSubActions, {
      label: "Max sub-actions",
      min: 1,
      integer: true,
    })
    if (parsedMaxSubActions.error) {
      toast.error(parsedMaxSubActions.error)
      return
    }
    const parsedPreviousStepCount = parseConfigNumberInput(previousStepCount, {
      label: "Previous step count",
      min: 0,
      integer: true,
    })
    if (parsedPreviousStepCount.error) {
      toast.error(parsedPreviousStepCount.error)
      return
    }

    setSaving(true)
    try {
      await updateSettings({
        'use.planner': {
          maxSubActions: parsedMaxSubActions.value,
          previousStepCount: parsedPreviousStepCount.value,
        },
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
        <h2 className="text-base font-semibold">Planner</h2>
        <p className="text-sm text-muted-foreground">Configure the AI planner observation and planning settings</p>
      </ConfigSectionHeader>
      <ConfigSectionBody>
        <div className="space-y-2">
          <Label htmlFor="planner-max-sub-actions">Max Sub-Actions</Label>
          <Input
            id="planner-max-sub-actions"
            type="number"
            min={1}
            step={1}
            value={maxSubActions}
            onChange={(e) => setMaxSubActions(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">Maximum sub-actions per step</p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="planner-prev-steps">Previous Step Count</Label>
          <Input
            id="planner-prev-steps"
            type="number"
            min={0}
            step={1}
            value={previousStepCount}
            onChange={(e) => setPreviousStepCount(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">Number of previous steps included in planner context</p>
        </div>

        <Button size="sm" onClick={handleSave} disabled={saving}>
          {saving ? <Loader2 className="size-4 animate-spin" /> : "Save Changes"}
        </Button>
      </ConfigSectionBody>
    </ConfigSectionShell>
  )
}
