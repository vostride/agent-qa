// The clustered presentation of a run's analysis — ONE layout, one package.
//
// RELOCATED from `cli/src/curation/post-run-tail.ts` by 391-06, unchanged byte-for-byte in what
// it produces. It moved because it acquired a second caller: the per-run digest (`runs.digest`)
// carries the clustered verdict sentences as its first section, and the CLI tail
// prints the digest's rendered lines. Had the layout stayed in the CLI, the digest would have
// needed its own — and two spellings of one block is how the terminal and the dashboard end up
// showing the same run's problems in two different shapes with nothing wrong in either. The CLI
// re-exports this symbol from where it used to live, so the surface that had it still names it.
//
// A PURE STRING FOLD over `analysis.get`'s output and nothing else. The sentence bytes are
// `representative.sentence` VERBATIM — already composed by the one barrel renderer inside the
// op — so every surface is byte-identical by construction (389 SC3). This function composes no
// sentence; it decides only what a LIST of them looks like.

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
