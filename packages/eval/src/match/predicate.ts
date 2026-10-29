import type { ReplayEscalationPredicate } from '../replay/ports'
import { scoreReplaySample } from './score'

// Only an unresolved tie after the first sample spends the remaining sample budget.
export const tiersSettlePredicate: ReplayEscalationPredicate = (firstSample, context) =>
  scoreReplaySample(context.sidecar, firstSample).kind === 'unresolved-tie'
