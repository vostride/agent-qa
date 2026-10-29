// File-scoped writes: recreating the dir would wipe the sibling `replay.json`.

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { CassetteScore, DecisionDiff, JudgeIdentityBlock, ScoringContext } from '@vostride/agent-qa-eval'
import { slugBranch } from '@vostride/agent-qa-schema'

import { DEFAULT_EVAL_REPLAYS_SUBDIR } from './replay-record-store.js'

export const SCORE_FILE = 'score.json'

/** The persisted per-cassette score document, computed entirely in eval core. */
export interface ScoreRecord {
  cassetteId: string
  /** The matcher constitution that minted the score (attribution stamp). */
  matcherVersion: number
  score: CassetteScore
  diffs: readonly DecisionDiff[]
  // The judge identity behind any stamp, serialized verbatim; absent when no judge walk ran.
  judge?: JudgeIdentityBlock
  scoringContext?: ScoringContext
}

export interface FsScoreStoreConfig {
  /** Runtime root (normally the workdir's `.agent-qa` directory). */
  root: string
}

export interface WrittenScoreRecord {
  cassetteId: string
  dir: string
  file: string
}

export class FsScoreStore {
  private readonly outputRoot: string

  constructor(config: FsScoreStoreConfig) {
    // SAME subdir as the record store — the score sits beside its replay.json.
    this.outputRoot = join(config.root, DEFAULT_EVAL_REPLAYS_SUBDIR)
  }

  save(record: ScoreRecord): WrittenScoreRecord {
    const dir = join(
      this.outputRoot,
      ...record.cassetteId.split('/').map(segment => slugBranch(segment)),
    )
    // File-scoped write: recreating the dir would wipe the sibling `replay.json`.
    mkdirSync(dir, { recursive: true })

    const file = join(dir, SCORE_FILE)
    writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8')

    return { cassetteId: record.cassetteId, dir, file }
  }
}
