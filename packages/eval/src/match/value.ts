import { normalizeValueText } from '../replay/identity'

// Recorded values are opaque data and never shape a pattern.
export function tokenizeValue(value: string): string[] {
  return normalizeValueText(value).split(/[^a-z0-9]+/).filter(Boolean)
}

function tokenCounts(tokens: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1)
  return counts
}

// Applied only when the sidecar carries `goldValue`; semantic equivalence is the judge's.
export function tokenSetF1(gold: string, candidate: string): number {
  const goldTokens = tokenizeValue(gold)
  const candidateTokens = tokenizeValue(candidate)
  const goldTotal = goldTokens.length
  const candidateTotal = candidateTokens.length

  if (goldTotal === 0 || candidateTotal === 0) {
    return goldTotal === candidateTotal ? 1 : 0
  }

  const goldCounts = tokenCounts(goldTokens)
  const candidateCounts = tokenCounts(candidateTokens)
  let overlap = 0

  for (const [token, goldCount] of goldCounts) {
    overlap += Math.min(goldCount, candidateCounts.get(token) ?? 0)
  }

  if (overlap === 0) return 0
  const precision = overlap / candidateTotal
  const recall = overlap / goldTotal
  return (2 * precision * recall) / (precision + recall)
}
