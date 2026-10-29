import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { KnowledgeRecordShowResult } from '@vostride/agent-qa-schema'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { publishBundle, type PublishBundleInput } from '../bundle-publish.test-helper.js'
import * as reader from '../reader.js'
import { showRecord } from '../show-record.js'
import { KnowledgeMaintenanceScanError } from '../maintenance-scan.js'

const scan = vi.hoisted(() => ({ enumerations: 0, loads: 0 }))
vi.mock('../maintenance-scan.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../maintenance-scan.js')>()
  return {
    ...actual,
    enumerateMaintenanceBundleDirs: (...args: Parameters<typeof actual.enumerateMaintenanceBundleDirs>) => {
      scan.enumerations += 1
      return actual.enumerateMaintenanceBundleDirs(...args)
    },
    loadMaintenanceBundle: (...args: Parameters<typeof actual.loadMaintenanceBundle>) => {
      scan.loads += 1
      return actual.loadMaintenanceBundle(...args)
    },
  }
})

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  scan.enumerations = 0
  scan.loads = 0
})

function tree(path: string): unknown {
  if (!existsSync(path)) return 'absent'
  return readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    .map(entry => [entry.name, entry.isDirectory() ? tree(join(path, entry.name))
      : readFileSync(join(path, entry.name)).toString('base64')])
}

const input: PublishBundleInput = {
  draft: {
    kind: 'fact', subtype: 'selector', anchors: [{ t: 'el', role: 'Button', name: '購入' }],
    scope: { tier: 'product', key: 'join-fixture' }, summary: '購入 Café e\u0301 🧪',
    body: 'Click 購入; preserve é and e\u0301 exactly.',
    distilledEvidenceRef: { id: 'join-evidence', sha: 'a'.repeat(64) },
    originStage: 'run-curation',
  },
  discriminant: { kind: 'fact', subtype: 'selector', elementRef: { role: 'Button', name: '購入' } },
  originClass: 'agent-verified', createdAtOrdinal: 7, screenStates: [], initialEvents: [],
  relations: [], provenance: { mode: 'standalone', sourceDescription: 'Synthetic joined record' }, artifacts: [],
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'agent-qa-423-join-'))
  roots.push(root)
  const knowledgeRoot = join(root, 'knowledge')
  const saved = publishBundle({ knowledgeRoot, productKey: 'join-fixture' },
    input)
  if (saved.kind !== 'published') throw new Error(`fixture publication: ${saved.kind}`)
  return { root, knowledgeRoot, ...saved }
}

type Batch = (options: { knowledgeRoot: string; recordIds: readonly string[] }) => readonly KnowledgeRecordShowResult[]
function batch(): Batch {
  const method = (reader as unknown as { showRecords?: Batch }).showRecords
  expect(method, 'the reader entry must bind the batch maintenance read').toBeTypeOf('function')
  return method!
}

describe('423 one maintenance record join', () => {
  it('JOIN-ONCE: 100 unique IDs plus duplicates enumerate once and preserve request order', () => {
    const f = fixture()
    const recordIds = [f.id, ...Array.from({ length: 99 }, (_, i) => `missing-${i}`)]
    const before = tree(f.root)
    scan.enumerations = 0
    scan.loads = 0
    const result = batch()({ knowledgeRoot: f.knowledgeRoot, recordIds: [...recordIds, ...recordIds] })
    expect(scan.enumerations).toBe(1)
    expect(result).toHaveLength(100)
    expect(result.map(row => row.kind === 'found' ? row.record.recordId : row.recordId)).toEqual(recordIds)
    expect(result[0]?.kind).toBe('found')
    expect(result.slice(1).every(row => row.kind === 'not-found')).toBe(true)
    expect(scan.loads).toBe(1)
    expect(tree(f.root)).toEqual(before)
  })

  it('JOIN-UNICODE: content and original missing identities survive without normalization', () => {
    const f = fixture()
    const ids = [f.id, 'é', 'e\u0301', '__proto__', '購入 🧪']
    const result = batch()({ knowledgeRoot: f.knowledgeRoot, recordIds: ids })
    expect(result[0]).toMatchObject({ kind: 'found', summary: input.draft.summary, body: input.draft.body,
      record: { recordId: f.id, scope: input.draft.scope.key } })
    expect(result.slice(1)).toEqual(ids.slice(1).map(recordId => ({ kind: 'not-found', schemaVersion: 2, recordId })))
  })

  it('JOIN-NOT-FOUND: absent roots and empty requests never materialize storage', () => {
    const f = fixture()
    const missing = join(f.root, 'never', 'knowledge')
    const before = tree(f.root)
    expect(batch()({ knowledgeRoot: missing, recordIds: ['gone', 'gone'] }))
      .toEqual([{ kind: 'not-found', schemaVersion: 2, recordId: 'gone' }])
    expect(batch()({ knowledgeRoot: missing, recordIds: [] })).toEqual([])
    expect(existsSync(missing)).toBe(false)
    expect(tree(f.root)).toEqual(before)
  })

  it('SHOW-RECORD-PARITY: frozen pre-batch projection and single reads retain identical JSON bytes', () => {
    const f = fixture()
    const before = tree(f.root)
    const original = showRecord({ knowledgeRoot: f.knowledgeRoot, recordId: f.id })
    expect(JSON.stringify(original)).toMatchInlineSnapshot(`"{"kind":"found","schemaVersion":2,"record":{"schemaVersion":2,"recordId":"fact-el-button-97ff2af3f56ffb17","product":"join-fixture","scope":"join-fixture","kind":"fact","status":"candidate","confirmations":0,"contradictions":0,"evidenceTokens":[],"lastEventOrdinal":7,"openedAtOrdinal":7,"anchors":["{\\"name\\":\\"購入\\",\\"role\\":\\"button\\",\\"t\\":\\"el\\"}"]},"provenance":{"schemaVersion":2,"mode":"standalone","originClass":"agent-verified","sourceDescription":"Synthetic joined record"},"summary":"購入 Café é 🧪","body":"Click 購入; preserve é and é exactly."}"`)
    expect(original).toMatchObject({ kind: 'found', schemaVersion: 2,
      summary: input.draft.summary, body: input.draft.body,
      record: { recordId: f.id, kind: 'fact', product: 'join-fixture', status: 'candidate',
        confirmations: 0, contradictions: 0, openedAtOrdinal: 7 },
    })
    const result = batch()({ knowledgeRoot: f.knowledgeRoot, recordIds: [f.id, 'gone'] })
    expect(JSON.stringify(result)).toBe(JSON.stringify([original,
      { kind: 'not-found', schemaVersion: 2, recordId: 'gone' }]))
    expect(JSON.stringify(batch()({ knowledgeRoot: f.knowledgeRoot, recordIds: [f.id, 'gone'] })))
      .toBe(JSON.stringify(result))
    expect(tree(f.root)).toEqual(before)
  })

  it('JOIN-SCAN-INCOMPLETE: corrupt bundles remain typed scan failures, never ordinary misses', () => {
    const f = fixture()
    writeFileSync(join(f.dir, 'record.md'), 'damaged synthetic fixture')
    const before = tree(f.root)
    expect(() => showRecord({ knowledgeRoot: f.knowledgeRoot, recordId: f.id }))
      .toThrow(KnowledgeMaintenanceScanError)
    const read = batch()
    expect(() => read({ knowledgeRoot: f.knowledgeRoot, recordIds: [f.id, 'gone'] }))
      .toThrow(KnowledgeMaintenanceScanError)
    expect(tree(f.root)).toEqual(before)
  })
})
