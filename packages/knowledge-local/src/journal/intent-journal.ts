// The intent is fsynced before the publish rename and cleared only after the index delta applies.
import { randomUUID } from 'node:crypto'
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'

import { canonicalJson } from '@vostride/agent-qa-schema'
import { z } from 'zod'
import { curationObservationSchema } from './curation-effect-receipt.js'
import { assertWithinKnowledgeRoot } from '../knowledge-containment.js'

export const JOURNAL_SUBDIR = 'memory/queue/journal'
export const COMMIT_INTENT_SCHEMA_VERSION = 2

/**
 * Highest writer epoch whose reconciliation has completed, relative to knowledgeRoot. Pinned
 * state, not configuration: reconciliation writes it inside the authority section it already
 * holds, so the watermark can never lag a completed pass.
 */
export const RECONCILED_EPOCH_FILE = `${JOURNAL_SUBDIR}/.reconciled-epoch`

const CANDIDATE_ID = /^[0-9a-f]{64}$/
const INTENT_FILE = /^([0-9a-f]{64})\.intent\.json$/

export const commitIntentSchema = z
  .object({
    schemaVersion: z.literal(COMMIT_INTENT_SCHEMA_VERSION),
    candidateId: z.string().regex(CANDIDATE_ID),
    bundleId: z.string().min(1),
    deltaKind: z.enum(['Add', 'Confirm', 'Supersede', 'Deprecate', 'MintUnknown', 'Noop']),
    targetRecordId: z.string().min(1).optional(),
    epoch: z.number().int().positive(),
    observation: curationObservationSchema.optional(),
  })
  .strict()

export type CommitIntent = z.infer<typeof commitIntentSchema>

export type ListedCommitIntent =
  | { parsed: CommitIntent }
  | { malformed: true; candidateId: string }

function journalRoot(knowledgeRoot: string): string {
  if (!isAbsolute(knowledgeRoot)) {
    throw new TypeError('knowledgeRoot must be absolute')
  }
  return join(knowledgeRoot, JOURNAL_SUBDIR)
}

function intentPath(knowledgeRoot: string, candidateId: string): string {
  const parsedCandidateId = z.string().regex(CANDIDATE_ID).parse(candidateId)
  return join(journalRoot(knowledgeRoot), `${parsedCandidateId}.intent.json`)
}

function bestEffortFsyncDirectory(dir: string): void {
  let fd: number | undefined
  try {
    fd = openSync(dir, 'r')
    fsyncSync(fd)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (
      code !== 'ENOENT' &&
      code !== 'EINVAL' &&
      code !== 'EISDIR' &&
      code !== 'EPERM' &&
      code !== 'ENOTSUP'
    ) {
      throw error
    }
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function atomicRewrite(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.tmp-${randomUUID()}`
  let fd: number | undefined
  try {
    fd = openSync(temporary, 'wx')
    writeFileSync(fd, text, 'utf8')
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(temporary, file)
    bestEffortFsyncDirectory(dirname(file))
  } finally {
    if (fd !== undefined) closeSync(fd)
    rmSync(temporary, { force: true })
  }
}

/** Durably replace one candidate's intent before any reader-visible bundle mutation. */
export function writeCommitIntent(knowledgeRoot: string, intent: CommitIntent): void {
  const parsed = commitIntentSchema.parse(intent)
  assertWithinKnowledgeRoot(knowledgeRoot, journalRoot(knowledgeRoot))
  atomicRewrite(
    intentPath(knowledgeRoot, parsed.candidateId),
    `${canonicalJson(parsed)}\n`,
  )
}

/**
 * Highest epoch whose reconciliation completed. Tolerant by construction: an absent or
 * unreadable watermark is zero, which admits every intent and preserves crash recovery on a
 * root that has never been reconciled.
 */
export function readReconciledEpoch(knowledgeRoot: string): number {
  let raw: string
  try {
    raw = readFileSync(join(knowledgeRoot, RECONCILED_EPOCH_FILE), 'utf8')
  } catch {
    return 0
  }
  const parsed = z.number().int().nonnegative().safeParse(Number(raw.trim()))
  return parsed.success ? parsed.data : 0
}

/** @internal The caller must already hold withCurrentWriterAuthority for this root. */
export function writeReconciledEpochWithinCurrentAuthority(
  knowledgeRoot: string,
  epoch: number,
): void {
  const validated = z.number().int().positive().parse(epoch)
  assertWithinKnowledgeRoot(knowledgeRoot, journalRoot(knowledgeRoot))
  atomicRewrite(join(knowledgeRoot, RECONCILED_EPOCH_FILE), `${validated}\n`)
}

export type QuarantineStaleCommitIntentOutcome =
  /** The bytes were preserved under `name`, which `listCommitIntents` never returns. */
  | { kind: 'quarantined'; name: string }
  | { kind: 'already-gone' }

// A per-call discriminator: a candidate can recur at a stale epoch, and a rename would clobber it.
export function quarantineStaleCommitIntent(
  knowledgeRoot: string,
  candidateId: string,
  epoch: number,
): QuarantineStaleCommitIntentOutcome {
  const file = intentPath(knowledgeRoot, candidateId)
  assertWithinKnowledgeRoot(knowledgeRoot, dirname(file))
  const quarantined = `.stale-${epoch}-${candidateId}-${randomUUID()}.intent.json`
  try {
    renameSync(file, join(dirname(file), quarantined))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return { kind: 'already-gone' }
  }
  bestEffortFsyncDirectory(dirname(file))
  return { kind: 'quarantined', name: quarantined }
}

/** Clear one confirmed intent after its index projection has been applied. */
export function clearCommitIntent(knowledgeRoot: string, candidateId: string): void {
  const file = intentPath(knowledgeRoot, candidateId)
  assertWithinKnowledgeRoot(knowledgeRoot, dirname(file))
  rmSync(file, { force: true })
  bestEffortFsyncDirectory(dirname(file))
}

/** List strict intents in candidate-id order while retaining torn bytes as recovery signals. */
export function listCommitIntents(knowledgeRoot: string): ListedCommitIntent[] {
  let names: string[]
  try {
    names = readdirSync(journalRoot(knowledgeRoot), { withFileTypes: true })
      .filter((entry) => entry.isFile() && INTENT_FILE.test(entry.name))
      .map((entry) => entry.name)
      .sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }

  return names.map((name) => {
    const candidateId = INTENT_FILE.exec(name)![1]!
    try {
      const parsed = commitIntentSchema.safeParse(
        JSON.parse(readFileSync(join(journalRoot(knowledgeRoot), name), 'utf8')),
      )
      return parsed.success && parsed.data.candidateId === candidateId
        ? { parsed: parsed.data }
        : { malformed: true, candidateId }
    } catch {
      return { malformed: true, candidateId }
    }
  })
}
