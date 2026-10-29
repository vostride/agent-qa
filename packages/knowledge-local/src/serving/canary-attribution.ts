// Reads only; an unloadable bundle is skipped and counted in `skippedBundles`, never absorbed.

import { asRecordId, survivingOutcomeEvents } from '@vostride/agent-qa-schema'

import {
  KnowledgeMaintenanceScanError,
  enumerateMaintenanceBundleDirs,
  loadMaintenanceBundle,
} from '../maintenance-scan.js'
import { canaryOutcomeObservationId } from './canary-observation-id.js'

/** The four observation words. A lifecycle event carrying the same id attributes nothing. */
const ATTRIBUTING_EVENT_TYPES = [
  'confirmed',
  'contradicted',
  'helpful',
  'harmful',
] as const

export type CanaryAttributionOutcome = (typeof ATTRIBUTING_EVENT_TYPES)[number]

/** One served canary line, addressed the way the run recorded it. */
export interface CanaryAttributionTuple {
  candidateId: string
  testId: string
  testIndex: number
  stepIndex: number
}

export interface CanaryAttributionRow {
  candidateId: string
  testIndex: number
  stepIndex: number
  observationId: string
  outcome?: CanaryAttributionOutcome
}

// `skippedBundles > 0` makes the answer partial: an absent `outcome` is then not found where read.
export interface CanaryAttributionsResult {
  rows: CanaryAttributionRow[]
  skippedBundles: number
}

export interface CanaryAttributionsForOptions {
  knowledgeRoot: string
  runId: string
  tuples: readonly CanaryAttributionTuple[]
}

function isAttributingType(type: string): type is CanaryAttributionOutcome {
  return (ATTRIBUTING_EVENT_TYPES as readonly string[]).includes(type)
}

// Unloadable bundles are skipped and counted; a store that cannot be listed still throws.
function attributingOutcomesByObservationId(
  knowledgeRoot: string,
  candidateIds: ReadonlySet<string>,
): { outcomes: Map<string, CanaryAttributionOutcome>; skippedBundles: number } {
  const outcomes = new Map<string, CanaryAttributionOutcome>()
  let skippedBundles = 0
  for (const entry of enumerateMaintenanceBundleDirs(knowledgeRoot)) {
    let bundle
    try {
      bundle = loadMaintenanceBundle(entry)
    } catch (error) {
      if (error instanceof KnowledgeMaintenanceScanError) {
        skippedBundles += 1
        continue
      }
      throw error
    }
    if (!candidateIds.has(bundle.manifest.id)) continue
    for (const event of survivingOutcomeEvents(bundle.events)) {
      if (event.observationId === undefined) continue
      if (!isAttributingType(event.type)) continue
      // First-wins, matching the dedupe law the surviving-events fold already applies: one
      // observation identity has one outcome, and a replayed line does not get a second vote.
      if (outcomes.has(event.observationId)) continue
      outcomes.set(event.observationId, event.type)
    }
  }
  return { outcomes, skippedBundles }
}

// An empty tuple list answers without touching the store, so a bad bundle cannot fail it.
export function canaryAttributionsFor(
  options: CanaryAttributionsForOptions,
): CanaryAttributionsResult {
  if (options.tuples.length === 0) return { rows: [], skippedBundles: 0 }

  const { outcomes, skippedBundles } = attributingOutcomesByObservationId(
    options.knowledgeRoot,
    new Set(options.tuples.map((tuple) => tuple.candidateId)),
  )

  const rows = options.tuples.map((tuple) => {
    const observationId = canaryOutcomeObservationId({
      candidateId: asRecordId(tuple.candidateId),
      runId: options.runId,
      testId: tuple.testId,
      testIndex: tuple.testIndex,
      stepIndex: tuple.stepIndex,
    })
    const outcome = outcomes.get(observationId)
    return {
      candidateId: tuple.candidateId,
      testIndex: tuple.testIndex,
      stepIndex: tuple.stepIndex,
      observationId,
      ...(outcome === undefined ? {} : { outcome }),
    }
  })

  return { rows, skippedBundles }
}
