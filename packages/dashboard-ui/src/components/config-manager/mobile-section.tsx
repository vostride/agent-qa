import { useState } from "react"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"

import { updateSettings } from "@/lib/api"
import {
  ConfigLineNotice,
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

interface MobileSectionProps {
  config: Record<string, unknown>
  onConfigChange: () => void
}

type MobileAppState = "preserve" | "reset"

function readAppState(config: Record<string, unknown>): MobileAppState | undefined {
  const appState = ((config.use as any)?.mobile as { appState?: unknown } | undefined)?.appState
  return appState === "preserve" || appState === "reset" ? appState : undefined
}

export function MobileSection({ config, onConfigChange }: MobileSectionProps) {
  const currentAppState = readAppState(config)
  const [appState, setAppState] = useState<MobileAppState>(currentAppState ?? "preserve")
  const [saving, setSaving] = useState(false)

  async function handleSave() {
    setSaving(true)
    try {
      await updateSettings({ "use.mobile.appState": appState })
      onConfigChange()
      toast.success("Mobile defaults saved")
    } catch {
      toast.error("Mobile defaults were not saved. Fix the setting and try again.")
    } finally {
      setSaving(false)
    }
  }

  return (
    <ConfigSectionShell>
      <ConfigSectionHeader>
        <h2 className="text-base font-semibold">Mobile</h2>
        <p className="text-sm text-muted-foreground">Set native mobile app-state behavior for mobile runs.</p>
      </ConfigSectionHeader>
      <ConfigSectionBody>
        {!currentAppState ? (
          <ConfigLineNotice className="border-dashed">
            <div className="font-medium text-foreground">Mobile app state is required.</div>
            <div>Add use.mobile.appState to run mobile tests.</div>
          </ConfigLineNotice>
        ) : null}

        <div className="space-y-2">
          <Label htmlFor="use-mobile-app-state">App state</Label>
          <Select value={appState} onValueChange={(value) => setAppState(value as MobileAppState)}>
            <SelectTrigger id="use-mobile-app-state">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="preserve">Preserve app data</SelectItem>
              <SelectItem value="reset">Reset app data</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <Button size="sm" onClick={handleSave} disabled={saving}>
          {saving ? <Loader2 className="size-4 animate-spin" /> : "Save Mobile Defaults"}
        </Button>
      </ConfigSectionBody>
    </ConfigSectionShell>
  )
}
