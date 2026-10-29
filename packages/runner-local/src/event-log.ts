// One synchronous append per envelope; the reader drops a torn final line instead of failing.

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
    // `slugBranch` makes the run id one safe path segment that never leaves `runs/`.
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
