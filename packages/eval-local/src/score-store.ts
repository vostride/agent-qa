// Filesystem score store (Phase 369, D-13).
//
// Persists one cassette's matcher verdict — the CassetteScore plus its per-decision D-16 diffs —
// as `score.json` BESIDE the replay record, in the exact same slugged cassette dir
// FsReplayRecordStore derives (same output root, same slugBranch-per-segment derivation,
// T-368-10 path-traversal control):
//
//   <output-root>/<slugged cassette id segments>/score.json
//
// Pitfall-5 deviation from the record store's posture: FsReplayRecordStore recreates its dir in
// full (rm + mkdir) so a re-run leaves no stale files — copying that here would wipe the sibling
// replay.json. Score writes are therefore FILE-scoped (mkdir-if-missing + overwrite the one file,
// never rmSync the dir), and the sanctioned composition orders record-save BEFORE score-save so
// the record store's dir-recreate can never destroy a fresher score (OQ-2). Bytes stay
// deterministic: same record ⇒ same path, same bytes — no timestamps or random ids minted here.
//
// eval-local serializes only (F9): every score and diff arrives fully computed from eval core
// (scoreCassetteReplay / buildDecisionDiff); no scoring logic of any kind lives in this file.

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { CassetteScore, DecisionDiff, JudgeIdentityBlock, ScoringContext } from '@vostride/agent-qa-eval'
import { slugBranch } from '@vostride/agent-qa-schema'

import { DEFAULT_EVAL_REPLAYS_SUBDIR } from './replay-record-store.js'

export const SCORE_FILE = 'score.json'

/** The persisted per-cassette score document — computed entirely in eval core (F9). */
export interface ScoreRecord {
  cassetteId: string
  /** The matcher constitution that minted the score (attribution stamp). */
  matcherVersion: number
  score: CassetteScore
  diffs: readonly DecisionDiff[]
  /**
   * D-16 score-side reproducibility receipt: the full identity of the judge that produced any
   * stamp on this score — judge model id, resolved family, judgeVersion, threshold. Computed
   * entirely by eval-core adjudication and serialized verbatim here (F9: eval-local never
   * computes, only writes). Typed-absent when no judge walk ran, keeping 369 records
   * byte-compatible. The cassette's reserved tier4JudgeId is Phase 371 label territory —
   * the scorer never writes back into the measurement.
   */
  judge?: JudgeIdentityBlock
  scoringContext?: ScoringContext
}

export interface FsScoreStoreConfig {
  /** Runtime root (normally the workdir's `.agent-qa` directory). */
  root: string
  /** Optional retargeted output directory. */
  outputDir?: string
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
    this.outputRoot = config.outputDir ?? join(config.root, DEFAULT_EVAL_REPLAYS_SUBDIR)
  }

  save(record: ScoreRecord): WrittenScoreRecord {
    const dir = join(
      this.outputRoot,
      ...record.cassetteId.split('/').map(segment => slugBranch(segment)),
    )
    // File-scoped write (Pitfall 5): no rmSync dir-recreate — that would wipe the sibling
    // replay.json. Idempotent overwrite of the one file only.
    mkdirSync(dir, { recursive: true })

    const file = join(dir, SCORE_FILE)
    writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8')

    return { cassetteId: record.cassetteId, dir, file }
  }
}
