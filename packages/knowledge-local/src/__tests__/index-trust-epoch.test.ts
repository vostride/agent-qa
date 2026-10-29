import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it } from 'vitest'
import { publishBundle, type PublishBundleInput } from '../bundle-publish.test-helper.js'
import { indexDbPath } from '../index-open.js'
import { rebuildIndex } from '../index-rebuild.js'
import { openKnowledgeReader } from '../index-reader.js'
import { acquireWriterLease } from '../lease/writer-lease.js'
import { readRebuildRequest } from '../rebuild-marker.js'
import { makeBundleDraftFixture, makeDiscriminantFixture } from './fixtures/bundle-fixture.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

const input: PublishBundleInput = {
  draft: makeBundleDraftFixture(), discriminant: makeDiscriminantFixture(),
  originClass: 'agent-observed', createdAtOrdinal: 10, screenStates: [], initialEvents: [], relations: [],
  provenance: { mode: 'standalone', sourceDescription: 'persisted prior characterization' },
  artifacts: [],
}

async function indexedFixture() {
  const root = mkdtempSync(join(tmpdir(), 'agent-qa-trust-epoch-'))
  roots.push(root)
  const config = { knowledgeRoot: join(root, 'knowledge'), productKey: 'fixture-storefront' }
  const result = publishBundle(config, input)
  if (result.kind !== 'published') throw new Error('fixture refused')
  const lease = acquireWriterLease(config.knowledgeRoot)
  if (lease.kind !== 'acquired') throw new Error('fixture lease refused')
  const writerAuthority = { knowledgeRoot: config.knowledgeRoot, leaseId: lease.leaseId, epoch: lease.epoch }
  await rebuildIndex({ knowledgeRoot: config.knowledgeRoot, writerAuthority })
  return { knowledgeRoot: config.knowledgeRoot, id: result.id, writerAuthority }
}

it('an index built under a different trust epoch is read by scan until it is rebuilt', async () => {
  const f = await indexedFixture()
  const db = new DatabaseSync(indexDbPath(f.knowledgeRoot))
  const changed = db.prepare("UPDATE meta SET v = ? WHERE k = 'trust_prior_digest'").run('another-trust-epoch')
  db.close()
  expect(changed.changes).toBe(1)

  const stale = openKnowledgeReader(f.knowledgeRoot)
  try {
    expect(stale.getById(f.id)).toMatchObject({ bundleId: f.id, trust: 0.5 })
    expect(stale.source).toBe('scan')
  } finally { stale.close() }
  expect(readRebuildRequest(f.knowledgeRoot)).toEqual({ present: false })

  await rebuildIndex({ knowledgeRoot: f.knowledgeRoot, writerAuthority: f.writerAuthority })
  const rebuilt = openKnowledgeReader(f.knowledgeRoot)
  try {
    expect(rebuilt.getById(f.id)).toMatchObject({ bundleId: f.id, trust: 0.5 })
    expect(rebuilt.source).toBe('index')
  } finally { rebuilt.close() }
})
