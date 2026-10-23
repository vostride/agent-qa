import { dirname, resolve } from 'node:path'
import { readLabelCalibration, readCalibrationGoldIdentity } from '../eval-session-composition.js'
import type { TrustPriorTable } from '@vostride/agent-qa-schema'

export type ResolveTrustPriors = () => TrustPriorTable | undefined
export interface TrustPriorDisclosure {
  readonly status: 'provisional' | 'calibrated'
  readonly digest?: string
  readonly nByOrigin: Readonly<Record<'agent-verified' | 'agent-observed', number>>
}
const REFUSAL = 'Trust prior calibration is invalid or unavailable; inspect the selected config\'s committed calibration marker and referenced revisions, following https://vostride.com/docs/agent-qa/self-improvement/evals#if-calibration-is-refused before composing this host.'
export type TrustPriorsResolution =
  | { readonly kind: 'ready'; readonly resolve: ResolveTrustPriors; readonly disclosure: TrustPriorDisclosure; readonly calibration?: string }
  | { readonly kind: 'refused'; readonly reason: typeof REFUSAL }

/** Read and validate once. No producer, revision or correction data leaves this boundary. */
export function buildTrustPriorsResolver(input: { configPath: string; inspectCalibration?: boolean }): TrustPriorsResolution {
  const configDir = dirname(resolve(input.configPath))
  const committedRoot = resolve(configDir, 'agent-qa-eval')
  const read = readLabelCalibration(committedRoot)
  if (read.kind === 'refused') return Object.freeze({ kind: 'refused', reason: REFUSAL })
  const table: Partial<Record<'agent-verified' | 'agent-observed', { alpha: number; beta: number }>> = {}
  const nByOrigin = { 'agent-verified': 0, 'agent-observed': 0 }
  if (read.kind === 'loaded') {
    for (const [origin, channel] of [['agent-verified', 'recorded-verdict'], ['agent-observed', 'self-heal-pair']] as const) {
      nByOrigin[origin] = read.artifact.channels[channel].n
      const prior = read.artifact.priors[origin]
      if (prior !== undefined) table[origin] = Object.freeze({ alpha: prior.alpha, beta: prior.beta })
    }
  }
  const priors = Object.keys(table).length === 0 ? undefined : Object.freeze(table)
  const disclosure: TrustPriorDisclosure = Object.freeze({
    status: priors === undefined ? 'provisional' : 'calibrated',
    ...(read.kind === 'loaded' ? { digest: read.artifact.generationId } : {}),
    nByOrigin: Object.freeze(nByOrigin),
  })
  let calibration: string | undefined
  if (input.inspectCalibration) {
    if (read.kind === 'absent') calibration = 'label calibration: absent'
    else {
      const identity = readCalibrationGoldIdentity({ committedRoot, agentQaRoot: resolve(configDir, '.agent-qa'), calibrationRead: read })
      const freshness = identity.kind === 'unavailable' ? 'unavailable'
        : identity.goldSetDigest === read.artifact.goldSetDigest ? 'current' : 'stale'
      const channels = (['recorded-verdict', 'self-heal-pair'] as const).map(channel => {
        const row = read.artifact.channels[channel]
        return `${channel} ${row.status} n=${row.n}`
      }).join(', ')
      calibration = `label calibration: ${channels}; goldDigest ${freshness}`
    }
  }
  return Object.freeze({ kind: 'ready', resolve: () => priors, disclosure,
    ...(calibration === undefined ? {} : { calibration }) })
}

/** Render only the captured neutral snapshot; historical callers explicitly use the default. */
export function formatTrustPriorDisclosure(disclosure?: TrustPriorDisclosure): string {
  if (disclosure?.status !== 'calibrated') return 'trust priors: provisional'
  return `trust priors: calibrated@${disclosure.digest} (agent-verified n=${disclosure.nByOrigin['agent-verified']}, agent-observed n=${disclosure.nByOrigin['agent-observed']})`
}

export class TrustPriorsRefusedError extends Error {
  readonly kind = 'trust-priors-refused'
  constructor() { super(REFUSAL); this.name = 'TrustPriorsRefusedError' }
}

/** Composing hosts fail explicitly; malformed persisted data never becomes provisional. */
export function trustPriorsForHost(input: { configPath: string }): Extract<TrustPriorsResolution, { kind: 'ready' }> {
  const result = buildTrustPriorsResolver(input)
  if (result.kind === 'refused') throw new TrustPriorsRefusedError()
  return result
}

/** Bind the host cache to its selected eval root; another project gets a run-local snapshot. */
export function bindTrustPriorsToConfig(input: {
  configPath: string
  trustPriors: ReturnType<typeof trustPriorsForHost>
}): (configPath: string) => ReturnType<typeof trustPriorsForHost> {
  const hostRoot = resolve(dirname(resolve(input.configPath)), 'agent-qa-eval')
  return configPath => resolve(dirname(resolve(configPath)), 'agent-qa-eval') === hostRoot
    ? input.trustPriors
    : trustPriorsForHost({ configPath })
}
