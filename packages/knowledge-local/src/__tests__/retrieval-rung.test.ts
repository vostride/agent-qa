// The ONE fold and the ONE resolver behind TRST-01 (407-03, D-13/D-15/D-17).
//
// The fold table is pinned HERE, before any of its three callers exists — the runner's evidence
// recorder (407-07), `doctor` (407-08) and, through the recorded evidence, the run header banner
// (407-10). Three callers folding the same two axes independently is exactly how a banner and a
// doctor row come to disagree about the same machine; a table asserted row by row is what stops it.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  DEFAULT_EMBEDDING_PROFILE,
  RETRIEVAL_RUNG_REASONS,
  RecordedRetrievalRungSchema,
  STATIC_FLOOR_EMBEDDING_PROFILE,
} from '@vostride/agent-qa-schema'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  resetEmbedderCapability,
  type EmbedderProbes,
} from '../embedder-acquire.js'
import { classifyIndexFace, openKnowledgeReader } from '../index-reader.js'
import type { IndexFace } from '../index-reader.js'
import { indexDbPath } from '../index-open.js'
import { rebuildIndex } from '../index-rebuild.js'
import { REBUILD_MARKER_FILE } from '../rebuild-marker.js'
import {
  foldRetrievalRung,
  resolveRetrievalRung,
  type EmbedderAxis,
} from '../retrieval-rung.js'
import { makeFakeEmbedder } from './fixtures/fake-embedder.js'
import { scaffoldKnowledgeRoot } from './fixtures/bundle-fixture.js'

const roots: string[] = []

afterEach(() => {
  resetEmbedderCapability()
  while (roots.length > 0) {
    const root = roots.pop()
    if (root !== undefined) rmSync(root, { recursive: true, force: true })
  }
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'retrieval-rung-'))
  roots.push(root)
  return root
}

function scaffoldedRoot(): string {
  const knowledgeRoot = join(tempRoot(), 'agent-qa-knowledge')
  scaffoldKnowledgeRoot(knowledgeRoot)
  return knowledgeRoot
}

async function healthyRoot(): Promise<string> {
  const knowledgeRoot = scaffoldedRoot()
  await rebuildIndex({ knowledgeRoot })
  return knowledgeRoot
}

function garbageRoot(): string {
  const knowledgeRoot = scaffoldedRoot()
  const dbPath = indexDbPath(knowledgeRoot)
  mkdirSync(dirname(dbPath), { recursive: true })
  writeFileSync(dbPath, 'not a sqlite database', 'utf8')
  return knowledgeRoot
}

function markerExists(knowledgeRoot: string): boolean {
  return existsSync(join(knowledgeRoot, 'memory', 'index', REBUILD_MARKER_FILE))
    || existsSync(join(knowledgeRoot, REBUILD_MARKER_FILE))
}

const INDEX_FACE: IndexFace = { source: 'index' }
const SCAN_FACE: IndexFace = {
  source: 'scan',
  reason: 'absent',
  detail: 'derived index file is absent',
  filePresent: false,
}

const READY_NATIVE: EmbedderAxis = {
  kind: 'ready',
  rung: 'native',
  profile: DEFAULT_EMBEDDING_PROFILE,
  embedder: makeFakeEmbedder(DEFAULT_EMBEDDING_PROFILE.dim),
}
const READY_FLOOR: EmbedderAxis = {
  kind: 'ready',
  rung: 'floor',
  profile: STATIC_FLOOR_EMBEDDING_PROFILE,
  embedder: makeFakeEmbedder(STATIC_FLOOR_EMBEDDING_PROFILE.dim),
}

function probes(overrides: Partial<EmbedderProbes> = {}): EmbedderProbes {
  return {
    discoverWorker: vi.fn().mockResolvedValue({ kind: 'no-worker' }),
    createNativeEmbedder: vi.fn().mockResolvedValue(makeFakeEmbedder()),
    createFloorEmbedder: vi.fn().mockReturnValue(makeFakeEmbedder(512)),
    ...overrides,
  }
}

function moduleUnavailableError(): Error {
  return Object.assign(new Error("Cannot find package '@huggingface/transformers'"), {
    code: 'ERR_MODULE_NOT_FOUND',
  })
}

describe('foldRetrievalRung — the index axis is folded FIRST', () => {
  it.each<[string, EmbedderAxis]>([
    ['a live native embedder', READY_NATIVE],
    ['the static floor', READY_FLOOR],
    ['a deferred embedder', { kind: 'deferred', reason: 'cold-artifact' }],
    ['no embedder at all', { kind: 'lexical-only' }],
  ])('folds an absent scan face to bundle-scan/index-not-built with %s', (_name, embedder) => {
    // No dense leg can run against an index that will not open, whatever the embedder did —
    // which is precisely why the index axis is consulted before the embedder axis.
    expect(foldRetrievalRung(SCAN_FACE, embedder)).toEqual({
      schemaVersion: 2,
      rung: 'bundle-scan',
      reason: 'index-not-built',
    })
  })

  it('folds index + native to memidex with NO reason key (the top rung names no cause)', () => {
    const recorded = foldRetrievalRung(INDEX_FACE, READY_NATIVE)
    expect(recorded).toEqual({ schemaVersion: 2, rung: 'memidex' })
    expect('reason' in recorded).toBe(false)
  })

  it('folds index + floor to static-floor/native-runtime-unavailable for a node profile', () => {
    expect(foldRetrievalRung(INDEX_FACE, READY_FLOOR, DEFAULT_EMBEDDING_PROFILE)).toEqual({
      schemaVersion: 2,
      rung: 'static-floor',
      reason: 'native-runtime-unavailable',
    })
  })

  it('folds index + floor to static-floor/profile-static-configured for a static profile', () => {
    // Same rung, different truth: the floor is serving because it was ASKED for, not because a
    // runtime broke. An operator reading `native-runtime-unavailable` here would go hunting for
    // a fault that does not exist.
    expect(foldRetrievalRung(INDEX_FACE, READY_FLOOR, STATIC_FLOOR_EMBEDDING_PROFILE)).toEqual({
      schemaVersion: 2,
      rung: 'static-floor',
      reason: 'profile-static-configured',
    })
  })

  it.each([
    ['cold-artifact', 'model-not-downloaded'],
    ['load-failure', 'embedder-load-failed'],
    ['worker-unavailable', 'profile-unresolved'],
  ] as const)('folds index + deferred/%s to lexical-only/%s', (deferReason, rungReason) => {
    expect(foldRetrievalRung(INDEX_FACE, { kind: 'deferred', reason: deferReason })).toEqual({
      schemaVersion: 2,
      rung: 'lexical-only',
      reason: rungReason,
    })
  })

  it('folds index + lexical-only to lexical-only/floor-disabled', () => {
    expect(foldRetrievalRung(INDEX_FACE, { kind: 'lexical-only' })).toEqual({
      schemaVersion: 2,
      rung: 'lexical-only',
      reason: 'floor-disabled',
    })
  })

  it('mints only values the schema admits, and only reason words in the closed enum', () => {
    const embedders: EmbedderAxis[] = [
      READY_NATIVE,
      READY_FLOOR,
      { kind: 'deferred', reason: 'cold-artifact' },
      { kind: 'deferred', reason: 'load-failure' },
      { kind: 'deferred', reason: 'worker-unavailable' },
      { kind: 'lexical-only' },
    ]
    const faces: IndexFace[] = [INDEX_FACE, SCAN_FACE]
    for (const face of faces) {
      for (const embedder of embedders) {
        for (const profile of [DEFAULT_EMBEDDING_PROFILE, STATIC_FLOOR_EMBEDDING_PROFILE]) {
          const recorded = foldRetrievalRung(face, embedder, profile)
          expect(RecordedRetrievalRungSchema.safeParse(recorded).success).toBe(true)
          if (recorded.rung === 'memidex') {
            expect(recorded.reason).toBeUndefined()
          } else {
            expect(RETRIEVAL_RUNG_REASONS).toContain(recorded.reason)
          }
        }
      }
    }
  })
})

describe('classifyIndexFace — the ladder as a PURE READ', () => {
  it('reports absent with filePresent false and writes NO rebuild marker', () => {
    const knowledgeRoot = scaffoldedRoot()

    const face = classifyIndexFace(knowledgeRoot)

    expect(face).toMatchObject({ source: 'scan', reason: 'absent', filePresent: false })
    expect(face.source === 'scan' && face.detail.length > 0).toBe(true)
    // A probe that requests a rebuild would turn `doctor` into a writer.
    expect(markerExists(knowledgeRoot)).toBe(false)

    // Control, so the assertion above cannot pass vacuously: the SERVING facade over the very
    // same root does write the marker. One ladder, two callers, one side effect.
    openKnowledgeReader(knowledgeRoot).close()
    expect(markerExists(knowledgeRoot)).toBe(true)
  })

  it('reports index for a healthy rebuilt root, holding no connection open', async () => {
    const knowledgeRoot = await healthyRoot()

    expect(classifyIndexFace(knowledgeRoot)).toEqual({ source: 'index' })
    expect(markerExists(knowledgeRoot)).toBe(false)
  })

  it('reports a corrupt-or-locked face with filePresent true for garbage bytes', () => {
    const knowledgeRoot = garbageRoot()

    const face = classifyIndexFace(knowledgeRoot)

    expect(face.source).toBe('scan')
    expect(face.source === 'scan' && face.filePresent).toBe(true)
    expect(['corrupt', 'locked']).toContain(face.source === 'scan' ? face.reason : undefined)
    expect(markerExists(knowledgeRoot)).toBe(false)
  })
})

describe('resolveRetrievalRung — never throws, never downloads, never writes', () => {
  it('folds a broken native runtime with a live floor to static-floor', async () => {
    const knowledgeRoot = await healthyRoot()

    const recorded = await resolveRetrievalRung({
      knowledgeRoot,
      agentQaRoot: knowledgeRoot,
      probes: probes({
        createNativeEmbedder: vi.fn().mockRejectedValue(moduleUnavailableError()),
      }),
    })

    expect(recorded).toEqual({
      schemaVersion: 2,
      rung: 'static-floor',
      reason: 'native-runtime-unavailable',
    })
  })

  it('folds a broken native runtime AND a refusing floor to lexical-only/floor-disabled', async () => {
    const knowledgeRoot = await healthyRoot()

    const recorded = await resolveRetrievalRung({
      knowledgeRoot,
      agentQaRoot: knowledgeRoot,
      probes: probes({
        createNativeEmbedder: vi.fn().mockRejectedValue(moduleUnavailableError()),
        createFloorEmbedder: vi.fn().mockImplementation(() => {
          throw new Error('floor assets are unavailable')
        }),
      }),
    })

    expect(recorded).toEqual({
      schemaVersion: 2,
      rung: 'lexical-only',
      reason: 'floor-disabled',
    })
  })

  it('folds a live native embedder over a healthy index to memidex', async () => {
    const knowledgeRoot = await healthyRoot()

    const recorded = await resolveRetrievalRung({
      knowledgeRoot,
      agentQaRoot: knowledgeRoot,
      probes: probes(),
    })

    expect(recorded).toEqual({ schemaVersion: 2, rung: 'memidex' })
  })

  it('short-circuits on a scan face without touching the embedder or writing a marker', async () => {
    const knowledgeRoot = scaffoldedRoot()
    const injected = probes()

    const recorded = await resolveRetrievalRung({
      knowledgeRoot,
      agentQaRoot: knowledgeRoot,
      probes: injected,
    })

    expect(recorded).toEqual({
      schemaVersion: 2,
      rung: 'bundle-scan',
      reason: 'index-not-built',
    })
    // The probe costs a model load; a face that already decides the fold must not pay it.
    expect(injected.discoverWorker).not.toHaveBeenCalled()
    expect(injected.createNativeEmbedder).not.toHaveBeenCalled()
    expect(markerExists(knowledgeRoot)).toBe(false)
  })

  it('folds a rejecting capability probe rather than throwing', async () => {
    const knowledgeRoot = await healthyRoot()

    const recorded = await resolveRetrievalRung({
      knowledgeRoot,
      agentQaRoot: knowledgeRoot,
      probes: probes({
        discoverWorker: vi.fn().mockImplementation(() => {
          throw new Error('worker discovery exploded')
        }),
        createNativeEmbedder: vi.fn().mockRejectedValue(new Error('nope')),
        createFloorEmbedder: vi.fn().mockImplementation(() => {
          throw new Error('nope either')
        }),
      }),
    })

    expect(RecordedRetrievalRungSchema.safeParse(recorded).success).toBe(true)
    expect(recorded.rung).toBe('lexical-only')
  })
})

describe('the main entry exports the rung seam', () => {
  it('exports the fold, the resolver and the index-face classifier', async () => {
    const entry = await import('../index.js')
    expect(typeof entry.foldRetrievalRung).toBe('function')
    expect(typeof entry.resolveRetrievalRung).toBe('function')
    expect(typeof entry.classifyIndexFace).toBe('function')
  })
})
