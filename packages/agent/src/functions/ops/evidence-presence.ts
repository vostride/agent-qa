// Unknown presence leaves the key absent, and a rejected stat is never a failed read.

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
