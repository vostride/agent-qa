// The entity index projection (Phase 387, D-06).
//
// Three claims, and the third is the load-bearing one: an entity is not a learned fact, and a
// run brief that ever served one would pollute planner context and corrupt trust math. That
// claim is only worth asserting if the assertion CAN fail, so the Pitfall-6 case ships with a
// positive control — the same marker, seeded into the RECORDS index instead, must reach the
// brief. Without the control the negative half would be indistinguishable from a brief path
// that simply cannot render a marker at all.

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  asEvidenceToken,
  asRecordId,
  BundleOutcomeEventSchema,
  formatEntityUri,
  type BundleDraft,
  type EntityDescriptor,
  type RecordId,
  type ScopeKey,
} from '@vostride/agent-qa-schema'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { openAddressingLedger, type AddressingLedger } from '../../addressing/ledger.js'
import {
  publishBundle,
  type BundleStoreConfig,
  type PublishBundleInput,
} from '../../bundle-publish.test-helper.js'
import {
  describeAllEntities,
  resolveEntityRef,
  type EntitySighting,
  type EntitySightingSource,
  type ResolveEntityRefDeps,
} from '../../resolver/resolve.js'
import { indexDbPath, openIndexWriter } from '../../index-open.js'
import { rebuildIndex } from '../../index-rebuild.js'
import type { EmbedderPort } from '../../embedder-port.js'
import { denseLeg, lexicalLeg } from '../../retrieval/legs.js'
import { openKnowledgeReader } from '../../serving/reader.js'
import { scaffoldKnowledgeRoot } from '../../__tests__/fixtures/bundle-fixture.js'
import {
  ENTITY_INDEX_DB_FILE,
  ENTITY_INDEX_SCOPE,
  countEntities,
  embedPendingEntities,
  entityIndexDbPath,
  openEntityIndex,
  readEntityDescriptor,
  readEntityRendering,
  rebuildEntityIndex,
  refreshEntity,
  sweepEntityIndex,
  type EntityIndexHandle,
} from '../entity-index.js'
import { renderEntity, renderEntityForEmbedding } from '../renderings.js'

const PRODUCT = 'entity-index-storefront'
const SCOPE: ScopeKey = { tier: 'product', key: PRODUCT }

function descriptor(input: {
  kind?: EntityDescriptor['kind']
  shortId: string
  machineId: string
  title: string
  statusSource?: string
  successorMachineId?: string
}): EntityDescriptor {
  const kind = input.kind ?? 'TST'
  return {
    kind,
    shortId: input.shortId,
    uri: formatEntityUri(kind, input.shortId),
    machineId: input.machineId,
    title: input.title,
    statusSource: input.statusSource ?? 'active',
    ...(input.successorMachineId === undefined
      ? {}
      : { successorMachineId: input.successorMachineId }),
  }
}

const CHECKOUT = descriptor({
  shortId: 'TST-001',
  machineId: 't_amber_kite_lantern',
  title: 'Buy a hat and pay at the checkout',
})
const LOGIN = descriptor({
  shortId: 'TST-002',
  machineId: 't_bronze_otter_maple',
  title: 'Sign in with a saved password',
})
const CHECKOUT_TARGET = descriptor({
  kind: 'TGT',
  shortId: 'TGT-checkout-web',
  machineId: 'checkout-web',
  title: 'checkout-web',
})

const SEEDED = [CHECKOUT, LOGIN, CHECKOUT_TARGET] as const

/** Deterministic unit vectors: no model runtime, no acquisition ladder, no network. */
function unitVector(dim: number, axis: number): Float32Array {
  const vector = new Float32Array(dim)
  vector[axis % dim] = 1
  return vector
}

function fixedEmbedder(assign: (text: string) => number, dim = 384): EmbedderPort {
  return {
    async embedDocument(rendering: string): Promise<Float32Array> {
      return unitVector(dim, assign(rendering))
    },
    async embedQuery(rendering: string): Promise<Float32Array> {
      return unitVector(dim, assign(rendering))
    },
  }
}

function lexicalBundleIds(handle: EntityIndexHandle, text: string): string[] {
  return lexicalLeg(handle.connection.db, text, ENTITY_INDEX_SCOPE, 10)
    .map(({ bundleId }) => bundleId)
}

describe('the entity index is a rebuildable projection in its own database file', () => {
  let root: string
  let knowledgeRoot: string
  let handle: EntityIndexHandle

  beforeEach(() => {
    root = join(tmpdir(), `entity-index-${randomUUID()}`)
    knowledgeRoot = join(root, 'agent-qa-knowledge')
    scaffoldKnowledgeRoot(knowledgeRoot)
    handle = openEntityIndex({ path: entityIndexDbPath(knowledgeRoot) })
  })

  afterEach(() => {
    handle.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('rebuilds from the ledger-side descriptor set and answers identical lexical queries', () => {
    for (const entity of SEEDED) refreshEntity(handle, entity)
    const incremental = {
      checkout: lexicalBundleIds(handle, 'checkout'),
      hat: lexicalBundleIds(handle, 'hat'),
      password: lexicalBundleIds(handle, 'password'),
      address: lexicalBundleIds(handle, 'TST-002'),
    }
    expect(incremental.checkout).toContain('TGT-checkout-web')
    expect(incremental.hat).toEqual(['TST-001'])
    expect(incremental.password).toEqual(['TST-002'])
    expect(incremental.address).toEqual(['TST-002'])

    // Arbitrary damage: a row deleted, a rendering corrupted, every FTS entry dropped — and a
    // STALE row that the descriptor set does not contain.
    //
    // The stale row is the case that makes this a rebuild rather than a repair, and it is here
    // because without it the assertion was defective: re-projecting each descriptor by upsert
    // heals every OTHER kind of damage on its own, so the "drop everything first" half of
    // `rebuildEntityIndex` could be deleted with the suite still green (probe p1). A projection
    // that can only add and correct is one that accumulates whatever it once believed.
    handle.connection.db.exec("DELETE FROM records WHERE bundle_id = 'TST-001'")
    handle.connection.db
      .prepare('UPDATE records SET summary = ?, embedding_input = ? WHERE bundle_id = ?')
      .run('corrupted rendering', 'corrupted rendering', 'TST-002')
    handle.connection.db.exec('DELETE FROM fts_records')
    refreshEntity(handle, descriptor({
      shortId: 'TST-404',
      machineId: 't_stale_ghost_row',
      title: 'A cancelled zzzstalemarker experiment',
    }))
    expect(lexicalBundleIds(handle, 'hat')).toEqual([])
    expect(lexicalBundleIds(handle, 'zzzstalemarker')).toEqual(['TST-404'])

    rebuildEntityIndex(handle, SEEDED)

    expect({
      checkout: lexicalBundleIds(handle, 'checkout'),
      hat: lexicalBundleIds(handle, 'hat'),
      password: lexicalBundleIds(handle, 'password'),
      address: lexicalBundleIds(handle, 'TST-002'),
    }).toEqual(incremental)
    expect(countEntities(handle)).toBe(SEEDED.length)
    expect(lexicalBundleIds(handle, 'zzzstalemarker')).toEqual([])
  })

  it('refreshes one entity incrementally and re-renders it when its source data changes', () => {
    refreshEntity(handle, CHECKOUT)
    expect(readEntityRendering(handle, 'TST-001')?.content).toBe(CHECKOUT.title)

    const renamed = descriptor({
      shortId: 'TST-001',
      machineId: CHECKOUT.machineId,
      title: 'Buy a scarf and pay at the checkout',
      statusSource: 'quarantined',
    })
    const swept = sweepEntityIndex(handle, [renamed, LOGIN])

    expect(swept).toEqual({ examined: 2, refreshed: 2 })
    expect(readEntityRendering(handle, 'TST-001')?.content).toBe(renamed.title)
    expect(lexicalBundleIds(handle, 'scarf')).toEqual(['TST-001'])
    expect(lexicalBundleIds(handle, 'hat')).toEqual([])
    // A second sweep over unchanged sources writes nothing: the projection is maintained, not
    // rewritten, so the daemon cadence costs a read when nothing moved.
    expect(sweepEntityIndex(handle, [renamed, LOGIN])).toEqual({ examined: 2, refreshed: 0 })
  })

  it('runs the brute dense rung on every host and never materializes a vec0 table', async () => {
    for (const entity of SEEDED) refreshEntity(handle, entity)
    const axis = (text: string): number => (text.includes('hat') ? 1 : text.includes('password') ? 2 : 3)
    const embedded = await embedPendingEntities(handle, fixedEmbedder(axis))
    expect(embedded).toBe(SEEDED.length)

    const candidates = await denseLeg(
      handle.connection,
      ['buy a hat'],
      ENTITY_INDEX_SCOPE,
      5,
      { embedder: fixedEmbedder(() => 1) },
    )

    expect(handle.connection.vec).toBe('brute')
    // The leg RANKS and does not admit — `admitCandidate` is the caller's floor, which is why
    // the orthogonal entities are still present here at cosine 0 and are dropped by the
    // resolver rather than by the scan.
    expect(candidates[0]?.bundleId).toBe('TST-001')
    expect(candidates[0]?.rawScores.cosine).toBeCloseTo(1, 10)
    expect(candidates.slice(1).map(({ rawScores }) => rawScores.cosine)).toEqual([0, 0])
    // The vec0 rung's per-profile bookkeeping stays entirely inside the records index
    // (RESEARCH A3): a virtual table here would be a second, unpinned spelling of it.
    const vecTables = handle.connection.db.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'vec_%'
    `).all().map((row) => String(row.name))
    expect(vecTables).toEqual([])
    // Lexical recall is unaffected by the dense rung's presence.
    expect(lexicalBundleIds(handle, 'hat')).toEqual(['TST-001'])
  })

  it('stores its rows in its own file, beside — and never inside — the knowledge index', () => {
    refreshEntity(handle, CHECKOUT)
    handle.close()

    const entityPath = entityIndexDbPath(knowledgeRoot)
    expect(entityPath.endsWith(ENTITY_INDEX_DB_FILE)).toBe(true)
    expect(entityPath).not.toBe(indexDbPath(knowledgeRoot))
    expect(existsSync(entityPath)).toBe(true)
    // The knowledge index was never brought into existence by an entity write.
    expect(existsSync(indexDbPath(knowledgeRoot))).toBe(false)

    handle = openEntityIndex({ path: entityPath })
    expect(countEntities(handle)).toBe(1)
  })
})

describe('an entity title is never retrievable as a learned fact', () => {
  const ENTITY_MARKER = 'zqxentitymarker'
  const RECORD_MARKER = 'zqxrecordmarker'

  let root: string
  let knowledgeRoot: string

  beforeEach(() => {
    root = join(tmpdir(), `entity-brief-${randomUUID()}`)
    knowledgeRoot = join(root, 'agent-qa-knowledge')
    scaffoldKnowledgeRoot(knowledgeRoot)
    mkdirSync(join(knowledgeRoot, 'policies'), { recursive: true })
    writeFileSync(
      join(knowledgeRoot, 'policies', 'global.md'),
      'GLOBAL POLICY: preserve checkout safety.\n',
      'utf8',
    )
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function storeConfig(): BundleStoreConfig {
    return {
      knowledgeRoot,
      productKey: PRODUCT,
      writerLeaseId: 'entity-index-test',
    }
  }

  function seedFact(key: string, summary: string): RecordId {
    const draft: BundleDraft = {
      kind: 'fact',
      subtype: 'selector',
      anchors: [{ t: 'el', role: 'button', name: `Checkout ${key}`, ordinal: 0 }],
      scope: SCOPE,
      summary,
      body: `Body for ${key}.`,
      distilledEvidenceRef: { id: `entity-${key}`, sha: key.padEnd(64, 'a').slice(0, 64) },
      originStage: 'run-curation',
    }
    const input: PublishBundleInput = {
      draft,
      discriminant: {
        kind: 'fact',
        subtype: 'selector',
        elementRef: { role: 'button', name: `Checkout ${key}` },
      },
      originClass: 'agent-verified',
      createdAtOrdinal: 10,
      screenStates: [],
      initialEvents: [
        BundleOutcomeEventSchema.parse({
          type: 'promoted',
          evidenceToken: asEvidenceToken(`promoted-${key}`),
          curationJobId: `entity-promoted-${key}`,
          buildOrdinal: 10,
        }),
      ],
      relations: [],
      provenance: {
        mode: 'standalone',
        sourceDescription: 'entity index fixture',
      },
      artifacts: [],
      evidenceMarkdown: `Evidence for ${key}.\n`,
    }
    const outcome = publishBundle(storeConfig(), input)
    if (outcome.kind !== 'published') {
      throw new Error(`expected ${key} publication, got ${outcome.kind}`)
    }
    return asRecordId(outcome.id)
  }

  function servedBriefText(): string {
    return JSON.stringify(
      openKnowledgeReader({ knowledgeRoot, product: PRODUCT }).getRunBrief(SCOPE, 4_000),
    )
  }

  it('keeps a seeded entity title out of assembleRunBrief while a records marker reaches it', async () => {
    seedFact('plain', 'Checkout button is stable')
    await rebuildIndex({ knowledgeRoot })

    const handle = openEntityIndex({ path: entityIndexDbPath(knowledgeRoot) })
    try {
      refreshEntity(handle, descriptor({
        shortId: 'TST-900',
        machineId: 't_marker_case',
        title: `The ${ENTITY_MARKER} regression test`,
      }))
      expect(countEntities(handle)).toBe(1)
    } finally {
      handle.close()
    }

    const withEntityOnly = servedBriefText()
    expect(withEntityOnly).toContain('Checkout button is stable')
    expect(withEntityOnly).not.toContain(ENTITY_MARKER)

    // POSITIVE CONTROL. The same shape of marker, seeded as a real record instead, DOES reach
    // the brief — so the assertion above is a gate on where entity rows live, not an artefact
    // of a brief path that could never have shown a marker at all.
    seedFact('marked', `Checkout note ${RECORD_MARKER}`)
    await rebuildIndex({ knowledgeRoot })
    expect(servedBriefText()).toContain(RECORD_MARKER)
  })

  it('leaves the knowledge index file byte-identical across an entity refresh and rebuild', async () => {
    seedFact('plain', 'Checkout button is stable')
    await rebuildIndex({ knowledgeRoot })
    const before = readFileSync(indexDbPath(knowledgeRoot))

    const handle = openEntityIndex({ path: entityIndexDbPath(knowledgeRoot) })
    try {
      refreshEntity(handle, CHECKOUT)
      rebuildEntityIndex(handle, SEEDED)
      await embedPendingEntities(handle, fixedEmbedder(() => 1))
    } finally {
      handle.close()
    }

    expect(readFileSync(indexDbPath(knowledgeRoot)).equals(before)).toBe(true)
  })
})

describe('a sighting maintains the projection, and a rebuild is driven by the ledger', () => {
  let root: string
  let handle: EntityIndexHandle
  let ledger: AddressingLedger

  const TITLES = new Map([
    ['bundle-checkout', 'The checkout regression bundle'],
    ['bundle-login', 'The login smoke bundle'],
  ])

  function memorySource(): EntitySightingSource {
    const sight = (machineId: string): EntitySighting | undefined => {
      const title = TITLES.get(machineId)
      return title === undefined
        ? undefined
        : { machineId, title, statusSource: 'active' }
    }
    return { kind: 'MEM', sight, hydrate: sight }
  }

  function deps(): ResolveEntityRefDeps {
    return { ledger, sources: [memorySource()], entityIndex: handle }
  }

  beforeEach(() => {
    root = join(tmpdir(), `entity-sighting-${randomUUID()}`)
    ledger = openAddressingLedger({ path: join(root, 'entity-addresses.db') })
    handle = openEntityIndex({ path: join(root, 'memory', 'index', ENTITY_INDEX_DB_FILE) })
  })

  afterEach(() => {
    handle.close()
    ledger.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('projects an entity the first time anything sights it', async () => {
    expect(countEntities(handle)).toBe(0)

    const resolution = await resolveEntityRef('bundle-checkout', deps())

    expect(resolution.kind).toBe('resolved')
    expect(countEntities(handle)).toBe(1)
    expect(readEntityDescriptor(handle, 'MEM-001')?.title)
      .toBe('The checkout regression bundle')
    expect(lexicalBundleIds(handle, 'checkout')).toEqual(['MEM-001'])
  })

  it('leaves the projection untouched when nothing was sighted', async () => {
    expect((await resolveEntityRef('nothing-owns-this', deps())).kind).toBe('none')

    expect(countEntities(handle)).toBe(0)
  })

  it('rebuilds the whole projection from the ledger, skipping addresses no source describes', async () => {
    await resolveEntityRef('bundle-checkout', deps())
    await resolveEntityRef('bundle-login', deps())
    // An address whose owning store has forgotten the entity. It keeps resolving through tier
    // (a) forever (D-04) but must not become a fuzzy-match target with no title.
    ledger.mint('MEM', 'bundle-vanished')
    handle.connection.db.exec('DELETE FROM records')

    const projected = rebuildEntityIndex(handle, describeAllEntities(deps()))

    expect(projected).toBe(2)
    expect(ledger.listAddresses()).toHaveLength(3)
    expect(lexicalBundleIds(handle, 'login')).toEqual(['MEM-002'])
    expect(readEntityDescriptor(handle, 'MEM-003')).toBeUndefined()
  })
})

describe('no statement in entity-index/ can reach the knowledge index', () => {
  // The plan's criterion was written as "no statement names the records FTS table". It cannot
  // be that: this projection presents the records SHAPE on purpose, because that is what
  // reusing `lexicalLeg`/`denseLeg` means (see the module header), so the words `records` and
  // `fts_records` appear here by design and naming them proves nothing either way.
  //
  // What the criterion is actually protecting is that entity writes cannot land in the
  // knowledge index. That is a claim about which FILE a statement can reach, so this scan is
  // written against the file: the module may not name the knowledge index's path, its file
  // name, or any of the helpers that open it. A runtime half — the knowledge index staying
  // byte-identical across a refresh and a rebuild — is asserted above; this half catches a
  // future edit that reaches for one of those helpers before anyone runs it.

  const FORBIDDEN = [
    'knowledge.db',
    'INDEX_DB_FILE',
    'indexDbPath',
    'openIndexWriter',
    'openIndexReaderConnection',
    'vecTableName',
    'deleteRecordFromAllSchemaVecTables',
  ] as const

  /**
   * Strip comments so the scan reads STATEMENTS.
   *
   * Deliberately line-oriented, which is sound here because every comment in these two modules
   * is a whole line: a scanner clever enough to handle a trailing comment would also have to
   * handle a `//` inside a string literal, and getting that subtly wrong is how a source scan
   * silently stops scanning.
   */
  function statementsOf(fileName: string): string {
    const source = readFileSync(new URL(`../${fileName}`, import.meta.url), 'utf8')
    return source
      .split('\n')
      .filter((line) => {
        const trimmed = line.trimStart()
        return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*')
      })
      .join('\n')
  }

  function offenders(text: string): string[] {
    // Whole-identifier matching, or the projection's own `ENTITY_INDEX_DB_FILE` would be
    // reported as a reach into the records index's `INDEX_DB_FILE` — a scan that flags the
    // module for naming its own constant is a scan somebody deletes.
    return FORBIDDEN.filter((name) => new RegExp(
      `(?<![A-Za-z0-9_])${name.replaceAll('.', '\\.')}(?![A-Za-z0-9_])`,
    ).test(text))
  }

  it('names no knowledge-index path, file or opener in any statement', () => {
    expect(offenders(statementsOf('entity-index.ts'))).toEqual([])
    expect(offenders(statementsOf('renderings.ts'))).toEqual([])
  })

  it('reads the real module, and would flag a planted reach into the knowledge index', () => {
    const statements = statementsOf('entity-index.ts')

    // Positive control: the scan catches a planted statement.
    expect(offenders(`${statements}\nconst leak = openIndexWriter(knowledgeRoot)\n`))
      .toEqual(['openIndexWriter'])
    // A marker only the real source carries, so the scan reads this module.
    expect(statements).toContain('ENTITY_INDEX_USER_VERSION')
  })
})

describe('§5.3 entity renderings carry meaning, and identity stays lexical', () => {
  it('embeds the kind word, the title and slug words — never an opaque machine id', () => {
    const embedded = renderEntityForEmbedding(CHECKOUT)

    expect(embedded).toContain('test')
    expect(embedded).toContain('Buy a hat and pay at the checkout')
    expect(embedded).not.toContain(CHECKOUT.machineId)
    expect(embedded).not.toContain(CHECKOUT.shortId)
    expect(embedded).not.toContain('agentqa://')
  })

  it('splits a slug-addressed machine id into words, because that machine id IS the name', () => {
    expect(renderEntityForEmbedding(CHECKOUT_TARGET)).toBe('target checkout-web checkout web')
  })

  it('keeps every exact handle in the identity column and out of the embedded text', () => {
    const rendering = renderEntity(CHECKOUT)

    expect(rendering.identity.split(/\s+/)).toEqual([
      'TST-001',
      'agentqa://test/TST-001',
      't_amber_kite_lantern',
    ])
    expect(rendering.content).toBe(CHECKOUT.title)
    expect(rendering.context).toBe('test')
    expect(rendering.embedding).toBe(renderEntityForEmbedding(CHECKOUT))
  })
})
