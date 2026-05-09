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
import { parseConfigNumberInput } from "@/components/config-manager/numeric-input"
import { updateSettings } from "@/lib/api"

interface DashboardSectionProps {
  config: Record<string, unknown>
  onConfigChange: () => void
}

export function DashboardSection({ config, onConfigChange }: DashboardSectionProps) {
  const dashboard = ((config.services as any)?.dashboard ?? {}) as {
    port?: number
    dbPath?: string
    artifactsDir?: string
  }
  const [port, setPort] = useState(String(dashboard.port ?? 4173))
  const [dbPath, setDbPath] = useState(dashboard.dbPath ?? "")
  const [artifactsDir, setArtifactsDir] = useState(dashboard.artifactsDir ?? "")
  const [saving, setSaving] = useState(false)

  async function handleSave() {
    const parsedPort = parseConfigNumberInput(port, {
      label: "Port",
      min: 1,
      max: 65535,
      integer: true,
    })
    if (parsedPort.error) {
      toast.error(parsedPort.error)
      return
    }

    setSaving(true)
    try {
      await updateSettings({
        'services.dashboard': { port: parsedPort.value, dbPath, artifactsDir },
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
        <h2 className="text-base font-semibold">Dashboard</h2>
        <p className="text-sm text-muted-foreground">Configure dashboard server and storage paths</p>
      </ConfigSectionHeader>
      <ConfigSectionBody>
        <div className="space-y-2">
          <Label htmlFor="dashboard-port">Port</Label>
          <Input
            id="dashboard-port"
            type="number"
            min={1}
            max={65535}
            step={1}
            value={port}
            onChange={(e) => setPort(e.target.value)}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="dashboard-db-path">Database Path</Label>
          <Input
            id="dashboard-db-path"
            placeholder=".agent-qa/runs.db"
            value={dbPath}
            onChange={(e) => setDbPath(e.target.value)}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="dashboard-artifacts-dir">Artifacts Directory</Label>
          <Input
            id="dashboard-artifacts-dir"
            placeholder=".agent-qa/artifacts"
            value={artifactsDir}
            onChange={(e) => setArtifactsDir(e.target.value)}
          />
        </div>

        <Button size="sm" onClick={handleSave} disabled={saving}>
          {saving ? <Loader2 className="size-4 animate-spin" /> : "Save Changes"}
        </Button>
      </ConfigSectionBody>
    </ConfigSectionShell>
  )
}
