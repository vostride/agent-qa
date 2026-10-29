// Concrete filesystem completed-run handoff store.
//
// Implements the storage-neutral `HandoffStorePort` from @vostride/agent-qa-runner. This is a
// storageImplementation home for node:fs + node:path (the FsActionCache / FsStorageStateStore
// boundary) — the durable handoff fs write lives here, never in the runner (validate:arch
// storageNeutral). On-disk layout — one JSON document beside the run's events.jsonl:
//
//   <root>/runs/<slug(runId)>/handoff.json
//
// The read side (`loadCompletedRunHandoff`) is deliberately thin: read → JSON.parse → delegate to
// the schema package's ONE `guardCompletedRunHandoff` version rule. The refusal (any schemaVersion
// other than the current one ⇒ typed HandoffVersionError) is never re-implemented here; the
// version discipline lives in exactly one place.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { guardCompletedRunHandoff } from '@vostride/agent-qa-schema'
import type { CompletedRunHandoff } from '@vostride/agent-qa-schema'
import type { HandoffStorePort } from '@vostride/agent-qa-runner'

import { slugBranch } from './branch-resolver.js'
import { RUNS_SUBDIR } from './event-log.js'

/** The single JSON document each run writes its completed-run handoff to. */
export const HANDOFF_FILE = 'handoff.json'

export interface FsHandoffStoreConfig {
  /** Runtime root (e.g. DEFAULT_AGENT_QA_DIR = '.agent-qa'). */
  root: string
  /** The run this handoff belongs to; slugged before it becomes a path segment. */
  runId: string
}

export class FsHandoffStore implements HandoffStorePort {
  private readonly dir: string
  private readonly file: string

  constructor(config: FsHandoffStoreConfig) {
    // Same slugged run dir as FsEventLog so handoff.json lands beside events.jsonl.
    this.dir = join(config.root, RUNS_SUBDIR, slugBranch(config.runId))
    this.file = join(this.dir, HANDOFF_FILE)
  }

  save(handoff: CompletedRunHandoff): void {
    mkdirSync(this.dir, { recursive: true })
    writeFileSync(this.file, `${JSON.stringify(handoff)}\n`, 'utf-8')
  }
}

/**
 * The fs read leg of the handoff version discipline: read the single document, parse it,
 * and delegate to the schema package's `guardCompletedRunHandoff`. A newer-than-known schemaVersion
 * surfaces the schema's typed `HandoffVersionError` — this leg re-implements no version rule.
 */
export function loadCompletedRunHandoff(filePath: string): CompletedRunHandoff {
  const raw = readFileSync(filePath, 'utf-8')
  return guardCompletedRunHandoff(JSON.parse(raw))
}
