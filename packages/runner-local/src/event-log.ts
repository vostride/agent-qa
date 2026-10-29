// Concrete filesystem event-log sink.
//
// Implements the storage-neutral `EventLogPort` from @vostride/agent-qa-runner. This is a
// storageImplementation home for node:fs + node:path (the same boundary as FsActionCache /
// FsStorageStateStore) — ALL run-event fs writes live here, never in the runner
// (validate:arch storageNeutral). On-disk layout:
//
//   <root>/runs/<slug(runId)>/events.jsonl
//
// D-06 append discipline: synchronous, fsync-free, mkdir-recursive then one appendFileSync of
// exactly one JSON line per envelope — the file is crash-safe up to the last completed append.
// The runId directory component is slugged traversal-safe (the T-360-03 `slugBranch` idiom) so a
// planner-supplied `../..`-shaped runId can never escape the runs root. The read leg
// (deep replay for the bus) tolerates a torn final line: a corrupt/partial row is dropped and the
// read still succeeds (the storage-state never-crash-the-reader posture — the bus layer, not this
// leg, reports incompleteness via ReplayIncompleteError; T-361-06 / D-07).

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { RunEventEnvelope } from '@vostride/agent-qa-schema'
import type { EventLogPort } from '@vostride/agent-qa-runner'

import { slugBranch } from './branch-resolver.js'

/** Subdirectory under the runtime root holding per-run event logs. */
export const RUNS_SUBDIR = 'runs'

/** The single JSONL file name each run appends its event stream to. */
export const EVENTS_FILE = 'events.jsonl'

export interface FsEventLogConfig {
  /** Runtime root (e.g. DEFAULT_AGENT_QA_DIR = '.agent-qa'). */
  root: string
  /** The run this log belongs to; slugged before it becomes a path segment. */
  runId: string
}

export class FsEventLog implements EventLogPort {
  private readonly dir: string
  private readonly file: string

  constructor(config: FsEventLogConfig) {
    // slugBranch neutralizes `..`, path separators, and leading/trailing dots so the slug is a
    // single safe path segment that can never traverse out of runs/ (T-361-01 / V5).
    this.dir = join(config.root, RUNS_SUBDIR, slugBranch(config.runId))
    this.file = join(this.dir, EVENTS_FILE)
  }

  append(envelope: RunEventEnvelope): void {
    // mkdir-recursive then a single synchronous appendFileSync of one line.
    mkdirSync(this.dir, { recursive: true })
    appendFileSync(this.file, `${JSON.stringify(envelope)}\n`)
  }

  read(fromSeq: number): RunEventEnvelope[] {
    let raw: string
    try {
      raw = readFileSync(this.file, 'utf-8')
    } catch (err) {
      // No log yet ⇒ empty replay, never an error.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }
    const out: RunEventEnvelope[] = []
    for (const line of raw.split('\n')) {
      if (line.length === 0) continue
      let parsed: RunEventEnvelope
      try {
        parsed = JSON.parse(line) as RunEventEnvelope
      } catch {
        // A torn/partial final line is dropped — the reader never throws on garbage.
        continue
      }
      if (parsed.seq >= fromSeq) out.push(parsed)
    }
    return out
  }
}
