import { useState } from "react"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"

import { updateSettings } from "@/lib/api"
import {
  ConfigSectionBody,
  ConfigSectionHeader,
  ConfigSectionShell,
} from "@/components/config-manager/config-section-shell"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Button } from "@/components/ui/button"

interface LogCaptureSectionProps {
  config: Record<string, unknown>
  onConfigChange: () => void
}

export function LogCaptureSection({ config, onConfigChange }: LogCaptureSectionProps) {
  const logCapture = (((config.use as Record<string, unknown> | undefined) ?? {}).logCapture ?? {}) as {
    console?: boolean
    network?: boolean
  }
  const [captureConsole, setCaptureConsole] = useState(logCapture.console ?? true)
  const [captureNetwork, setCaptureNetwork] = useState(logCapture.network ?? true)
  const [saving, setSaving] = useState(false)

  async function handleSave() {
    setSaving(true)
    try {
      await updateSettings({
        'use.logCapture': {
          console: captureConsole,
          network: captureNetwork,
        },
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
        <h2 className="text-base font-semibold">Log Capture</h2>
        <p className="text-sm text-muted-foreground">Control the default runtime capture of console and network events.</p>
      </ConfigSectionHeader>
      <ConfigSectionBody>
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-0.5">
            <Label htmlFor="use-log-capture-console">Capture console logs</Label>
            <p className="text-xs text-muted-foreground">Record browser console output during runs by default.</p>
          </div>
          <Switch
            id="use-log-capture-console"
            checked={captureConsole}
            onCheckedChange={setCaptureConsole}
          />
        </div>

        <div className="flex items-center justify-between gap-4">
          <div className="space-y-0.5">
            <Label htmlFor="use-log-capture-network">Capture network logs</Label>
            <p className="text-xs text-muted-foreground">Record request and response metadata during runs by default.</p>
          </div>
          <Switch
            id="use-log-capture-network"
            checked={captureNetwork}
            onCheckedChange={setCaptureNetwork}
          />
        </div>

        <Button size="sm" onClick={handleSave} disabled={saving}>
          {saving ? <Loader2 className="size-4 animate-spin" /> : "Save Changes"}
        </Button>
      </ConfigSectionBody>
    </ConfigSectionShell>
  )
}
