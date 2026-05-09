import { Label } from "@/components/ui/label"
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Input } from "@/components/ui/input"
import type { ConfigSectionProps } from "./platform-section"

const BROWSERS = [
  { value: "chromium", label: "Chromium" },
  { value: "firefox", label: "Firefox" },
  { value: "webkit", label: "WebKit" },
]

const VIEWPORT_PRESETS = [
  { value: "desktop", label: "Desktop (1920\u00d71080)", width: 1920, height: 1080 },
  { value: "laptop", label: "Laptop (1366\u00d7768)", width: 1366, height: 768 },
  { value: "tablet", label: "Tablet (768\u00d71024)", width: 768, height: 1024 },
  { value: "mobile", label: "Mobile (375\u00d7812)", width: 375, height: 812 },
  { value: "custom", label: "Custom", width: 0, height: 0 },
]

function matchPreset(width: unknown, height: unknown): string {
  if (typeof width !== "number" || typeof height !== "number") return ""
  const match = VIEWPORT_PRESETS.find(
    (p) => p.value !== "custom" && p.width === width && p.height === height,
  )
  return match ? match.value : "custom"
}

export function BrowserSection({
  getIn,
  onChange,
}: ConfigSectionProps) {
  const browserName = getIn(["config", "browser", "name"]) as string | undefined
  const headless = getIn(["config", "browser", "headless"]) as boolean | undefined
  const vpWidth = getIn(["config", "browser", "viewport", "width"]) as
    | number
    | undefined
  const vpHeight = getIn(["config", "browser", "viewport", "height"]) as
    | number
    | undefined

  const currentPreset = matchPreset(vpWidth, vpHeight)
  const isCustom = currentPreset === "custom"

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label>Browser</Label>
        <Select
          value={browserName ?? ""}
          onValueChange={(v) => onChange(["config", "browser", "name"], v)}
        >
          <SelectTrigger className="w-full">
            <SelectValue placeholder="Select browser" />
          </SelectTrigger>
          <SelectContent>
            {BROWSERS.map((b) => (
              <SelectItem key={b.value} value={b.value}>
                {b.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex items-center justify-between">
        <Label>Headless</Label>
        <Switch
          size="sm"
          checked={headless ?? true}
          onCheckedChange={(checked) =>
            onChange(["config", "browser", "headless"], checked)
          }
        />
      </div>

      <div className="space-y-2">
        <Label>Viewport</Label>
        <Select
          value={currentPreset}
          onValueChange={(v) => {
            const preset = VIEWPORT_PRESETS.find((p) => p.value === v)
            if (preset && preset.value !== "custom") {
              onChange(["config", "browser", "viewport"], {
                width: preset.width,
                height: preset.height,
              })
            }
          }}
        >
          <SelectTrigger className="w-full">
            <SelectValue placeholder="Select viewport" />
          </SelectTrigger>
          <SelectContent>
            {VIEWPORT_PRESETS.map((p) => (
              <SelectItem key={p.value} value={p.value}>
                {p.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {isCustom && (
          <div className="flex gap-2">
            <div className="flex-1 space-y-1">
              <Label className="text-xs text-muted-foreground">Width</Label>
              <Input
                type="number"
                value={vpWidth ?? ""}
                onChange={(e) => {
                  const val = parseInt(e.target.value, 10)
                  if (!isNaN(val)) {
                    onChange(["config", "browser", "viewport", "width"], val)
                  }
                }}
                onBlur={(e) => {
                  const val = parseInt(e.target.value, 10)
                  if (!isNaN(val)) {
                    onChange(["config", "browser", "viewport", "width"], val)
                  }
                }}
              />
            </div>
            <div className="flex-1 space-y-1">
              <Label className="text-xs text-muted-foreground">Height</Label>
              <Input
                type="number"
                value={vpHeight ?? ""}
                onChange={(e) => {
                  const val = parseInt(e.target.value, 10)
                  if (!isNaN(val)) {
                    onChange(["config", "browser", "viewport", "height"], val)
                  }
                }}
                onBlur={(e) => {
                  const val = parseInt(e.target.value, 10)
                  if (!isNaN(val)) {
                    onChange(["config", "browser", "viewport", "height"], val)
                  }
                }}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
