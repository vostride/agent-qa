// Strictly leg-derived: a text-only cassette gets no screenshot key, a full one the recorded bytes.

import type { ArtifactRef, ScreenState } from '@vostride/agent-qa-schema'
import type { StepContext } from '@vostride/agent-qa-runner'
import type { CassetteInputLeg } from '../cassette/input-leg'
import type { ArtifactSource } from '../ports'
import { rebuildKnowledgeTiers } from './brief-tiers'
import type { BriefSource, TurnMatch } from './brief-tiers'

/**
 * A full-capture leg whose decision-screenshot blob is absent from the ArtifactSource.
 * Completeness normally refuses this upstream; this is the defense-in-depth path. Distinct
 * from brief reconstruction refusals so the engine maps it to 'missing-blob'.
 */
export class MissingDecisionBlobError extends Error {
  readonly sha: string | undefined
  constructor(sha: string | undefined) {
    super(`full-capture decision blob is unavailable${sha !== undefined ? ` for ${sha}` : ''}`)
    this.name = 'MissingDecisionBlobError'
    this.sha = sha
  }
}

/**
 * Historical error retained for callers reading pre-rendering replay evidence. New replays
 * rebuild populated briefs or produce UnrenderableBriefError; nothing constructs this class.
 */
export class UnsupportedBriefError extends Error {
  readonly channel: string
  constructor(channel: string) {
    super(`served brief carries content on ${channel}; replay brief rendering is undecided (M2)`)
    this.name = 'UnsupportedBriefError'
    this.channel = channel
  }
}

export interface ReconstructDecisionContextInput {
  leg: CassetteInputLeg
  captureMode: 'full' | 'textOnly'
  screenshotRef?: ArtifactRef
  artifacts: ArtifactSource
  model: StepContext['plannerModel']
}

export interface ReconstructedDecisionContext {
  screenState: ScreenState
  stepContext: StepContext
  briefSource: BriefSource
  turnMatch?: TurnMatch
}

export function reconstructDecisionContext(
  input: ReconstructDecisionContextInput,
): ReconstructedDecisionContext {
  const { leg, captureMode, screenshotRef, artifacts, model } = input

  const tiers = rebuildKnowledgeTiers(leg.servedBrief, leg.decisionOrdinal)

  const workingMemory =
    leg.workingMemory !== undefined && leg.workingMemory.length > 0
      ? leg.workingMemory
      : undefined

  let screenshot: NonNullable<StepContext['screenshot']> | undefined
  if (captureMode === 'full') {
    const sha = screenshotRef?.sha
    const bytes = sha !== undefined ? artifacts.getBlob(sha) : undefined
    if (bytes === undefined) {
      throw new MissingDecisionBlobError(sha)
    }
    // StepContext.screenshot is a Buffer field on the runner type; a Uint8Array is
    // structurally acceptable and eval core carries bytes as Uint8Array. Cast at the
    // boundary rather than importing any host module.
    screenshot = bytes as unknown as NonNullable<StepContext['screenshot']>
  }

  const stepContext: StepContext = {
    stepInstruction: leg.stepText,
    testName: leg.testId,
    previousSteps: [],
    plannerModel: model,
    // Required by the type; never consulted on the plan() path in replay.
    verifierModel: model,
    ...(workingMemory !== undefined ? { workingMemory } : {}),
    ...(screenshot !== undefined ? { screenshot } : {}),
    ...(tiers.knowledgePolicyL0 !== undefined ? { knowledgePolicyL0: tiers.knowledgePolicyL0 } : {}),
    ...(tiers.knowledgeBriefL1 !== undefined ? { knowledgeBriefL1: tiers.knowledgeBriefL1 } : {}),
    ...(tiers.knowledgeBriefL2 !== undefined ? { knowledgeBriefL2: tiers.knowledgeBriefL2 } : {}),
    ...(leg.servedBrief.truncation.length > 0
      ? { knowledgeBriefTruncation: leg.servedBrief.truncation }
      : {}),
  }

  return {
    screenState: leg.stateBefore,
    stepContext,
    briefSource: tiers.briefSource,
    ...(tiers.turnMatch !== undefined ? { turnMatch: tiers.turnMatch } : {}),
  }
}
