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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { updateSettings } from "@/lib/api"

interface AccessibilitySectionProps {
  config: Record<string, unknown>
  onConfigChange: () => void
}

export function AccessibilitySection({ config, onConfigChange }: AccessibilitySectionProps) {
  const a11y = ((config.services as any)?.accessibility ?? {}) as {
    enabled?: boolean
    standard?: string
    runAfter?: string
    failOnViolation?: boolean
  }
  const [enabled, setEnabled] = useState(a11y.enabled ?? false)
  const [standard, setStandard] = useState(a11y.standard ?? "wcag2aa")
  const [runAfter, setRunAfter] = useState(a11y.runAfter ?? "test-end")
  const [failOnViolation, setFailOnViolation] = useState(a11y.failOnViolation ?? false)
  const [saving, setSaving] = useState(false)

  async function handleSave() {
    setSaving(true)
    try {
      await updateSettings({
        'services.accessibility': { enabled, standard, runAfter, failOnViolation },
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
        <h2 className="text-base font-semibold">Accessibility</h2>
        <p className="text-sm text-muted-foreground">Configure accessibility audit settings</p>
      </ConfigSectionHeader>
      <ConfigSectionBody>
        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <Label htmlFor="a11y-enabled">Enabled</Label>
            <p className="text-xs text-muted-foreground">Run accessibility checks during tests</p>
          </div>
          <Switch id="a11y-enabled" checked={enabled} onCheckedChange={setEnabled} />
        </div>

        <div className="space-y-2">
          <Label htmlFor="a11y-standard">Standard</Label>
          <Select value={standard} onValueChange={setStandard}>
            <SelectTrigger id="a11y-standard">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="wcag2a">WCAG 2.0 A</SelectItem>
              <SelectItem value="wcag2aa">WCAG 2.0 AA</SelectItem>
              <SelectItem value="wcag2aaa">WCAG 2.0 AAA</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label htmlFor="a11y-run-after">Run After</Label>
          <Select value={runAfter} onValueChange={setRunAfter}>
            <SelectTrigger id="a11y-run-after">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="every-step">Every Step</SelectItem>
              <SelectItem value="navigation">Navigation</SelectItem>
              <SelectItem value="test-end">Test End</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <Label htmlFor="a11y-fail">Fail on Violation</Label>
            <p className="text-xs text-muted-foreground">Fail the test if violations are found</p>
          </div>
          <Switch id="a11y-fail" checked={failOnViolation} onCheckedChange={setFailOnViolation} />
        </div>

        <Button size="sm" onClick={handleSave} disabled={saving}>
          {saving ? <Loader2 className="size-4 animate-spin" /> : "Save Changes"}
        </Button>
      </ConfigSectionBody>
    </ConfigSectionShell>
  )
}
