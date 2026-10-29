// A field is named by segments, not a dotted string, so a key holding a dot stays addressable.
import { z } from 'zod'
import { isConfigSchemaPath } from './leaves'

// `move` re-keys a field inside the server, so its value never travels.
export type ConfigWriteOp =
  | 'set'
  | 'unset'
  | 'append'
  | 'set-if-absent'
  | 'move'
  | 'expect'
// prettier-ignore
export const CONFIG_WRITE_OPS = [
  'set',
  'unset',
  'append',
  'set-if-absent',
  'move',
  'expect',
] as const satisfies readonly ConfigWriteOp[]

// `marker_written_back`: writing a `[secret:<name>]` marker back would replace the real secret.
export type ConfigWriteRefusal =
  | 'invalid_write_input'
  | 'file_invalid'
  | 'path_not_found'
  | 'validation_failed'
  | 'write_failed'
  | 'field_changed'
  | 'path_not_writable'
  | 'marker_written_back'
// prettier-ignore
export const CONFIG_WRITE_REFUSALS = [
  'invalid_write_input',
  'file_invalid',
  'path_not_found',
  'validation_failed',
  'write_failed',
  'field_changed',
  'path_not_writable',
  'marker_written_back',
] as const satisfies readonly ConfigWriteRefusal[]

// The one sentence every write door answers `marker_written_back` with.
export const MARKER_WRITTEN_BACK_SENTENCE =
  "This holds [secret:<name>], the way a declared secret is shown, so it can't be saved here. "
  + "Edit your config or test file directly instead, and don't copy [secret:<name>] into it; "
  + "the secret's value stays in your secrets file."

/**
 * The only arrays a `{ name }` segment may select inside. Selecting by name rather than index
 * keeps a change on its entry when an outside edit reorders the list.
 */
export type ConfigNamedArray = 'registry.llms'
// prettier-ignore
export const CONFIG_NAMED_ARRAYS = [
  'registry.llms',
] as const satisfies readonly ConfigNamedArray[]

/** A mapping key, an array index, or a `{ name }` selector inside a named array. */
export type ConfigPathSegment = string | number | { name: string }

export const ConfigPathSegmentSchema = z.union([
  z.string().min(1),
  z.number().int().nonnegative(),
  z.object({ name: z.string().min(1) }).strict(),
])

const ConfigPathSchema = z.array(ConfigPathSegmentSchema).min(1)

// `plugins` names code the CLI loads, so it stays a file edit.
export type ConfigWriteDeniedRoot = 'plugins'
// prettier-ignore
export const CONFIG_WRITE_DENIED_ROOTS = [
  'plugins',
] as const satisfies readonly ConfigWriteDeniedRoot[]

/**
 * True when the page's write door may change the path: a schema leaf or an ancestor of one,
 * outside the denied roots. A `{ name }` selector is read as an array item.
 */
export function isPageWritableConfigPath(path: readonly ConfigPathSegment[]): boolean {
  const root = path[0]
  if (typeof root !== 'string') return false
  if ((CONFIG_WRITE_DENIED_ROOTS as readonly string[]).includes(root)) return false
  return isConfigSchemaPath(path.map(segment => (typeof segment === 'object' ? 0 : segment)))
}

const [SET_OP, UNSET_OP, APPEND_OP, SET_IF_ABSENT_OP, MOVE_OP, EXPECT_OP] = CONFIG_WRITE_OPS

export const ConfigChangeSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal(SET_OP), path: ConfigPathSchema, value: z.unknown() }).strict(),
  z.object({ op: z.literal(UNSET_OP), path: ConfigPathSchema }).strict(),
  z.object({ op: z.literal(APPEND_OP), path: ConfigPathSchema, value: z.unknown() }).strict(),
  z.object({ op: z.literal(SET_IF_ABSENT_OP), path: ConfigPathSchema, value: z.unknown() }).strict(),
  z.object({ op: z.literal(MOVE_OP), from: ConfigPathSchema, path: ConfigPathSchema }).strict(),
  z.object({ op: z.literal(EXPECT_OP), path: ConfigPathSchema, value: z.unknown() }).strict(),
])

export type ConfigChange = z.infer<typeof ConfigChangeSchema>

export const ConfigWriteRequestSchema = z.object({
  changes: z.array(ConfigChangeSchema).min(1),
  undoable: z.boolean().optional(),
}).strict()

export type ConfigWriteRequest = z.infer<typeof ConfigWriteRequestSchema>

export type ConfigWriteIssue = { path: (string | number)[]; message: string }

export type ConfigWriteResult = {
  revision: string
  /** The sha256 of the bytes the write merged onto; CONFIG_REVISION_ABSENT when the file did not exist. */
  baseRevision?: string
  undo?: { token: string; expiresAt: number }
}

/** The revision a config file that does not exist yet reports. */
export const CONFIG_REVISION_ABSENT = 'absent'

export const ConfigUndoRequestSchema = z.object({
  token: z.string().min(1),
}).strict()

export type ConfigUndoRequest = z.infer<typeof ConfigUndoRequestSchema>

export type ConfigUndoResult = { restored: true; revision?: string }

/**
 * Why an Undo was refused.
 * - `undo_expired`: the token is unknown or its window has passed.
 * - `undo_conflict`: the field changed since the write the token undoes.
 */
export type ConfigActionRefusal =
  | 'undo_expired'
  | 'undo_conflict'
// prettier-ignore
export const CONFIG_ACTION_REFUSALS = [
  'undo_expired',
  'undo_conflict',
] as const satisfies readonly ConfigActionRefusal[]
