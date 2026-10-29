// The read side delegates to the schema's one handoff version rule and re-implements none.

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

// A newer schema version surfaces the schema's typed `HandoffVersionError`.
export function loadCompletedRunHandoff(filePath: string): CompletedRunHandoff {
  const raw = readFileSync(filePath, 'utf-8')
  return guardCompletedRunHandoff(JSON.parse(raw))
}
