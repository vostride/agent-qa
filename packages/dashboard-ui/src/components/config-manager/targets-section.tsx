import { useEffect, useMemo, useState } from "react"
import { Loader2, Pencil, Plus, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { selectApprovedSaasPlaceholderSlug } from "@vostride/agent-qa-ids"

import { updateSettings } from "@/lib/api"
import {
  ConfigSectionBody,
  ConfigSectionHeader,
  ConfigSectionShell,
} from "@/components/config-manager/config-section-shell"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

type TargetPlatform = "web" | "android" | "ios"

interface TargetEntry {
  product?: string
  platform: TargetPlatform
  bundleId?: string
  appPackage?: string
  appActivity?: string
  app?: {
    path?: string
    browserstack?: string
  }
  url?: string
}

interface TargetsSectionProps {
  config: Record<string, unknown>
  onConfigChange: () => void
}

const EMPTY_TARGET: TargetEntry = {
  platform: "web",
  product: "",
  bundleId: "",
  appPackage: "",
  appActivity: "",
  app: {
    path: "",
    browserstack: "",
  },
  url: "",
}

const TARGET_PRODUCT_PLACEHOLDER = selectApprovedSaasPlaceholderSlug("dashboard.config.targets.product")

export function TargetsSection({ config, onConfigChange }: TargetsSectionProps) {
  const initialTargets = useMemo(
    () => (((config.registry as Record<string, unknown> | undefined) ?? {}).targets ?? {}) as Record<string, TargetEntry>,
    [config],
  )
  const [targets, setTargets] = useState<Record<string, TargetEntry>>(initialTargets)
  const [editingName, setEditingName] = useState<string | null>(null)
  const [draftName, setDraftName] = useState("")
  const [draftTarget, setDraftTarget] = useState<TargetEntry>(EMPTY_TARGET)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setTargets(initialTargets)
  }, [initialTargets])

  function resetDraft() {
    setEditingName(null)
    setDraftName("")
    setDraftTarget(EMPTY_TARGET)
  }

  function openCreateDialog() {
    resetDraft()
    setDialogOpen(true)
  }

  function validateDraft() {
    if (!draftName.trim()) {
      toast.error("Target name is required")
      return false
    }
    if (draftTarget.platform === "web" && !draftTarget.url?.trim()) {
      toast.error("Web targets must include a URL")
      return false
    }
    return true
  }

  function handleApplyTarget() {
    if (!validateDraft()) return
    const trimmedName = draftName.trim()
    const nextTargets = { ...targets }
    if (editingName && editingName !== trimmedName) {
      delete nextTargets[editingName]
    }
    const appPath = draftTarget.app?.path?.trim()
    const browserstackApp = draftTarget.app?.browserstack?.trim()
    const app = draftTarget.platform !== "web" && (appPath || browserstackApp)
      ? {
          ...(appPath ? { path: appPath } : {}),
          ...(browserstackApp ? { browserstack: browserstackApp } : {}),
        }
      : undefined
    nextTargets[trimmedName] = {
      platform: draftTarget.platform,
      ...(draftTarget.product?.trim() ? { product: draftTarget.product.trim() } : {}),
      ...(draftTarget.url?.trim() ? { url: draftTarget.url.trim() } : {}),
      ...(draftTarget.bundleId?.trim() ? { bundleId: draftTarget.bundleId.trim() } : {}),
      ...(draftTarget.appPackage?.trim() ? { appPackage: draftTarget.appPackage.trim() } : {}),
      ...(draftTarget.appActivity?.trim() ? { appActivity: draftTarget.appActivity.trim() } : {}),
      ...(app ? { app } : {}),
    }
    setTargets(nextTargets)
    setDialogOpen(false)
    resetDraft()
  }

  function handleEdit(name: string) {
    const target = targets[name]
    if (!target) return
    setEditingName(name)
    setDraftName(name)
    setDraftTarget({
      platform: target.platform,
      product: target.product ?? "",
      url: target.url ?? "",
      bundleId: target.bundleId ?? "",
      appPackage: target.appPackage ?? "",
      appActivity: target.appActivity ?? "",
      app: {
        path: target.app?.path ?? "",
        browserstack: target.app?.browserstack ?? "",
      },
    })
    setDialogOpen(true)
  }

  async function handleSave() {
    setSaving(true)
    try {
      await updateSettings({ "registry.targets": targets })
      onConfigChange()
      toast.success("Changes saved")
    } catch {
      toast.error("Failed to save configuration")
    } finally {
      setSaving(false)
    }
  }

  const names = Object.keys(targets).sort()

  return (
    <>
      <ConfigSectionShell>
        <ConfigSectionHeader>
          <h2 className="text-base font-semibold">Targets</h2>
          <p className="mt-1 text-sm text-muted-foreground">Manage reusable named web and mobile targets referenced elsewhere in agent-qa.</p>
        </ConfigSectionHeader>
        <ConfigSectionBody>
          <div className="flex flex-wrap items-start justify-between gap-3 border border-border bg-transparent rounded-none px-4 py-3">
            <div className="space-y-1">
              <p className="text-sm font-medium">Reusable target entries</p>
              <p className="text-xs text-muted-foreground">
                Use the target editor to define a named URL, bundle ID, or app package once and reference it across tests and suites.
              </p>
            </div>
            <Button size="sm" onClick={openCreateDialog}>
              <Plus className="size-4" />
              Add Target
            </Button>
          </div>

          <div className="space-y-3">
            {names.length === 0 ? (
              <div className="border border-dashed border-border bg-transparent rounded-none p-6 text-sm text-muted-foreground">
                No targets configured. Add a named target to make it selectable across tests and suites.
              </div>
            ) : (
              names.map((name) => {
                const target = targets[name]
                return (
                  <div key={name} className="border border-border bg-transparent rounded-none px-4 py-3">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="space-y-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="font-medium">{name}</p>
                          <Badge variant="secondary">{target.platform}</Badge>
                        </div>
                        <p className="text-sm text-muted-foreground">{summarizeTarget(target)}</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <Button variant="outline" size="sm" onClick={() => handleEdit(name)}>
                          <Pencil className="size-4" />
                          Edit
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setTargets((current) => {
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
                )
              })
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
            <DialogTitle>{editingName ? `Edit ${editingName}` : "Add Target"}</DialogTitle>
            <DialogDescription>
              Update the target entry in this section draft. Use Save Changes in the section to persist it to config.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="target-name">Target Name</Label>
              <Input
                id="target-name"
                placeholder="staging-web"
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="target-platform">Platform</Label>
              <Select
                value={draftTarget.platform}
                onValueChange={(value) => setDraftTarget((current) => ({ ...current, platform: value as TargetPlatform }))}
              >
                <SelectTrigger id="target-platform">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="web">Web</SelectItem>
                  <SelectItem value="android">Android</SelectItem>
                  <SelectItem value="ios">iOS</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2 md:col-span-2">
              <Label htmlFor="target-product">Product</Label>
              <Input
                id="target-product"
                placeholder={TARGET_PRODUCT_PLACEHOLDER}
                value={draftTarget.product ?? ""}
                onChange={(e) => setDraftTarget((current) => ({ ...current, product: e.target.value }))}
              />
            </div>

            {draftTarget.platform === "web" ? (
              <div className="space-y-2 md:col-span-2">
                <Label htmlFor="target-url">URL</Label>
                <Input
                  id="target-url"
                  placeholder="https://staging.example.com"
                  value={draftTarget.url ?? ""}
                  onChange={(e) => setDraftTarget((current) => ({ ...current, url: e.target.value }))}
                />
              </div>
            ) : (
              <>
                {draftTarget.platform === "ios" ? (
                  <div className="space-y-2 md:col-span-2">
                    <Label htmlFor="target-bundle-id">Bundle ID</Label>
                    <Input
                      id="target-bundle-id"
                      placeholder="com.example.ios"
                      value={draftTarget.bundleId ?? ""}
                      onChange={(e) => setDraftTarget((current) => ({ ...current, bundleId: e.target.value }))}
                    />
                  </div>
                ) : (
                  <>
                    <div className="space-y-2">
                      <Label htmlFor="target-app-package">App Package</Label>
                      <Input
                        id="target-app-package"
                        placeholder="com.example.android"
                        value={draftTarget.appPackage ?? ""}
                        onChange={(e) => setDraftTarget((current) => ({ ...current, appPackage: e.target.value }))}
                      />
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="target-app-activity">App Activity</Label>
                      <Input
                        id="target-app-activity"
                        placeholder=".MainActivity"
                        value={draftTarget.appActivity ?? ""}
                        onChange={(e) => setDraftTarget((current) => ({ ...current, appActivity: e.target.value }))}
                      />
                    </div>
                  </>
                )}
                <div className="space-y-2 md:col-span-2">
                  <Label htmlFor="target-app-path">App Path</Label>
                  <Input
                    id="target-app-path"
                    placeholder="apps/wikipedia-alpha.apk"
                    value={draftTarget.app?.path ?? ""}
                    onChange={(e) => setDraftTarget((current) => ({
                      ...current,
                      app: {
                        ...(current.app ?? {}),
                        path: e.target.value,
                      },
                    }))}
                  />
                </div>

                <div className="space-y-2 md:col-span-2">
                  <Label htmlFor="target-browserstack-app">BrowserStack App</Label>
                  <Input
                    id="target-browserstack-app"
                    placeholder="bs://... or custom_id"
                    value={draftTarget.app?.browserstack ?? ""}
                    onChange={(e) => setDraftTarget((current) => ({
                      ...current,
                      app: {
                        ...(current.app ?? {}),
                        browserstack: e.target.value,
                      },
                    }))}
                  />
                </div>
              </>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleApplyTarget}>
              {editingName ? "Apply Target Changes" : "Add Target to Section"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

function summarizeTarget(target: TargetEntry) {
  const appSummary = summarizeAppInstall(target)
  const withAppSummary = (summary: string) => appSummary ? `${summary} | App: ${appSummary}` : summary

  if (target.platform === "web") {
    return target.url ?? "Web target without URL"
  }
  if (target.platform === "ios") {
    return withAppSummary(target.bundleId ?? "iOS target")
  }
  const parts = [target.appPackage, target.appActivity].filter(Boolean)
  return withAppSummary(parts.length > 0 ? parts.join(" / ") : "Android target")
}

function summarizeAppInstall(target: TargetEntry) {
  if (target.platform === "web") return null
  const parts = [target.app?.path, target.app?.browserstack].filter(Boolean)
  return parts.length > 0 ? parts.join(" / ") : null
}
