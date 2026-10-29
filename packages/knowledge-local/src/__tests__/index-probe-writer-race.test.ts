// 2026-10-03 (quick 261003-lgd, Phase 432 review IN-26): the immutable doctor probe checks for a
// `-wal` and then opens the index `immutable=1`. A writer that opens the index in between, or
// checkpoints while the probe reads, changes the main file under a connection SQLite was told
// cannot change, and the probe could then read a torn page and report the index `corrupt`.
//
// The race is driven at the module boundary: right after the probe's immutable open, a real
// writer connection opens the index (its `-wal` appears) and the main file's bytes change under
// the probe, as a checkpoint would change them. The probe must then answer busy (`locked`, a
// writer is active), not `corrupt`. A probe that nothing interrupts keeps its ordinary answers,
// and it still creates no `-wal`/`-shm` itself (C-HYG-PROBE-NO-SIDECARS stands).
//
// OBSERVED RED on agent-qa e7bc9c8c3: { source: 'scan', reason: 'corrupt', ... }.
import { closeSync, mkdtempSync, openSync, readdirSync, rmSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { afterEach, describe, expect, it, vi } from 'vitest'

const race = vi.hoisted(() => ({ afterOpen: undefined as undefined | (() => void) }))

vi.mock('../index-open.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../index-open.js')>()
  return {
    ...original,
    openIndexReaderConnection: (...args: Parameters<typeof original.openIndexReaderConnection>) => {
      const connection = original.openIndexReaderConnection(...args)
      const afterOpen = race.afterOpen
      race.afterOpen = undefined
      afterOpen?.()
      return connection
    },
  }
})

const { classifyIndexFace } = await import('../index-reader.js')
const { indexDbPath } = await import('../index-open.js')
const { rebuildIndex } = await import('../index-rebuild.js')
const { scaffoldKnowledgeRoot } = await import('./fixtures/bundle-fixture.js')

const INSPECT = { inspectCheckpointedImmutably: true } as const
const roots: string[] = []
const writers: DatabaseSync[] = []

afterEach(() => {
  race.afterOpen = undefined
  for (const writer of writers.splice(0)) writer.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function healthyRoot(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'index-probe-writer-race-'))
  roots.push(root)
  const knowledgeRoot = join(root, 'agent-qa-knowledge')
  scaffoldKnowledgeRoot(knowledgeRoot)
  await rebuildIndex({ knowledgeRoot })
  return knowledgeRoot
}

function indexDir(knowledgeRoot: string): string[] {
  return readdirSync(dirname(indexDbPath(knowledgeRoot))).sort()
}

/** A writer opens the index and the main file changes under the probe, as a checkpoint would. */
function writerArrives(knowledgeRoot: string): void {
  const path = indexDbPath(knowledgeRoot)
  const writer = new DatabaseSync(path)
  writers.push(writer)
  writer.exec("INSERT INTO meta(k, v) VALUES ('lgd-race', 'in flight')")
  const fd = openSync(path, 'r+')
  try {
    // Page 2 onwards, as a torn checkpoint leaves it; the header page stays intact.
    writeSync(fd, Buffer.alloc(4096, 0xa5), 0, 4096, 4096)
  } finally {
    closeSync(fd)
  }
}

describe('the immutable probe against a writer that arrives mid-check', () => {
  it('answers busy (locked), not corrupt, when a writer opened the index during the check', async () => {
    const knowledgeRoot = await healthyRoot()
    race.afterOpen = () => writerArrives(knowledgeRoot)

    const face = classifyIndexFace(knowledgeRoot, INSPECT)

    expect(face).toMatchObject({ source: 'scan', reason: 'locked', filePresent: true })
    expect(face).not.toMatchObject({ reason: 'corrupt' })
    expect(JSON.stringify(face)).toContain('a writer')
  })

  it('keeps the ordinary answers, and creates no -wal/-shm, when nothing interrupts it', async () => {
    const knowledgeRoot = await healthyRoot()
    const before = indexDir(knowledgeRoot)
    expect(classifyIndexFace(knowledgeRoot, INSPECT)).toEqual({ source: 'index' })
    expect(indexDir(knowledgeRoot)).toEqual(before)
  })
})
