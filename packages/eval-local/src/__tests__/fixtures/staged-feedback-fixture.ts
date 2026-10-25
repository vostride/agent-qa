import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { committedFileText, extractRunCassettes, maskCorpusText } from '@vostride/agent-qa-eval'
import { loadCompletedRunHandoff } from '@vostride/agent-qa-runner-local'
import { slugBranch, type Benefit, type MaskFn } from '@vostride/agent-qa-schema'
import { FsRunArtifactSource } from '../../artifact-source.js'
import { FEEDBACK_STAGING_SUBDIR } from '../../gate2-composition.js'

export interface StagedFeedbackFixtureInput {
  agentQaRoot: string
  product: string
  stateDigest: string
  target: { runId: string; testId: string; stepIndex: number }
  attributedObservationId: string
  benefit: Benefit
  candidateId: string
  /** Applied to the run before extraction; identity when absent. */
  mask?: MaskFn
}

/** Writes one staged feedback entry in the layout `listStagedFeedback` reads, from the run's own handoff. */
export function writeStagedFeedback(input: StagedFeedbackFixtureInput): string {
  const handoff = loadCompletedRunHandoff(join(input.agentQaRoot, 'runs', slugBranch(input.target.runId), 'handoff.json'))
  const matches = extractRunCassettes({
    handoff: input.mask === undefined ? handoff : maskCorpusText(handoff, input.mask),
    artifacts: new FsRunArtifactSource({ root: input.agentQaRoot, runId: handoff.runId }),
  }).cassettes.filter(entry => entry.cassette.granularity === 'leaf' && entry.cassette.runId === input.target.runId
    && entry.cassette.input.testId === input.target.testId && entry.cassette.stepIndex === input.target.stepIndex)
  if (matches.length !== 1) throw new Error(`expected one leaf cassette at the target, found ${matches.length}`)
  const extracted = matches[0]!
  const dir = join(realpathSync(input.agentQaRoot), FEEDBACK_STAGING_SUBDIR, slugBranch(input.product), input.stateDigest)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'cassette.json'), committedFileText(extracted.cassette))
  writeFileSync(join(dir, 'feedback.json'), committedFileText({ schemaVersion: 2, product: input.product,
    stateDigest: input.stateDigest, attributedObservationId: input.attributedObservationId, benefit: input.benefit,
    candidateId: input.candidateId, ...input.target, stagedAt: new Date(0).toISOString() }))
  if (extracted.blobs.length > 0) mkdirSync(join(dir, 'blobs'))
  for (const blob of extracted.blobs) writeFileSync(join(dir, 'blobs', blob.sha), blob.bytes)
  return dir
}
