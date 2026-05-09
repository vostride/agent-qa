function tokenize(text: string): Set<string> {
  const cleaned = text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ')
  const words = cleaned.split(/\s+/).filter(Boolean)
  return new Set(words)
}

export function jaccardSimilarity(a: string, b: string): number {
  const setA = tokenize(a)
  const setB = tokenize(b)

  if (setA.size === 0 || setB.size === 0) return 0.0

  let intersection = 0
  for (const word of setA) {
    if (setB.has(word)) intersection++
  }

  const union = setA.size + setB.size - intersection
  if (union === 0) return 0.0

  return intersection / union
}

export function findSimilarObservations(
  query: string,
  observations: Array<{ id: string; title: string; content: string; trust: number }>,
  threshold = 0.85
): Array<{ id: string; title: string; content: string; trust: number; similarity: number }> {
  if (observations.length === 0) return []

  const results: Array<{ id: string; title: string; content: string; trust: number; similarity: number }> = []

  for (const obs of observations) {
    // Title-aware recall should widen matches without penalizing legacy body-only similarity.
    const similarity = Math.max(
      jaccardSimilarity(query, obs.title),
      jaccardSimilarity(query, obs.content),
      jaccardSimilarity(query, `${obs.title} ${obs.content}`),
    )
    if (similarity >= threshold) {
      results.push({ id: obs.id, title: obs.title, content: obs.content, trust: obs.trust, similarity })
    }
  }

  results.sort((a, b) => b.similarity - a.similarity)
  return results
}
