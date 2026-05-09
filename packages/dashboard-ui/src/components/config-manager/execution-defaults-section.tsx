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
import { Switch } from "@/components/ui/switch"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

interface ExecutionDefaultsSectionProps {
  config: Record<string, unknown>
  onConfigChange: () => void
}

export function ExecutionDefaultsSection({ config, onConfigChange }: ExecutionDefaultsSectionProps) {
  const registry = (config.registry as Record<string, unknown> | undefined) ?? {}
  const useBlock = (config.use as Record<string, unknown> | undefined) ?? {}
  const llmConfigs = Array.isArray(registry.llms)
    ? (registry.llms as Array<Record<string, unknown>>)
    : []
  const llmNames = llmConfigs
    .map((llm) => llm.name)
    .filter((name): name is string => typeof name === 'string')

  const [defaultLlm, setDefaultLlm] = useState((useBlock.llm as string) ?? "")
  const [parallel, setParallel] = useState((useBlock.parallel as boolean) ?? false)
  const [saving, setSaving] = useState(false)

  async function handleSave() {
    const payload: Record<string, unknown> = {
      'use.parallel': parallel,
    }
    if (defaultLlm) payload['use.llm'] = defaultLlm

    setSaving(true)
    try {
      await updateSettings(payload)
      onConfigChange()
      toast.success("Runtime defaults saved")
    } catch {
      toast.error("Runtime defaults were not saved. Fix the setting and try again.")
    } finally {
      setSaving(false)
    }
  }

  return (
    <ConfigSectionShell>
      <ConfigSectionHeader>
        <h2 className="text-base font-semibold">Execution Defaults</h2>
        <p className="text-sm text-muted-foreground">Set shared runtime defaults used by tests and suites.</p>
      </ConfigSectionHeader>
      <ConfigSectionBody>
        <div className="flex flex-wrap gap-2">
          <Badge variant="secondary">Registry-backed</Badge>
          <Badge variant="outline" className="font-mono text-[11px]">use.llm</Badge>
          <Badge variant="outline" className="font-mono text-[11px]">use.parallel</Badge>
        </div>

        <div className="space-y-2">
          <Label htmlFor="use-default-llm">Default LLM</Label>
          {llmNames.length > 0 ? (
            <Select value={defaultLlm || undefined} onValueChange={setDefaultLlm}>
              <SelectTrigger id="use-default-llm">
                <SelectValue placeholder="Select an LLM from Registry / LLMs" />
              </SelectTrigger>
              <SelectContent>
                {llmNames.map((name) => (
                  <SelectItem key={name} value={name}>
                    {name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <ConfigLineNotice className="border-dashed px-3 py-2">
              <div className="font-medium text-foreground">No LLMs configured yet.</div>
              <div>Add an LLM in Registry / LLMs before selecting a default.</div>
            </ConfigLineNotice>
          )}
          <p className="text-xs text-muted-foreground">This value selects from entries defined in Registry.</p>
        </div>

        <div className="flex items-center justify-between gap-4">
          <div className="space-y-0.5">
            <Label htmlFor="use-parallel">Parallel Execution</Label>
            <p className="text-xs text-muted-foreground">Allow eligible web runs and suite parent jobs to share available queue slots by default.</p>
          </div>
          <Switch
            id="use-parallel"
            checked={parallel}
            onCheckedChange={setParallel}
          />
        </div>

        <Button size="sm" onClick={handleSave} disabled={saving}>
          {saving ? <Loader2 className="size-4 animate-spin" /> : "Save Runtime Defaults"}
        </Button>
      </ConfigSectionBody>
    </ConfigSectionShell>
  )
}
