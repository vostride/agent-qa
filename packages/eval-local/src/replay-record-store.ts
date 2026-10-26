// Filesystem replay-record store (Phase 368, D-12).
//
// Persists each per-cassette replay outcome — a ReplayResult or a typed ReplayRefusal (refusals are
// records too, never silent; the report verb counts them) — under an uncommitted runtime staging
// root beside `eval/cassettes`:
//
//   <output-root>/<slugged cassette id segments>/replay.json
//
// The store mirrors FsCassetteStore's posture exactly: every id segment delegates to schema's
// security-reviewed slugBranch sanitizer (path-traversal control, T-368-10), and each record is
// recreated in full (rm + mkdir) before writing so a re-run leaves no stale files behind (idempotent
// overwrite). The write is deterministic: the same outcome yields the same path and the same bytes —
// no timestamps or random ids are minted here; timing data already lives inside the outcome from the
// engine clock. Records land ONLY under this output root — never knowledge dirs. Records are
// written as handed over.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { ReplayCassetteOutcome } from '@vostride/agent-qa-eval'
import { slugBranch } from '@vostride/agent-qa-schema'

export const DEFAULT_EVAL_REPLAYS_SUBDIR = 'eval/replays'
export const REPLAY_RECORD_FILE = 'replay.json'

export interface FsReplayRecordStoreConfig {
  /** Runtime root (normally the workdir's `.agent-qa` directory). */
  root: string
  /** Optional retargeted output directory. */
  outputDir?: string
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
    this.outputRoot = config.outputDir ?? join(config.root, DEFAULT_EVAL_REPLAYS_SUBDIR)
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
