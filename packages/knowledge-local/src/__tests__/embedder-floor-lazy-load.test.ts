// FLOOR-LAZY-IMPORT (431-06 task 1 · D-09 · T-431-13): the floor tokenizer runtime loads when an
// embedding is acquired, never when the wrapper is imported.
//
// THE OBSERVATION IS A LOAD, NOT A CALL. The mock factory below runs exactly when some module
// resolves `@huggingface/tokenizers`, and it hands back the real package, so every vector here is
// a real floor vector. Each cell re-registers the factory over a reset module graph, because a
// mocked module instance otherwise survives `vi.resetModules()`; the counter is what that cold
// graph loaded. A failing factory re-registers itself, so a retry is a genuine second load.
//
// The cross-process proof (a real MCP host under a pre-import loader trap) is
// packages/cli/src/__tests__/431-mcp-no-embedder.test.ts.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { STATIC_FLOOR_EMBEDDING_PROFILE } from '@vostride/agent-qa-schema'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const runtime = { loads: 0, failNext: false }

function observeTokenizerRuntime(): void {
  vi.doMock('@huggingface/tokenizers', async (importOriginal) => {
    runtime.loads += 1
    if (runtime.failNext) {
      runtime.failNext = false
      observeTokenizerRuntime()
      throw new Error('synthetic tokenizer runtime load failure')
    }
    return await importOriginal()
  })
}

interface GoldenVectors {
  cases: { text: string; vector: number[] }[]
}

const GOLDEN = JSON.parse(readFileSync(fileURLToPath(
  new URL('../../assets/potion-retrieval-32m/golden-vectors.json', import.meta.url),
), 'utf8')) as GoldenVectors

function cosine(left: ArrayLike<number>, right: ArrayLike<number>): number {
  let dot = 0
  let leftSquared = 0
  let rightSquared = 0
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index]! * right[index]!
    leftSquared += left[index]! * left[index]!
    rightSquared += right[index]! * right[index]!
  }
  return dot / Math.sqrt(leftSquared * rightSquared)
}

const noWorker = { discoverWorker: async () => ({ kind: 'no-worker' as const }) }

beforeEach(() => {
  vi.resetModules()
  runtime.loads = 0
  runtime.failNext = false
  observeTokenizerRuntime()
})

describe('FLOOR-LAZY-IMPORT', () => {
  it('importing the floor wrapper, the acquisition ladder and the package barrel loads no tokenizer runtime', async () => {
    const floor = await import('../embedder-floor.js')
    await import('../embedder-acquire.js')
    await import('../index.js')
    const embedder = floor.createFloorEmbedder()

    expect(typeof embedder.embedQuery).toBe('function')
    expect(runtime.loads).toBe(0)
  })

  it('the real acquisition ladder loads the runtime once and embeds the committed golden vectors', async () => {
    const { acquireEmbedder } = await import('../embedder-acquire.js')
    expect(runtime.loads).toBe(0)

    const outcome = await acquireEmbedder({
      preferredProfile: STATIC_FLOOR_EMBEDDING_PROFILE, allowDownload: false,
      agentQaRoot: '/nonexistent/431-06/.agent-qa', probes: noWorker,
    })
    if (outcome.kind !== 'ready') throw new Error(`expected a ready floor rung, received ${outcome.kind}`)
    expect(outcome.rung).toBe('floor')
    expect(runtime.loads).toBe(1)

    const golden = GOLDEN.cases[0]!
    const [document, query] = await Promise.all([
      outcome.embedder.embedDocument(golden.text), outcome.embedder.embedQuery(golden.text),
    ])
    expect(document).toHaveLength(512)
    expect(query).toEqual(document)
    expect(cosine(document, golden.vector)).toBeGreaterThanOrEqual(0.99)
    expect(runtime.loads).toBe(1)
  })

  it('concurrent first embeddings share one runtime load and one verified asset set', async () => {
    const { createFloorEmbedder, loadFloorAssets } = await import('../embedder-floor.js')
    const first = createFloorEmbedder()
    const second = createFloorEmbedder()

    const vectors = await Promise.all(GOLDEN.cases.slice(0, 4).flatMap(({ text }) => [
      first.embedDocument(text), second.embedQuery(text),
    ]))
    for (let index = 0; index < vectors.length; index += 2) {
      expect(vectors[index + 1]).toEqual(vectors[index])
    }
    expect(runtime.loads).toBe(1)
    const [left, right] = await Promise.all([loadFloorAssets(), loadFloorAssets()])
    expect(right).toBe(left)
    expect(runtime.loads).toBe(1)
  })

  it('a failed runtime load is a typed floor error, is not memoized, and the next acquisition retries', async () => {
    const { FloorAssetLoadError, createFloorEmbedder } = await import('../embedder-floor.js')
    runtime.failNext = true
    const embedder = createFloorEmbedder()

    const failure = await embedder.embedQuery('first attempt').catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(FloorAssetLoadError)
    expect(failure).toMatchObject({ code: 'tokenizer-runtime-unavailable' })

    const vector = await embedder.embedQuery(GOLDEN.cases[0]!.text)
    expect(cosine(vector, GOLDEN.cases[0]!.vector)).toBeGreaterThanOrEqual(0.99)
    expect(runtime.loads).toBe(2)
  })

  it('a failed runtime load drops the ladder to lexical-only rather than a half-built floor', async () => {
    const { acquireEmbedder } = await import('../embedder-acquire.js')
    runtime.failNext = true

    const outcome = await acquireEmbedder({
      preferredProfile: STATIC_FLOOR_EMBEDDING_PROFILE, allowDownload: false,
      agentQaRoot: '/nonexistent/431-06-failed/.agent-qa', probes: noWorker,
    })
    expect(outcome).toEqual({ kind: 'lexical-only' })
    expect(runtime.loads).toBe(1)
  })
})
