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

interface HealingSectionProps {
  config: Record<string, unknown>
  onConfigChange: () => void
}

export function HealingSection({ config, onConfigChange }: HealingSectionProps) {
  const healing = ((config.use as any)?.healing ?? {}) as { maxAttempts?: number }
  const [maxAttempts, setMaxAttempts] = useState(String(healing.maxAttempts ?? 3))
  const [saving, setSaving] = useState(false)

  async function handleSave() {
    const parsedMaxAttempts = parseConfigNumberInput(maxAttempts, {
      label: "Max healing attempts",
      min: 1,
      integer: true,
    })
    if (parsedMaxAttempts.error) {
      toast.error(parsedMaxAttempts.error)
      return
    }

    setSaving(true)
    try {
      await updateSettings({ 'use.healing': { maxAttempts: parsedMaxAttempts.value } })
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
        <h2 className="text-base font-semibold">Healing</h2>
        <p className="text-sm text-muted-foreground">Configure self-healing behavior for failing test steps</p>
      </ConfigSectionHeader>
      <ConfigSectionBody>
        <div className="space-y-2">
          <Label htmlFor="healing-max-attempts">Max Healing Attempts</Label>
          <Input
            id="healing-max-attempts"
            type="number"
            min={1}
            step={1}
            value={maxAttempts}
            onChange={(e) => setMaxAttempts(e.target.value)}
          />
        </div>

        <Button size="sm" onClick={handleSave} disabled={saving}>
          {saving ? <Loader2 className="size-4 animate-spin" /> : "Save Changes"}
        </Button>
      </ConfigSectionBody>
    </ConfigSectionShell>
  )
}
