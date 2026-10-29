// A payload can hold a removed secret, so it stays in memory, is handed out once, never serialized.
import { randomUUID } from 'node:crypto'

import type { ConfigPriors } from './config-manager.js'

/** How long a token stays redeemable: longer than the page's 10 s Undo link, so a late click lands. */
export const UNDO_RETENTION_MS = 30_000

/** What a token redeems: the priors of an undoable config write, or a removed auth.json entry. */
export type UndoPayload =
  | { kind: 'config'; priors: ConfigPriors }
  | { kind: 'credential'; name: string; credential: unknown }

export interface UndoTicket {
  token: string
  expiresAt: number
}

export interface UndoStore {
  put(payload: UndoPayload, now: number): UndoTicket
  /** The payload once; a second take, an unknown token or an expired one answers undefined. */
  take(token: string, now: number): UndoPayload | undefined
}

export function createUndoStore(options: { retentionMs: number }): UndoStore {
  const entries = new Map<string, { payload: UndoPayload; expiresAt: number }>()

  function prune(now: number): void {
    for (const [token, entry] of entries) {
      if (entry.expiresAt <= now) entries.delete(token)
    }
  }

  return {
    put(payload, now) {
      prune(now)
      const token = randomUUID()
      const expiresAt = now + options.retentionMs
      entries.set(token, { payload, expiresAt })
      return { token, expiresAt }
    },
    take(token, now) {
      prune(now)
      const entry = entries.get(token)
      if (entry === undefined) return undefined
      entries.delete(token)
      return entry.payload
    },
  }
}
