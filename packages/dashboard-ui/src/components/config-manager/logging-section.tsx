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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { updateSettings } from "@/lib/api"

interface LoggingSectionProps {
  config: Record<string, unknown>
  onConfigChange: () => void
}

export function LoggingSection({ config, onConfigChange }: LoggingSectionProps) {
  const logging = ((config.services as any)?.logging ?? {}) as { level?: string }
  const [level, setLevel] = useState(logging.level ?? "info")
  const [saving, setSaving] = useState(false)

  async function handleSave() {
    setSaving(true)
    try {
      await updateSettings({ 'services.logging': { level } })
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
        <h2 className="text-base font-semibold">Logging</h2>
        <p className="text-sm text-muted-foreground">Configure service log verbosity.</p>
      </ConfigSectionHeader>
      <ConfigSectionBody>
        <div className="space-y-2">
          <Label htmlFor="logging-level">Log Level</Label>
          <Select value={level} onValueChange={setLevel}>
            <SelectTrigger id="logging-level">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="silent">Silent</SelectItem>
              <SelectItem value="error">Error</SelectItem>
              <SelectItem value="warn">Warn</SelectItem>
              <SelectItem value="info">Info</SelectItem>
              <SelectItem value="debug">Debug</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <Button size="sm" onClick={handleSave} disabled={saving}>
          {saving ? <Loader2 className="size-4 animate-spin" /> : "Save Changes"}
        </Button>
      </ConfigSectionBody>
    </ConfigSectionShell>
  )
}
