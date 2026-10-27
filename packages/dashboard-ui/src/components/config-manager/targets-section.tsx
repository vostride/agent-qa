// TARGETS (429-22 · D-02, D-19, D-23, D-24 · UI-SPEC S2 "Record/list editors", S6, E6, E8).
//
// Each target is a row: its name and summary, opened in place to edit its fields, which autosave
// by leaf. Add target opens an inline draft row that writes the whole target once it is valid.
// Delete acts at once and offers Undo.

import { useEffect, useId, useRef, useState, type FocusEvent } from "react"
import { Plus } from "lucide-react"
import { selectApprovedSaasPlaceholderSlug } from "@vostride/agent-qa-ids"

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
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  configFieldControlId,
  configFieldKeyOf,
  useConfigAutosaveContext,
  type ConfigFieldParse,
  type ConfigFieldRef,
} from "@/hooks/use-config-autosave"
import {
  ADD_TARGET_LABEL,
  DISCARD_TARGET_LABEL,
  NO_TARGETS_TEXT,
  TARGET_APP_PATH_ERROR,
  TARGET_APP_SUMMARY_PREFIX,
  TARGET_ENVIRONMENT_CHOICE_LABELS,
  TARGET_ENVIRONMENT_LABELS,
  TARGET_ENVIRONMENT_PLACEHOLDER,
  TARGET_FIELD_LABELS,
  TARGET_NAME_FORMAT_ERROR,
  TARGET_NAME_REQUIRED_ERROR,
  TARGET_PLATFORM_LABELS,
  TARGET_PRODUCT_ERROR,
  TARGET_URL_REQUIRED_ERROR,
  TARGET_WEB_NEEDS_URL_ERROR,
  deleteActionName,
  targetNameTakenError,
} from "@/lib/config-copy"

type TargetPlatform = keyof typeof TARGET_PLATFORM_LABELS

interface TargetEntry {
  platform?: string
  product?: string
  bundleId?: string
  appPackage?: string
  appActivity?: string
  app?: { path?: string }
  url?: string
  environment?: string
}

interface TargetsSectionProps {
  config: Record<string, unknown>
  onConfigChange: () => void
}

const LIST_REF: ConfigFieldRef = { segments: ["registry", "targets"], tab: "targets" }
// The schema's target-name rule (the saved-login-state slug), so a draft never sends a name the file refuses.
const TARGET_NAME_PATTERN = /^[a-z][a-z0-9-]*[a-z0-9]$/
const TARGET_PRODUCT_PLACEHOLDER = selectApprovedSaasPlaceholderSlug("dashboard.config.targets.product")
const UNSET: ConfigFieldParse = { valid: true, unset: true }

const PLATFORM_OPTIONS = (Object.keys(TARGET_PLATFORM_LABELS) as TargetPlatform[]).map((value) => ({
  value,
  label: TARGET_PLATFORM_LABELS[value],
}))
type TargetEnvironment = keyof typeof TARGET_ENVIRONMENT_LABELS
const ENVIRONMENT_OPTIONS = (Object.keys(TARGET_ENVIRONMENT_LABELS) as TargetEnvironment[]).map(
  (value) => ({ value, label: TARGET_ENVIRONMENT_LABELS[value] }),
)
// The add row's choices: undeclared first, stored as the draft's empty string.
const ENVIRONMENT_CHOICES = Object.keys(TARGET_ENVIRONMENT_CHOICE_LABELS) as (keyof typeof TARGET_ENVIRONMENT_CHOICE_LABELS)[]

// Own keys only: `in` walks the prototype chain, and this guard decides whether a draft writes the
// environment field.
export function isTargetEnvironment(value: string): value is TargetEnvironment {
  return Object.hasOwn(TARGET_ENVIRONMENT_LABELS, value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function targetsOf(config: Record<string, unknown>): [string, TargetEntry][] {
  const registry = config.registry
  const targets = isRecord(registry) ? registry.targets : undefined
  if (!isRecord(targets)) return []
  return Object.entries(targets).map(([name, entry]) => [name, isRecord(entry) ? (entry as TargetEntry) : {}])
}

function isPlatform(value: unknown): value is TargetPlatform {
  return typeof value === "string" && value in TARGET_PLATFORM_LABELS
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\")
}

function badProduct(value: string): boolean {
  return /\.\./.test(value) || /[/\\]/.test(value) || value.includes("\0")
}

function parseOptional(raw: string): ConfigFieldParse {
  return raw.trim() === "" ? UNSET : { valid: true, value: raw.trim() }
}

function parseProduct(raw: string): ConfigFieldParse {
  if (raw.trim() === "") return UNSET
  return badProduct(raw.trim()) ? { valid: false, error: TARGET_PRODUCT_ERROR } : { valid: true, value: raw.trim() }
}

function parseAppPath(raw: string): ConfigFieldParse {
  if (raw.trim() === "") return UNSET
  return isAbsolutePath(raw.trim()) ? { valid: false, error: TARGET_APP_PATH_ERROR } : { valid: true, value: raw.trim() }
}

function parseUrl(raw: string): ConfigFieldParse {
  return raw.trim() === "" ? { valid: false, error: TARGET_URL_REQUIRED_ERROR } : { valid: true, value: raw.trim() }
}

export function summarizeTarget(target: TargetEntry): string {
  const platform = isPlatform(target.platform) ? target.platform : "web"
  const parts: string[] = [TARGET_PLATFORM_LABELS[platform]]
  if (platform === "web") {
    if (target.url) parts.push(target.url)
    return parts.join(" · ")
  }
  if (platform === "ios" && target.bundleId) parts.push(target.bundleId)
  if (platform === "android") {
    const app = [target.appPackage, target.appActivity].filter(Boolean).join(" / ")
    if (app) parts.push(app)
  }
  if (target.app?.path) parts.push(`${TARGET_APP_SUMMARY_PREFIX}: ${target.app.path}`)
  return parts.join(" · ")
}

export function TargetsSection({ config }: TargetsSectionProps) {
  const held = useHeldDraft(LIST_REF, EMPTY_DRAFT)
  const [adding, setAdding] = useState(() => held.restored !== undefined)
  const list = useRef<HTMLDivElement>(null)
  const addButton = useRef<HTMLButtonElement>(null)
  const focusAddNext = useRef(false)
  const rows = useOpenRows()
  const { removing, remove } = useRecordDeletes({ kind: "delete-target", attr: "target", list, addButton })
  const all = targetsOf(config)
  const targets = all.filter(([name]) => !removing.has(name))
  const focusNewRow = useFocusNewRow(list, "target", targets.map(([name]) => name))

  useEffect(() => {
    if (!adding && focusAddNext.current) {
      focusAddNext.current = false
      addButton.current?.focus()
    }
  }, [adding])

  return (
    <div ref={list} data-field-list="registry.targets" className="space-y-3">
      {targets.length > 0 ? (
        <ul className="divide-y divide-border">
          {targets.map(([name, target]) => (
            <RecordRow
              key={name}
              attr="target"
              name={name}
              summary={summarizeTarget(target)}
              open={rows.isOpen(name)}
              onToggle={() => rows.toggle(name)}
              deleteName={deleteActionName("delete-target", name)}
              onDelete={() => void remove(name, ["registry", "targets", name])}
            >
              <TargetFields name={name} target={target} />
            </RecordRow>
          ))}
        </ul>
      ) : null}
      {adding ? (
        <AddTargetRow
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
          {targets.length === 0 ? <p className="text-sm text-muted-foreground">{NO_TARGETS_TEXT}</p> : null}
          <Button ref={addButton} type="button" variant="outline" size="sm" onClick={() => setAdding(true)}>
            <Plus className="size-3.5" aria-hidden="true" />
            {ADD_TARGET_LABEL}
          </Button>
        </div>
      )}
    </div>
  )
}

function TargetFields({ name, target }: { name: string; target: TargetEntry }) {
  const autosave = useConfigAutosaveContext()
  const at = (...rest: string[]) => ({ segments: ["registry", "targets", name, ...rest], tab: "targets" as const })
  const platformField = at("platform")
  const shown = autosave.valueOf(platformField)
  const platform: TargetPlatform = isPlatform(shown) ? shown : isPlatform(target.platform) ? target.platform : "web"
  const hasUrl = typeof target.url === "string" && target.url !== ""

  // A switch to web waits for a URL; once one lands in the file, the held switch is written.
  useEffect(() => {
    if (!hasUrl || autosave.stateOf(platformField) !== "draft" || autosave.valueOf(platformField) !== "web") return
    autosave.edit(platformField, "web", { valid: true, value: "web" })
    autosave.settle(platformField)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasUrl])

  return (
    <>
      <ConfigField
        field={{ ...platformField, pattern: "registry.targets.*.platform" }}
        label={TARGET_FIELD_LABELS.platform}
        kind="select"
        options={PLATFORM_OPTIONS}
        parse={(raw) =>
          raw === "web" && !hasUrl ? { valid: false, error: TARGET_WEB_NEEDS_URL_ERROR } : { valid: true, value: raw }
        }
      />
      {platform === "web" ? (
        <ConfigField
          field={{ ...at("url"), pattern: "registry.targets.*.url" }}
          label={TARGET_FIELD_LABELS.url}
          kind="text"
          placeholder="https://staging.example.com"
          parse={parseUrl}
        />
      ) : null}
      {platform === "ios" ? (
        <ConfigField
          field={{ ...at("bundleId"), pattern: "registry.targets.*.bundleId" }}
          label={TARGET_FIELD_LABELS.bundleId}
          kind="text"
          placeholder="com.example.ios"
          parse={parseOptional}
        />
      ) : null}
      {platform === "android" ? (
        <>
          <ConfigField
            field={{ ...at("appPackage"), pattern: "registry.targets.*.appPackage" }}
            label={TARGET_FIELD_LABELS.appPackage}
            kind="text"
            placeholder="com.example.android"
            parse={parseOptional}
          />
          <ConfigField
            field={{ ...at("appActivity"), pattern: "registry.targets.*.appActivity" }}
            label={TARGET_FIELD_LABELS.appActivity}
            kind="text"
            placeholder=".MainActivity"
            parse={parseOptional}
          />
        </>
      ) : null}
      {platform === "web" ? null : (
        <ConfigField
          field={{ ...at("app", "path"), pattern: "registry.targets.*.app.path" }}
          label={TARGET_FIELD_LABELS.appPath}
          kind="text"
          placeholder="apps/app.apk"
          parse={parseAppPath}
        />
      )}
      <ConfigField
        field={{ ...at("product"), pattern: "registry.targets.*.product" }}
        label={TARGET_FIELD_LABELS.product}
        kind="text"
        placeholder={TARGET_PRODUCT_PLACEHOLDER}
        parse={parseProduct}
      />
      <ConfigField
        field={{ ...at("environment"), pattern: "registry.targets.*.environment" }}
        label={TARGET_FIELD_LABELS.environment}
        kind="select"
        placeholder={TARGET_ENVIRONMENT_PLACEHOLDER}
        options={ENVIRONMENT_OPTIONS}
      />
    </>
  )
}

interface TargetDraft extends Record<string, string> {
  name: string
  platform: string
  url: string
  bundleId: string
  appPackage: string
  appActivity: string
  environment: string
}

type DraftKey = "name" | "platform" | "url" | "bundleId" | "appPackage" | "appActivity"

const EMPTY_DRAFT: TargetDraft = {
  name: "",
  platform: "web",
  url: "",
  bundleId: "",
  appPackage: "",
  appActivity: "",
  environment: "",
}

function draftErrors(draft: TargetDraft, takenNames: ReadonlySet<string>): Partial<Record<DraftKey, string>> {
  const errors: Partial<Record<DraftKey, string>> = {}
  const name = draft.name.trim()
  if (name === "") errors.name = TARGET_NAME_REQUIRED_ERROR
  else if (!TARGET_NAME_PATTERN.test(name)) errors.name = TARGET_NAME_FORMAT_ERROR
  else if (takenNames.has(name)) errors.name = targetNameTakenError(name)
  if (draft.platform === "web" && draft.url.trim() === "") errors.url = TARGET_URL_REQUIRED_ERROR
  return errors
}

function draftValue(draft: TargetDraft): TargetEntry {
  const platform: TargetPlatform = isPlatform(draft.platform) ? draft.platform : "web"
  const set = (key: DraftKey) => (draft[key].trim() === "" ? {} : { [key]: draft[key].trim() })
  const environment = isTargetEnvironment(draft.environment) ? { environment: draft.environment } : {}
  if (platform === "web") return { platform, ...set("url"), ...environment }
  if (platform === "ios") return { platform, ...set("bundleId"), ...environment }
  return { platform, ...set("appPackage"), ...set("appActivity"), ...environment }
}

interface AddTargetRowProps {
  initial: TargetDraft
  takenNames: ReadonlySet<string>
  onHold: (draft: TargetDraft) => void
  onDiscard: () => void
  onAdded: (name: string) => void
}

function AddTargetRow({ initial, takenNames, onHold, onDiscard, onAdded }: AddTargetRowProps) {
  const autosave = useConfigAutosaveContext()
  const [draft, setDraft] = useState(initial)
  const [touched, setTouched] = useState(false)
  const saving = useRef(false)
  const baseId = useId()
  const errors = touched ? draftErrors(draft, takenNames) : {}
  const platform: TargetPlatform = isPlatform(draft.platform) ? draft.platform : "web"

  useEffect(() => {
    onHold(initial)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function change(next: TargetDraft) {
    setDraft(next)
    onHold(next)
  }

  async function settle(current: TargetDraft, markTouched: boolean) {
    if (markTouched) setTouched(true)
    if (saving.current || Object.keys(draftErrors(current, takenNames)).length > 0) return
    saving.current = true
    const name = current.name.trim()
    const landed = await autosave.runExplicit(
      [{ op: "set", path: ["registry", "targets", name], value: draftValue(current) }],
      undefined,
      [LIST_REF],
    )
    saving.current = false
    if (landed) onAdded(name)
  }

  function leave(event: FocusEvent<HTMLDivElement>) {
    if (leavesGroup(event)) void settle(draft, true)
  }

  const text = (key: DraftKey, label: string, placeholder: string, extra: { autoFocus?: boolean; id?: string } = {}) => (
    <DraftTextField
      id={extra.id ?? `${baseId}-${key}`}
      name={key}
      label={label}
      value={draft[key]}
      placeholder={placeholder}
      mono={key === "name"}
      autoFocus={extra.autoFocus}
      error={errors[key]}
      onChange={(value) => change({ ...draft, [key]: value })}
      onEnter={() => void settle(draft, true)}
    />
  )

  return (
    <div data-target-draft onBlur={leave} className="space-y-4 border-t border-border pt-3">
      {text("name", TARGET_FIELD_LABELS.name, "staging-web", {
        autoFocus: true,
        id: configFieldControlId(configFieldKeyOf(LIST_REF.segments)),
      })}
      <div className="space-y-2">
        <Label htmlFor={`${baseId}-platform`}>{TARGET_FIELD_LABELS.platform}</Label>
        <Select
          value={platform}
          onValueChange={(value) => {
            const next = { ...draft, platform: value }
            change(next)
            void settle(next, false)
          }}
        >
          <SelectTrigger id={`${baseId}-platform`} className="w-full max-w-md">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PLATFORM_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {platform === "web" ? text("url", TARGET_FIELD_LABELS.url, "https://staging.example.com") : null}
      {platform === "ios" ? text("bundleId", TARGET_FIELD_LABELS.bundleId, "com.example.ios") : null}
      {platform === "android" ? (
        <>
          {text("appPackage", TARGET_FIELD_LABELS.appPackage, "com.example.android")}
          {text("appActivity", TARGET_FIELD_LABELS.appActivity, ".MainActivity")}
        </>
      ) : null}
      <fieldset data-target-environment className="space-y-2">
        <legend className="text-sm font-medium">{TARGET_FIELD_LABELS.environment}</legend>
        <RadioGroup
          className="flex flex-wrap gap-x-6 gap-y-2"
          value={isTargetEnvironment(draft.environment) ? draft.environment : "undeclared"}
          onValueChange={(value) => {
            const next = { ...draft, environment: isTargetEnvironment(value) ? value : "" }
            change(next)
            void settle(next, false)
          }}
        >
          {ENVIRONMENT_CHOICES.map((choice) => {
            const itemId = `${baseId}-environment-${choice}`
            return (
              <Label key={choice} htmlFor={itemId} data-environment-choice={choice} className="font-normal">
                <RadioGroupItem id={itemId} value={choice} />
                {TARGET_ENVIRONMENT_CHOICE_LABELS[choice]}
              </Label>
            )
          })}
        </RadioGroup>
      </fieldset>
      <Button type="button" variant="ghost" size="sm" onClick={onDiscard}>
        {DISCARD_TARGET_LABEL}
      </Button>
    </div>
  )
}
