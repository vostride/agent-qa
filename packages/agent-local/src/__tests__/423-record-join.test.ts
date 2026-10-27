import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FunctionNotBoundError, RUNS_KNOWLEDGE_FUNCTION_ID, type KnowledgeReaderPort } from '@vostride/agent-qa-agent'
import { publishBundleForTest } from '@vostride/agent-qa-knowledge-local'
import { KnowledgeMaintenanceScanError, showRecord } from '@vostride/agent-qa-knowledge-local/reader'
import { afterEach, expect, it, vi } from 'vitest'
import { createKnowledgeReader } from '../composition/compose-local-agent.js'
import { createKnowledgeReaderPort } from '../composition/knowledge-review-reader.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tree(path: string): unknown {
  if (!existsSync(path)) return 'absent'
  return readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    .map(entry => [entry.name, entry.isDirectory() ? tree(join(path, entry.name))
      : readFileSync(join(path, entry.name)).toString('base64')])
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'agent-qa-423-port-join-'))
  roots.push(root)
  const knowledgeRoot = join(root, 'knowledge')
  const saved = publishBundleForTest({ knowledgeRoot, productKey: 'port-join' }, {
    draft: { kind: 'fact', subtype: 'selector',
      anchors: [{ t: 'el', role: 'Button', name: '購入' }],
      scope: { tier: 'product', key: 'port-join' }, summary: '購入 e\u0301 🧪', body: 'Read the recorded 購入 control.',
      distilledEvidenceRef: { id: 'port-join-evidence', sha: 'b'.repeat(64) }, originStage: 'run-curation' },
    discriminant: { kind: 'fact', subtype: 'selector', elementRef: { role: 'Button', name: '購入' } },
    originClass: 'agent-verified', createdAtOrdinal: 9, screenStates: [], initialEvents: [],
    relations: [], provenance: { mode: 'standalone', sourceDescription: 'Synthetic port fixture' }, artifacts: [],
  })
  if (saved.kind !== 'published') throw new Error(`fixture publication: ${saved.kind}`)
  return { root, knowledgeRoot, ...saved }
}

type Batch = NonNullable<KnowledgeReaderPort['showRecords']>
function boundBatch(port: KnowledgeReaderPort): Batch {
  const method = port.showRecords
  expect(method, 'the actual composed reader must bind showRecords').toBeTypeOf('function')
  return method!.bind(port)
}

it('JOIN-COMPOSED-PORT: actual composition returns maintenance data and per-ID misses in one root resolution', async () => {
  const f = fixture()
  const resolveRoot = vi.fn(async () => f.knowledgeRoot)
  const port: KnowledgeReaderPort = createKnowledgeReader(resolveRoot)
  const readSingle = vi.spyOn(port, 'showRecord')
  const result = await boundBatch(port)({ recordIds: [f.id, 'gone', f.id, 'é', 'e\u0301'] })
  expect(result).toEqual([showRecord({ knowledgeRoot: f.knowledgeRoot, recordId: f.id }),
    ...['gone', 'é', 'e\u0301'].map(recordId => ({ kind: 'not-found', schemaVersion: 2, recordId }))])
  expect(result[0]).toMatchObject({ kind: 'found', summary: '購入 e\u0301 🧪',
    record: { recordId: f.id, kind: 'fact', scope: 'port-join', status: 'candidate' } })
  expect(resolveRoot).toHaveBeenCalledTimes(1)
  expect(readSingle).not.toHaveBeenCalled()
})

it('JOIN-READ-NOTHING: populated reads preserve all tree bytes and never sight supplied identities', async () => {
  const f = fixture()
  const sight = vi.fn(async () => { writeFileSync(join(f.root, 'address-ledger-sighting'), 'write forbidden') })
  const port = createKnowledgeReaderPort({ resolveKnowledgeRoot: () => f.knowledgeRoot,
    sightMemoryEntities: sight })
  const before = tree(f.root)
  const read = boundBatch(port)
  const ids = [f.id, ...Array.from({ length: 99 }, (_, i) => `missing-${i}`)]
  expect(await read({ recordIds: [...ids, ...ids] })).toHaveLength(100)
  expect(await read({ recordIds: ids })).toHaveLength(100)
  expect(sight).not.toHaveBeenCalled()
  expect(tree(f.root)).toEqual(before)
})

it('JOIN-READ-NOTHING: missing root stays absent through the real composed binding', async () => {
  const f = fixture()
  const missing = join(f.root, 'never', 'knowledge')
  const before = tree(f.root)
  const port = createKnowledgeReaderPort({ resolveKnowledgeRoot: () => missing })
  expect(await boundBatch(port)({ recordIds: ['gone', 'gone'] }))
    .toEqual([{ kind: 'not-found', schemaVersion: 2, recordId: 'gone' }])
  expect(existsSync(missing)).toBe(false)
  expect(tree(f.root)).toEqual(before)
})

it('JOIN-SCAN-INCOMPLETE: composition forwards typed corruption without fake misses or writes', async () => {
  const f = fixture()
  writeFileSync(join(f.dir, 'record.md'), 'synthetic corrupt record')
  const before = tree(f.root)
  const port = createKnowledgeReaderPort({ resolveKnowledgeRoot: () => f.knowledgeRoot })
  await expect(boundBatch(port)({ recordIds: [f.id, 'gone'] })).rejects.toBeInstanceOf(KnowledgeMaintenanceScanError)
  expect(tree(f.root)).toEqual(before)
})

it('JOIN-NOT-BOUND: optional neutral batch refuses by name without a per-ID fallback', async () => {
  const f = fixture()
  const port = createKnowledgeReaderPort({ resolveKnowledgeRoot: () => f.knowledgeRoot })
  const single = vi.spyOn(port, 'showRecord')
  // Contract-only consumer: run-level dispatch belongs to 423-34. This existing error
  // is how an optional reader is refused, rather than substituting N single reads.
  const { showRecords: _omitted, ...legacy } = port
  const oldPort: KnowledgeReaderPort = legacy
  async function consume(reader: KnowledgeReaderPort) {
    const read = reader.showRecords
    if (read === undefined) throw new FunctionNotBoundError(RUNS_KNOWLEDGE_FUNCTION_ID)
    return read({ recordIds: [f.id, 'gone'] })
  }
  const before = tree(f.root)
  await expect(consume(oldPort)).rejects.toMatchObject({ name: 'FunctionNotBoundError', functionId: RUNS_KNOWLEDGE_FUNCTION_ID })
  expect(single).not.toHaveBeenCalled()
  expect(tree(f.root)).toEqual(before)
})
