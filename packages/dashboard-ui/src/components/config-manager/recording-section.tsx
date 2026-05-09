import { useState } from "react"
import { toast } from "sonner"
import { Loader2 } from "lucide-react"
import {
  ConfigSectionBody,
  ConfigSectionHeader,
  ConfigSectionShell,
} from "@/components/config-manager/config-section-shell"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { updateSettings } from "@/lib/api"

interface RecordingSectionProps {
  config: Record<string, unknown>
  onConfigChange: () => void
}

export function RecordingSection({ config, onConfigChange }: RecordingSectionProps) {
  const recording = ((config.services as any)?.recording ?? {}) as {
    enabled?: boolean
  }
  const [enabled, setEnabled] = useState(recording.enabled ?? false)
  const [saving, setSaving] = useState(false)

  async function handleSave() {
    setSaving(true)
    try {
      await updateSettings({
        'services.recording': { enabled },
      })
      onConfigChange()
      toast.success("Changes saved")
    } catch {
      toast.error("Failed to save configuration")
    } finally {
      setSaving(false)
    }
  }

  return (
    <ConfigSectionShell>
      <ConfigSectionHeader>
        <h2 className="text-base font-semibold">Recording</h2>
        <p className="text-sm text-muted-foreground">Configure whether runtime recording is enabled by default.</p>
      </ConfigSectionHeader>
      <ConfigSectionBody>
        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <Label htmlFor="recording-enabled">Enabled</Label>
            <p className="text-xs text-muted-foreground">Record video of test execution</p>
          </div>
          <Switch id="recording-enabled" checked={enabled} onCheckedChange={setEnabled} />
        </div>

        <Button size="sm" onClick={handleSave} disabled={saving}>
          {saving ? <Loader2 className="size-4 animate-spin" /> : "Save Changes"}
        </Button>
      </ConfigSectionBody>
    </ConfigSectionShell>
  )
}
