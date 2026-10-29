import { describe, expect, it } from 'vitest'

import { DEFAULT_EMBEDDING_PROFILE } from '@vostride/agent-qa-schema'

import { createNativeEmbedder } from '../embedder-native.js'

function cosine(left: Float32Array, right: Float32Array): number {
  let dot = 0
  let leftSquared = 0
  let rightSquared = 0

  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0
    const rightValue = right[index] ?? 0
    dot += leftValue * rightValue
    leftSquared += leftValue * leftValue
    rightSquared += rightValue * rightValue
  }

  return dot / Math.sqrt(leftSquared * rightSquared)
}

function magnitude(vector: Float32Array): number {
  let squared = 0
  for (const value of vector) squared += value * value
  return Math.sqrt(squared)
}

describe.skipIf(process.env.AGENT_QA_NATIVE_IT !== '1')('native embedder integration', () => {
  it(
    'embeds normalized bge-small vectors and reuses its warm pipeline',
    async () => {
      const embedder = await createNativeEmbedder({
        profile: DEFAULT_EMBEDDING_PROFILE,
        allowDownload: true,
      })
      const document = await embedder.embedDocument(
        'The checkout button submits the shopping cart and opens the payment form.',
      )
      const related = await embedder.embedQuery(
        'How do I proceed from my cart to the payment form?',
      )
      const unrelated = await embedder.embedQuery(
        'What is the weather forecast for Antarctica tomorrow?',
      )

      expect(document).toHaveLength(384)
      expect(Math.abs(magnitude(document) - 1)).toBeLessThan(1e-3)
      expect(cosine(document, related)).toBeGreaterThan(cosine(document, unrelated))

      const warmEmbedder = await createNativeEmbedder({
        profile: DEFAULT_EMBEDDING_PROFILE,
        allowDownload: true,
      })

      await expect(warmEmbedder.embedDocument('Warm pipeline check.')).resolves.toHaveLength(384)
    },
    300_000,
  )
})
