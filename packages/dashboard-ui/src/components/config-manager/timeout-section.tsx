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
import { updateSettings } from "@/lib/api"

interface TimeoutSectionProps {
  config: Record<string, unknown>
  onConfigChange: () => void
}

export function TimeoutSection({ config, onConfigChange }: TimeoutSectionProps) {
  const timeout = ((config.use as any)?.timeout ?? {}) as { step?: string; test?: string; navigation?: string }
  const [step, setStep] = useState(timeout.step ?? '30s')
  const [test, setTest] = useState(timeout.test ?? '10m')
  const [navigation, setNavigation] = useState(timeout.navigation ?? '10s')
  const [saving, setSaving] = useState(false)

  async function handleSave() {
    setSaving(true)
    try {
      await updateSettings({ 'use.timeout': { step, test, navigation } })
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
        <h2 className="text-base font-semibold">Timeout</h2>
        <p className="text-sm text-muted-foreground">Configure timeout limits for test execution</p>
      </ConfigSectionHeader>
      <ConfigSectionBody>
        <div className="space-y-2">
          <Label htmlFor="timeout-step">Step Timeout</Label>
          <Input
            id="timeout-step"
            type="text"
            placeholder='e.g., "30s", "5m"'
            value={step}
            onChange={(e) => setStep(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">Max time for a single test step (e.g., "30s", "5m")</p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="timeout-test">Test Timeout</Label>
          <Input
            id="timeout-test"
            type="text"
            placeholder='e.g., "10m", "1h"'
            value={test}
            onChange={(e) => setTest(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">Max time for an entire test (e.g., "10m", "1h")</p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="timeout-navigation">Navigation Timeout</Label>
          <Input
            id="timeout-navigation"
            type="text"
            placeholder='e.g., "10s", "30s"'
            value={navigation}
            onChange={(e) => setNavigation(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">Max time for page navigation (e.g., "10s", "30s")</p>
        </div>

        <Button size="sm" onClick={handleSave} disabled={saving}>
          {saving ? <Loader2 className="size-4 animate-spin" /> : "Save Changes"}
        </Button>
      </ConfigSectionBody>
    </ConfigSectionShell>
  )
}
