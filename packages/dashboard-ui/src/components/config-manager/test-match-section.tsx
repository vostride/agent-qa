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
import { Textarea } from "@/components/ui/textarea"
import { updateSettings } from "@/lib/api"

interface TestMatchSectionProps {
  config: Record<string, unknown>
  onConfigChange: () => void
}

export function TestMatchSection({ config, onConfigChange }: TestMatchSectionProps) {
  const workspace = (config.workspace ?? {}) as Record<string, unknown>
  const testMatch = ((workspace.testMatch ?? []) as string[])
  const testPathIgnore = ((workspace.testPathIgnore ?? []) as string[])
  const suiteMatch = ((workspace.suiteMatch ?? []) as string[])
  const [matchText, setMatchText] = useState(testMatch.join("\n"))
  const [ignoreText, setIgnoreText] = useState(testPathIgnore.join("\n"))
  const [suiteMatchText, setSuiteMatchText] = useState(suiteMatch.join("\n"))
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  async function handleSave() {
    const patterns = matchText.split("\n").map((s) => s.trim()).filter(Boolean)
    const ignorePatterns = ignoreText.split("\n").map((s) => s.trim()).filter(Boolean)
    const suitePatterns = suiteMatchText.split("\n").map((s) => s.trim()).filter(Boolean)
    const nextErrors: Record<string, string> = {}
    if (patterns.length === 0) nextErrors.testMatch = "workspace.testMatch must contain at least one pattern."
    if (suitePatterns.length === 0) nextErrors.suiteMatch = "workspace.suiteMatch must contain at least one pattern."
    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors)
      return
    }

    setErrors({})
    setSaving(true)
    try {
      await updateSettings({
        'workspace.testMatch': patterns,
        'workspace.suiteMatch': suitePatterns,
        'workspace.testPathIgnore': ignorePatterns,
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
        <h2 className="text-base font-semibold">Discovery</h2>
        <p className="text-sm text-muted-foreground">Configure test and suite discovery patterns</p>
      </ConfigSectionHeader>
      <ConfigSectionBody>
        <div className="space-y-2">
          <Label htmlFor="test-match">Test Match Patterns</Label>
          <Textarea
            id="test-match"
            placeholder="**/*.yaml"
            value={matchText}
            aria-invalid={errors.testMatch ? true : undefined}
            onChange={(e) => {
              setMatchText(e.target.value)
              if (errors.testMatch && e.target.value.split("\n").some((line) => line.trim())) {
                setErrors((current) => ({ ...current, testMatch: "" }))
              }
            }}
            className="min-h-[120px] font-mono text-sm"
          />
          <p className="text-xs text-muted-foreground">One glob pattern per line</p>
          {errors.testMatch ? <p className="text-xs text-destructive">{errors.testMatch}</p> : null}
        </div>

        <div className="space-y-2">
          <Label htmlFor="suite-match">Suite Match Patterns</Label>
          <Textarea
            id="suite-match"
            placeholder="**/*.suite.yaml"
            value={suiteMatchText}
            aria-invalid={errors.suiteMatch ? true : undefined}
            onChange={(e) => {
              setSuiteMatchText(e.target.value)
              if (errors.suiteMatch && e.target.value.split("\n").some((line) => line.trim())) {
                setErrors((current) => ({ ...current, suiteMatch: "" }))
              }
            }}
            className="min-h-[120px] font-mono text-sm"
          />
          <p className="text-xs text-muted-foreground">One glob pattern per line</p>
          {errors.suiteMatch ? <p className="text-xs text-destructive">{errors.suiteMatch}</p> : null}
        </div>

        <div className="space-y-2">
          <Label htmlFor="test-path-ignore">Test Path Ignore Patterns</Label>
          <Textarea
            id="test-path-ignore"
            placeholder="**/node_modules/**"
            value={ignoreText}
            onChange={(e) => setIgnoreText(e.target.value)}
            className="min-h-[120px] font-mono text-sm"
          />
          <p className="text-xs text-muted-foreground">One glob pattern per line</p>
        </div>

        <Button size="sm" onClick={handleSave} disabled={saving}>
          {saving ? <Loader2 className="size-4 animate-spin" /> : "Save Changes"}
        </Button>
      </ConfigSectionBody>
    </ConfigSectionShell>
  )
}
