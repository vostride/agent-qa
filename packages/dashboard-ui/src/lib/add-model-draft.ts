// THE ADD ROW'S DRAFT. The add row's non-secret fields survive a
// reload for this viewer; the typed key, token, sign-in code and header values never reach
// storage. Writes and reads both go through one allow-list, so a new field stays out until named.

import { CONNECTION_CHOICES, type ConnectionChoice } from './config-tabs'

export const ADD_MODEL_DRAFT_STORAGE_PREFIX = 'agent-qa:config-add-draft:'

export type AddModelKeyType = 'api-key' | 'bearer-token'

export interface AddModelDraft {
  choice?: ConnectionChoice
  baseURL?: string
  model?: string
  name?: string
  nameEdited?: boolean
  keyType?: AddModelKeyType
  headerNames?: string[]
  createdCredential?: boolean
}

type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

const KEY_TYPES: readonly AddModelKeyType[] = ['api-key', 'bearer-token']

const FIELD_CHECKS: { [K in keyof Required<AddModelDraft>]: (value: unknown) => boolean } = {
  choice: (value) => typeof value === 'string' && (CONNECTION_CHOICES as readonly string[]).includes(value),
  baseURL: (value) => typeof value === 'string',
  model: (value) => typeof value === 'string',
  name: (value) => typeof value === 'string',
  nameEdited: (value) => typeof value === 'boolean',
  keyType: (value) => typeof value === 'string' && (KEY_TYPES as readonly string[]).includes(value),
  headerNames: (value) => Array.isArray(value) && value.every((item) => typeof item === 'string'),
  createdCredential: (value) => typeof value === 'boolean',
}

const FIELDS = Object.keys(FIELD_CHECKS) as (keyof AddModelDraft)[]

function storageKey(configPath: string): string {
  return `${ADD_MODEL_DRAFT_STORAGE_PREFIX}${configPath}`
}

/** The allow-listed fields only; undefined when any listed field is off-shape. */
function pickDraft(value: unknown): AddModelDraft | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const source = value as Record<string, unknown>
  const draft: Record<string, unknown> = {}
  for (const field of FIELDS) {
    const item = source[field]
    if (item === undefined) continue
    if (!FIELD_CHECKS[field](item)) return undefined
    draft[field] = Array.isArray(item) ? [...item] : item
  }
  return draft as AddModelDraft
}

/** The name the add row suggests for a model id (UI-SPEC S5, step 3). */
export function suggestModelName(modelId: string): string {
  return modelId
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, '-')
    .replace(/^[-.]+/, '')
}

export function readAddModelDraft(
  configPath: string,
  storage?: Pick<Storage, 'getItem'>,
): AddModelDraft | undefined {
  try {
    const text = (storage ?? globalThis.localStorage)?.getItem(storageKey(configPath))
    if (!text) return undefined
    return pickDraft(JSON.parse(text))
  } catch {
    return undefined
  }
}

export function writeAddModelDraft(configPath: string, draft: AddModelDraft, storage?: DraftStorage): void {
  const picked = pickDraft(draft)
  if (!picked) return
  try {
    ;(storage ?? globalThis.localStorage)?.setItem(storageKey(configPath), JSON.stringify(picked))
  } catch {
    // Storage can be full or blocked; the draft still lives in the row.
  }
}

export function clearAddModelDraft(configPath: string, storage?: Pick<Storage, 'removeItem'>): void {
  try {
    ;(storage ?? globalThis.localStorage)?.removeItem(storageKey(configPath))
  } catch {
    // Storage is optional.
  }
}
