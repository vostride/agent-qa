// Asking about a checkpointed index must not create `-wal` or `-shm` files in the knowledge root.
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { afterEach, describe, expect, it } from 'vitest'

import { classifyIndexFace, openKnowledgeReader } from '../index-reader.js'
import { indexDbPath } from '../index-open.js'
import { rebuildIndex } from '../index-rebuild.js'
import { scaffoldKnowledgeRoot } from './fixtures/bundle-fixture.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function scaffoldedRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'index-probe-sidecars-'))
  roots.push(root)
  const knowledgeRoot = join(root, 'agent-qa-knowledge')
  scaffoldKnowledgeRoot(knowledgeRoot)
  return knowledgeRoot
}

async function healthyRoot(): Promise<string> {
  const knowledgeRoot = scaffoldedRoot()
  await rebuildIndex({ knowledgeRoot })
  return knowledgeRoot
}

function indexDir(knowledgeRoot: string): string[] {
  return readdirSync(dirname(indexDbPath(knowledgeRoot))).sort()
}

const INSPECT = { inspectCheckpointedImmutably: true } as const

describe('the inspecting probe leaves a checkpointed index alone', () => {
  it('answers `index`, creates no -wal/-shm; the ordinary probe does', async () => {
    const knowledgeRoot = await healthyRoot()
    const path = indexDbPath(knowledgeRoot)
    const before = indexDir(knowledgeRoot)
    const bytes = readFileSync(path)
    expect(before).not.toContain('knowledge.db-wal')
    expect(before).not.toContain('knowledge.db-shm')

    expect(classifyIndexFace(knowledgeRoot, INSPECT)).toEqual({ source: 'index' })
    expect(indexDir(knowledgeRoot)).toEqual(before)
    expect(readFileSync(path).equals(bytes)).toBe(true)

    // The control: the same question through the ordinary read-only open leaves both sidecars.
    expect(classifyIndexFace(knowledgeRoot)).toEqual({ source: 'index' })
    expect(indexDir(knowledgeRoot)).toEqual(
      [...before, 'knowledge.db-shm', 'knowledge.db-wal'].sort(),
    )
  })

  it('under a live connection (a -wal) it opens as before', async () => {
    const knowledgeRoot = await healthyRoot()
    const live = new DatabaseSync(indexDbPath(knowledgeRoot))
    try {
      live.exec('BEGIN IMMEDIATE')
      live.exec("INSERT INTO meta(k, v) VALUES ('hyg-probe', 'uncheckpointed')")
      live.exec('COMMIT')
      expect(existsSync(`${indexDbPath(knowledgeRoot)}-wal`)).toBe(true)

      expect(classifyIndexFace(knowledgeRoot, INSPECT)).toEqual(classifyIndexFace(knowledgeRoot))
      expect(classifyIndexFace(knowledgeRoot, INSPECT)).toEqual({ source: 'index' })
    } finally {
      live.close()
    }
  })

  it('absent and corrupt indexes get the ordinary answers', () => {
    const absent = scaffoldedRoot()
    expect(classifyIndexFace(absent, INSPECT)).toEqual(classifyIndexFace(absent))

    const corrupt = scaffoldedRoot()
    const path = indexDbPath(corrupt)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, 'not a sqlite database', 'utf8')
    const inspected = classifyIndexFace(corrupt, INSPECT)
    expect(inspected).toMatchObject({ source: 'scan', reason: 'corrupt', filePresent: true })
    expect(inspected).toEqual(classifyIndexFace(corrupt))
  })

  it('the serving facade never opens immutably, whatever it is handed', async () => {
    const knowledgeRoot = await healthyRoot()
    const handed = INSPECT as Parameters<typeof openKnowledgeReader>[1]
    const reader = openKnowledgeReader(knowledgeRoot, handed)
    try {
      expect(indexDir(knowledgeRoot)).toContain('knowledge.db-shm')
    } finally {
      reader.close()
    }
  })
})
