import { join } from 'node:path'

import type {
  ModelProfile,
  ModelProviderOverrides,
  ResolvedModelAuth,
} from '@vostride/agent-qa-model'
import { slugBranch } from '@vostride/agent-qa-schema'

import { loadCassetteBundle, type CassetteBundleLoad } from './cassette-loader.js'
import { runCassetteReplay, type RunCassetteReplayInput } from './replay-composition.js'
import { listCassetteBundleDirs } from './replay-read.js'
import type { FsReplayRecordStore } from './replay-record-store.js'
import type { FsScoreStore } from './score-store.js'

export type LoadedCassetteBundle = Extract<CassetteBundleLoad, { kind: 'loaded' }>

/** Enumerate every bundle once, retaining load refusals as batch counters. */
export function loadCassetteBundles(cassettesRoot: string): {
  swept: number
  loaded: LoadedCassetteBundle[]
  loadRefusals: Record<string, number>
} {
  const bundleDirs = listCassetteBundleDirs(cassettesRoot)
  const loadRefusals: Record<string, number> = {}
  const loaded: LoadedCassetteBundle[] = []
  for (const bundleDir of bundleDirs) {
    const load = loadCassetteBundle(bundleDir)
    if (load.kind === 'refused') {
      bumpCounter(loadRefusals, load.refusal.reason)
      continue
    }
    loaded.push(load)
  }
  return { swept: bundleDirs.length, loaded, loadRefusals }
}

export interface SweepCassetteReplaysInput {
  /** Caller-selected order; whole-corpus callers sort by cassette id before sweeping. */
  selected: readonly LoadedCassetteBundle[]
  profile: ModelProfile
  auth: ResolvedModelAuth
  modelOverrides?: ModelProviderOverrides
  modelCallObservation?: RunCassetteReplayInput['modelCallObservation']
  clock?: RunCassetteReplayInput['clock']
  k?: number
  seed?: number
  judge?: RunCassetteReplayInput['judge']
  mask: RunCassetteReplayInput['mask']
  recordStore: FsReplayRecordStore
  scoreStore: FsScoreStore
  /** The explicit output root shared by the caller's record and score stores. */
  replaysRoot: string
  onProgress?: (cassetteId: string) => void
}

export interface SweepCassetteReplaysResult {
  replayed: number
  replayRefusals: Record<string, number>
  replayedDirs: string[]
  /** Only invocations that returned and persisted this time, including typed refusals. */
  recordedDirs: string[]
  notices: string[]
}

/**
 * Run the selected batch through the one sanctioned replay composition. Persistence roots
 * come from the caller so repeat runs can retain independent records. Refusals and thrown
 * harness errors remain data; one broken cassette never aborts the rest of the batch.
 */
export async function sweepCassetteReplays(
  input: SweepCassetteReplaysInput,
): Promise<SweepCassetteReplaysResult> {
  const replayRefusals: Record<string, number> = {}
  const replayedDirs: string[] = []
  const recordedDirs: string[] = []
  const notices: string[] = []
  let replayed = 0

  for (const entry of input.selected) {
    input.onProgress?.(entry.cassette.id)
    let outcome: Awaited<ReturnType<typeof runCassetteReplay>>
    try {
      outcome = await runCassetteReplay({
        cassette: entry.cassette,
        artifacts: entry.artifacts,
        profile: input.profile,
        auth: input.auth,
        ...(input.modelOverrides !== undefined ? { modelOverrides: input.modelOverrides } : {}),
        ...(input.modelCallObservation !== undefined ? { modelCallObservation: input.modelCallObservation } : {}),
        ...(input.clock !== undefined ? { clock: input.clock } : {}),
        ...(input.k !== undefined ? { k: input.k } : {}),
        ...(input.seed !== undefined ? { seed: input.seed } : {}),
        ...(input.judge !== undefined ? { judge: input.judge } : {}),
        mask: input.mask,
        recordStore: input.recordStore,
        scoreStore: input.scoreStore,
      })
    } catch (err) {
      bumpCounter(replayRefusals, 'harness-error')
      notices.push(
        `harness error replaying ${entry.cassette.id}: ${err instanceof Error ? err.message : String(err)}`,
      )
      continue
    }
    const recordDir = join(input.replaysRoot, ...entry.cassette.id.split('/').map(segment => slugBranch(segment)))
    recordedDirs.push(recordDir)
    if (!('granularity' in outcome)) {
      bumpCounter(replayRefusals, outcome.reason)
      continue
    }
    replayed++
    replayedDirs.push(recordDir)
  }

  return { replayed, replayRefusals, replayedDirs, recordedDirs, notices }
}

function bumpCounter(counters: Record<string, number>, reason: string): void {
  counters[reason] = (counters[reason] ?? 0) + 1
}
