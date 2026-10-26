// Filesystem batch-report store.
//
// Persists one aggregated EvalBatchReport as its own artifact under the uncommitted runtime
// staging root:
//
//   <output-root>/eval/reports/<slugged batchKey>.json
//
// The filename derives ONLY from report.batchKey — eval core's deterministic replay-batch key
// (sha256 over the canonical sorted cassette-id list) — through schema's slugBranch sanitizer,
// which keeps a hostile key inside the reports root. No timestamps or random components are
// minted in the published identity, so a rerun of the same batch replaces the same file and a
// different batch lands beside it. Bytes are deterministic: same report ⇒ same path, same bytes.
// The save writes that one file and nothing else.
//
// eval-local serializes only: the report arrives fully aggregated from eval core's
// buildEvalReport — no aggregation or scoring logic lives in this file.

import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

import type { EvalBatchReport } from '@vostride/agent-qa-eval'
import { slugBranch } from '@vostride/agent-qa-schema'

export const DEFAULT_EVAL_REPORTS_SUBDIR = 'eval/reports'

export interface FsReportStoreConfig {
  /** Runtime root (normally the workdir's `.agent-qa` directory). */
  root: string
}

export interface WrittenReport {
  batchKey: string
  file: string
}

export class FsReportStore {
  private readonly outputRoot: string

  constructor(config: FsReportStoreConfig) {
    this.outputRoot = join(config.root, DEFAULT_EVAL_REPORTS_SUBDIR)
  }

  save(report: EvalBatchReport): WrittenReport {
    const file = join(this.outputRoot, `${slugBranch(report.batchKey)}.json`)
    mkdirSync(this.outputRoot, { recursive: true })
    // Unique temporary storage keeps concurrent writers from sharing a staging file.
    const temporary = mkdtempSync(join(this.outputRoot, '.publish-'))
    const staged = join(temporary, basename(file))
    try {
      writeFileSync(staged, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
      renameSync(staged, file)
    } catch (error) {
      const io = error as NodeJS.ErrnoException
      if (typeof io.code !== 'string') throw error
      throw Object.assign(new Error(io.message, { cause: error }), { code: io.code, path: file })
    } finally {
      rmSync(temporary, { recursive: true, force: true })
    }
    return { batchKey: report.batchKey, file }
  }
}
