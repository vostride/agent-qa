// DEVICES (429-22 · D-02, D-08, D-19, D-23, D-24 · UI-SPEC S2 "Record/list editors", S6, S8, E8).
//
// Each device is a row opened in place: the platform autosaves, and each match setting
// shows its key with its value through SecretValue, replaced explicitly. A new setting
// saves only through Save setting. Add device opens an inline draft row; delete acts at once with
// Undo.

import { useEffect, useId, useRef, useState, type FocusEvent, type KeyboardEvent } from "react"
import { Plus, X } from "lucide-react"
import type { ConfigChange } from "@vostride/agent-qa-schema"

import { ConfigField } from "@/components/config-manager/config-field"
import {
  DraftTextField,
  RecordRow,
  leavesGroup,
  useFocusNewRow,
  useHeldDraft,
  useOpenRows,
  useRecordDeletes,
} from "@/components/config-manager/record-list"
import { SecretValue } from "@/components/config-manager/secret-value"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  configFieldControlId,
  configFieldKeyOf,
  useConfigAutosaveContext,
  type ConfigFieldRef,
} from "@/hooks/use-config-autosave"
import {
  ADD_DEVICE_LABEL,
  ADD_SETTING_LABEL,
  DEVICE_FIELD_LABELS,
  DEVICE_NAME_REQUIRED_ERROR,
  DISCARD_DEVICE_LABEL,
  DISCARD_SETTING_LABEL,
  NO_DEVICES_TEXT,
  SAVE_SETTING_LABEL,
  TARGET_PLATFORM_LABELS,
  deleteActionName,
  deviceMatchKeysHelp,
  deviceMatchSettingLabel,
  deviceNameTakenError,
  removeMatchSettingName,
} from "@/lib/config-copy"

type DevicePlatform = "android" | "ios"
const DEVICE_PLATFORM_OPTIONS: { value: DevicePlatform; label: string }[] = [
  { value: "android", label: TARGET_PLATFORM_LABELS.android },
  { value: "ios", label: TARGET_PLATFORM_LABELS.ios },
]

const LOCAL_MATCH_FIELDS: Record<DevicePlatform, readonly string[]> = {
  android: ["avd", "serial", "appPackage", "appActivity", "automationName", "browserName", "platformVersion"],
  ios: ["udid", "bundleId", "automationName", "platformVersion"],
}

interface DeviceEntry {
  platform?: string
  match?: Record<string, unknown>
}

interface DevicesSectionProps {
  config: Record<string, unknown>
  onConfigChange: () => void
}

const LIST_REF: ConfigFieldRef = { segments: ["registry", "devices"], tab: "targets" }
const MATCH_PATTERN = "registry.devices.*.match.*"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function devicesOf(config: Record<string, unknown>): [string, DeviceEntry][] {
  const registry = config.registry
  const devices = isRecord(registry) ? registry.devices : undefined
  if (!isRecord(devices)) return []
  return Object.entries(devices).map(([name, entry]) => [name, isRecord(entry) ? (entry as DeviceEntry) : {}])
}

function platformOf(value: unknown): DevicePlatform {
  return value === "ios" ? "ios" : "android"
}

function summarizeDevice(device: DeviceEntry): string {
  return TARGET_PLATFORM_LABELS[platformOf(device.platform)]
}

function maskedTextOf(value: unknown): string {
  if (typeof value === "string") return value
  if (value === null || value === undefined) return ""
  return typeof value === "object" ? JSON.stringify(value) : String(value)
}

export function DevicesSection({ config }: DevicesSectionProps) {
  const held = useHeldDraft(LIST_REF, EMPTY_DRAFT)
  const [adding, setAdding] = useState(() => held.restored !== undefined)
  const list = useRef<HTMLDivElement>(null)
  const addButton = useRef<HTMLButtonElement>(null)
  const focusAddNext = useRef(false)
  const rows = useOpenRows()
  const { removing, remove } = useRecordDeletes({ kind: "delete-device", attr: "device", list, addButton })
  const all = devicesOf(config)
  const devices = all.filter(([name]) => !removing.has(name))
  const focusNewRow = useFocusNewRow(list, "device", devices.map(([name]) => name))

  useEffect(() => {
    if (!adding && focusAddNext.current) {
      focusAddNext.current = false
      addButton.current?.focus()
    }
  }, [adding])

  return (
    <div ref={list} data-field-list="registry.devices" className="space-y-3">
      {devices.length > 0 ? (
        <ul className="divide-y divide-border">
          {devices.map(([name, device]) => (
            <RecordRow
              key={name}
              attr="device"
              name={name}
              summary={summarizeDevice(device)}
              open={rows.isOpen(name)}
              onToggle={() => rows.toggle(name)}
              deleteName={deleteActionName("delete-device", name)}
              onDelete={() => void remove(name, ["registry", "devices", name])}
            >
              <DeviceFields name={name} device={device} />
            </RecordRow>
          ))}
        </ul>
      ) : null}
      {adding ? (
        <AddDeviceRow
          initial={held.restored ?? EMPTY_DRAFT}
          takenNames={new Set(all.map(([name]) => name))}
          onHold={held.hold}
          onDiscard={() => {
            held.discard()
            focusAddNext.current = true
            setAdding(false)
          }}
          onAdded={(name) => {
            setAdding(false)
            focusNewRow(name)
          }}
        />
      ) : null}
      {adding ? null : (
        <div className="flex flex-wrap items-center gap-3">
          {devices.length === 0 ? <p className="text-sm text-muted-foreground">{NO_DEVICES_TEXT}</p> : null}
          <Button ref={addButton} type="button" variant="outline" size="sm" onClick={() => setAdding(true)}>
            <Plus className="size-3.5" aria-hidden="true" />
            {ADD_DEVICE_LABEL}
          </Button>
        </div>
      )}
    </div>
  )
}

function DeviceFields({ name, device }: { name: string; device: DeviceEntry }) {
  const autosave = useConfigAutosaveContext()
  const [removingKeys, setRemovingKeys] = useState<ReadonlySet<string>>(new Set())
  const at = (...rest: string[]) => ({ segments: ["registry", "devices", name, ...rest], tab: "targets" as const })
  const match = isRecord(device.match) ? device.match : {}
  const keys = Object.keys(match).filter((key) => !removingKeys.has(key))

  async function removeKey(key: string) {
    setRemovingKeys((current) => new Set(current).add(key))
    await autosave.runExplicit([{ op: "unset", path: ["registry", "devices", name, "match", key] }])
    setRemovingKeys((current) => {
      const next = new Set(current)
      next.delete(key)
      return next
    })
  }

  return (
    <>
      <ConfigField
        field={{ ...at("platform"), pattern: "registry.devices.*.platform" }}
        label={DEVICE_FIELD_LABELS.platform}
        kind="select"
        options={DEVICE_PLATFORM_OPTIONS}
      />
      <div className="space-y-2">
        {keys.length > 0 ? (
          <dl data-field-list="registry.devices.*.match" className="space-y-2">
            {keys.map((key) => (
              <div key={key} className="grid items-center gap-1 sm:grid-cols-[minmax(8rem,auto)_1fr] sm:gap-3">
                <dt className="font-mono text-xs text-muted-foreground wrap-anywhere">{key}</dt>
                <dd className="flex min-w-0 items-center gap-1">
                  <div className="min-w-0 flex-1">
                    <SecretValue
                      field={{ segments: ["registry", "devices", name, "match", key], pattern: MATCH_PATTERN }}
                      label={deviceMatchSettingLabel(name, key)}
                      maskedText={maskedTextOf(match[key])}
                    />
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={removeMatchSettingName(name, key)}
                    className="hover:text-destructive"
                    onClick={() => void removeKey(key)}
                  >
                    <X className="size-3.5" aria-hidden="true" />
                  </Button>
                </dd>
              </div>
            ))}
          </dl>
        ) : null}
        <AddMatchSetting
          device={name}
          existingKeys={Object.keys(match)}
          platform={platformOf(device.platform)}
        />
      </div>
    </>
  )
}

interface SettingDraft {
  key: string
  value: string
}

const EMPTY_SETTING: SettingDraft = { key: "", value: "" }

function AddMatchSetting({
  device,
  existingKeys,
  platform,
}: {
  device: string
  existingKeys: readonly string[]
  platform: DevicePlatform
}) {
  const autosave = useConfigAutosaveContext()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<SettingDraft>(EMPTY_SETTING)
  const [saving, setSaving] = useState(false)
  const addButton = useRef<HTMLButtonElement>(null)
  const focusAddNext = useRef(false)
  const helpId = useId()
  const key = draft.key.trim()
  const allowed = LOCAL_MATCH_FIELDS[platform]
  const ready = key !== "" && draft.value !== "" && !existingKeys.includes(key) && allowed.includes(key)

  useEffect(() => {
    if (!open && focusAddNext.current) {
      focusAddNext.current = false
      addButton.current?.focus()
    }
  }, [open])

  function close() {
    setDraft(EMPTY_SETTING)
    focusAddNext.current = true
    setOpen(false)
  }

  async function save() {
    if (!ready || saving) return
    setSaving(true)
    const change: ConfigChange = { op: "set", path: ["registry", "devices", device, "match", key], value: draft.value }
    const landed = await autosave.runExplicit([change])
    setSaving(false)
    if (landed) close()
  }

  function keyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault()
      void save()
    } else if (event.key === "Escape") {
      event.preventDefault()
      close()
    }
  }

  if (!open) {
    return (
      <Button ref={addButton} type="button" variant="ghost" size="xs" onClick={() => setOpen(true)}>
        <Plus className="size-3" aria-hidden="true" />
        {ADD_SETTING_LABEL}
      </Button>
    )
  }

  const platformLabel = TARGET_PLATFORM_LABELS[platform]
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1">
        <Input
          type="text"
          autoComplete="off"
          autoFocus
          aria-label={DEVICE_FIELD_LABELS.key}
          aria-describedby={helpId}
          placeholder={DEVICE_FIELD_LABELS.key}
          value={draft.key}
          onChange={(event) => setDraft({ ...draft, key: event.target.value })}
          onKeyDown={keyDown}
          className="h-8 w-36 font-mono"
        />
        <Input
          type="password"
          autoComplete="off"
          aria-label={DEVICE_FIELD_LABELS.value}
          placeholder={DEVICE_FIELD_LABELS.value}
          value={draft.value}
          onChange={(event) => setDraft({ ...draft, value: event.target.value })}
          onKeyDown={keyDown}
          className="h-8 min-w-0 flex-1 font-mono"
        />
        <Button type="button" variant="outline" size="sm" disabled={!ready || saving} onClick={() => void save()}>
          {SAVE_SETTING_LABEL}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={close}>
          {DISCARD_SETTING_LABEL}
        </Button>
      </div>
      <p id={helpId} className="text-xs text-muted-foreground break-words">
        {deviceMatchKeysHelp(platformLabel, allowed)}
      </p>
    </div>
  )
}

interface DeviceDraft extends Record<string, string> {
  name: string
  platform: string
}

const EMPTY_DRAFT: DeviceDraft = { name: "", platform: "android" }

function draftNameError(draft: DeviceDraft, takenNames: ReadonlySet<string>): string | undefined {
  const name = draft.name.trim()
  if (name === "") return DEVICE_NAME_REQUIRED_ERROR
  if (takenNames.has(name)) return deviceNameTakenError(name)
  return undefined
}

interface AddDeviceRowProps {
  initial: DeviceDraft
  takenNames: ReadonlySet<string>
  onHold: (draft: DeviceDraft) => void
  onDiscard: () => void
  onAdded: (name: string) => void
}

function AddDeviceRow({ initial, takenNames, onHold, onDiscard, onAdded }: AddDeviceRowProps) {
  const autosave = useConfigAutosaveContext()
  const [draft, setDraft] = useState(initial)
  const [touched, setTouched] = useState(false)
  const saving = useRef(false)
  const baseId = useId()
  const nameError = touched ? draftNameError(draft, takenNames) : undefined

  useEffect(() => {
    onHold(initial)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function change(next: DeviceDraft) {
    setDraft(next)
    onHold(next)
  }

  async function settle(current: DeviceDraft, markTouched: boolean) {
    if (markTouched) setTouched(true)
    if (saving.current || draftNameError(current, takenNames) !== undefined) return
    saving.current = true
    const name = current.name.trim()
    const landed = await autosave.runExplicit(
      [
        {
          op: "set",
          path: ["registry", "devices", name],
          value: { platform: platformOf(current.platform) },
        },
      ],
      undefined,
      [LIST_REF],
    )
    saving.current = false
    if (landed) onAdded(name)
  }

  function leave(event: FocusEvent<HTMLDivElement>) {
    if (leavesGroup(event)) void settle(draft, true)
  }

  function select(key: "platform", label: string, options: readonly { value: string; label: string }[]) {
    return (
      <div className="space-y-2">
        <Label htmlFor={`${baseId}-${key}`}>{label}</Label>
        <Select
          value={draft[key]}
          onValueChange={(value) => {
            const next = { ...draft, [key]: value }
            change(next)
            void settle(next, false)
          }}
        >
          <SelectTrigger id={`${baseId}-${key}`} className="w-full max-w-md">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    )
  }

  return (
    <div data-device-draft onBlur={leave} className="space-y-4 border-t border-border pt-3">
      <DraftTextField
        id={configFieldControlId(configFieldKeyOf(LIST_REF.segments))}
        name="name"
        label={DEVICE_FIELD_LABELS.name}
        value={draft.name}
        placeholder="pixel-8"
        mono
        autoFocus
        error={nameError}
        onChange={(value) => change({ ...draft, name: value })}
        onEnter={() => void settle(draft, true)}
      />
      {select("platform", DEVICE_FIELD_LABELS.platform, DEVICE_PLATFORM_OPTIONS)}
      <Button type="button" variant="ghost" size="sm" onClick={onDiscard}>
        {DISCARD_DEVICE_LABEL}
      </Button>
    </div>
  )
}
