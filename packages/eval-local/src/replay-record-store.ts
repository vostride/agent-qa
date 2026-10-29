// Each record dir is recreated in full, so a re-run leaves no stale files; bytes are deterministic.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { ReplayCassetteOutcome } from '@vostride/agent-qa-eval'
import { slugBranch } from '@vostride/agent-qa-schema'

export const DEFAULT_EVAL_REPLAYS_SUBDIR = 'eval/replays'
export const REPLAY_RECORD_FILE = 'replay.json'

export interface FsReplayRecordStoreConfig {
  /** Runtime root (normally the workdir's `.agent-qa` directory). */
  root: string
  /** Actual producer seed, embedded in the record bytes. */
  executionSeed?: number
}

export interface WrittenReplayRecord {
  cassetteId: string
  dir: string
  file: string
}

export class FsReplayRecordStore {
  private readonly outputRoot: string
  private readonly executionSeed?: number

  constructor(config: FsReplayRecordStoreConfig) {
    this.outputRoot = join(config.root, DEFAULT_EVAL_REPLAYS_SUBDIR)
    this.executionSeed = config.executionSeed
  }

  save(outcome: ReplayCassetteOutcome): WrittenReplayRecord {
    const dir = join(
      this.outputRoot,
      ...outcome.cassetteId.split('/').map((segment) => slugBranch(segment)),
    )
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })

    const file = join(dir, REPLAY_RECORD_FILE)
    const record =
      this.executionSeed === undefined ? outcome : { ...outcome, executionSeed: this.executionSeed }
    writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8')

    return { cassetteId: outcome.cassetteId, dir, file }
  }
}
