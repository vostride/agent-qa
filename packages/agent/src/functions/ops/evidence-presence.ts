// Read-time presence for artifact refs — the ONE rule both durable reads call.
//
// `runs.detail` and `analysis.get` each hand a page a list of artifact refs, and neither could say
// whether the bytes behind them still exist. A ref recorded at write time survives a GC, a pruned
// run directory and a hand-deleted blob; a link drawn from it 404s on click, which reads to an
// operator as a broken product rather than as collected evidence. So presence is asked at READ
// time, in one place, and both ops annotate through this function.
//
// BOTH ABSENCES ARE `false`, AND THAT IS NOT A COLLAPSE OF THE D-15 SPLIT. `blob_absent` and
// `unknown_run` stay two words at the port, because `runs.artifact` refuses differently for each.
// Here the question is narrower — are the bytes there — and the answer is no either way. A page
// rendering "evidence incomplete" has the same thing to say about a pruned run and a pruned blob.
//
// UNKNOWN LEAVES THE KEY ABSENT, WHICH IS THE WHOLE POINT. Presence unknown is not an
// absence, and reporting `present: false` for refs this host never looked at would render honest,
// intact evidence as incomplete. The refs come back untouched — copies, so a caller cannot mutate
// the port's rows — and the page's `present === false` predicate stays false.
//
// THERE ARE TWO WAYS TO NOT KNOW, AND BOTH TAKE THE SAME EXIT. A port with no `has` never looked;
// a `has` that REJECTED looked and did not come back. `present` is derived from an answer that is
// in hand, never from a lookup miss — `answers.get(sha) === 'found'` would read the second case as
// a claimed absence, which is the one answer this field must never give by accident.
//
// AND A REJECTED STAT IS NEVER A FAILED READ. Every surface reading this calls it opportunistic:
// "a host with no runtime root still serves a complete analysis" (`analysis-get.ts`), "this is not
// a binding condition" (`runs-detail.ts`), "a host that cannot cheaply stat its blobs is not lying
// about anything" (`spec.ts`). A rejection escaping here throws out of `invoke` and the routes map
// it to `read_failed` — an optional annotation taking down the whole run-detail page and the whole
// failure view. The bundled local `existsSync` cannot throw, but the port is shaped for hosts that
// do not hold blobs locally, i.e. hosts whose `has` is a network call.
//
// STATS ARE DEDUPED BY SHA WITHIN ONE CALL, AND ONE CALL IS ONE REF LIST — NOT ONE RUN.
// `new Set(refs.map(...))` collapses the duplicates in the list it was handed, which is the refs
// ONE verdict cites or the refs ONE sub-action produced. Both callers invoke this inside a
// `Promise.all` — `analysis-get` per verdict, `runs-detail` per sub-action — so a 40-failure run
// citing the same decision screenshot from every member still takes 40 stats, and a ref repeated
// across a page's steps is stat'd once per step.
//
// THAT RESIDUAL IS RECORDED, NOT MITIGATED, and an earlier spelling of this note claimed the
// opposite by citing exactly those two cross-call examples as things it collapsed. The fix, if it
// ever needs one, is to hoist to one probe per read and join back by sha. It is not taken here:
// v1 excludes performance work, the bundled `has` is a single `existsSync`, and the bound is
// refs-per-member rather than refs-per-run. A note describing a mitigation the code does not
// implement is worse than the syscalls, because the next reader budgets against it.

import type { EvidenceBlobPresence, RunId } from '@vostride/agent-qa-schema'

import type { EvidenceBlobReaderPort } from '../spec.js'

export async function annotatePresence<T extends { sha: string }>(
  port: EvidenceBlobReaderPort | undefined,
  runId: RunId,
  refs: readonly T[],
): Promise<(T & { present?: boolean })[]> {
  const has = port?.has
  if (has === undefined) return refs.map((ref) => ({ ...ref }))

  const distinct = [...new Set(refs.map((ref) => ref.sha))]
  const answers = new Map<string, EvidenceBlobPresence | undefined>(
    await Promise.all(distinct.map(async (sha): Promise<[string, EvidenceBlobPresence | undefined]> => {
      // PER SHA, so one host that cannot answer about one blob costs presence on that blob only.
      // Absorbing at the `Promise.all` instead would lose every sibling answer already in hand.
      try {
        return [sha, await has.call(port, runId, sha)]
      } catch {
        return [sha, undefined]
      }
    })),
  )

  return refs.map((ref) => {
    const answer = answers.get(ref.sha)
    return answer === undefined ? { ...ref } : { ...ref, present: answer === 'found' }
  })
}
