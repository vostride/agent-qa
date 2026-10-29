// Stage, fsync, rename, fsync the directory: the artifact is what a chip's `done` promises exists.

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

// The caller owns the path; this helper owns only the bytes and their durability.
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
