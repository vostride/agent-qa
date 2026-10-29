// Holds no lock, so callers append under the writer lease; a bad line is refused, never dropped.

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  CURRENT_QUARANTINE_LEDGER_SCHEMA_VERSION,
  canonicalJson,
  guardQuarantineLedgerEvent,
  hasQuarantineEventShape,
} from '@vostride/agent-qa-schema'
import type {
  QuarantineEntryState,
  QuarantineEntryStateName,
  QuarantineLedgerEvent,
  QuarantineOwner,
} from '@vostride/agent-qa-schema'
import { quarantineIdentityKey } from './identity.js'

/** The ledger's fixed name directly under the committed knowledge root — never caller-supplied. */
export const QUARANTINE_LEDGER_FILENAME = 'quarantine.jsonl'

/** One line the read refused, surfaced as data so a caller can print or audit it. */
export interface RefusedQuarantineLine {
  /** 1-based, so it matches what an editor shows the human who has to fix the file. */
  lineNumber: number
  reason: string
}

export interface QuarantineLedgerRead {
  events: readonly QuarantineLedgerEvent[]
  refusedLines: readonly RefusedQuarantineLine[]
}

/** The ledger's absolute path under one knowledge root. */
export function quarantineLedgerPath(knowledgeRoot: string): string {
  return join(knowledgeRoot, QUARANTINE_LEDGER_FILENAME)
}

// A missing ledger is empty; a newer `schemaVersion` throws `QuarantineLedgerVersionError`.
export function readQuarantineLedger(knowledgeRoot: string): QuarantineLedgerRead {
  let text: string
  try {
    text = readFileSync(quarantineLedgerPath(knowledgeRoot), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { events: [], refusedLines: [] }
    }
    throw error
  }

  const events: QuarantineLedgerEvent[] = []
  const refusedLines: RefusedQuarantineLine[] = []

  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim().length === 0) continue

    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch (error) {
      refusedLines.push({
        lineNumber: index + 1,
        reason: `unparseable line: ${error instanceof Error ? error.message : String(error)}`,
      })
      continue
    }

    // The version guard's own reject-newer arm must propagate; only its structural rejection
    // folds to a refusal. Distinguishing them keeps a build-level "cannot read this truth at all"
    // apart from a line-level "this one record is damaged".
    let event: QuarantineLedgerEvent
    try {
      event = guardQuarantineLedgerEvent(parsed)
    } catch (error) {
      if (error instanceof TypeError) {
        refusedLines.push({ lineNumber: index + 1, reason: error.message })
        continue
      }
      throw error
    }
    events.push(event)
  }

  return { events, refusedLines }
}

interface MutableEntry {
  product: string
  filePath: string
  testName: string
  fingerprint: string
  verdictClass: QuarantineEntryState['verdictClass']
  owner: QuarantineOwner
  enteredAt: string
  expiresAt: string
  /** Accumulated across every `entered` event for this key — never reset by the re-entry arm. */
  enteredCount: number
  /** The FIRST `entered` event's instant for this key; set once and carried forward. */
  firstEnteredAt: string
  /** The state the EVENTS put the entry in; expiry is applied against `now` afterwards. */
  eventState: 'quarantined' | 'released'
}

// A renewal never reopens a released window, and a lapse ends the window, not the suppression.
export function foldQuarantineLedgerState(
  events: readonly QuarantineLedgerEvent[],
  now: string,
): QuarantineEntryState[] {
  const entries = new Map<string, MutableEntry>()

  for (const event of events) {
    const key = quarantineIdentityKey(event)
    switch (event.kind) {
      case 'entered': {
        // Read the prior record first: `enteredCount` and `firstEnteredAt` are history.
        const prior = entries.get(key)
        entries.set(key, {
          product: event.product,
          filePath: event.filePath,
          testName: event.testName,
          fingerprint: event.fingerprint,
          verdictClass: event.verdictClass,
          owner: event.owner,
          enteredAt: event.at,
          expiresAt: event.expiresAt,
          enteredCount: (prior?.enteredCount ?? 0) + 1,
          firstEnteredAt: prior?.firstEnteredAt ?? event.at,
          eventState: 'quarantined',
        })
        break
      }
      case 'renewed': {
        const existing = entries.get(key)
        // A renewal with no window to renew is meaningless — refusing to synthesize one keeps the
        // fold honest about what the log actually says (no invented entries reach any surface).
        if (existing === undefined) break
        // A renewal never reopens a closed window; only a new `entered` does.
        if (existing.eventState === 'released') break
        existing.expiresAt = event.expiresAt
        if (event.owner !== undefined) existing.owner = event.owner
        existing.eventState = 'quarantined'
        break
      }
      case 'released-manual':
      case 'released-auto': {
        const existing = entries.get(key)
        if (existing === undefined) break
        existing.eventState = 'released'
        break
      }
    }
  }

  const nowMs = Date.parse(now)
  return [...entries.values()].map((entry) => {
    let state: QuarantineEntryStateName = entry.eventState
    if (state === 'quarantined') {
      const expiresMs = Date.parse(entry.expiresAt)
      // An unparseable deadline counts as lapsed, so the failing test fails builds again.
      if (Number.isNaN(expiresMs) || expiresMs <= nowMs) state = 'expired'
    }
    return {
      product: entry.product,
      filePath: entry.filePath,
      testName: entry.testName,
      fingerprint: entry.fingerprint,
      verdictClass: entry.verdictClass,
      owner: entry.owner,
      enteredAt: entry.enteredAt,
      expiresAt: entry.expiresAt,
      enteredCount: entry.enteredCount,
      firstEnteredAt: entry.firstEnteredAt,
      state,
    }
  })
}

/** What an append answers: how many lines it wrote. */
export type QuarantineAppendOutcome = { kind: 'appended'; lines: number }

// One fail-closed unit: every event is checked before any byte is written.
export function appendQuarantineEvents(
  knowledgeRoot: string,
  events: readonly QuarantineLedgerEvent[],
): QuarantineAppendOutcome {
  if (events.length === 0) return { kind: 'appended', lines: 0 }

  // `===`, not `<=`: older versions also refuse the read, and `NaN` fails every ordering test.
  for (let index = 0; index < events.length; index += 1) {
    const version = events[index]?.schemaVersion
    if (version !== CURRENT_QUARANTINE_LEDGER_SCHEMA_VERSION) {
      throw new TypeError(
        `quarantine event at index ${String(index)} would be refused by the ledger read: ` +
          `schemaVersion ${String(version)} is not the current version ` +
          `${String(CURRENT_QUARANTINE_LEDGER_SCHEMA_VERSION)} — the committed ledger must never ` +
          'carry a line no checkout can consume',
      )
    }
    if (hasQuarantineEventShape(events[index])) continue
    throw new TypeError(
      `quarantine event at index ${String(index)} would be refused by the ledger read: ` +
        'the committed ledger must never carry a line no checkout can consume',
    )
  }

  const lines = events.map((event) => canonicalJson(event))
  mkdirSync(knowledgeRoot, { recursive: true })
  appendFileSync(quarantineLedgerPath(knowledgeRoot), `${lines.join('\n')}\n`, 'utf8')
  return { kind: 'appended', lines: lines.length }
}
