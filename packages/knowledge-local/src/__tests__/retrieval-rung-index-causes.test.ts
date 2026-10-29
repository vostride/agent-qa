// the fold records WHY the index face degraded instead of one historical word.
// Plan 423-23 owns the mutation script; RUNG-ABSENT/LOCKED/CORRUPT/SCHEMA and LEGACY-HISTORICAL
// are its required named RED cells.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import {
  DEFAULT_EMBEDDING_PROFILE,
  RecordedRetrievalRungSchema,
  STATIC_FLOOR_EMBEDDING_PROFILE,
} from '@vostride/agent-qa-schema'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { resetEmbedderCapability, type EmbedderProbes } from '../embedder-acquire.js'
import { classifyIndexFace, type IndexFace } from '../index-reader.js'
import { indexDbPath } from '../index-open.js'
import { rebuildIndex } from '../index-rebuild.js'
import type { RebuildReason } from '../rebuild-marker.js'
import { REBUILD_MARKER_FILE } from '../rebuild-marker.js'
import { foldRetrievalRung, resolveRetrievalRung, type EmbedderAxis } from '../retrieval-rung.js'
import { scaffoldKnowledgeRoot } from './fixtures/bundle-fixture.js'
import { makeFakeEmbedder } from './fixtures/fake-embedder.js'

const roots: string[] = []

afterEach(() => {
  resetEmbedderCapability()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function scaffoldedRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'retrieval-rung-423-'))
  roots.push(root)
  const knowledgeRoot = join(root, 'agent-qa-knowledge')
  scaffoldKnowledgeRoot(knowledgeRoot)
  return knowledgeRoot
}

function markerExists(knowledgeRoot: string): boolean {
  return existsSync(join(knowledgeRoot, 'memory', 'index', REBUILD_MARKER_FILE))
    || existsSync(join(knowledgeRoot, REBUILD_MARKER_FILE))
}

function neverProbed(): EmbedderProbes {
  return {
    discoverWorker: vi.fn().mockResolvedValue({ kind: 'no-worker' }),
    createNativeEmbedder: vi.fn().mockResolvedValue(makeFakeEmbedder()),
    createFloorEmbedder: vi.fn().mockReturnValue(makeFakeEmbedder(512)),
  }
}

function scanFace(reason: RebuildReason): IndexFace {
  return { source: 'scan', reason, detail: `synthetic ${reason}`, filePresent: reason !== 'absent' }
}

const EMBEDDERS: readonly EmbedderAxis[] = [
  {
    kind: 'ready',
    rung: 'native',
    profile: DEFAULT_EMBEDDING_PROFILE,
    embedder: makeFakeEmbedder(DEFAULT_EMBEDDING_PROFILE.dim),
  },
  {
    kind: 'ready',
    rung: 'floor',
    profile: STATIC_FLOOR_EMBEDDING_PROFILE,
    embedder: makeFakeEmbedder(STATIC_FLOOR_EMBEDDING_PROFILE.dim),
  },
  { kind: 'deferred', reason: 'cold-artifact' },
  { kind: 'lexical-only' },
]

/** Every embedder and both profiles fold one face to one recorded value. */
function foldsFor(reason: RebuildReason) {
  return EMBEDDERS.flatMap((embedder) => [DEFAULT_EMBEDDING_PROFILE, STATIC_FLOOR_EMBEDDING_PROFILE]
    .map((profile) => foldRetrievalRung(scanFace(reason), embedder, profile)))
}

async function resolvedOnDisk(knowledgeRoot: string) {
  const probes = neverProbed()
  const recorded = await resolveRetrievalRung({ knowledgeRoot, agentQaRoot: knowledgeRoot, probes })
  expect(probes.createNativeEmbedder).not.toHaveBeenCalled()
  expect(markerExists(knowledgeRoot)).toBe(false)
  return recorded
}

describe('RUNG-ABSENT', () => {
  it('folds an absent index to bundle-scan/index-not-built under every embedder', () => {
    for (const recorded of foldsFor('absent')) {
      expect(recorded).toEqual({ schemaVersion: 2, rung: 'bundle-scan', reason: 'index-not-built' })
    }
  })

  it('records index-not-built for a fresh store with no index file on disk', async () => {
    const knowledgeRoot = scaffoldedRoot()
    expect(classifyIndexFace(knowledgeRoot)).toMatchObject({ source: 'scan', reason: 'absent' })
    expect(await resolvedOnDisk(knowledgeRoot)).toEqual({
      schemaVersion: 2,
      rung: 'bundle-scan',
      reason: 'index-not-built',
    })
  })
})

describe('RUNG-LOCKED', () => {
  it('folds a locked index to bundle-scan/index-locked under every embedder', () => {
    for (const recorded of foldsFor('locked')) {
      expect(recorded).toEqual({ schemaVersion: 2, rung: 'bundle-scan', reason: 'index-locked' })
    }
  })

  it('records index-locked while another connection holds an exclusive lock', async () => {
    const knowledgeRoot = scaffoldedRoot()
    await rebuildIndex({ knowledgeRoot })
    const locker = new DatabaseSync(indexDbPath(knowledgeRoot), { timeout: 100 })
    locker.exec('PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE')
    try {
      expect(classifyIndexFace(knowledgeRoot)).toMatchObject({ source: 'scan', reason: 'locked' })
      expect(await resolvedOnDisk(knowledgeRoot)).toEqual({
        schemaVersion: 2,
        rung: 'bundle-scan',
        reason: 'index-locked',
      })
    } finally {
      locker.exec('ROLLBACK')
      locker.close()
    }
  })
})

describe('RUNG-CORRUPT', () => {
  it('folds a corrupt index to bundle-scan/index-corrupt under every embedder', () => {
    for (const recorded of foldsFor('corrupt')) {
      expect(recorded).toEqual({ schemaVersion: 2, rung: 'bundle-scan', reason: 'index-corrupt' })
    }
  })

  it('records index-corrupt for an index file holding garbage bytes', async () => {
    const knowledgeRoot = scaffoldedRoot()
    const dbPath = indexDbPath(knowledgeRoot)
    mkdirSync(dirname(dbPath), { recursive: true })
    writeFileSync(dbPath, 'not a sqlite database, synthetic corruption', 'utf8')
    expect(classifyIndexFace(knowledgeRoot)).toMatchObject({ source: 'scan', reason: 'corrupt' })
    expect(await resolvedOnDisk(knowledgeRoot)).toEqual({
      schemaVersion: 2,
      rung: 'bundle-scan',
      reason: 'index-corrupt',
    })
  })
})

describe('RUNG-SCHEMA', () => {
  it('folds a schema-version mismatch to the same index-corrupt cause', () => {
    for (const recorded of foldsFor('schema-version')) {
      expect(recorded).toEqual({ schemaVersion: 2, rung: 'bundle-scan', reason: 'index-corrupt' })
    }
  })

  it('records index-corrupt for a built index whose schema version is missing', async () => {
    const knowledgeRoot = scaffoldedRoot()
    await rebuildIndex({ knowledgeRoot })
    const db = new DatabaseSync(indexDbPath(knowledgeRoot))
    try {
      db.prepare("DELETE FROM meta WHERE k = 'index_schema_version'").run()
    } finally {
      db.close()
    }
    expect(classifyIndexFace(knowledgeRoot)).toMatchObject({
      source: 'scan',
      reason: 'schema-version',
    })
    expect(await resolvedOnDisk(knowledgeRoot)).toEqual({
      schemaVersion: 2,
      rung: 'bundle-scan',
      reason: 'index-corrupt',
    })
  })
})

describe('LEGACY-HISTORICAL', () => {
  it('records only schemaVersion 2 values whose index causes are the three distinct ones', () => {
    const embedders: EmbedderAxis[] = [
      ...EMBEDDERS,
      { kind: 'deferred', reason: 'cold-artifact' },
      { kind: 'deferred', reason: 'load-failure' },
      { kind: 'deferred', reason: 'worker-unavailable' },
    ]
    const faces: IndexFace[] = [
      { source: 'index' },
      scanFace('absent'),
      scanFace('locked'),
      scanFace('corrupt'),
      scanFace('schema-version'),
    ]
    const reasons = new Set<string>()
    for (const face of faces) {
      for (const embedder of embedders) {
        for (const profile of [DEFAULT_EMBEDDING_PROFILE, STATIC_FLOOR_EMBEDDING_PROFILE]) {
          const recorded = foldRetrievalRung(face, embedder, profile)
          expect(recorded.schemaVersion).toBe(2)
          expect(RecordedRetrievalRungSchema.safeParse(recorded).success).toBe(true)
          if (recorded.reason !== undefined) reasons.add(recorded.reason)
        }
      }
    }
    expect([...reasons].filter((reason) => reason.startsWith('index-')).sort()).toEqual([
      'index-corrupt',
      'index-locked',
      'index-not-built',
    ])
  })

  it('keeps the three causes distinct values rather than one collapsed word', () => {
    const causes = (['absent', 'locked', 'corrupt'] as const)
      .map((reason) => foldRetrievalRung(scanFace(reason), { kind: 'lexical-only' }).reason)
    expect(new Set(causes).size).toBe(3)
  })
})
