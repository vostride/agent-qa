// A pure fold over `analysis.get`'s output; the sentences are the op's, verbatim.

import type { AnalysisGetOutput } from '@vostride/agent-qa-schema'

/**
 * One representative sentence per cluster: a multi-member cluster is annotated with its
 * occurrence count and member refs (`×40: TST-101, TST-102, …`), a singleton reads as one bare
 * sentence.
 *
 * Member refs print the run's own `testId`s; a degenerate member with none falls back to
 * `#testIndex` rather than an empty ref. Empty clusters render the EMPTY STRING and no header:
 * a zero-failure run has no problems to enumerate and gets no line saying so.
 */
export function renderAnalysisClusterBlock(analysis: AnalysisGetOutput): string {
  if (analysis.clusters.length === 0) return ''
  const problems = analysis.clusters.length
  const entries = analysis.clusters.map((cluster) => {
    if (cluster.count === 1) return cluster.representative.sentence
    const refs = cluster.members
      .map((member) => (member.testId === '' ? `#${member.testIndex}` : member.testId))
      .join(', ')
    return `×${cluster.count}: ${refs}\n${cluster.representative.sentence}`
  })
  return `analysis — ${problems} distinct problem${problems === 1 ? '' : 's'}:\n${
    entries.join('\n')}`
}
