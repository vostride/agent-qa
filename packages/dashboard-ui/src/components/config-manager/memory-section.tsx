import { useState } from "react"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"

import { updateSettings } from "@/lib/api"
import {
  ConfigSectionBody,
  ConfigSectionHeader,
  ConfigSectionShell,
} from "@/components/config-manager/config-section-shell"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { parseConfigNumberInput } from "@/components/config-manager/numeric-input"

interface MemorySectionProps {
  config: Record<string, unknown>
  onConfigChange: () => void
}

export function MemorySection({ config, onConfigChange }: MemorySectionProps) {
  const memory = (((config.services as Record<string, unknown> | undefined) ?? {}).memory ?? {}) as {
    enabled?: boolean
    provider?: string
    dir?: string
    minTrust?: number
    maxInjections?: number
    curatorEnabled?: boolean
    curatorLockTimeout?: number
    trustConfirmDelta?: number
    trustContradictDelta?: number
    ablationEnabled?: boolean
    circuitBreakerEnabled?: boolean
    circuitBreakerWindowSize?: number
    circuitBreakerBaselineSize?: number
    circuitBreakerThreshold?: number
  }

  const [enabled, setEnabled] = useState(memory.enabled ?? true)
  const [provider, setProvider] = useState(memory.provider ?? "local")
  const [dir, setDir] = useState(memory.dir ?? "agent-qa-memory")
  const [minTrust, setMinTrust] = useState(String(memory.minTrust ?? 0.3))
  const [maxInjections, setMaxInjections] = useState(String(memory.maxInjections ?? 3))
  const [curatorEnabled, setCuratorEnabled] = useState(memory.curatorEnabled ?? true)
  const [curatorLockTimeout, setCuratorLockTimeout] = useState(String(memory.curatorLockTimeout ?? 120000))
  const [trustConfirmDelta, setTrustConfirmDelta] = useState(String(memory.trustConfirmDelta ?? 0.05))
  const [trustContradictDelta, setTrustContradictDelta] = useState(String(memory.trustContradictDelta ?? 0.1))
  const [ablationEnabled, setAblationEnabled] = useState(memory.ablationEnabled ?? true)
  const [circuitBreakerEnabled, setCircuitBreakerEnabled] = useState(memory.circuitBreakerEnabled ?? true)
  const [circuitBreakerWindowSize, setCircuitBreakerWindowSize] = useState(String(memory.circuitBreakerWindowSize ?? 20))
  const [circuitBreakerBaselineSize, setCircuitBreakerBaselineSize] = useState(String(memory.circuitBreakerBaselineSize ?? 3))
  const [circuitBreakerThreshold, setCircuitBreakerThreshold] = useState(String(memory.circuitBreakerThreshold ?? 0.15))
  const [saving, setSaving] = useState(false)

  async function handleSave() {
    const trimmedDir = dir.trim()
    if (!trimmedDir) {
      toast.error("Memory directory is required")
      return
    }
    const parsedMinTrust = parseConfigNumberInput(minTrust, {
      label: "Min trust",
      min: 0,
      max: 1,
    })
    if (parsedMinTrust.error) {
      toast.error(parsedMinTrust.error)
      return
    }
    const parsedMaxInjections = parseConfigNumberInput(maxInjections, {
      label: "Max injections",
      min: 0,
      integer: true,
    })
    if (parsedMaxInjections.error) {
      toast.error(parsedMaxInjections.error)
      return
    }
    const parsedCuratorLockTimeout = parseConfigNumberInput(curatorLockTimeout, {
      label: "Curator lock timeout",
      min: 1000,
      integer: true,
    })
    if (parsedCuratorLockTimeout.error) {
      toast.error(parsedCuratorLockTimeout.error)
      return
    }
    const parsedTrustConfirmDelta = parseConfigNumberInput(trustConfirmDelta, {
      label: "Trust confirm delta",
      min: 0,
      max: 1,
    })
    if (parsedTrustConfirmDelta.error) {
      toast.error(parsedTrustConfirmDelta.error)
      return
    }
    const parsedTrustContradictDelta = parseConfigNumberInput(trustContradictDelta, {
      label: "Trust contradict delta",
      min: 0,
      max: 1,
    })
    if (parsedTrustContradictDelta.error) {
      toast.error(parsedTrustContradictDelta.error)
      return
    }
    const parsedCircuitBreakerWindowSize = parseConfigNumberInput(circuitBreakerWindowSize, {
      label: "Circuit breaker window size",
      min: 5,
      integer: true,
    })
    if (parsedCircuitBreakerWindowSize.error) {
      toast.error(parsedCircuitBreakerWindowSize.error)
      return
    }
    const parsedCircuitBreakerBaselineSize = parseConfigNumberInput(circuitBreakerBaselineSize, {
      label: "Circuit breaker baseline size",
      min: 2,
      integer: true,
    })
    if (parsedCircuitBreakerBaselineSize.error) {
      toast.error(parsedCircuitBreakerBaselineSize.error)
      return
    }
    const parsedCircuitBreakerThreshold = parseConfigNumberInput(circuitBreakerThreshold, {
      label: "Circuit breaker threshold",
      min: 0,
      max: 1,
    })
    if (parsedCircuitBreakerThreshold.error) {
      toast.error(parsedCircuitBreakerThreshold.error)
      return
    }

    setSaving(true)
    try {
      await updateSettings({
        'services.memory': {
          enabled,
          provider,
          dir: trimmedDir,
          minTrust: parsedMinTrust.value,
          maxInjections: parsedMaxInjections.value,
          curatorEnabled,
          curatorLockTimeout: parsedCuratorLockTimeout.value,
          trustConfirmDelta: parsedTrustConfirmDelta.value,
          trustContradictDelta: parsedTrustContradictDelta.value,
          ablationEnabled,
          circuitBreakerEnabled,
          circuitBreakerWindowSize: parsedCircuitBreakerWindowSize.value,
          circuitBreakerBaselineSize: parsedCircuitBreakerBaselineSize.value,
          circuitBreakerThreshold: parsedCircuitBreakerThreshold.value,
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
        <h2 className="text-base font-semibold">Memory</h2>
        <p className="mt-1 text-sm text-muted-foreground">Configure runtime memory injection thresholds, curator behavior, and safety guards.</p>
      </ConfigSectionHeader>
      <ConfigSectionBody>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="memory-provider">Provider</Label>
            <Select value={provider} onValueChange={setProvider}>
              <SelectTrigger id="memory-provider">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="local">Local</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="memory-dir">Memory Directory</Label>
            <Input
              id="memory-dir"
              placeholder="agent-qa-memory"
              value={dir}
              onChange={(e) => setDir(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="memory-min-trust">Min Trust</Label>
            <Input
              id="memory-min-trust"
              type="number"
              min="0"
              max="1"
              step="0.01"
              value={minTrust}
              onChange={(e) => setMinTrust(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="memory-max-injections">Max Injections</Label>
            <Input
              id="memory-max-injections"
              type="number"
              min="0"
              value={maxInjections}
              onChange={(e) => setMaxInjections(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="memory-curator-lock-timeout">Curator Lock Timeout (ms)</Label>
            <Input
              id="memory-curator-lock-timeout"
              type="number"
              min="1000"
              step="1000"
              value={curatorLockTimeout}
              onChange={(e) => setCuratorLockTimeout(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="memory-confirm-delta">Trust Confirm Delta</Label>
            <Input
              id="memory-confirm-delta"
              type="number"
              min="0"
              max="1"
              step="0.01"
              value={trustConfirmDelta}
              onChange={(e) => setTrustConfirmDelta(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="memory-contradict-delta">Trust Contradict Delta</Label>
            <Input
              id="memory-contradict-delta"
              type="number"
              min="0"
              max="1"
              step="0.01"
              value={trustContradictDelta}
              onChange={(e) => setTrustContradictDelta(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="memory-circuit-window">Circuit Breaker Window Size</Label>
            <Input
              id="memory-circuit-window"
              type="number"
              min="5"
              value={circuitBreakerWindowSize}
              onChange={(e) => setCircuitBreakerWindowSize(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="memory-circuit-baseline">Circuit Breaker Baseline Size</Label>
            <Input
              id="memory-circuit-baseline"
              type="number"
              min="2"
              value={circuitBreakerBaselineSize}
              onChange={(e) => setCircuitBreakerBaselineSize(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="memory-circuit-threshold">Circuit Breaker Threshold</Label>
            <Input
              id="memory-circuit-threshold"
              type="number"
              min="0"
              max="1"
              step="0.01"
              value={circuitBreakerThreshold}
              onChange={(e) => setCircuitBreakerThreshold(e.target.value)}
            />
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <ToggleRow
            id="memory-enabled"
            label="Enabled"
            description="Allow runtime memory retrieval and injection during execution."
            checked={enabled}
            onCheckedChange={setEnabled}
          />
          <ToggleRow
            id="memory-curator-enabled"
            label="Curator Enabled"
            description="Allow the curator to confirm, reject, and refine candidate memories."
            checked={curatorEnabled}
            onCheckedChange={setCuratorEnabled}
          />
          <ToggleRow
            id="memory-ablation-enabled"
            label="Ablation Enabled"
            description="Permit ablation passes that measure whether injected memories help or hurt."
            checked={ablationEnabled}
            onCheckedChange={setAblationEnabled}
          />
          <ToggleRow
            id="memory-circuit-enabled"
            label="Circuit Breaker Enabled"
            description="Temporarily suppress memory injection when observed quality regresses."
            checked={circuitBreakerEnabled}
            onCheckedChange={setCircuitBreakerEnabled}
          />
        </div>

        <Button size="sm" onClick={handleSave} disabled={saving}>
          {saving ? <Loader2 className="size-4 animate-spin" /> : "Save Changes"}
        </Button>
      </ConfigSectionBody>
    </ConfigSectionShell>
  )
}

function ToggleRow({
  id,
  label,
  description,
  checked,
  onCheckedChange,
}: {
  id: string
  label: string
  description: string
  checked: boolean
  onCheckedChange: (checked: boolean) => void
}) {
  return (
    <div className="flex items-center justify-between gap-4 border border-border bg-transparent rounded-none px-4 py-3">
      <div className="space-y-0.5">
        <Label htmlFor={id}>{label}</Label>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} />
    </div>
  )
}
