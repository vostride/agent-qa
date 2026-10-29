// The analysis artifact's host write adapter.
//
// The durability idiom is the curation-tail receipt writer's, copied deliberately and NOT
// handoff.json's plain write: stage under a random `.tmp` name, write at 0o600, fsync the
// staged file, rename into place, fsync the directory, remove the staged file in a finally.
// The artifact is what a chip's `done` promises is fetchable — the verdicts-authored value
// is recorded only AFTER this returns — so a torn or unsynced write here would be the one
// place `authored` could overstate. Idempotent per path by construction: rename replaces
// atomically, so re-persisting the same run leaves one file and last write wins.

import { closeSync, fsyncSync, openSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'

import { canonicalJson } from '@vostride/agent-qa-schema'
import type { RunAnalysisArtifact } from '@vostride/agent-qa-schema'

/** The staged-file marker, kept distinct from the receipt writer's so residue is attributable. */
const ANALYSIS_STAGE_PREFIX = 'analysis.json'

function fsyncFile(file: string): void {
  const fd = openSync(file, 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/**
 * Durably write one run's analysis artifact at `path`.
 *
 * The caller owns the path law — the composition root derives it from `runId` alone via
 * `slugBranch`, mirroring the handoff read binding. This helper owns only the
 * bytes and their durability.
 */
export function writeAnalysisArtifact(path: string, artifact: RunAnalysisArtifact): void {
  const dir = dirname(path)
  const staged = join(dir, `.${ANALYSIS_STAGE_PREFIX}.${randomUUID()}.tmp`)
  try {
    writeFileSync(staged, `${canonicalJson(artifact)}\n`, { encoding: 'utf8', mode: 0o600 })
    fsyncFile(staged)
    renameSync(staged, path)
    fsyncFile(dir)
  } finally {
    rmSync(staged, { force: true })
  }
}
