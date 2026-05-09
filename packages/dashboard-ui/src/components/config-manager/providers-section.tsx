import { useEffect, useMemo, useState } from "react"
import { Loader2, Pencil, Plus, Trash2 } from "lucide-react"
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
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

interface ProvidersSectionProps {
  config: Record<string, unknown>
  onConfigChange: () => void
}

export function ProvidersSection({ config, onConfigChange }: ProvidersSectionProps) {
  const initialProviders = useMemo(
    () => (((config.registry as Record<string, unknown> | undefined) ?? {}).providers ?? {}) as Record<string, Record<string, unknown>>,
    [config],
  )
  const [providers, setProviders] = useState<Record<string, Record<string, unknown>>>(initialProviders)
  const [editingName, setEditingName] = useState<string | null>(null)
  const [draftName, setDraftName] = useState("")
  const [draftJson, setDraftJson] = useState("{}")
  const [dialogOpen, setDialogOpen] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setProviders(initialProviders)
  }, [initialProviders])

  function resetDraft() {
    setEditingName(null)
    setDraftName("")
    setDraftJson("{}")
  }

  function openCreateDialog() {
    resetDraft()
    setDialogOpen(true)
  }

  function parseProviderJson() {
    try {
      const parsed = JSON.parse(draftJson || "{}")
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        toast.error("Provider config must be a JSON object")
        return null
      }
      return parsed as Record<string, unknown>
    } catch {
      toast.error("Provider config must be valid JSON")
      return null
    }
  }

  function handleApplyProvider() {
    if (!draftName.trim()) {
      toast.error("Provider key is required")
      return
    }
    const parsed = parseProviderJson()
    if (!parsed) return

    const trimmedName = draftName.trim()
    const nextProviders = { ...providers }
    if (editingName && editingName !== trimmedName) {
      delete nextProviders[editingName]
    }
    nextProviders[trimmedName] = parsed
    setProviders(nextProviders)
    setDialogOpen(false)
    resetDraft()
  }

  function handleEdit(name: string) {
    setEditingName(name)
    setDraftName(name)
    setDraftJson(JSON.stringify(providers[name] ?? {}, null, 2))
    setDialogOpen(true)
  }

  async function handleSave() {
    setSaving(true)
    try {
      await updateSettings({ "registry.providers": providers })
      onConfigChange()
      toast.success("Changes saved")
    } catch {
      toast.error("Failed to save configuration")
    } finally {
      setSaving(false)
    }
  }

  const providerNames = Object.keys(providers).sort()

  return (
    <>
      <ConfigSectionShell>
        <ConfigSectionHeader>
          <h2 className="text-base font-semibold">Providers</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Store provider-keyed integration config for BrowserStack and other supported remote services.
          </p>
        </ConfigSectionHeader>
        <ConfigSectionBody>
          <div className="space-y-3 border border-border bg-transparent rounded-none px-4 py-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="space-y-1">
                <p className="text-sm font-medium">Provider integration registry</p>
                <p className="text-xs text-muted-foreground">
                  Use this when a transport or integration expects provider-specific JSON keyed by provider name.
                </p>
              </div>
              <Button size="sm" onClick={openCreateDialog}>
                <Plus className="size-4" />
                Add Provider
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              The schema is intentionally open-ended. The dashboard keeps the editor as raw JSON, parses it locally, and the config backend validates the final object again on save.
            </p>
          </div>

          <div className="space-y-3">
            {providerNames.length === 0 ? (
              <div className="border border-dashed border-border bg-transparent rounded-none p-6 text-sm text-muted-foreground">
                No providers configured. Add provider JSON when a remote integration needs named credentials or settings.
              </div>
            ) : (
              providerNames.map((name) => (
                <div key={name} className="border border-border bg-transparent rounded-none px-4 py-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-medium">{name}</p>
                        <Badge variant="secondary">Integration JSON</Badge>
                      </div>
                      <pre className="overflow-auto rounded-none bg-muted/40 p-3 text-xs text-muted-foreground">
                        {JSON.stringify(providers[name] ?? {}, null, 2)}
                      </pre>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button variant="outline" size="sm" onClick={() => handleEdit(name)}>
                        <Pencil className="size-4" />
                        Edit
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setProviders((current) => {
                          const next = { ...current }
                          delete next[name]
                          return next
                        })}
                      >
                        <Trash2 className="size-4" />
                        Delete
                      </Button>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>

          <Button size="sm" onClick={handleSave} disabled={saving}>
            {saving ? <Loader2 className="size-4 animate-spin" /> : "Save Changes"}
          </Button>
        </ConfigSectionBody>
      </ConfigSectionShell>

      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open)
          if (!open) resetDraft()
        }}
      >
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{editingName ? `Edit ${editingName}` : "Add Provider"}</DialogTitle>
            <DialogDescription>
              Update the provider entry in this section draft. Use Save Changes in the section to persist it to config.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="provider-key">Provider Key</Label>
              <Input
                id="provider-key"
                placeholder="browserstack"
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="provider-json">Provider JSON</Label>
              <Textarea
                id="provider-json"
                className="min-h-[200px] font-mono text-sm"
                value={draftJson}
                onChange={(e) => setDraftJson(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Keep provider payloads honest to the integration contract. This surface does not invent provider-specific forms.
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleApplyProvider}>
              {editingName ? "Apply Provider Changes" : "Add Provider to Section"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
