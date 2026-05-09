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
import { Button } from "@/components/ui/button"

interface FilesSectionProps {
  config: Record<string, unknown>
  onConfigChange: () => void
}

export function FilesSection({ config, onConfigChange }: FilesSectionProps) {
  const workspace = ((config.workspace as Record<string, unknown> | undefined) ?? {})
  const [hooksFile, setHooksFile] = useState((workspace.hooksFile as string) ?? "")
  const [agentRules, setAgentRules] = useState((workspace.agentRules as string) ?? "")
  const [envFile, setEnvFile] = useState((workspace.envFile as string) ?? "")
  const [secretsFile, setSecretsFile] = useState((workspace.secretsFile as string) ?? "")
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  async function handleSave() {
    const nextErrors: Record<string, string> = {}
    if (hooksFile.trim().length === 0) nextErrors.hooksFile = "Hooks file is required."
    if (agentRules.trim().length === 0) nextErrors.agentRules = "Agent rules file is required."
    if (envFile.trim().length === 0) nextErrors.envFile = "Environment file is required."
    if (secretsFile.trim().length === 0) nextErrors.secretsFile = "Secrets file is required."
    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors)
      return
    }
    setErrors({})
    setSaving(true)
    try {
      await updateSettings({
        'workspace.hooksFile': hooksFile.trim(),
        'workspace.agentRules': agentRules.trim(),
        'workspace.envFile': envFile.trim(),
        'workspace.secretsFile': secretsFile.trim(),
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
        <h2 className="text-base font-semibold">Files</h2>
        <p className="text-sm text-muted-foreground">Set shared workspace file paths for hooks, environment loading, and runtime-only secrets.</p>
      </ConfigSectionHeader>
      <ConfigSectionBody>
        <div className="space-y-2">
          <Label htmlFor="workspace-hooks-file">Hooks File</Label>
          <Input
            id="workspace-hooks-file"
            placeholder="tests/hooks.ts"
            value={hooksFile}
            aria-invalid={errors.hooksFile ? true : undefined}
            onChange={(e) => {
              setHooksFile(e.target.value)
              if (errors.hooksFile && e.target.value.trim().length > 0) setErrors((current) => ({ ...current, hooksFile: "" }))
            }}
          />
          <p className="text-xs text-muted-foreground">Path to the shared hooks module used across tests and suites.</p>
          {errors.hooksFile ? <p className="text-xs text-destructive">{errors.hooksFile}</p> : null}
        </div>

        <div className="space-y-2">
          <Label htmlFor="workspace-agent-rules">Agent Rules File</Label>
          <Input
            id="workspace-agent-rules"
            placeholder="agent-rules.md"
            value={agentRules}
            aria-invalid={errors.agentRules ? true : undefined}
            onChange={(e) => {
              setAgentRules(e.target.value)
              if (errors.agentRules && e.target.value.trim().length > 0) setErrors((current) => ({ ...current, agentRules: "" }))
            }}
          />
          <p className="text-xs text-muted-foreground">Required instructions file loaded for agent runs.</p>
          {errors.agentRules ? <p className="text-xs text-destructive">{errors.agentRules}</p> : null}
        </div>

        <div className="space-y-2">
          <Label htmlFor="workspace-env-file">Environment File</Label>
          <Input
            id="workspace-env-file"
            placeholder=".env.local"
            value={envFile}
            aria-invalid={errors.envFile ? true : undefined}
            onChange={(e) => {
              setEnvFile(e.target.value)
              if (errors.envFile && e.target.value.trim().length > 0) setErrors((current) => ({ ...current, envFile: "" }))
            }}
          />
          <p className="text-xs text-muted-foreground">Required dotenv file loaded before runs start.</p>
          {errors.envFile ? <p className="text-xs text-destructive">{errors.envFile}</p> : null}
        </div>

        <div className="space-y-2">
          <Label htmlFor="workspace-secrets-file">Secrets File</Label>
          <Input
            id="workspace-secrets-file"
            placeholder=".secrets.local"
            value={secretsFile}
            aria-invalid={errors.secretsFile ? true : undefined}
            onChange={(e) => {
              setSecretsFile(e.target.value)
              if (errors.secretsFile && e.target.value.trim().length > 0) setErrors((current) => ({ ...current, secretsFile: "" }))
            }}
          />
          <p className="text-xs text-muted-foreground">Required dotenv-style file for runtime-only secrets.</p>
          {errors.secretsFile ? <p className="text-xs text-destructive">{errors.secretsFile}</p> : null}
        </div>

        <Button size="sm" onClick={handleSave} disabled={saving}>
          {saving ? <Loader2 className="size-4 animate-spin" /> : "Save Changes"}
        </Button>
      </ConfigSectionBody>
    </ConfigSectionShell>
  )
}
