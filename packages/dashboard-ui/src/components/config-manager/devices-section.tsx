// Deleting a device has Undo. A device's remote and capabilities show read-only: the write door refuses them.

import { useEffect, useId, useRef, useState, type FocusEvent } from "react"
import { Plus } from "lucide-react"

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
  DEVICE_CAPABILITIES_NOTE,
  DEVICE_FIELD_LABELS,
  DEVICE_ID_HELP,
  DEVICE_NAME_REQUIRED_ERROR,
  DISCARD_DEVICE_LABEL,
  NO_DEVICES_TEXT,
  TARGET_PLATFORM_LABELS,
  deleteActionName,
  deviceCapabilityLabel,
  deviceNameTakenError,
  deviceRemoteText,
} from "@/lib/config-copy"

type DevicePlatform = "android" | "ios"
const DEVICE_PLATFORM_OPTIONS: { value: DevicePlatform; label: string }[] = [
  { value: "android", label: TARGET_PLATFORM_LABELS.android },
  { value: "ios", label: TARGET_PLATFORM_LABELS.ios },
]

interface DeviceEntry {
  platform?: string
  remote?: unknown
  capabilities?: unknown
}

interface DevicesSectionProps {
  config: Record<string, unknown>
  onConfigChange: () => void
}

const LIST_REF: ConfigFieldRef = { segments: ["registry", "devices"], tab: "targets" }
const CAPABILITY_PATTERN = "registry.devices.*.capabilities.*"

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
  const at = (...rest: string[]) => ({ segments: ["registry", "devices", name, ...rest], tab: "targets" as const })
  return (
    <>
      <ConfigField
        field={{ ...at("platform"), pattern: "registry.devices.*.platform" }}
        label={DEVICE_FIELD_LABELS.platform}
        kind="select"
        options={DEVICE_PLATFORM_OPTIONS}
      />
      {typeof device.remote === "string" ? (
        <p data-device-remote={device.remote} className="text-sm text-muted-foreground">
          {deviceRemoteText(device.remote)}
        </p>
      ) : null}
      <ConfigField
        field={{ ...at("model"), pattern: "registry.devices.*.model" }}
        label={DEVICE_FIELD_LABELS.model}
        kind="text"
      />
      <ConfigField
        field={{ ...at("os"), pattern: "registry.devices.*.os" }}
        label={DEVICE_FIELD_LABELS.os}
        kind="text"
      />
      <ConfigField
        field={{ ...at("id"), pattern: "registry.devices.*.id" }}
        label={DEVICE_FIELD_LABELS.id}
        help={DEVICE_ID_HELP}
        kind="text"
      />
      {isRecord(device.capabilities) && Object.keys(device.capabilities).length > 0 ? (
        <DeviceCapabilities name={name} capabilities={device.capabilities} />
      ) : null}
    </>
  )
}

function DeviceCapabilities({ name, capabilities }: { name: string; capabilities: Record<string, unknown> }) {
  return (
    <div data-device-capabilities className="space-y-2">
      <p className="text-sm font-medium">{DEVICE_FIELD_LABELS.capabilities}</p>
      <dl className="space-y-2">
        {Object.entries(capabilities).map(([key, value]) => (
          <div key={key} className="grid items-center gap-1 sm:grid-cols-[minmax(8rem,auto)_1fr] sm:gap-3">
            <dt className="font-mono text-xs text-muted-foreground wrap-anywhere">{key}</dt>
            <dd className="min-w-0">
              <SecretValue
                field={{ segments: ["registry", "devices", name, "capabilities", key], pattern: CAPABILITY_PATTERN }}
                label={deviceCapabilityLabel(name, key)}
                maskedText={maskedTextOf(value)}
                readOnly
              />
            </dd>
          </div>
        ))}
      </dl>
      <p className="text-xs text-muted-foreground">{DEVICE_CAPABILITIES_NOTE}</p>
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
