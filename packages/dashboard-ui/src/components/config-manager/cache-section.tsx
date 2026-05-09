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

interface CacheSectionProps {
  config: Record<string, unknown>
  onConfigChange: () => void
}

export function CacheSection({ config, onConfigChange }: CacheSectionProps) {
  const cache = ((config.services as any)?.cache ?? {}) as { dir?: string; ttl?: string }
  const [dir, setDir] = useState(cache.dir ?? "")
  const [ttl, setTtl] = useState(cache.ttl ?? "")
  const [saving, setSaving] = useState(false)

  async function handleSave() {
    setSaving(true)
    try {
      await updateSettings({ 'services.cache': { dir, ttl } })
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
        <h2 className="text-base font-semibold">Cache</h2>
        <p className="text-sm text-muted-foreground">Configure action cache directory and expiration</p>
      </ConfigSectionHeader>
      <ConfigSectionBody>
        <div className="space-y-2">
          <Label htmlFor="cache-dir">Cache Directory</Label>
          <Input
            id="cache-dir"
            placeholder=".agent-qa/cache"
            value={dir}
            onChange={(e) => setDir(e.target.value)}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="cache-ttl">TTL</Label>
          <Input
            id="cache-ttl"
            placeholder="7d"
            value={ttl}
            onChange={(e) => setTtl(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">Cache time-to-live — human-readable duration (e.g., "7d", "24h", "30m")</p>
        </div>

        <Button size="sm" onClick={handleSave} disabled={saving}>
          {saving ? <Loader2 className="size-4 animate-spin" /> : "Save Changes"}
        </Button>
      </ConfigSectionBody>
    </ConfigSectionShell>
  )
}
