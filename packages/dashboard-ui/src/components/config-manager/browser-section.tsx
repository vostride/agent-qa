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
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { parseConfigNumberInput } from "@/components/config-manager/numeric-input"
import { updateSettings } from "@/lib/api"

interface BrowserSectionProps {
  config: Record<string, unknown>
  onConfigChange: () => void
}

export function BrowserSection({ config, onConfigChange }: BrowserSectionProps) {
  const browser = ((config.use as any)?.browser ?? {}) as {
    name?: string
    headless?: boolean
    viewport?: { width: number; height: number }
  }
  const [name, setName] = useState(browser.name ?? "chromium")
  const [headless, setHeadless] = useState(browser.headless ?? true)
  const initialViewport = browser.viewport ?? { width: 1280, height: 720 }
  const [viewportWidth, setViewportWidth] = useState(String(initialViewport.width))
  const [viewportHeight, setViewportHeight] = useState(String(initialViewport.height))
  const [saving, setSaving] = useState(false)

  async function handleSave() {
    const parsedWidth = parseConfigNumberInput(viewportWidth, {
      label: "Viewport width",
      min: 1,
      integer: true,
    })
    if (parsedWidth.error) {
      toast.error(parsedWidth.error)
      return
    }
    const parsedHeight = parseConfigNumberInput(viewportHeight, {
      label: "Viewport height",
      min: 1,
      integer: true,
    })
    if (parsedHeight.error) {
      toast.error(parsedHeight.error)
      return
    }

    setSaving(true)
    try {
      await updateSettings({
        'use.browser': {
          name,
          headless,
          viewport: { width: parsedWidth.value, height: parsedHeight.value },
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
        <h2 className="text-base font-semibold">Browser</h2>
        <p className="text-sm text-muted-foreground">Configure default browser settings for web test execution</p>
      </ConfigSectionHeader>
      <ConfigSectionBody>
        <div className="space-y-2">
          <Label htmlFor="browser-name">Browser</Label>
          <Select value={name} onValueChange={setName}>
            <SelectTrigger id="browser-name">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="chromium">Chromium</SelectItem>
              <SelectItem value="firefox">Firefox</SelectItem>
              <SelectItem value="webkit">WebKit</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <Label htmlFor="browser-headless">Headless</Label>
            <p className="text-xs text-muted-foreground">Run web browsers without a visible window.</p>
          </div>
          <Switch
            id="browser-headless"
            checked={headless}
            onCheckedChange={setHeadless}
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="browser-vw">Viewport Width</Label>
            <Input
              id="browser-vw"
              type="number"
              min={1}
              step={1}
              value={viewportWidth}
              onChange={(e) => setViewportWidth(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="browser-vh">Viewport Height</Label>
            <Input
              id="browser-vh"
              type="number"
              min={1}
              step={1}
              value={viewportHeight}
              onChange={(e) => setViewportHeight(e.target.value)}
            />
          </div>
        </div>

        <Button size="sm" onClick={handleSave} disabled={saving}>
          {saving ? <Loader2 className="size-4 animate-spin" /> : "Save Changes"}
        </Button>
      </ConfigSectionBody>
    </ConfigSectionShell>
  )
}
