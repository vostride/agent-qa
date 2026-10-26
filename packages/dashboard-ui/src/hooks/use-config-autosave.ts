// THE CONFIG PAGE'S AUTOSAVE (429 D-19/D-20/D-21/D-22/D-24 · PXH-CONF-04/05).
//
// One hook the whole page shares, because Radix unmounts inactive tab panels: a draft kept in a
// section component would vanish on a tab change. The pure machine in lib/config-autosave.ts
// decides what the status may say; this hook owns the effects: settle timers, the one write in
// flight, browser-storage drafts and the loaded config. A landed write is mirrored as written, and
// only the fields a person changed are sent, so a value shown through the declared mask is never
// written back (441-40, D-29).

import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
} from "react"
import type { ConfigChange, ConfigPathSegment } from "@vostride/agent-qa-schema"

import {
  applyConfigChanges,
  fetchConfig,
  fetchConfigRevision,
  undoConfigAction,
  type ConfigReadAnswer,
} from "@/lib/api"
import {
  createInitialConfigAutosave,
  deriveSaveStatus,
  draftFieldKeys,
  reduceConfigAutosave,
  type ConfigAutosaveEvent,
  type ConfigAutosaveIssue,
  type ConfigAutosaveState,
  type ConfigSaveStatus,
  type RestoredDraft,
} from "@/lib/config-autosave"
import {
  FIELD_CHANGED_TEXT,
  REVISION_POLL_MS,
  SAVED_VISIBLE_MS,
  SETTLE_DELAY_MS,
  UNDO_WINDOW_MS,
} from "@/lib/config-copy"
import { completeRequiredSiblings } from "@/lib/config-fields"
import { CONFIG_TABS, type ConfigTab, type ExplicitActionKind, type FieldState } from "@/lib/config-tabs"

export const CONFIG_DRAFTS_STORAGE_PREFIX = "agent-qa:config-drafts:"

export interface ConfigFieldRef {
  segments: readonly ConfigPathSegment[]
  tab: ConfigTab
}

export type ConfigFieldParse =
  | { valid: true; value: unknown }
  | { valid: true; unset: true }
  | { valid: false; error: string }

export type ConfigLoadState =
  | { kind: "loading" }
  | { kind: "error"; reason: string }
  | { kind: "ready"; answer: ConfigReadAnswer }

export interface ConfigUndoMeta {
  kind: ExplicitActionKind
  name: string
}

/** The action the last Undo reversed, once the re-read shows it again; seq tells repeats apart. */
export interface ConfigRestored {
  kind: ExplicitActionKind
  name: string
  seq: number
}

/** Computes a write from the config it is handed: the freshest one the page holds. */
export type ConfigCompute = (config: Record<string, unknown>) => ConfigChange[]

export interface ConfigDraftTarget {
  tab: ConfigTab
  fieldKey: string
}

export interface ConfigAutosave {
  load: ConfigLoadState
  status: ConfigSaveStatus
  draftTabs: ReadonlySet<ConfigTab>
  edit: (field: ConfigFieldRef, raw: unknown, parsed: ConfigFieldParse) => void
  /** Keeps a typed value as a draft that never writes by itself; only an explicit action saves it. */
  hold: (field: ConfigFieldRef, raw: string) => void
  /** Drops a field's draft, so it shows the file's value again. */
  discard: (field: ConfigFieldRef) => void
  settle: (field: ConfigFieldRef) => void
  retry: () => void
  valueOf: (field: ConfigFieldRef) => unknown
  stateOf: (field: ConfigFieldRef) => FieldState
  errorOf: (field: ConfigFieldRef) => string | undefined
  setFocusedField: (field: ConfigFieldRef | undefined) => void
  /**
   * One explicit write; with undo metadata it offers Undo. Resolves true once the write landed.
   * Fields it carries show saving, take the server's named reasons, and drop their held draft once
   * it lands; a refused write with fields is what Retry sends again.
   */
  runExplicit: (
    changes: ConfigChange[],
    undoMeta?: ConfigUndoMeta,
    fields?: readonly ConfigFieldRef[],
  ) => Promise<boolean>
  /**
   * One explicit write computed from the freshest config the page holds (429-46 · CR-01). When the
   * file changed under it (field_changed), the page re-reads and computes once more; a second
   * refusal in a row reads Couldn't save, and Retry computes again from a fresh read.
   */
  runComputed: (compute: ConfigCompute, undoMeta?: ConfigUndoMeta) => Promise<boolean>
  /**
   * Offers Undo for an action the server already performed through its own door (a credential
   * delete); the Undo link then redeems the server's token as for a config write.
   */
  offerUndo: (undo: { token: string }, meta: ConfigUndoMeta) => void
  /**
   * An explicit action outside the config write failed: the status says so. As for a refused
   * explicit write, Retry re-sends only drafts, so it clears this failure and re-reads the file.
   */
  failExplicit: (error: unknown) => void
  undo: () => Promise<void>
  /** What the last Undo restored, so the section holding it can return focus to the row. */
  restored: ConfigRestored | undefined
  goToFirstDraft: () => ConfigDraftTarget | undefined
  /** The field the failed write named, else the first field it carried: where focus goes after Retry. */
  failedFieldTarget: () => ConfigDraftTarget | undefined
  /** Re-reads with the loading state shown (the Reload config button). */
  reload: () => void
  /** Re-reads quietly, for sections still saving through their own routes. */
  refresh: () => void
  /** A draft held outside the field map (the add row): its tab carries the dot and the status reads Not saved. */
  setExternalDraft: (tab: ConfigTab, present: boolean) => void
}

interface FieldLocation {
  segments: readonly ConfigPathSegment[]
  tab: ConfigTab
}

interface HookState {
  machine: ConfigAutosaveState
  locations: Readonly<Record<string, FieldLocation>>
}

interface HookAction {
  event: ConfigAutosaveEvent
  now: number
  locations?: Readonly<Record<string, FieldLocation>>
}

function reduceHook(state: HookState, action: HookAction): HookState {
  const machine = reduceConfigAutosave(state.machine, action.event, action.now)
  const locations = action.locations ? { ...state.locations, ...action.locations } : state.locations
  return machine === state.machine && locations === state.locations ? state : { machine, locations }
}

function initialHookState(): HookState {
  return { machine: createInitialConfigAutosave(), locations: {} }
}

/** The same key the machine uses: the JSON of the field's segments. */
export function configFieldKeyOf(segments: readonly ConfigPathSegment[]): string {
  return JSON.stringify(segments)
}

/** The field key Not saved names for a tab's external draft; its control carries configFieldControlId of it. */
export function externalDraftFieldKey(tab: ConfigTab): string {
  return `external:${tab}`
}

/** The DOM id of a field's control, so Not saved can focus it. */
export function configFieldControlId(fieldKey: string): string {
  return `config-field-${encodeURIComponent(fieldKey).replace(/%/g, "_")}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function childAt(node: unknown, segment: ConfigPathSegment): { found: boolean; value: unknown; index?: number } {
  if (typeof segment === "object") {
    if (!Array.isArray(node)) return { found: false, value: undefined }
    const index = node.findIndex((item) => isRecord(item) && item.name === segment.name)
    return index < 0 ? { found: false, value: undefined } : { found: true, value: node[index], index }
  }
  if (typeof segment === "number") {
    return Array.isArray(node) && segment < node.length
      ? { found: true, value: node[segment], index: segment }
      : { found: false, value: undefined }
  }
  return isRecord(node) && segment in node ? { found: true, value: node[segment] } : { found: false, value: undefined }
}

function lookup(config: unknown, segments: readonly ConfigPathSegment[]): { found: boolean; value: unknown } {
  let node = config
  for (const segment of segments) {
    const next = childAt(node, segment)
    if (!next.found) return { found: false, value: undefined }
    node = next.value
  }
  return { found: true, value: node }
}

function valueAt(config: unknown, segments: readonly ConfigPathSegment[]): unknown {
  return lookup(config, segments).value
}

/** The index path the server names in its issues, with each `{ name }` resolved on the loaded config. */
function indexPathOf(config: unknown, segments: readonly ConfigPathSegment[]): (string | number)[] | undefined {
  const path: (string | number)[] = []
  let node = config
  for (const segment of segments) {
    const next = childAt(node, segment)
    if (typeof segment === "object") {
      if (next.index === undefined) return undefined
      path.push(next.index)
    } else {
      path.push(segment)
    }
    node = next.value
  }
  return path
}

function sameAsFile(raw: unknown, fileValue: unknown): boolean {
  if (raw === fileValue) return true
  if (fileValue === undefined || fileValue === null) return raw === ""
  if (typeof raw !== "string") return false
  if (typeof fileValue === "string" || typeof fileValue === "number" || typeof fileValue === "boolean") {
    return String(fileValue) === raw
  }
  return Array.isArray(fileValue) && fileValue.every((item) => typeof item === "string") && fileValue.join("\n") === raw
}

interface StoredDraft {
  segments: ConfigPathSegment[]
  tab: ConfigTab
  raw: string | number | boolean
  error?: string
}

function isSegment(value: unknown): value is ConfigPathSegment {
  if (typeof value === "string") return value.length > 0
  if (typeof value === "number") return Number.isInteger(value) && value >= 0
  return (
    isRecord(value) &&
    Object.keys(value).length === 1 &&
    typeof value.name === "string" &&
    value.name.length > 0
  )
}

function isStorableRaw(raw: unknown): raw is StoredDraft["raw"] {
  return typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean"
}

/** The normalizeProductTourState idiom: anything off-shape or equal to the file is dropped. */
function normalizeStoredDraft(key: string, value: unknown, config: unknown): StoredDraft | undefined {
  if (!isRecord(value)) return undefined
  const { segments, tab, raw, error } = value
  if (!Array.isArray(segments) || segments.length === 0 || !segments.every(isSegment)) return undefined
  if (configFieldKeyOf(segments) !== key) return undefined
  if (typeof tab !== "string" || !(CONFIG_TABS as readonly string[]).includes(tab)) return undefined
  if (!isStorableRaw(raw)) return undefined
  if (error !== undefined && typeof error !== "string") return undefined
  if (sameAsFile(raw, valueAt(config, segments))) return undefined
  return { segments, tab: tab as ConfigTab, raw, ...(error === undefined ? {} : { error }) }
}

function readStoredDrafts(storageKey: string, config: unknown): Record<string, StoredDraft> {
  try {
    const text = globalThis.localStorage?.getItem(storageKey)
    if (!text) return {}
    const parsed: unknown = JSON.parse(text)
    if (!isRecord(parsed)) return {}
    const drafts: Record<string, StoredDraft> = {}
    for (const [key, value] of Object.entries(parsed)) {
      const draft = normalizeStoredDraft(key, value, config)
      if (draft) drafts[key] = draft
    }
    return drafts
  } catch {
    return {}
  }
}

function writeStoredDrafts(storageKey: string, state: HookState): void {
  const drafts: Record<string, StoredDraft> = {}
  for (const key of draftFieldKeys(state.machine)) {
    const location = state.locations[key]
    const field = state.machine.fields[key]
    if (!location || !field || !isStorableRaw(field.raw)) continue
    drafts[key] = {
      segments: [...location.segments],
      tab: location.tab,
      raw: field.raw,
      ...(field.error === undefined ? {} : { error: field.error }),
    }
  }
  try {
    if (Object.keys(drafts).length === 0) globalThis.localStorage?.removeItem(storageKey)
    else globalThis.localStorage?.setItem(storageKey, JSON.stringify(drafts))
  } catch {
    // Storage can be full or blocked; the drafts still live in memory.
  }
}

/** The structured body an ApiError carries, read by shape so any thrown answer is handled alike. */
function errorPayload(error: unknown): Record<string, unknown> | undefined {
  if (!(error instanceof Error) || !("payload" in error)) return undefined
  return isRecord(error.payload) ? error.payload : undefined
}

function isFieldChanged(error: unknown): boolean {
  return errorPayload(error)?.error === "field_changed"
}

/** A read the server refused with a 4xx is about the file itself; any other failure may pass by. */
function isFileRefusal(error: unknown): boolean {
  if (!(error instanceof Error) || !("status" in error)) return false
  const { status } = error as { status: unknown }
  return typeof status === "number" && status < 500
}

function loadFailureReason(error: unknown): string {
  const message = errorPayload(error)?.message
  const payloadMessage = typeof message === "string" ? message : undefined
  const text = payloadMessage ?? (error instanceof Error ? error.message : String(error))
  return text.trim().replace(/[.\s]+$/, "")
}

type PlainChange =
  | { op: "set" | "append"; path: readonly ConfigPathSegment[]; value: unknown }
  | { op: "unset"; path: readonly ConfigPathSegment[] }

const BROWSER_HEADLESS_PATH = ["use", "browser", "headless"]
const LEGACY_HEADLESS_PATH = ["use", "headless"]

/** One set, unset or append on the copy; false when its path is not there to mirror. */
function applyAt(next: Record<string, unknown>, change: PlainChange): boolean {
  const parentPath = change.path.slice(0, -1)
  const last = change.path[change.path.length - 1]!
  let parent: unknown = next
  for (const segment of parentPath) {
    const child = childAt(parent, segment)
    if (child.found && (isRecord(child.value) || Array.isArray(child.value))) {
      parent = child.value
    } else if (change.op !== "unset" && typeof segment === "string" && isRecord(parent)) {
      parent = parent[segment] = {}
    } else {
      // Nothing is there to remove; the rest of the set still applies (deferred 429-28).
      return change.op === "unset"
    }
  }
  const target = childAt(parent, last)
  if (change.op === "append") {
    if (typeof last !== "string" || !isRecord(parent)) return false
    const list = target.found ? target.value : (parent[last] = [])
    if (!Array.isArray(list)) return false
    list.push(change.value)
  } else if (Array.isArray(parent)) {
    if (target.index === undefined) return change.op === "unset"
    if (change.op === "unset") parent.splice(target.index, 1)
    else parent[target.index] = change.value
  } else if (isRecord(parent) && typeof last === "string") {
    if (change.op === "unset") delete parent[last]
    else parent[last] = change.value
  } else {
    return false
  }
  return true
}

/**
 * The loaded config with a landed write applied as the server merges it on a trusted base, so
 * nothing waits on a re-read; undefined when it cannot be mirrored here.
 */
function patchConfig(
  config: Record<string, unknown>,
  changes: readonly ConfigChange[],
): Record<string, unknown> | undefined {
  const next = JSON.parse(JSON.stringify(config)) as Record<string, unknown>
  for (const change of changes) {
    if (change.op === "expect") continue
    if (change.op === "move") {
      const moving = lookup(next, change.from)
      if (!moving.found || !applyAt(next, { op: "unset", path: change.from })) return undefined
      if (!applyAt(next, { op: "set", path: change.path, value: moving.value })) return undefined
      continue
    }
    if (change.op === "set-if-absent") {
      if (lookup(next, change.path).found) continue
      // 429-42: completion over a root use.headless keeps the owner's value, so only a read shows it.
      const legacy =
        change.path.length === BROWSER_HEADLESS_PATH.length &&
        change.path.every((segment, index) => segment === BROWSER_HEADLESS_PATH[index]) &&
        lookup(next, LEGACY_HEADLESS_PATH).found
      if (legacy || !applyAt(next, { op: "set", path: change.path, value: change.value })) return undefined
      continue
    }
    if (!applyAt(next, change)) return undefined
  }
  return next
}

interface OutboxEntry {
  change?: ConfigChange
  /** A valid change no write has carried yet. */
  dirty: boolean
  /** A change a refused write carried; only Retry or a new edit sends it again. */
  held: boolean
}

interface Pin {
  fieldKey: string
  value: unknown
}

interface HeldExplicit {
  keys: readonly string[]
  changes: ConfigChange[]
  undoMeta?: ConfigUndoMeta
  /** A computed write is computed again on Retry, never re-sent as it was. */
  compute?: ConfigCompute
}

interface EngineHost {
  dispatch: Dispatch<HookAction>
  getState: () => HookState
  setLoad: (load: ConfigLoadState) => void
  setStorageKey: (key: string) => void
  setPin: (pin: Pin | undefined) => void
  setRestored: (restored: ConfigUndoMeta) => void
}

function createEngine(host: EngineHost) {
  const outbox = new Map<string, OutboxEntry>()
  const locations = new Map<string, FieldLocation>()
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  let attached = false
  let flight: Promise<void> | undefined
  let polling = false
  let reading: Promise<void> | undefined
  let writeSeq = 0
  let answer: ConfigReadAnswer | undefined
  let loaded = false
  let revision: string | undefined
  let restored = false
  let focusedKey: string | undefined
  let pin: Pin | undefined
  /** The raw value each held field shows; an explicit write drops it only if it is still what it sent. */
  const holds = new Map<string, unknown>()
  let heldExplicit: HeldExplicit | undefined

  function emit(event: ConfigAutosaveEvent, newLocations?: Record<string, FieldLocation>) {
    host.dispatch({ event, now: Date.now(), ...(newLocations ? { locations: newLocations } : {}) })
  }

  function setPin(next: Pin | undefined) {
    pin = next
    host.setPin(next)
  }

  function clearTimer(key: string) {
    const timer = timers.get(key)
    if (timer !== undefined) clearTimeout(timer)
    timers.delete(key)
  }

  /** A clean entry only mirrors what was typed; once nothing is pending on it, the file's value takes over. */
  function releaseClean(key: string) {
    if (key === focusedKey || outbox.get(key)?.dirty) return
    if (host.getState().machine.fields[key]?.fieldState !== "clean") return
    outbox.delete(key)
    emit({ type: "draft-cleared", fieldKey: key })
  }

  function issuesFrom(error: unknown, keys: readonly string[]): { issues: ConfigAutosaveIssue[]; message?: string } {
    const text = error instanceof Error ? error.message : String(error)
    const payload = errorPayload(error)
    if (payload === undefined) return { issues: [], message: text }
    const listed = Array.isArray(payload.issues) ? payload.issues : []
    const issues: ConfigAutosaveIssue[] = []
    const unmatched: string[] = []
    for (const item of listed) {
      if (!isRecord(item) || !Array.isArray(item.path) || typeof item.message !== "string") continue
      const named = JSON.stringify(item.path)
      const fieldKey = keys.find((key) => {
        const location = locations.get(key)
        if (!location) return key === named
        const indexed = indexPathOf(answer?.config, location.segments)
        return key === named || (indexed !== undefined && JSON.stringify(indexed) === named)
      })
      if (fieldKey === undefined) unmatched.push(item.message)
      else issues.push({ fieldKey, message: item.message })
    }
    const message = unmatched[0] ?? (issues.length === 0 ? text : undefined)
    return message === undefined ? { issues } : { issues, message }
  }

  function applyLanded(changes: readonly ConfigChange[]): boolean {
    if (!answer) return false
    const config = patchConfig(answer.config, changes)
    if (!config) {
      // The landed write could not be mirrored here, so the next poll re-reads it.
      revision = undefined
      return false
    }
    answer = { ...answer, config, ...(revision === undefined ? {} : { revision }) }
    if (loaded) host.setLoad({ kind: "ready", answer })
    return true
  }

  async function write(
    keys: readonly string[],
    changes: ConfigChange[],
    explicit?: ConfigUndoMeta,
    byAction = false,
    compute?: ConfigCompute,
  ): Promise<boolean> {
    let id = `config-write-${++writeSeq}`
    const sentHolds = keys.map((key) => holds.get(key))
    let landed!: () => void
    flight = new Promise<void>((resolve) => {
      landed = resolve
    })
    emit({ type: "write-started", id, fieldKeys: keys })
    const send = (set: ConfigChange[]) =>
      explicit ? applyConfigChanges(set, { undoable: true }) : applyConfigChanges(set)
    try {
      let result: Awaited<ReturnType<typeof applyConfigChanges>>
      try {
        result = await send(changes)
      } catch (error) {
        if (compute === undefined || !attached || !isFieldChanged(error)) throw error
        // The file moved under a computed write: read it and compute once more (429-46).
        if (reading) await reading
        await quietRead()
        if (!attached) return false
        if (!answer) throw error
        changes = compute(answer.config)
        if (changes.length === 0) {
          emit({ type: "write-succeeded", id })
          return true
        }
        id = `config-write-${++writeSeq}`
        emit({ type: "write-started", id, fieldKeys: keys })
        result = await send(changes)
      }
      if (!attached) return false
      // 429-37 CR-01: a write that merged onto bytes this page never read absorbed an outside
      // edit, so its revision is not the page's own read; drop trust and re-read once it settles.
      const stale =
        typeof result.baseRevision === "string" && (revision === undefined || result.baseRevision !== revision)
      revision = stale ? undefined : result.revision
      const mirrored = applyLanded(changes)
      const written = keys.filter((key) => {
        const entry = outbox.get(key)
        if (!entry || entry.dirty) return false
        outbox.delete(key)
        return true
      })
      emit({ type: "write-succeeded", id })
      if (mirrored) {
        for (const key of written) releaseClean(key)
      }
      if (byAction) {
        keys.forEach((key, index) => {
          if (outbox.get(key)?.dirty || holds.get(key) !== sentHolds[index]) return
          holds.delete(key)
          emit({ type: "draft-cleared", fieldKey: key })
        })
      }
      if (explicit && result.undo) {
        emit({
          type: "undo-offered",
          kind: explicit.kind,
          name: explicit.name,
          token: result.undo.token,
          expiresAt: Date.now() + UNDO_WINDOW_MS,
        })
      }
      return true
    } catch (error) {
      if (!attached) return false
      for (const key of keys) {
        const entry = outbox.get(key)
        if (entry && !entry.dirty && entry.change) entry.held = true
      }
      if (compute !== undefined) {
        heldExplicit = { keys, changes, compute, ...(explicit === undefined ? {} : { undoMeta: explicit }) }
      } else if (byAction && keys.length > 0) {
        heldExplicit = explicit === undefined ? { keys, changes } : { keys, changes, undoMeta: explicit }
      }
      if (compute !== undefined && isFieldChanged(error)) {
        // A second refusal in a row: say so, and show the file as it now is.
        revision = undefined
        emit({ type: "write-failed", id, issues: [], message: FIELD_CHANGED_TEXT })
        return false
      }
      const { issues, message } = issuesFrom(error, keys)
      emit(message === undefined ? { type: "write-failed", id, issues } : { type: "write-failed", id, issues, message })
      return false
    } finally {
      flight = undefined
      landed()
      if (attached) flush()
      if (attached && !flight && revision === undefined) void quietRead()
    }
  }

  function flush() {
    if (flight) return
    const keys = [...outbox.entries()].filter(([, entry]) => entry.dirty && entry.change).map(([key]) => key)
    if (keys.length === 0) return
    const changes: ConfigChange[] = []
    for (const key of keys) {
      const entry = outbox.get(key)!
      changes.push(entry.change!)
      entry.dirty = false
      entry.held = false
      clearTimer(key)
    }
    void write(keys, answer ? completeRequiredSiblings(changes, answer.config) : changes)
  }

  function edit(field: ConfigFieldRef, raw: unknown, parsed: ConfigFieldParse) {
    const key = configFieldKeyOf(field.segments)
    const location: FieldLocation = { segments: [...field.segments], tab: field.tab }
    locations.set(key, location)
    clearTimer(key)
    if (pin?.fieldKey === key) setPin(undefined)
    const entry = outbox.get(key) ?? { dirty: false, held: false }
    if (parsed.valid) {
      const path = [...field.segments]
      entry.change = "unset" in parsed ? { op: "unset", path } : { op: "set", path, value: parsed.value }
      entry.dirty = true
      entry.held = false
      timers.set(
        key,
        setTimeout(() => {
          timers.delete(key)
          flush()
        }, SETTLE_DELAY_MS),
      )
    } else {
      delete entry.change
      entry.dirty = false
      entry.held = false
    }
    outbox.set(key, entry)
    emit(
      parsed.valid
        ? { type: "edit", fieldKey: key, raw, valid: true }
        : { type: "edit", fieldKey: key, raw, valid: false, error: parsed.error },
      { [key]: location },
    )
  }

  function forgetHeldExplicit(key: string) {
    if (heldExplicit?.keys.includes(key)) heldExplicit = undefined
  }

  function hold(field: ConfigFieldRef, raw: string) {
    const key = configFieldKeyOf(field.segments)
    const location: FieldLocation = { segments: [...field.segments], tab: field.tab }
    locations.set(key, location)
    clearTimer(key)
    outbox.delete(key)
    forgetHeldExplicit(key)
    if (pin?.fieldKey === key) setPin(undefined)
    if (answer && sameAsFile(raw, valueAt(answer.config, field.segments))) {
      holds.delete(key)
      emit({ type: "draft-cleared", fieldKey: key })
      return
    }
    holds.set(key, raw)
    emit({ type: "edit", fieldKey: key, raw, valid: false }, { [key]: location })
  }

  function discard(field: ConfigFieldRef) {
    const key = configFieldKeyOf(field.segments)
    clearTimer(key)
    outbox.delete(key)
    holds.delete(key)
    forgetHeldExplicit(key)
    if (pin?.fieldKey === key) setPin(undefined)
    emit({ type: "draft-cleared", fieldKey: key })
  }

  function settle(field: ConfigFieldRef) {
    clearTimer(configFieldKeyOf(field.segments))
    flush()
  }

  function retry() {
    let resend = false
    for (const entry of outbox.values()) {
      if (entry.held) {
        entry.held = false
        entry.dirty = true
      }
      if (entry.dirty) resend = true
    }
    const explicit = heldExplicit
    heldExplicit = undefined
    if (explicit?.compute) void computedWrite(explicit.compute, explicit.undoMeta, true)
    else if (explicit) void explicitWrite(explicit.keys, explicit.changes, explicit.undoMeta)
    if (resend || flight) {
      flush()
      return
    }
    if (explicit) return
    // A refused explicit action or Undo leaves nothing to re-send: clear the failure (it stays
    // while any draft remains) and show the file as it is.
    emit({ type: "draft-cleared", fieldKey: "" })
    void read()
  }

  function setFocusedField(field: ConfigFieldRef | undefined) {
    const key = field ? configFieldKeyOf(field.segments) : undefined
    if (field && key !== undefined) locations.set(key, { segments: [...field.segments], tab: field.tab })
    if (key === focusedKey) return
    const previous = focusedKey
    focusedKey = key
    if (previous === undefined) return
    if (pin?.fieldKey === previous) setPin(undefined)
    releaseClean(previous)
  }

  function restoreDrafts(next: ConfigReadAnswer) {
    const storageKey = `${CONFIG_DRAFTS_STORAGE_PREFIX}${next.file?.path ?? ""}`
    const drafts = readStoredDrafts(storageKey, next.config)
    const entries: RestoredDraft[] = []
    const restoredLocations: Record<string, FieldLocation> = {}
    for (const [key, draft] of Object.entries(drafts)) {
      const location = { segments: draft.segments, tab: draft.tab }
      locations.set(key, location)
      restoredLocations[key] = location
      entries.push(draft.error === undefined ? { fieldKey: key, raw: draft.raw } : { fieldKey: key, raw: draft.raw, error: draft.error })
    }
    if (entries.length > 0) emit({ type: "drafts-restored", entries }, restoredLocations)
    host.setStorageKey(storageKey)
  }

  /** An outside re-read replaces the loaded answer; drafts and the focused field keep what they show. */
  function mergeQuietly(previous: ConfigReadAnswer) {
    const fields = host.getState().machine.fields
    if (focusedKey !== undefined && fields[focusedKey] === undefined && pin?.fieldKey !== focusedKey) {
      const location = locations.get(focusedKey)
      if (location) setPin({ fieldKey: focusedKey, value: valueAt(previous.config, location.segments) })
    }
    for (const key of Object.keys(fields)) releaseClean(key)
  }

  async function read(polledRevision?: string): Promise<void> {
    try {
      const next = await fetchConfig()
      if (!attached) return
      const previous = answer
      answer = next
      revision = next.revision ?? polledRevision
      if (!restored) {
        restored = true
        restoreDrafts(next)
      }
      if (previous) mergeQuietly(previous)
      loaded = true
      host.setLoad({ kind: "ready", answer: next })
    } catch (error) {
      if (!attached) return
      // A quiet re-read that failed in transit keeps the last good answer with no notice; the
      // revision stays stale, so the next poll reads again.
      if (loaded && !isFileRefusal(error)) return
      if (polledRevision !== undefined) revision = polledRevision
      loaded = false
      host.setLoad({ kind: "error", reason: loadFailureReason(error) })
    }
  }

  /** One quiet re-read at a time: a stale write and a poll that both want one share it. */
  function quietRead(polledRevision?: string): Promise<void> {
    reading ??= read(polledRevision).finally(() => {
      reading = undefined
    })
    return reading
  }

  async function poll(): Promise<void> {
    if (polling || flight || !attached) return
    polling = true
    try {
      const { revision: current } = await fetchConfigRevision()
      if (attached && !flight && current !== revision) await quietRead(current)
    } catch {
      // A missed poll is retried on the next tick.
    } finally {
      polling = false
    }
  }

  async function explicitWrite(
    keys: readonly string[],
    changes: ConfigChange[],
    undoMeta?: ConfigUndoMeta,
  ): Promise<boolean> {
    while (flight) await flight
    if (!attached) return false
    return write(keys, changes, undoMeta, true)
  }

  function runExplicit(
    changes: ConfigChange[],
    undoMeta?: ConfigUndoMeta,
    fields: readonly ConfigFieldRef[] = [],
  ): Promise<boolean> {
    const keys = fields.map((field) => {
      const key = configFieldKeyOf(field.segments)
      locations.set(key, { segments: [...field.segments], tab: field.tab })
      forgetHeldExplicit(key)
      return key
    })
    return explicitWrite(keys, changes, undoMeta)
  }

  async function computedWrite(
    compute: ConfigCompute,
    undoMeta?: ConfigUndoMeta,
    fresh = false,
  ): Promise<boolean> {
    while (flight) await flight
    if (!attached) return false
    if (fresh || revision === undefined || !answer) {
      if (reading) await reading
      await quietRead()
      while (flight) await flight
      if (!attached) return false
    }
    if (!answer) return false
    const changes = compute(answer.config)
    if (changes.length === 0) {
      // A Retry that finds nothing left to write clears the failure it was offered for.
      if (fresh) emit({ type: "draft-cleared", fieldKey: "" })
      return true
    }
    return write([], changes, undoMeta, true, compute)
  }

  function runComputed(compute: ConfigCompute, undoMeta?: ConfigUndoMeta): Promise<boolean> {
    return computedWrite(compute, undoMeta)
  }

  function offerUndo(ticket: { token: string }, meta: ConfigUndoMeta) {
    if (!attached) return
    emit({
      type: "undo-offered",
      kind: meta.kind,
      name: meta.name,
      token: ticket.token,
      expiresAt: Date.now() + UNDO_WINDOW_MS,
    })
  }

  function failExplicit(error: unknown) {
    if (!attached) return
    const { message } = issuesFrom(error, [])
    emit(
      message === undefined
        ? { type: "write-failed", id: "explicit-action", issues: [] }
        : { type: "write-failed", id: "explicit-action", issues: [], message },
    )
  }

  async function undo(): Promise<void> {
    const pending = host.getState().machine.undo
    if (!pending || Date.now() >= pending.expiresAt) return
    try {
      await undoConfigAction(pending.token)
      if (!attached) return
      emit({ type: "undo-finished" })
      await read()
      if (attached) host.setRestored({ kind: pending.kind, name: pending.name })
    } catch (error) {
      if (!attached) return
      emit({ type: "undo-finished" })
      const { message } = issuesFrom(error, [])
      emit(message === undefined ? { type: "write-failed", id: "undo", issues: [] } : { type: "write-failed", id: "undo", issues: [], message })
    }
  }

  function refresh() {
    void read()
  }

  function reload() {
    loaded = false
    host.setLoad({ kind: "loading" })
    void read()
  }

  function attach() {
    attached = true
    void read()
  }

  function detach() {
    attached = false
    for (const key of [...timers.keys()]) clearTimer(key)
  }

  return {
    attach,
    detach,
    edit,
    hold,
    discard,
    settle,
    retry,
    reload,
    refresh,
    poll,
    runExplicit,
    runComputed,
    offerUndo,
    failExplicit,
    undo,
    setFocusedField,
  }
}

type Engine = ReturnType<typeof createEngine>

function failedField(state: HookState): ConfigDraftTarget | undefined {
  const named = Object.entries(state.machine.fields)
    .filter(([, field]) => field.fieldState === "failed")
    .map(([key]) => key)
  for (const fieldKey of [...named, ...(state.machine.failure?.fieldKeys ?? [])]) {
    const location = state.locations[fieldKey]
    if (location) return { tab: location.tab, fieldKey }
  }
  return undefined
}

function firstDraft(state: HookState, externalDrafts: ReadonlySet<ConfigTab>): ConfigDraftTarget | undefined {
  let best: ConfigDraftTarget | undefined
  let bestRank = Number.POSITIVE_INFINITY
  for (const tab of externalDrafts) {
    const rank = CONFIG_TABS.indexOf(tab)
    if (rank < bestRank) {
      best = { tab, fieldKey: externalDraftFieldKey(tab) }
      bestRank = rank
    }
  }
  for (const fieldKey of draftFieldKeys(state.machine)) {
    const location = state.locations[fieldKey]
    if (!location) continue
    const rank = CONFIG_TABS.indexOf(location.tab)
    if (rank < bestRank) {
      best = { tab: location.tab, fieldKey }
      bestRank = rank
    }
  }
  return best
}

export function useConfigAutosave(): ConfigAutosave {
  const [state, dispatch] = useReducer(reduceHook, undefined, initialHookState)
  const [load, setLoad] = useState<ConfigLoadState>({ kind: "loading" })
  const [storageKey, setStorageKey] = useState<string | undefined>(undefined)
  const [pin, setPin] = useState<Pin | undefined>(undefined)
  const [restored, setRestored] = useState<ConfigRestored | undefined>(undefined)
  const [externalDrafts, setExternalDrafts] = useState<ReadonlySet<ConfigTab>>(() => new Set())
  const setExternalDraft = useMemo(
    () => (tab: ConfigTab, present: boolean) =>
      setExternalDrafts((previous) => {
        if (previous.has(tab) === present) return previous
        const next = new Set(previous)
        if (present) next.add(tab)
        else next.delete(tab)
        return next
      }),
    [],
  )
  const [, setTick] = useState(0)
  const stateRef = useRef(state)
  stateRef.current = state
  const engineRef = useRef<Engine | null>(null)
  if (engineRef.current === null) {
    engineRef.current = createEngine({
      dispatch,
      getState: () => stateRef.current,
      setLoad,
      setStorageKey,
      setPin,
      setRestored: ({ kind, name }) => setRestored((previous) => ({ kind, name, seq: (previous?.seq ?? 0) + 1 })),
    })
  }
  const engine = engineRef.current

  useEffect(() => {
    engine.attach()
    return () => engine.detach()
  }, [engine])

  useEffect(() => {
    const pollIfVisible = () => {
      if (document.visibilityState === "visible") void engine.poll()
    }
    const timer = setInterval(pollIfVisible, REVISION_POLL_MS)
    document.addEventListener("visibilitychange", pollIfVisible)
    window.addEventListener("focus", pollIfVisible)
    return () => {
      clearInterval(timer)
      document.removeEventListener("visibilitychange", pollIfVisible)
      window.removeEventListener("focus", pollIfVisible)
    }
  }, [engine])

  useEffect(() => {
    if (storageKey !== undefined) writeStoredDrafts(storageKey, state)
  }, [state, storageKey])

  const machineStatus = deriveSaveStatus(state.machine, Date.now())
  // An external draft sits at the draft rung: it outranks saved and idle, never failed, undo or saving.
  const status: ConfigSaveStatus =
    externalDrafts.size > 0 && (machineStatus.state === "saved" || machineStatus.state === "idle")
      ? { ...machineStatus, state: "draft" }
      : machineStatus
  const savedAt = state.machine.savedAt
  const undoExpiresAt = state.machine.undo?.expiresAt

  useEffect(() => {
    const deadlines: number[] = []
    if (status.state === "saved" && savedAt !== undefined) deadlines.push(savedAt + SAVED_VISIBLE_MS)
    if (undoExpiresAt !== undefined) deadlines.push(undoExpiresAt)
    if (deadlines.length === 0) return
    const timer = setTimeout(() => setTick((tick) => tick + 1), Math.max(0, Math.min(...deadlines) - Date.now()))
    return () => clearTimeout(timer)
  }, [status.state, savedAt, undoExpiresAt])

  const draftTabs = useMemo(() => {
    const tabs = new Set<ConfigTab>(externalDrafts)
    for (const key of draftFieldKeys(state.machine)) {
      const location = state.locations[key]
      if (location) tabs.add(location.tab)
    }
    return tabs
  }, [state, externalDrafts])

  const config = load.kind === "ready" ? load.answer.config : undefined

  return {
    load,
    status,
    draftTabs,
    edit: engine.edit,
    hold: engine.hold,
    discard: engine.discard,
    settle: engine.settle,
    retry: engine.retry,
    valueOf: (field) => {
      const key = configFieldKeyOf(field.segments)
      const entry = state.machine.fields[key]
      if (entry) return entry.raw
      if (pin?.fieldKey === key) return pin.value
      return valueAt(config, field.segments)
    },
    stateOf: (field) => state.machine.fields[configFieldKeyOf(field.segments)]?.fieldState ?? "clean",
    errorOf: (field) => state.machine.fields[configFieldKeyOf(field.segments)]?.error,
    setFocusedField: engine.setFocusedField,
    runExplicit: engine.runExplicit,
    runComputed: engine.runComputed,
    offerUndo: engine.offerUndo,
    failExplicit: engine.failExplicit,
    undo: engine.undo,
    restored,
    goToFirstDraft: () => firstDraft(state, externalDrafts),
    failedFieldTarget: () => failedField(state),
    reload: engine.reload,
    refresh: engine.refresh,
    setExternalDraft,
  }
}

const ConfigAutosaveContext = createContext<ConfigAutosave | null>(null)

export function ConfigAutosaveProvider({ value, children }: { value: ConfigAutosave; children: ReactNode }) {
  return createElement(ConfigAutosaveContext.Provider, { value }, children)
}

export function useConfigAutosaveContext(): ConfigAutosave {
  const value = useContext(ConfigAutosaveContext)
  if (value === null) throw new Error("useConfigAutosaveContext needs a ConfigAutosaveProvider")
  return value
}
