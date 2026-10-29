/** One identity in a target refusal: the element's role, exact name and row words. */
export interface TargetIdentity {
  /** Absent only on a stated target that named no role; the observed identity always has one. */
  role?: string
  name: string
  row?: string
}

export type TargetMismatchReason = 'role-kind' | 'name-no-shared-word' | 'name-number' | 'row'

// Identities are redacted before record; a refusal is a planning decision, not an app failure.
export interface TargetRefusalMeta {
  kind: 'target-mismatch'
  lane: 'ref' | 'fromRef' | 'toRef'
  path: 'live' | 'heal'
  stated: TargetIdentity
  observed: TargetIdentity
  reasons: TargetMismatchReason[]
  rowStated: boolean
  inputSent: false
}

export const TARGET_REFUSAL_KEYS = [
  'kind',
  'lane',
  'path',
  'stated',
  'observed',
  'reasons',
  'rowStated',
  'inputSent',
] as const

export const TARGET_IDENTITY_KEYS = ['role', 'name', 'row'] as const

const LANES: ReadonlySet<unknown> = new Set(['ref', 'fromRef', 'toRef'])
const PATHS: ReadonlySet<unknown> = new Set(['live', 'heal'])
const REASONS: ReadonlySet<unknown> = new Set([
  'role-kind',
  'name-no-shared-word',
  'name-number',
  'row',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readIdentity(raw: unknown): TargetIdentity | undefined {
  if (!isRecord(raw)) return undefined
  const { role, name, row } = raw
  if (typeof name !== 'string') return undefined
  if (role !== undefined && typeof role !== 'string') return undefined
  if (row !== undefined && typeof row !== 'string') return undefined
  return {
    ...(role !== undefined ? { role } : {}),
    name,
    ...(row !== undefined ? { row } : {}),
  }
}

// Narrows field by field; a hand-edited or partial block reads as undefined.
export function readTargetRefusalMeta(
  result?: { metadata?: Record<string, unknown> },
): TargetRefusalMeta | undefined {
  const raw = result?.metadata?.['targetRefusal']
  if (!isRecord(raw)) return undefined
  const { kind, lane, path, reasons, rowStated, inputSent } = raw
  if (kind !== 'target-mismatch' || inputSent !== false) return undefined
  if (!LANES.has(lane) || !PATHS.has(path) || typeof rowStated !== 'boolean') return undefined
  if (!Array.isArray(reasons) || reasons.length === 0) return undefined
  if (!reasons.every((reason) => REASONS.has(reason))) return undefined
  const stated = readIdentity(raw['stated'])
  const observed = readIdentity(raw['observed'])
  if (stated === undefined || observed === undefined) return undefined
  return {
    kind,
    lane: lane as TargetRefusalMeta['lane'],
    path: path as TargetRefusalMeta['path'],
    stated,
    observed,
    reasons: [...reasons] as TargetMismatchReason[],
    rowStated,
    inputSent,
  }
}
