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
import { Badge } from "@/components/ui/badge"
import { Textarea } from "@/components/ui/textarea"
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

type DevicePlatform = "android" | "ios"
type DeviceTransport = "local" | "browserstack"

export const DEVICE_TRANSPORT_OPTIONS: { value: DeviceTransport; label: string }[] = [
  { value: "local", label: "Local" },
  { value: "browserstack", label: "BrowserStack" },
]

interface DeviceEntry {
  platform: DevicePlatform
  transport: DeviceTransport
  match?: Record<string, unknown>
}

interface DevicesSectionProps {
  config: Record<string, unknown>
  onConfigChange: () => void
}

const LOCAL_MATCH_FIELDS: Record<DevicePlatform, string[]> = {
  android: ["avd", "serial", "appPackage", "appActivity", "automationName", "browserName", "platformVersion"],
  ios: ["udid", "bundleId", "automationName", "platformVersion"],
}

const EMPTY_DEVICE: DeviceEntry = {
  platform: "android",
  transport: "local",
  match: {},
}

export function DevicesSection({ config, onConfigChange }: DevicesSectionProps) {
  const initialDevices = useMemo(
    () => (((config.registry as Record<string, unknown> | undefined) ?? {}).devices ?? {}) as Record<string, DeviceEntry>,
    [config],
  )
  const [devices, setDevices] = useState<Record<string, DeviceEntry>>(initialDevices)
  const [editingName, setEditingName] = useState<string | null>(null)
  const [draftName, setDraftName] = useState("")
  const [draftDevice, setDraftDevice] = useState<DeviceEntry>(EMPTY_DEVICE)
  const [matchText, setMatchText] = useState("{}")
  const [dialogOpen, setDialogOpen] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setDevices(initialDevices)
  }, [initialDevices])

  function resetDraft() {
    setEditingName(null)
    setDraftName("")
    setDraftDevice(EMPTY_DEVICE)
    setMatchText("{}")
  }

  function openCreateDialog() {
    resetDraft()
    setDialogOpen(true)
  }

  function parseMatch() {
    try {
      const parsed = JSON.parse(matchText || "{}")
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        toast.error("Device match must be a JSON object")
        return null
      }
      const match = parsed as Record<string, unknown>
      if (draftDevice.transport === "local") {
        const allowed = LOCAL_MATCH_FIELDS[draftDevice.platform]
        const invalidKeys = Object.keys(match).filter((key) => !allowed.includes(key))
        if (invalidKeys.length > 0) {
          toast.error(`Invalid local match fields: ${invalidKeys.join(", ")}`)
          return null
        }
      }
      return match
    } catch {
      toast.error("Device match must be valid JSON")
      return null
    }
  }

  function handleApplyDevice() {
    if (!draftName.trim()) {
      toast.error("Device name is required")
      return
    }
    const parsedMatch = parseMatch()
    if (!parsedMatch) return

    const trimmedName = draftName.trim()
    const nextDevices = { ...devices }
    if (editingName && editingName !== trimmedName) {
      delete nextDevices[editingName]
    }
    nextDevices[trimmedName] = {
      platform: draftDevice.platform,
      transport: draftDevice.transport,
      match: parsedMatch,
    }
    setDevices(nextDevices)
    setDialogOpen(false)
    resetDraft()
  }

  function handleEdit(name: string) {
    const device = devices[name]
    if (!device) return
    setEditingName(name)
    setDraftName(name)
    setDraftDevice({
      platform: device.platform,
      transport: device.transport,
      match: device.match ?? {},
    })
    setMatchText(JSON.stringify(device.match ?? {}, null, 2))
    setDialogOpen(true)
  }

  async function handleSave() {
    setSaving(true)
    try {
      await updateSettings({ "registry.devices": devices })
      onConfigChange()
      toast.success("Changes saved")
    } catch {
      toast.error("Failed to save configuration")
    } finally {
      setSaving(false)
    }
  }

  const deviceNames = Object.keys(devices).sort()

  return (
    <>
      <ConfigSectionShell>
        <ConfigSectionHeader>
          <h2 className="text-base font-semibold">Devices</h2>
          <p className="mt-1 text-sm text-muted-foreground">Manage reusable named device profiles and transport matching rules.</p>
        </ConfigSectionHeader>
        <ConfigSectionBody>
          <div className="flex flex-wrap items-start justify-between gap-3 border border-border bg-transparent rounded-none px-4 py-3">
            <div className="space-y-1">
              <p className="text-sm font-medium">Reusable device profiles</p>
              <p className="text-xs text-muted-foreground">
                Store a platform, transport, and match contract once, then reference it from execution defaults or per-test overrides.
              </p>
            </div>
            <Button size="sm" onClick={openCreateDialog}>
              <Plus className="size-4" />
              Add Device
            </Button>
          </div>

          <div className="space-y-3">
            {deviceNames.length === 0 ? (
              <div className="border border-dashed border-border bg-transparent rounded-none p-6 text-sm text-muted-foreground">
                No devices configured. Add a named device profile to make it selectable in runtime defaults.
              </div>
            ) : (
              deviceNames.map((name) => {
                const device = devices[name]
                return (
                  <div key={name} className="border border-border bg-transparent rounded-none px-4 py-3">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="space-y-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="font-medium">{name}</p>
                          <Badge variant="secondary">{device.platform}</Badge>
                          <Badge variant="outline">{device.transport}</Badge>
                        </div>
                        <pre className="overflow-auto rounded-none bg-muted/40 p-3 text-xs text-muted-foreground">
                          {JSON.stringify(device.match ?? {}, null, 2)}
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
                          onClick={() => setDevices((current) => {
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
            <DialogTitle>{editingName ? `Edit ${editingName}` : "Add Device"}</DialogTitle>
            <DialogDescription>
              Update the device entry in this section draft. Use Save Changes in the section to persist it to config.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="device-name">Device Name</Label>
              <Input
                id="device-name"
                placeholder="ios-local"
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="device-platform">Platform</Label>
              <Select
                value={draftDevice.platform}
                onValueChange={(value) => setDraftDevice((current) => ({ ...current, platform: value as DevicePlatform }))}
              >
                <SelectTrigger id="device-platform">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="android">Android</SelectItem>
                  <SelectItem value="ios">iOS</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2 md:col-span-2">
              <Label htmlFor="device-transport">Transport</Label>
              <Select
                value={draftDevice.transport}
                onValueChange={(value) => setDraftDevice((current) => ({ ...current, transport: value as DeviceTransport }))}
              >
                <SelectTrigger id="device-transport">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DEVICE_TRANSPORT_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2 md:col-span-2">
              <Label htmlFor="device-match">Match JSON</Label>
              <Textarea
                id="device-match"
                className="min-h-[160px] font-mono text-sm"
                value={matchText}
                onChange={(e) => setMatchText(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Local transport fields for {draftDevice.platform}:{" "}
                <span className="font-mono">{LOCAL_MATCH_FIELDS[draftDevice.platform].join(", ")}</span>
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleApplyDevice}>
              {editingName ? "Apply Device Changes" : "Add Device to Section"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
