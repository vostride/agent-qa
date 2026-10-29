// Staged files are untrusted, so read failures are typed refusals; a missing score is absence.

import { existsSync, readFileSync, readdirSync, type Dirent } from 'node:fs'
import { basename, join } from 'node:path'

import type { ReplayCassetteOutcome, ReplayRefusal } from '@vostride/agent-qa-eval'
import { scoringContextSchema, hasValidScoreJudgeMetadata } from '@vostride/agent-qa-eval'

import { CASSETTE_FILE } from './cassette-store.js'
import { REPLAY_RECORD_FILE } from './replay-record-store.js'
import { SCORE_FILE, type ScoreRecord } from './score-store.js'

/** The discriminated replay-record read outcome: a persisted outcome, or a typed refusal. */
export type ReplayRecordLoad =
  | { kind: 'loaded'; outcome: ReplayCassetteOutcome }
  | { kind: 'refused'; refusal: ReplayRefusal }

/** The score read outcome: a persisted record, typed absence (never scored), or a typed refusal. */
export type ScoreRecordLoad =
  | { kind: 'loaded'; record: ScoreRecord }
  | { kind: 'absent' }
  | { kind: 'refused'; refusal: ReplayRefusal }

// Every refusal is attributed to a cassette id recovered from the dir basename: unlike
// loadCassetteBundle there is no guard step here (deep validation stays with eval core), so a
// document is never parsed-but-rejected — read/parse failures are the only refusal paths and the
// basename is the only recoverable id on them.
function refusal(cassetteId: string, detail: string): ReplayRefusal {
  return { kind: 'integrity-refusal', cassetteId, reason: 'parse-failed', detail }
}

// The shared read→parse ladder (loadCassetteBundle's posture): every failure is a returned value.
function readDocument(
  path: string,
  fallbackId: string,
): { kind: 'parsed'; document: unknown } | { kind: 'refused'; refusal: ReplayRefusal } {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    return {
      kind: 'refused',
      refusal: refusal(
        fallbackId,
        `Failed to read ${path}: ${(error as NodeJS.ErrnoException).message}`,
      ),
    }
  }

  let document: unknown
  try {
    document = JSON.parse(raw)
  } catch (error) {
    return {
      kind: 'refused',
      refusal: refusal(fallbackId, `Invalid JSON at ${path}: ${(error as Error).message}`),
    }
  }

  return { kind: 'parsed', document }
}

/**
 * Read a persisted ReplayCassetteOutcome back from `<dir>/replay.json`. A replay dir without its
 * marker file is corrupt, not empty — a missing or unreadable file refuses like a parse failure.
 * Never throws; the store serialized the outcome verbatim so the parsed document is it.
 */
export function loadReplayRecord(dir: string): ReplayRecordLoad {
  const read = readDocument(join(dir, REPLAY_RECORD_FILE), basename(dir))
  if (read.kind === 'refused') return read
  return { kind: 'loaded', outcome: read.document as ReplayCassetteOutcome }
}

/**
 * Read a persisted ScoreRecord back from `<dir>/score.json`. Absence is typed and legitimate
 * (refusal outcomes are never scored); an existing-but-unreadable/unparseable file refuses.
 * Never throws.
 */
export function loadScoreRecord(dir: string): ScoreRecordLoad {
  const path = join(dir, SCORE_FILE)
  if (!existsSync(path)) return { kind: 'absent' }

  const read = readDocument(path, basename(dir))
  if (read.kind === 'refused') return read
  if (!hasValidScoreJudgeMetadata(read.document)) {
    return { kind: 'refused', refusal: refusal(basename(dir), `Invalid score judge metadata at ${path}`) }
  }
  if (typeof read.document === 'object' && read.document !== null && 'scoringContext' in read.document &&
    !scoringContextSchema.safeParse(read.document.scoringContext).success) {
    return { kind: 'refused', refusal: refusal(basename(dir), `Invalid scoring context at ${path}`) }
  }
  return { kind: 'loaded', record: read.document as ScoreRecord }
}

// Cassette ids nest at any depth, so the walk recurses and sorts; a missing root is empty.
function listMarkerDirs(root: string, markerFile: string): string[] {
  const found: string[] = []

  function walk(dir: string): void {
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    if (entries.some(entry => entry.isFile() && entry.name === markerFile)) found.push(dir)
    for (const entry of entries) {
      if (entry.isDirectory()) walk(join(dir, entry.name))
    }
  }

  walk(root)
  return found.sort()
}

/** Enumerate every staged replay-record dir (contains replay.json) under the replays root, sorted. */
export function listReplayRecordDirs(replaysRoot: string): string[] {
  return listMarkerDirs(replaysRoot, REPLAY_RECORD_FILE)
}

/** Enumerate every staged cassette-bundle dir (contains cassette.json) under the cassettes root, sorted. */
export function listCassetteBundleDirs(cassettesRoot: string): string[] {
  return listMarkerDirs(cassettesRoot, CASSETTE_FILE)
}
