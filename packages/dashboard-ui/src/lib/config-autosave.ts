// THE CONFIG PAGE'S SAVE STATE.
//
// One pure, total machine owns what the page's one status may say. Every clock is a parameter,
// the reduceLivePreview idiom: no timers, no storage and no network here, the hook owns effects.
// The truthfulness rules live in the reducer: only write-succeeded reaches saved, and a failed
// write keeps every value it carried.

import { SAVED_VISIBLE_MS, undoLine } from './config-copy'
import type { ExplicitActionKind, FieldState, SaveState } from './config-tabs'

export interface ConfigFieldEntry {
  raw: unknown
  /** clean: no problem known (written, or valid and not yet settled). */
  fieldState: FieldState
  error?: string
}

export interface ConfigWriteInFlight {
  id: string
  fieldKeys: readonly string[]
}

/** A server-named problem, already mapped from its config path to a field key. */
export interface ConfigAutosaveIssue {
  fieldKey: string
  message: string
}

export interface ConfigWriteFailure {
  fieldKeys: readonly string[]
  message?: string
  issues: readonly ConfigAutosaveIssue[]
}

export interface PendingUndo {
  kind: ExplicitActionKind
  name: string
  token: string
  expiresAt: number
}

export interface ConfigAutosaveState {
  fields: Readonly<Record<string, ConfigFieldEntry>>
  write?: ConfigWriteInFlight
  failure?: ConfigWriteFailure
  undo?: PendingUndo
  savedAt?: number
}

export interface RestoredDraft {
  fieldKey: string
  raw: unknown
  error?: string
}

// prettier-ignore
export type ConfigAutosaveEvent =
  | { type: 'edit'; fieldKey: string; raw: unknown; valid: boolean; error?: string }
  | { type: 'write-started'; id: string; fieldKeys: readonly string[] }
  | { type: 'write-succeeded'; id: string }
  | { type: 'write-failed'; id: string; issues: readonly ConfigAutosaveIssue[]; message?: string }
  | { type: 'retry' }
  | { type: 'undo-offered'; kind: ExplicitActionKind; name: string; token: string; expiresAt: number }
  | { type: 'undo-finished' }
  | { type: 'drafts-restored'; entries: readonly RestoredDraft[] }
  | { type: 'draft-cleared'; fieldKey: string }

export interface ConfigSaveUndoLine {
  line: string
  name: string
  token: string
}

export interface ConfigSaveStatus {
  state: SaveState
  undo?: ConfigSaveUndoLine
  failingFieldKeys: readonly string[]
  message?: string
}

/** A field's key is the JSON of its config path segments. */
export function configFieldKey(segments: readonly (string | number)[]): string {
  return JSON.stringify(segments)
}

export function createInitialConfigAutosave(): ConfigAutosaveState {
  return { fields: {} }
}

function entry(raw: unknown, fieldState: FieldState, error?: string): ConfigFieldEntry {
  return error === undefined ? { raw, fieldState } : { raw, fieldState, error }
}

function without(
  state: ConfigAutosaveState,
  key: 'write' | 'failure' | 'undo' | 'savedAt',
): ConfigAutosaveState {
  const next = { ...state }
  delete next[key]
  return next
}

/** Carried fields still holding the value the write sent; one edited mid-flight keeps its own state. */
function settleCarried(
  state: ConfigAutosaveState,
  carried: readonly string[],
  next: (key: string, current: ConfigFieldEntry) => ConfigFieldEntry,
): ConfigAutosaveState['fields'] {
  const fields = { ...state.fields }
  for (const key of carried) {
    const current = fields[key]
    if (current?.fieldState === 'saving') fields[key] = next(key, current)
  }
  return fields
}

function hasDrafts(fields: ConfigAutosaveState['fields']): boolean {
  return Object.values(fields).some((f) => f.fieldState === 'draft' || f.fieldState === 'failed')
}

function reduceEvent(
  state: ConfigAutosaveState,
  event: ConfigAutosaveEvent,
  now: number,
): ConfigAutosaveState {
  switch (event.type) {
    case 'edit':
      return {
        ...state,
        fields: {
          ...state.fields,
          [event.fieldKey]: event.valid
            ? entry(event.raw, 'clean')
            : entry(event.raw, 'draft', event.error),
        },
      }
    case 'write-started': {
      const fields = { ...state.fields }
      for (const key of event.fieldKeys) {
        const current = fields[key]
        if (current !== undefined) fields[key] = entry(current.raw, 'saving')
      }
      return { ...state, fields, write: { id: event.id, fieldKeys: [...event.fieldKeys] } }
    }
    case 'write-succeeded': {
      if (state.write?.id !== event.id) return state
      const fields = settleCarried(state, state.write.fieldKeys, (_key, current) =>
        entry(current.raw, 'clean'),
      )
      const { write: _write, failure: _failure, ...rest } = state
      return { ...rest, fields, savedAt: now }
    }
    case 'write-failed': {
      const carried = state.write?.id === event.id ? state.write.fieldKeys : []
      const named = new Map(event.issues.map((issue) => [issue.fieldKey, issue.message]))
      const fields = settleCarried(state, carried, (key, current) => {
        const message = named.get(key)
        return message === undefined
          ? entry(current.raw, 'draft')
          : entry(current.raw, 'failed', message)
      })
      const failure: ConfigWriteFailure = {
        fieldKeys: [...carried],
        issues: [...event.issues],
        ...(event.message === undefined ? {} : { message: event.message }),
      }
      const rest = without(state, 'savedAt')
      // A failed write is no longer in flight, whatever it carried.
      return state.write?.id === event.id
        ? { ...without(rest, 'write'), fields, failure }
        : { ...rest, fields, failure }
    }
    case 'retry':
      // The hook re-sends the drafts; failed holds until a write actually lands.
      return state
    case 'undo-offered':
      return {
        ...state,
        undo: {
          kind: event.kind,
          name: event.name,
          token: event.token,
          expiresAt: event.expiresAt,
        },
      }
    case 'undo-finished':
      return without(state, 'undo')
    case 'drafts-restored': {
      const fields = { ...state.fields }
      for (const restored of event.entries) {
        if (fields[restored.fieldKey] === undefined) {
          fields[restored.fieldKey] = entry(restored.raw, 'draft', restored.error)
        }
      }
      return { ...state, fields }
    }
    case 'draft-cleared': {
      const { [event.fieldKey]: _gone, ...fields } = state.fields
      const next = { ...state, fields }
      return hasDrafts(fields) ? next : without(next, 'failure')
    }
  }
}

/** Pure and total: the host passes its clock reading; an Undo line past its window is dropped. */
export function reduceConfigAutosave(
  state: ConfigAutosaveState,
  event: ConfigAutosaveEvent,
  now: number,
): ConfigAutosaveState {
  const next = reduceEvent(state, event, now)
  return next.undo !== undefined && now >= next.undo.expiresAt ? without(next, 'undo') : next
}

/** Fields the status calls unsaved: drafts and server-refused fields, in the order they appeared. */
export function draftFieldKeys(state: ConfigAutosaveState): string[] {
  return Object.entries(state.fields)
    .filter(([, f]) => f.fieldState === 'draft' || f.fieldState === 'failed')
    .map(([key]) => key)
}

/** What the status says at `now`: failed → undo → saving → draft → saved → idle. */
export function deriveSaveStatus(state: ConfigAutosaveState, now: number): ConfigSaveStatus {
  const failingFieldKeys = Object.entries(state.fields)
    .filter(([, f]) => f.fieldState === 'failed')
    .map(([key]) => key)
  const status = (saveState: SaveState): ConfigSaveStatus => ({
    state: saveState,
    failingFieldKeys,
  })

  if (state.failure !== undefined) {
    const message = state.failure.message
    return message === undefined ? status('failed') : { ...status('failed'), message }
  }
  const undo = state.undo
  if (undo !== undefined && now < undo.expiresAt) {
    const line = undoLine(undo.kind, undo.name)
    return { ...status('undo'), undo: { line, name: undo.name, token: undo.token } }
  }
  if (state.write !== undefined) return status('saving')
  if (draftFieldKeys(state).length > 0) return status('draft')
  if (state.savedAt !== undefined && now - state.savedAt < SAVED_VISIBLE_MS) return status('saved')
  return status('idle')
}
