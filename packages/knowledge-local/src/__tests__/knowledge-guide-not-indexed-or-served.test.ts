// Structure, not exclusion code, keeps the guide unindexed and unserved; each cell can fail.
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  asEvidenceToken,
  BundleOutcomeEventSchema,
  type BundleDraft,
  type RecordId,
  type ScopeKey,
} from '@vostride/agent-qa-schema'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { enumerateBundleDirs, scanBundles } from '../bundle-scan.js'
import { publishBundle, type PublishBundleInput } from '../bundle-publish.test-helper.js'
import { INDEX_DB_FILE } from '../index-open.js'
import { rebuildIndex } from '../index-rebuild.js'
import { readPolicyLadder } from '../serving/policy-ladder.js'
import { openKnowledgeReader } from '../serving/reader.js'

const PRODUCT = 'guide-storefront'
const SCOPE: ScopeKey = { tier: 'product', key: PRODUCT }
const RECORD_SENTINEL = 'GUIDE DECOY RECORD 7f3a'
const POLICY_SENTINEL = 'GUIDE DECOY POLICY 7f3a'
const CONTROL_SUMMARY = 'Guide control checkout button'
const CONTROL_RULE = 'Always use the sandbox checkout on guide-storefront.'
const GUIDE_SOURCE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../cli/src/commands/knowledge-guide.ts',
)

let guideBytes = ''
let guideHeading = ''
const roots: string[] = []

beforeAll(async () => {
  const guide = await import(/* @vite-ignore */ pathToFileURL(GUIDE_SOURCE).href) as {
    buildKnowledgeAgentGuide(): string
  }
  guideBytes = guide.buildKnowledgeAgentGuide()
  guideHeading = guideBytes.split('\n')[0]!
})

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempRoot(): { root: string; knowledgeRoot: string } {
  const root = join(tmpdir(), `knowledge-guide-${randomUUID()}`)
  roots.push(root)
  const knowledgeRoot = join(root, 'agent-qa-knowledge')
  mkdirSync(join(knowledgeRoot, 'policies'), { recursive: true })
  return { root, knowledgeRoot }
}

function publishRecord(root: string, knowledgeRoot: string, summary: string): { id: RecordId; dir: string } {
  const draft: BundleDraft = {
    kind: 'fact',
    subtype: 'selector',
    anchors: [{ t: 'el', role: 'button', name: summary, ordinal: 0 }, { t: 'page', route: '/checkout' }],
    scope: SCOPE,
    summary,
    body: `${summary} submits the order.`,
    distilledEvidenceRef: { id: `guide-${randomUUID()}`, sha: 'b'.repeat(64) },
    originStage: 'run-curation',
  }
  const input: PublishBundleInput = {
    draft,
    discriminant: { kind: 'fact', subtype: 'selector', elementRef: { role: 'button', name: summary } },
    originClass: 'agent-verified',
    createdAtOrdinal: 10,
    screenStates: [],
    initialEvents: [BundleOutcomeEventSchema.parse({
      type: 'promoted',
      evidenceToken: asEvidenceToken(`promoted-${summary}`),
      curationJobId: `guide-${summary}`,
      buildOrdinal: 10,
    })],
    relations: [],
    provenance: { mode: 'standalone', sourceDescription: 'guide exclusion fixture' },
    artifacts: [],
    evidenceMarkdown: `Evidence for ${summary}.\n`,
  }
  const outcome = publishBundle({
    knowledgeRoot,
    productKey: PRODUCT,
    writerLeaseId: 'guide-exclusion',
  }, input)
  if (outcome.kind !== 'published') throw new Error(`expected publication, got ${outcome.kind}`)
  return { id: outcome.id, dir: outcome.dir }
}

// The generated guide, followed by a real record.md relabelled with the sentinel and an active
// policy line: everything a careless scanner or ladder could mistake for knowledge.
function adversarialGuide(controlDir: string): string {
  const record = readFileSync(join(controlDir, 'record.md'), 'utf8').replaceAll(CONTROL_SUMMARY, RECORD_SENTINEL)
  if (!record.includes(RECORD_SENTINEL)) throw new Error('the record decoy does not carry its sentinel')
  return `${guideBytes}\n${record}\n${POLICY_SENTINEL}: always click it before asserting.\n`
}

// Every row of every readable index table, as text.
function indexedText(knowledgeRoot: string): string {
  const db = new DatabaseSync(join(knowledgeRoot, 'memory', 'index', INDEX_DB_FILE), { readOnly: true })
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
    return tables.flatMap(({ name }) => {
      try {
        return [JSON.stringify(db.prepare(`SELECT * FROM "${name}"`).all(), (_key, value: unknown) =>
          value instanceof Uint8Array ? '' : value)]
      } catch {
        return []
      }
    }).join('\n')
  } finally {
    db.close()
  }
}

function recordIds(knowledgeRoot: string): string[] {
  const db = new DatabaseSync(join(knowledgeRoot, 'memory', 'index', INDEX_DB_FILE), { readOnly: true })
  try {
    return (db.prepare('SELECT bundle_id FROM records ORDER BY bundle_id').all() as { bundle_id: string }[])
      .map((row) => row.bundle_id)
  } finally {
    db.close()
  }
}

function servedText(knowledgeRoot: string): string {
  return JSON.stringify(openKnowledgeReader({ knowledgeRoot, product: PRODUCT }).getRunBrief(SCOPE, 4_000))
}

describe('GUIDE-NOT-INDEXED: a real rebuild indexes zero records from the guide', () => {
  it('indexes only the real bundle while the guide slot holds record-shaped decoys', async () => {
    const { root, knowledgeRoot } = tempRoot()
    const control = publishRecord(root, knowledgeRoot, CONTROL_SUMMARY)
    writeFileSync(join(knowledgeRoot, 'AGENTS.md'), adversarialGuide(control.dir))

    const report = await rebuildIndex({ knowledgeRoot })

    expect(report.projected).toBe(1)
    expect(report.scanIssues).toEqual([])
    expect(recordIds(knowledgeRoot)).toEqual([control.id])
    const indexed = indexedText(knowledgeRoot)
    expect(indexed).toContain(CONTROL_SUMMARY)
    expect(indexed).not.toContain(RECORD_SENTINEL)
    expect(indexed).not.toContain(POLICY_SENTINEL)
    expect(indexed).not.toContain(guideHeading)
    expect(enumerateBundleDirs(knowledgeRoot).map((entry) => entry.dir)).toEqual([control.dir])
    expect(scanBundles({ knowledgeRoot }).map((hit) => hit.bundleId)).toEqual([control.id])
  })

  it('known-bad subject: the same assertion reds when the decoy sits in an admitted bundle', async () => {
    const { root, knowledgeRoot } = tempRoot()
    publishRecord(root, knowledgeRoot, CONTROL_SUMMARY)
    publishRecord(root, knowledgeRoot, RECORD_SENTINEL)

    await rebuildIndex({ knowledgeRoot })

    expect(indexedText(knowledgeRoot)).toContain(RECORD_SENTINEL)
    expect(recordIds(knowledgeRoot)).toHaveLength(2)
  })
})

describe('GUIDE-NOT-SERVED: the policy ladder and the serving reader never serve the guide', () => {
  it('serves only the authored policy and the real record while the guide slot holds policy decoys', async () => {
    const { root, knowledgeRoot } = tempRoot()
    const control = publishRecord(root, knowledgeRoot, CONTROL_SUMMARY)
    writeFileSync(join(knowledgeRoot, 'policies', 'global.md'), `${CONTROL_RULE}\n`)
    writeFileSync(join(knowledgeRoot, 'AGENTS.md'), adversarialGuide(control.dir))
    await rebuildIndex({ knowledgeRoot })

    const ladder = readPolicyLadder(knowledgeRoot, PRODUCT)
    expect(ladder.files).toEqual(['policies/global.md'])
    expect(ladder.text).toBe(`${CONTROL_RULE}\n`)

    const served = servedText(knowledgeRoot)
    expect(served).toContain(CONTROL_RULE)
    expect(served).toContain(control.id)
    expect(served).not.toContain(POLICY_SENTINEL)
    expect(served).not.toContain(RECORD_SENTINEL)
    expect(served).not.toContain(guideHeading)
  })

  it('known-bad subject: the same assertions red when the guide bytes sit on a policy rung', async () => {
    const { root, knowledgeRoot } = tempRoot()
    const control = publishRecord(root, knowledgeRoot, CONTROL_SUMMARY)
    writeFileSync(join(knowledgeRoot, 'policies', 'global.md'), `${CONTROL_RULE}\n`)
    writeFileSync(join(knowledgeRoot, 'policies', `${PRODUCT}.md`), adversarialGuide(control.dir))
    await rebuildIndex({ knowledgeRoot })

    expect(readPolicyLadder(knowledgeRoot, PRODUCT).text).toContain(POLICY_SENTINEL)
    const served = servedText(knowledgeRoot)
    expect(served).toContain(POLICY_SENTINEL)
    expect(served).toContain(guideHeading)
  })
})
