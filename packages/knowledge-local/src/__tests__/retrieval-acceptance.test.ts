import { rebuildAuthorizedIndex as rebuildIndex } from './fixtures/authorized-rebuild.js'
import {
  cpSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
} from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DISTILLED_OBSERVATION_SCHEMA_VERSION,
  BundleOutcomeEventSchema,
  type Anchor,
  type BundleOutcomeEvent,
  type BundleRelation,
  type DistilledObservation,
  type OriginClass,
} from '@vostride/agent-qa-schema'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  appendRelation,
  buildRetrievalQuery,
  openIndexReaderConnection,
  openKnowledgeReader,
  resolveActiveProfile,
  retrieve,
  vecTableName,
  type BundleStoreConfig,
  type PublishBundleInput,
  type PublishBundleOutcome,
} from '../index.js'
import { publishBundle } from '../bundle-publish.test-helper.js'
import {
  makeBundleDraftFixture,
  makeScreenStateFixture,
  scaffoldKnowledgeRoot,
} from './fixtures/bundle-fixture.js'
import { makeFakeEmbedder } from './fixtures/fake-embedder.js'
import { publishObservationFixture } from './fixtures/observation-fixture.js'

type PublishedBundle = Extract<PublishBundleOutcome, { kind: 'published' }>

interface AcceptanceIds {
  activeOld: string
  activeNew: string
  user: string
  superseded: string
  sibling: string
  fallbackOld: string
  fallbackNew: string
  conflictLeft: string
  conflictRight: string
  conflictUnknown: string
  expansionSeed: string
  expansionNeighbors: string[]
  poisonedGlobal: string
  curatedBridgeSource: string
  curatedBridgeTarget: string
}

interface AcceptanceFixture {
  tempRoot: string
  canonicalRoot: string
  permutedRoot: string
  vecRoot: string
  bruteRoot: string
  ids: AcceptanceIds
}

interface GraphDumpRow {
  src_node_id: string
  src_type: string
  edge_type: string
  dst_node_id: string
  dst_type: string
  bundle_id: string
  product: string
  recency_ordinal: number
}

interface ProjectionRow {
  embedding_input: string
  situating_line: string
  contextual_rendering: string
  fts_context: string
}

interface FactFixtureInput {
  identity: string
  anchors: readonly Anchor[]
  createdAtOrdinal: number
  originClass?: OriginClass
  initialEvents?: readonly BundleOutcomeEvent[]
  relations?: readonly BundleRelation[]
  scope?: PublishBundleInput['draft']['scope']
  summary?: string
  body?: string
}

const PRODUCT = 'acceptance-storefront'
const SIBLING_PRODUCT = 'acceptance-payments'
const EXPANSION_FRACTION = 0.25
const FAN_OUT_CAP = 32
const RAW_SELECTOR = '[data-testid="acceptance-checkout"]'
const TEST_DIR = dirname(fileURLToPath(import.meta.url))

const MAIN_ANCHOR = {
  t: 'el',
  role: 'button',
  name: 'Acceptance checkout',
} as const satisfies Anchor
const FALLBACK_ANCHOR = {
  t: 'el',
  role: 'button',
  name: 'Acceptance fallback',
} as const satisfies Anchor
const CONFLICT_ANCHOR = {
  t: 'page',
  route: '/acceptance-conflict',
} as const satisfies Anchor
const EXPANSION_ANCHOR = {
  t: 'flow',
  name: 'Acceptance expansion seed',
} as const satisfies Anchor
const POISON_ANCHOR = {
  t: 'error',
  message: 'Acceptance poison direct match',
} as const satisfies Anchor
const SIBLING_ANCHOR = {
  t: 'page',
  route: '/acceptance-sibling',
} as const satisfies Anchor

let acceptance: AcceptanceFixture | undefined

beforeAll(async () => {
  acceptance = await buildAcceptanceFixture()
}, 120_000)

// The teardown gets an explicit budget for the same reason the setup above has one, and it is the
// SAME budget question rather than a new one: this fixture builds a real embedded index under a
// temp root, and recursively removing it competes for the disk with every other worker under
// whole-monorepo parallelism. Vitest's DEFAULT hook timeout is 10s, so the file passed every
// assertion and then failed the run on cleanup — a red gate with zero failing assertions, observed
// across waves 18 and 19 of phase 390 and again on 391-01's own full-suite gate. Sixty seconds is
// half what the build side already declares for the same tree.
afterAll(() => {
  if (acceptance !== undefined) {
    rmSync(acceptance.tempRoot, { recursive: true, force: true })
  }
}, 60_000)

function fixture(): AcceptanceFixture {
  if (acceptance === undefined) throw new Error('acceptance fixture is unavailable')
  return acceptance
}

function orderedIds(entries: readonly { id: string }[]): string[] {
  return entries.map(({ id }) => String(id))
}

function dumpGraph(knowledgeRoot: string): GraphDumpRow[] {
  const connection = openIndexReaderConnection(knowledgeRoot)
  try {
    return connection.db.prepare(`
      SELECT
        edge.src_node_id,
        source.node_type AS src_type,
        edge.edge_type,
        edge.dst_node_id,
        target.node_type AS dst_type,
        records.bundle_id,
        edge.product,
        edge.recency_ordinal
      FROM graph_edges AS edge
      JOIN graph_nodes AS source ON source.node_id = edge.src_node_id
      JOIN graph_nodes AS target ON target.node_id = edge.dst_node_id
      JOIN records ON records.record_rowid = edge.record_rowid
      ORDER BY
        edge.src_node_id,
        edge.edge_type,
        edge.dst_node_id,
        records.bundle_id,
        edge.product,
        edge.recency_ordinal
    `).all() as unknown as GraphDumpRow[]
  } finally {
    connection.db.close()
  }
}

function projection(knowledgeRoot: string, bundleId: string): ProjectionRow {
  const connection = openIndexReaderConnection(knowledgeRoot)
  try {
    const row = connection.db.prepare(`
      SELECT
        records.embedding_input,
        records.situating_line,
        records.contextual_rendering,
        fts_records.context AS fts_context
      FROM records
      JOIN fts_records ON fts_records.rowid = records.record_rowid
      WHERE records.bundle_id = ?
    `).get(bundleId)
    if (row === undefined) throw new Error(`missing projection for ${bundleId}`)
    return row as unknown as ProjectionRow
  } finally {
    connection.db.close()
  }
}

function rawVecIds(
  knowledgeRoot: string,
  embedding: Float32Array,
  statusFiltered: boolean,
): string[] {
  const connection = openIndexReaderConnection(knowledgeRoot)
  try {
    expect(connection.vec).toBe('vec0')
    const tableName = vecTableName(resolveActiveProfile(connection.db))
    const statusClause = statusFiltered
      ? "AND status != 'deprecated' AND status != 'superseded'"
      : ''
    const query = Buffer.from(
      embedding.buffer,
      embedding.byteOffset,
      embedding.byteLength,
    )
    const rows = connection.db.prepare(`
      SELECT record_rowid
      FROM ${tableName}
      WHERE embedding MATCH ?
        AND product = ?
        AND scope_key = ?
        ${statusClause}
        AND k = ?
      ORDER BY distance
    `).all(query, PRODUCT, PRODUCT, 128)

    return rows.map((row) => {
      const record = connection.db
        .prepare('SELECT bundle_id FROM records WHERE record_rowid = ?')
        .get(row.record_rowid)
      if (record === undefined) throw new Error('vec row has no projected record')
      return String(record.bundle_id)
    })
  } finally {
    connection.db.close()
  }
}

function phaseSourceFiles(): string[] {
  const retrievalDir = join(TEST_DIR, '..', 'retrieval')
  const retrievalFiles = readdirSync(retrievalDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => join(retrievalDir, entry.name))
  return [
    ...retrievalFiles,
    join(TEST_DIR, '..', 'graph-derive.ts'),
    join(TEST_DIR, '..', 'contextual-rendering.ts'),
    join(TEST_DIR, '..', 'retrieve.ts'),
    join(TEST_DIR, '..', 'query-helper.ts'),
  ].sort()
}

describe('ROADMAP success criterion 1 — deterministic graph construction', () => {
  it('rebuilds identical bundle-keyed edges with curated and mechanical bridges', async () => {
    const { canonicalRoot, permutedRoot, ids } = fixture()
    const first = dumpGraph(canonicalRoot)

    await expect(rebuildIndex({ knowledgeRoot: canonicalRoot })).resolves.toMatchObject({
      projected: 0,
      scanIssues: [],
    })

    expect(dumpGraph(canonicalRoot)).toEqual(first)
    expect(dumpGraph(permutedRoot)).toEqual(first)

    const bridges = first.filter(({ edge_type }) => edge_type === 'equivalent-to')
    expect(bridges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        src_type: 'fact',
        dst_type: 'fact',
        bundle_id: ids.curatedBridgeSource,
      }),
      expect.objectContaining({ src_type: 'web-element', dst_type: 'mobile-element' }),
    ]))
  })
})

describe('ROADMAP success criterion 2 — bounded one-hop graph expansion', () => {
  it('contains global poison and enforces the fraction and fan-out ceilings', async () => {
    const { canonicalRoot, ids } = fixture()
    const reader = openKnowledgeReader(canonicalRoot)
    const neighborIds = new Set(ids.expansionNeighbors)
    try {
      const small = await retrieve(
        reader,
        { intent: '', anchors: [EXPANSION_ANCHOR] },
        { n: 20, product: PRODUCT, asOfBuild: 1_000 },
      )
      const large = await retrieve(
        reader,
        { intent: '', anchors: [EXPANSION_ANCHOR] },
        { n: 160, product: PRODUCT, asOfBuild: 1_000 },
      )
      const smallExpanded = orderedIds(small).filter((id) => neighborIds.has(id))
      const largeExpanded = orderedIds(large).filter((id) => neighborIds.has(id))

      expect(smallExpanded).toHaveLength(Math.ceil(EXPANSION_FRACTION * 20))
      expect(largeExpanded).toHaveLength(FAN_OUT_CAP)
      expect(orderedIds(small)).not.toContain(ids.poisonedGlobal)
      expect(orderedIds(large)).not.toContain(ids.poisonedGlobal)

      const direct = await retrieve(
        reader,
        { intent: '', anchors: [POISON_ANCHOR] },
        { n: 5, product: PRODUCT, asOfBuild: 1_000 },
      )
      expect(orderedIds(direct)).toContain(ids.poisonedGlobal)
    } finally {
      reader.close()
    }
  })
})

describe('ROADMAP success criterion 3 — fail-closed filters, audit, and fallback', () => {
  it('excludes withdrawn and sibling-product rows before serving and raw vec KNN', async () => {
    const { canonicalRoot, vecRoot, bruteRoot, ids } = fixture()
    const reader = openKnowledgeReader(canonicalRoot)
    try {
      for (const anchors of [[MAIN_ANCHOR], [SIBLING_ANCHOR], [MAIN_ANCHOR, SIBLING_ANCHOR]]) {
        const result = await retrieve(
          reader,
          { intent: '', anchors },
          { n: 128, product: PRODUCT, asOfBuild: 1_000 },
        )
        expect(orderedIds(result)).not.toContain(ids.superseded)
        expect(orderedIds(result)).not.toContain(ids.sibling)
      }
    } finally {
      reader.close()
    }

    const embedder = makeFakeEmbedder()
    const queryEmbedding = await embedder.embedQuery('acceptance raw status-filtered KNN')
    expect(rawVecIds(vecRoot, queryEmbedding, false)).not.toContain(ids.superseded)
    expect(rawVecIds(vecRoot, queryEmbedding, true)).not.toContain(ids.superseded)
    expect(rawVecIds(vecRoot, queryEmbedding, false)).not.toContain(ids.sibling)

    for (const [root, vecLoadablePath] of [
      [vecRoot, undefined],
      [bruteRoot, join(fixture().tempRoot, 'missing-sqlite-vec')],
    ] as const) {
      const denseReader = openKnowledgeReader(
        root,
        vecLoadablePath === undefined ? {} : { vecLoadablePath },
      )
      try {
        const denseIds = denseReader
          .searchDense(queryEmbedding, { product: PRODUCT, k: 128 })
          .map(({ bundleId }) => bundleId)
        expect(denseIds).not.toContain(ids.superseded)
        expect(denseIds).not.toContain(ids.sibling)
      } finally {
        denseReader.close()
      }
    }
  })

  it('returns typed full-truth audits and the flagged prior-build fallback', async () => {
    const { canonicalRoot, ids } = fixture()
    const reader = openKnowledgeReader(canonicalRoot)
    try {
      const query = { intent: '', anchors: [MAIN_ANCHOR] } as const
      const serving = await retrieve(reader, query, {
        n: 20,
        product: PRODUCT,
        asOfBuild: 1_000,
      })
      const supersededAudit = await retrieve(reader, query, {
        n: 20,
        product: PRODUCT,
        asOfBuild: 1_000,
        includeSuperseded: true,
      })
      const rangeAudit = await retrieve(reader, query, {
        n: 20,
        product: PRODUCT,
        asOfBuild: 1_000,
        asOfRange: { lo: 1, hi: 1_000 },
      })

      expect(orderedIds(supersededAudit)).toEqual(expect.arrayContaining([
        ids.activeOld,
        ids.activeNew,
        ids.user,
        ids.superseded,
      ]))
      expect(orderedIds(rangeAudit)).toEqual(expect.arrayContaining([
        ids.activeOld,
        ids.activeNew,
        ids.user,
      ]))
      expect(supersededAudit.length).toBeGreaterThan(serving.length)
      expect(rangeAudit.length).toBeGreaterThan(serving.length)
      expect([...supersededAudit, ...rangeAudit].every((entry) => entry.audit !== undefined))
        .toBe(true)
      expect(supersededAudit.find(({ id }) => id === ids.superseded)).toMatchObject({
        status: 'superseded',
        validity: 'current',
        audit: { status: 'superseded' },
      })

      const fallback = await retrieve(
        reader,
        { intent: '', anchors: [FALLBACK_ANCHOR] },
        { n: 10, product: PRODUCT, asOfBuild: 1_000 },
      )
      expect(fallback).toMatchObject([
        {
          id: ids.fallbackNew,
          servedAs: 'prior-build-hypothesis',
          validity: 'prior-build-hypothesis',
        },
      ])
      expect(orderedIds(fallback)).not.toContain(ids.fallbackOld)
    } finally {
      reader.close()
    }
  })
})

describe('ROADMAP success criterion 4 — deterministic hybrid rank and carve-outs', () => {
  it(
    'returns identical ids twice, after permuted rebuild, and across vec capabilities',
    async () => {
      const { canonicalRoot, permutedRoot, vecRoot, bruteRoot, tempRoot } = fixture()
      const query = { intent: '', anchors: [MAIN_ANCHOR, CONFLICT_ANCHOR] } as const
      const options = { n: 20, product: PRODUCT, asOfBuild: 1_000 } as const
      const canonical = openKnowledgeReader(canonicalRoot)
      const permuted = openKnowledgeReader(permutedRoot)
      const vec = openKnowledgeReader(vecRoot)
      const brute = openKnowledgeReader(bruteRoot, {
        vecLoadablePath: join(tempRoot, 'missing-sqlite-vec'),
      })
      try {
        expect(vec.vec).toBe('vec0')
        expect(brute.vec).toBe('brute')

        const first = orderedIds(await retrieve(canonical, query, options))
        const second = orderedIds(await retrieve(canonical, query, options))
        const permutedIds = orderedIds(await retrieve(permuted, query, options))
        const vecIds = orderedIds(await retrieve(vec, query, options))
        const bruteIds = orderedIds(await retrieve(brute, query, options))

        expect(second).toEqual(first)
        expect(permutedIds).toEqual(first)
        expect(bruteIds).toEqual(vecIds)
      } finally {
        canonical.close()
        permuted.close()
        vec.close()
        brute.close()
      }
    },
    120_000,
  )

  it('preserves user sovereignty and annotates both MintUnknown peers', async () => {
    const { canonicalRoot, ids } = fixture()
    const reader = openKnowledgeReader(canonicalRoot)
    try {
      const collapsed = await retrieve(
        reader,
        { intent: '', anchors: [MAIN_ANCHOR] },
        { n: 20, product: PRODUCT, asOfBuild: 1_000 },
      )
      expect(orderedIds(collapsed)).toContain(ids.user)
      expect(orderedIds(collapsed)).toContain(ids.activeNew)
      expect(orderedIds(collapsed)).not.toContain(ids.activeOld)

      const conflicts = await retrieve(
        reader,
        { intent: '', anchors: [CONFLICT_ANCHOR] },
        { n: 20, product: PRODUCT, asOfBuild: 1_000 },
      )
      expect(conflicts.find(({ id }) => id === ids.conflictLeft)?.conflict).toEqual({
        peerRecordId: ids.conflictRight,
        unknownRecordId: ids.conflictUnknown,
      })
      expect(conflicts.find(({ id }) => id === ids.conflictRight)?.conflict).toEqual({
        peerRecordId: ids.conflictLeft,
        unknownRecordId: ids.conflictUnknown,
      })
      expect(conflicts.find(({ id }) => id === ids.conflictUnknown)).toMatchObject({
        kind: 'unknown',
      })
    } finally {
      reader.close()
    }
  })
})

describe('ROADMAP success criterion 5 — normalized and contextual renderings', () => {
  it(
    'normalizes anchors, keeps selectors lexical-only, and mirrors index-side context',
    async () => {
      const { canonicalRoot, ids } = fixture()
      const input = {
        intent: 'Complete acceptance checkout',
        anchors: [
          { t: 'selector', literal: RAW_SELECTOR },
          { t: 'el', role: ' BUTTON ', name: ' Acceptance checkout (9) ' },
        ],
        screenState: makeScreenStateFixture(),
      } as const
      const first = buildRetrievalQuery(input)
      const second = buildRetrievalQuery(input)

      expect(second).toEqual(first)
      expect(first.normalizedAnchors[1]).toEqual({
        ...MAIN_ANCHOR,
        name: 'acceptance checkout',
      })
      expect(first.lexicalQuery).toContain(RAW_SELECTOR)
      expect(first.semanticText).not.toContain(RAW_SELECTOR)
      expect(first.fallbackRenderings).toHaveLength(1)

      const reader = openKnowledgeReader(canonicalRoot)
      try {
        const normalized = await retrieve(
          reader,
          { intent: '', anchors: [MAIN_ANCHOR] },
          { n: 20, product: PRODUCT, asOfBuild: 1_000 },
        )
        const messy = await retrieve(
          reader,
          { intent: '', anchors: [input.anchors[1]] },
          { n: 20, product: PRODUCT, asOfBuild: 1_000 },
        )
        expect(orderedIds(messy)).toEqual(orderedIds(normalized))
      } finally {
        reader.close()
      }

      const row = projection(canonicalRoot, ids.activeNew)
      const manifest = JSON.parse(
        readFileSync(
          join(
            canonicalRoot,
            'memory',
            PRODUCT,
            'bundles',
            ids.activeNew,
            'manifest.json',
          ),
          'utf8',
        ),
      ) as { embeddingInput: string }
      expect(row.embedding_input).toBe(manifest.embeddingInput)
      expect(row.situating_line).not.toBe('')
      expect(row.contextual_rendering).toBe(
        `${manifest.embeddingInput}\n${row.situating_line}`,
      )
      expect(row.fts_context).toBe(row.situating_line)
    },
  )

  it('contains no wall-clock reads in the retrieval decision modules', () => {
    const wallClockCall = /\b(?:Date\.now|performance\.now)\s*\(|\bnew\s+Date\s*\(/
    for (const file of phaseSourceFiles()) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(wallClockCall)
    }
  })
})

async function buildAcceptanceFixture(): Promise<AcceptanceFixture> {
  const tempRoot = await mkdtemp(join(tmpdir(), 'knowledge-retrieval-acceptance-'))
  const canonicalRoot = join(tempRoot, 'canonical-knowledge')
  const permutedRoot = join(tempRoot, 'permuted-knowledge')
  const vecRoot = join(tempRoot, 'vec-knowledge')
  const bruteRoot = join(tempRoot, 'brute-knowledge')

  try {
    const ids = buildCorpus(canonicalRoot)
    for (const clone of [permutedRoot, vecRoot, bruteRoot]) {
      cpSync(canonicalRoot, clone, { recursive: true })
    }

    const canonical = await rebuildIndex({ knowledgeRoot: canonicalRoot })
    assertCleanRebuild('canonical', canonical.scanIssues)

    const restorePermutation = permuteBundleEnumeration(permutedRoot)
    try {
      const permuted = await rebuildIndex({ knowledgeRoot: permutedRoot })
      assertCleanRebuild('permuted', permuted.scanIssues)
    } finally {
      restorePermutation()
    }

    const embedder = makeFakeEmbedder()
    const vec = await rebuildIndex({ knowledgeRoot: vecRoot, embedder })
    assertCleanRebuild('vec0', vec.scanIssues)
    if (vec.vec !== 'vec0') throw new Error(`expected vec0 fixture index, got ${vec.vec}`)

    const brute = await rebuildIndex({
      knowledgeRoot: bruteRoot,
      embedder,
      vecLoadablePath: join(tempRoot, 'missing-sqlite-vec'),
    })
    assertCleanRebuild('brute', brute.scanIssues)
    if (brute.vec !== 'brute') throw new Error(`expected brute fixture index, got ${brute.vec}`)

    return { tempRoot, canonicalRoot, permutedRoot, vecRoot, bruteRoot, ids }
  } catch (error) {
    rmSync(tempRoot, { recursive: true, force: true })
    throw error
  }
}

function assertCleanRebuild(label: string, scanIssues: readonly string[]): void {
  if (scanIssues.length > 0) {
    throw new Error(`${label} acceptance rebuild issues: ${scanIssues.join('; ')}`)
  }
}

function config(knowledgeRoot: string, productKey = PRODUCT): BundleStoreConfig {
  return {
    knowledgeRoot,
    productKey,
  }
}

function factInput(input: FactFixtureInput): PublishBundleInput {
  return {
    draft: makeBundleDraftFixture({
      anchors: [...input.anchors],
      scope: input.scope ?? { tier: 'product', key: PRODUCT },
      summary: input.summary ?? `${input.identity} acceptance fact`,
      body: input.body ?? `${input.identity} records deterministic acceptance behavior.`,
    }),
    discriminant: {
      kind: 'fact',
      subtype: 'selector',
      elementRef: { role: 'acceptance-fixture', name: input.identity },
    },
    originClass: input.originClass ?? 'agent-verified',
    createdAtOrdinal: input.createdAtOrdinal,
    screenStates: [makeScreenStateFixture(input.createdAtOrdinal % 3)],
    initialEvents: [...(input.initialEvents ?? [])],
    relations: [...(input.relations ?? [])],
    provenance: {
      mode: 'run-linked',
      runId: 'retrieval-acceptance-run',
      testId: `retrieval-acceptance-${input.identity}`,
      stepIndex: input.createdAtOrdinal,
    },
    artifacts: [],
  }
}

function publishFact(
  knowledgeRoot: string,
  input: FactFixtureInput,
  productKey = PRODUCT,
): PublishedBundle {
  const outcome = publishBundle(config(knowledgeRoot, productKey), factInput(input))
  if (outcome.kind !== 'published') {
    throw new Error(`expected ${input.identity} publication, got ${outcome.kind}`)
  }
  return outcome
}

function confirmation(identity: string, buildOrdinal: number): BundleOutcomeEvent {
  return BundleOutcomeEventSchema.parse({
    type: 'confirmed',
    evidenceToken: `${identity}-confirmed-${buildOrdinal}`,
    curationJobId: `${identity}-confirmed-${buildOrdinal}-job`,
    buildOrdinal,
    origin: 'agent-verified',
  })
}

function windowClose(identity: string, closedAtOrdinal: number): BundleOutcomeEvent {
  return BundleOutcomeEventSchema.parse({
    type: 'window-close',
    evidenceToken: `${identity}-window-close`,
    curationJobId: `${identity}-window-close-job`,
    buildOrdinal: closedAtOrdinal,
    closedAtOrdinal,
  })
}

function relation(
  targetId: PublishedBundle['id'],
  identity: string,
  ordinal: number,
): BundleRelation {
  return {
    type: 'relates-to',
    targetId,
    addedAtOrdinal: ordinal,
    curationJobId: `${identity}-relation-job`,
  }
}

function observation(
  platform: 'web' | 'mobile',
  elementNaturalKey: string,
  observedAtOrdinal: number,
): DistilledObservation {
  return {
    schemaVersion: DISTILLED_OBSERVATION_SCHEMA_VERSION,
    step: { naturalKey: 'acceptance shared checkout step', ordinal: 3 },
    platform,
    test: { id: 'retrieval-acceptance-test' },
    procedure: { id: 'retrieval-acceptance-procedure' },
    flow: { name: 'acceptance checkout', precedes: 'acceptance confirmation' },
    surface: {
      kind: platform === 'web' ? 'page' : 'screen',
      naturalKey: platform === 'web' ? '/acceptance-web' : 'AcceptanceActivity',
    },
    element: { naturalKey: elementNaturalKey },
    error: { naturalKey: `${platform} acceptance failure` },
    observedAtOrdinal,
  }
}

function buildCorpus(knowledgeRoot: string): AcceptanceIds {
  scaffoldKnowledgeRoot(knowledgeRoot)

  const activeOld = publishFact(knowledgeRoot, {
    identity: 'active-old',
    anchors: [MAIN_ANCHOR, { t: 'page', route: '/acceptance-checkout' }],
    createdAtOrdinal: 10,
    initialEvents: [confirmation('active-old', 11)],
  })
  const activeNew = publishFact(knowledgeRoot, {
    identity: 'active-new',
    anchors: [MAIN_ANCHOR, { t: 'page', route: '/acceptance-checkout' }],
    createdAtOrdinal: 20,
    initialEvents: [confirmation('active-new-a', 21), confirmation('active-new-b', 22)],
  })
  const user = publishFact(knowledgeRoot, {
    identity: 'user-sovereign',
    anchors: [MAIN_ANCHOR, { t: 'page', route: '/acceptance-checkout' }],
    createdAtOrdinal: 7,
    originClass: 'user',
  })
  const superseded = publishFact(knowledgeRoot, {
    identity: 'withdrawn',
    anchors: [MAIN_ANCHOR, { t: 'page', route: '/acceptance-checkout' }],
    createdAtOrdinal: 8,
    initialEvents: [
      BundleOutcomeEventSchema.parse({
        type: 'superseded',
        evidenceToken: 'withdrawn-superseded',
        curationJobId: 'withdrawn-superseded-job',
        buildOrdinal: 30,
        byRecordId: activeNew.id,
      }),
    ],
  })
  const sibling = publishFact(
    knowledgeRoot,
    {
      identity: 'sibling-product',
      anchors: [SIBLING_ANCHOR, MAIN_ANCHOR],
      scope: { tier: 'product', key: PRODUCT },
      createdAtOrdinal: 40,
    },
    SIBLING_PRODUCT,
  )

  const fallbackOld = publishFact(knowledgeRoot, {
    identity: 'fallback-old',
    anchors: [FALLBACK_ANCHOR, { t: 'page', route: '/acceptance-fallback' }],
    createdAtOrdinal: 1,
    initialEvents: [windowClose('fallback-old', 5)],
  })
  const fallbackNew = publishFact(knowledgeRoot, {
    identity: 'fallback-new',
    anchors: [FALLBACK_ANCHOR, { t: 'page', route: '/acceptance-fallback' }],
    createdAtOrdinal: 2,
    initialEvents: [windowClose('fallback-new', 10)],
  })

  const conflictLeft = publishFact(knowledgeRoot, {
    identity: 'conflict-left',
    anchors: [CONFLICT_ANCHOR, { t: 'platform', platform: 'web' }],
    createdAtOrdinal: 50,
  })
  const conflictRight = publishFact(knowledgeRoot, {
    identity: 'conflict-right',
    anchors: [CONFLICT_ANCHOR, { t: 'platform', platform: 'web' }],
    createdAtOrdinal: 51,
  })
  const conflictUnknownOutcome = publishBundle(config(knowledgeRoot), {
    draft: makeBundleDraftFixture({
      kind: 'unknown',
      anchors: [CONFLICT_ANCHOR, { t: 'platform', platform: 'web' }],
      scope: { tier: 'product', key: PRODUCT },
      summary: 'Acceptance conflict remains unresolved',
      body: 'Both conflicting acceptance observations remain visible.',
    }),
    discriminant: {
      kind: 'unknown',
      conflictRecordIds: [conflictLeft.id, conflictRight.id],
    },
    originClass: 'agent-verified',
    createdAtOrdinal: 52,
    screenStates: [makeScreenStateFixture()],
    initialEvents: [],
    relations: [],
    provenance: {
      mode: 'run-linked',
      runId: 'retrieval-acceptance-run',
      testId: 'retrieval-acceptance-conflict-unknown',
      stepIndex: 52,
    },
    artifacts: [],
  })
  if (conflictUnknownOutcome.kind !== 'published') {
    throw new Error(`expected conflict unknown publication, got ${conflictUnknownOutcome.kind}`)
  }
  const conflictUnknown = conflictUnknownOutcome
  for (const peer of [conflictLeft, conflictRight]) {
    const appended = appendRelation(config(knowledgeRoot), peer.id, {
      type: 'conflicts-with',
      targetId: conflictUnknown.id,
      addedAtOrdinal: 53,
      curationJobId: `${peer.id}-conflict-job`,
    })
    if (appended.kind !== 'appended') {
      throw new Error(`expected conflict relation append, got ${appended.kind}`)
    }
  }

  const expansionSeed = publishFact(knowledgeRoot, {
    identity: 'expansion-seed',
    anchors: [EXPANSION_ANCHOR, { t: 'platform', platform: 'web' }],
    createdAtOrdinal: 100,
  })
  const expansionNeighbors = Array.from({ length: 40 }, (_, index) => {
    const suffix = String(index).padStart(2, '0')
    return publishFact(knowledgeRoot, {
      identity: `expansion-neighbor-${suffix}`,
      anchors: [{ t: 'page', route: `/acceptance-neighbor-${suffix}` }],
      createdAtOrdinal: 200 + index,
      relations: [relation(expansionSeed.id, `expansion-neighbor-${suffix}`, 300 + index)],
    })
  })
  const poisonedGlobal = publishFact(knowledgeRoot, {
    identity: 'poisoned-global',
    anchors: [POISON_ANCHOR, { t: 'platform', platform: 'web' }],
    scope: { tier: 'global', key: 'global' },
    createdAtOrdinal: 500,
    initialEvents: [confirmation('poisoned-global-a', 501), confirmation('poisoned-global-b', 502)],
    relations: [relation(expansionSeed.id, 'poisoned-global', 503)],
  })

  const mobileBridge = publishObservationFixture(
    config(knowledgeRoot),
    factInput({
      identity: 'mechanical-mobile-bridge',
      anchors: [
        { t: 'el', role: 'button', name: 'Acceptance mobile submit' },
        { t: 'page', route: 'AcceptanceActivity' },
        { t: 'platform', platform: 'android' },
      ],
      createdAtOrdinal: 600,
    }),
    [observation('mobile', 'mobile:acceptance submit', 601)],
  )
  const webBridge = publishObservationFixture(
    config(knowledgeRoot),
    factInput({
      identity: 'mechanical-web-bridge',
      anchors: [
        { t: 'el', role: 'button', name: 'Acceptance web submit' },
        { t: 'page', route: '/acceptance-web' },
        { t: 'platform', platform: 'web' },
      ],
      createdAtOrdinal: 602,
      relations: [{
        type: 'equivalent-to',
        targetId: mobileBridge.id,
        addedAtOrdinal: 603,
        curationJobId: 'acceptance-curated-bridge-job',
      }],
    }),
    [observation('web', 'web:acceptance submit', 604)],
  )

  return {
    activeOld: activeOld.id,
    activeNew: activeNew.id,
    user: user.id,
    superseded: superseded.id,
    sibling: sibling.id,
    fallbackOld: fallbackOld.id,
    fallbackNew: fallbackNew.id,
    conflictLeft: conflictLeft.id,
    conflictRight: conflictRight.id,
    conflictUnknown: conflictUnknown.id,
    expansionSeed: expansionSeed.id,
    expansionNeighbors: expansionNeighbors.map(({ id }) => id),
    poisonedGlobal: poisonedGlobal.id,
    curatedBridgeSource: webBridge.id,
    curatedBridgeTarget: mobileBridge.id,
  }
}

function permuteBundleEnumeration(knowledgeRoot: string): () => void {
  const memoryDir = join(knowledgeRoot, 'memory')
  const moves: Array<{ current: string; canonical: string }> = []
  const products = readdirSync(memoryDir, { withFileTypes: true })
    .filter(
      (entry) => entry.isDirectory() && !entry.name.startsWith('.')
        && entry.name !== 'index' && entry.name !== 'queue',
    )
    .map(({ name }) => name)
    .sort()

  for (const product of products) {
    const bundlesDir = join(memoryDir, product, 'bundles')
    const canonicalNames = readdirSync(bundlesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map(({ name }) => name)
      .sort()
    const staged = canonicalNames.map((canonicalName, index) => {
      const canonical = join(bundlesDir, canonicalName)
      const staging = join(bundlesDir, `.acceptance-permutation-${index}`)
      renameSync(canonical, staging)
      return { canonical, staging }
    })

    for (const [index, move] of staged.entries()) {
      const visible = join(
        bundlesDir,
        `permuted-${String(staged.length - index).padStart(3, '0')}`,
      )
      renameSync(move.staging, visible)
      moves.push({ current: visible, canonical: move.canonical })
    }
  }

  return () => {
    for (const move of moves) renameSync(move.current, move.canonical)
  }
}
