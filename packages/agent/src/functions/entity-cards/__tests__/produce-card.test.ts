// The ONE card producer, over all five kinds.
//
// The gates here are shaped against the failure this phase keeps finding — a check whose LOGIC
// is sound but whose INPUT DOMAIN never contains a case it could reject. Three of them are
// written specifically to have such a case:
//
//   - determinism is measured against SHUFFLED store input, not against two calls with the
//     same array. Two renders of one array are trivially equal for any pure map, so that
//     comparison cannot reject a projection that preserves arrival order;
//   - `url`'s absence is asserted as key PRESENCE (`'url' in card`), because `card.url ===
//     undefined` is satisfied by a card that carries the key with an undefined value, and by
//     a card that carries it as an empty string once `z.url()` stops being consulted;
//   - the two-render equality varies something between the renders that must NOT reach the
//     card, so it can reject a producer that started reading it.

import {
  FORGET_RECEIPT_SCHEMA_VERSION,
  ENTITY_CARD_MAX_KEY_FACTS,
  ENTITY_KINDS,
  ENTITY_STATUSES,
  ENTITY_URI_SEGMENTS,
  ENTITY_URL_ROUTE,
  MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
  isEntityUri,
} from '@vostride/agent-qa-schema'
import type {
  BundleProvenance,
  EntityDescriptor,
  EntityKind,
  ForgetReceiptV1,
  MaskedResolvedConfig,
  QuarantineEntryState,
} from '@vostride/agent-qa-schema'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import {
  DASHBOARD_BASE_URL_CONFIG_KEY,
  DASHBOARD_WORKSPACE_CONFIG_KEY,
  readDashboardUrlBase,
} from '../card-context.js'
import {
  ENTITY_IDENTITY_FACT_LABELS,
  ENTITY_RENAMED_TO_FACT_LABEL,
  FORGET_RECEIPT_FACT_LABELS,
  QUARANTINE_FACT_LABELS,
  forgetReceiptKeyFacts,
} from '../key-facts.js'
import { ForgetReceiptKindError, produceEntityCard } from '../produce-card.js'

// ---- fixtures ---------------------------------------------------------------------------

/** A short-ID in each kind's own address FORM: four ordinal, `TGT` slug. */
const SHORT_IDS = {
  TST: 'TST-001',
  RUN: 'RUN-002',
  MEM: 'MEM-004',
  POL: 'POL-005',
  TGT: 'TGT-checkout',
} as const satisfies Record<EntityKind, string>

const MACHINE_IDS = {
  TST: 'tests/checkout.spec.ts::adds to cart',
  RUN: 'run-2026-08-02-a',
  MEM: 'shop.cart.fact.0001',
  POL: 'policy.retry.flaky',
  TGT: 'checkout',
} as const satisfies Record<EntityKind, string>

function descriptorFor(
  kind: EntityKind,
  overrides: Partial<EntityDescriptor> = {},
): EntityDescriptor {
  return {
    kind,
    shortId: SHORT_IDS[kind],
    uri: `agentqa://${ENTITY_URI_SEGMENTS[kind]}/${SHORT_IDS[kind]}`,
    machineId: MACHINE_IDS[kind],
    title: `The ${kind} entity`,
    // The first member of each kind's own closed vocabulary, so a per-kind fixture cannot
    // accidentally assert a status the kind does not declare.
    statusSource: ENTITY_STATUSES[kind][0],
    ...overrides,
  } as EntityDescriptor
}

function maskedConfig(entries: MaskedResolvedConfig['entries']): MaskedResolvedConfig {
  return {
    schemaVersion: MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
    configPath: 'agent-qa.config.yaml',
    entries,
  }
}

function visibleEntry(key: string, value: string): MaskedResolvedConfig['entries'][number] {
  return { key, value, source: 'config-file', masked: false }
}

/** A minimal, schema-valid provenance — the arm that needs no run behind it. */
const PROVENANCE: BundleProvenance = {
  schemaVersion: 1,
  mode: 'standalone',
  originClass: 'user',
  sourceDescription: 'authored by hand for this fixture',
}

function receipt(overrides: Partial<ForgetReceiptV1> = {}): ForgetReceiptV1 {
  return {
    schemaVersion: FORGET_RECEIPT_SCHEMA_VERSION,
    proposalId: 'prop-0001',
    tombstonedRecords: [
      { recordId: 'rec-b', provenance: PROVENANCE },
      { recordId: 'rec-a', provenance: PROVENANCE },
    ],
    projectionsScrubbed: ['fts', 'vec'],
    resultingBundleStatus: 'forgotten',
    forgottenAt: 1_754_000_000_000,
    ...overrides,
  } as ForgetReceiptV1
}

// ---- Test 1: per-kind facts, closed statuses, deterministic order -------------------------

describe('every kind renders through the one producer', () => {
  it('renders each kind with a status its own closed vocabulary declares', () => {
    for (const kind of ENTITY_KINDS) {
      for (const status of ENTITY_STATUSES[kind]) {
        const card = produceEntityCard(descriptorFor(kind, { statusSource: status }))
        expect(card.kind, kind).toBe(kind)
        expect(card.status, `${kind}/${status}`).toBe(status)
        expect(card.id, kind).toBe(SHORT_IDS[kind])
        expect(card.uri, kind).toBe(`agentqa://${ENTITY_URI_SEGMENTS[kind]}/${SHORT_IDS[kind]}`)
      }
    }
  })

  it('REFUSES a status the kind does not declare, rather than repairing it', () => {
    // The render-never-recompute boundary. `passed` is a real status — of a RUN.
    expect(() => produceEntityCard(descriptorFor('MEM', { statusSource: 'passed' })))
      .toThrow()
  })

  it("labels the identity fact with the kind's own noun", () => {
    for (const kind of ENTITY_KINDS) {
      const card = produceEntityCard(descriptorFor(kind))
      expect(card.keyFacts[0], kind).toEqual({
        label: ENTITY_IDENTITY_FACT_LABELS[kind],
        value: MACHINE_IDS[kind],
      })
    }
    // The labels are five DISTINCT nouns — a table that answered `machine id` five times would
    // satisfy every per-kind assertion above and tell a reader nothing.
    expect(new Set(Object.values(ENTITY_IDENTITY_FACT_LABELS)).size).toBe(ENTITY_KINDS.length)
  })

  it('emits only agentqa:// refs on the facts that carry one', () => {
    const cards = ENTITY_KINDS.map((kind) => produceEntityCard(descriptorFor(kind)))
    cards.push(produceEntityCard(
      descriptorFor('TGT', { successorMachineId: 'checkout-v2' }),
    ))
    const refs = cards.flatMap((card) => card.keyFacts.flatMap(
      (fact) => (fact.ref === undefined ? [] : [fact.ref]),
    ))
    expect(refs.length).toBeGreaterThan(0)
    for (const ref of refs) expect(isEntityUri(ref), ref).toBe(true)
  })

  it('keeps keyFacts order a function of receipt CONTENT, not of arrival order', () => {
    // The input-domain case: two renders of the same array are equal for any pure map, so the
    // only mutation that can be rejected here is one that preserves arrival order. The two
    // receipts below carry the same records in opposite orders.
    const forward = receipt({
      tombstonedRecords: [
        { recordId: 'rec-a', provenance: PROVENANCE },
        { recordId: 'rec-b', provenance: PROVENANCE },
        { recordId: 'rec-c', provenance: PROVENANCE },
      ],
      projectionsScrubbed: ['fts', 'vec', 'graph'],
    })
    const shuffled = receipt({
      tombstonedRecords: [...forward.tombstonedRecords].reverse(),
      projectionsScrubbed: [...forward.projectionsScrubbed].reverse(),
    })

    const descriptor = descriptorFor('MEM')
    expect(produceEntityCard(descriptor, { forgetReceipt: shuffled }))
      .toEqual(produceEntityCard(descriptor, { forgetReceipt: forward }))
    expect(forgetReceiptKeyFacts(forward).find(
      (fact) => fact.label === FORGET_RECEIPT_FACT_LABELS.recordIds,
    )?.value).toBe('rec-a, rec-b, rec-c')
  })

  it('is bounded BY CONSTRUCTION across the whole projection table', () => {
    // A mutation probe measured the first version of this case vacuous: it asserted the bound
    // against a 400-record receipt, and the projection emits five facts for any receipt, so a
    // removed truncation left it green. The bound is not carried by a truncation — it is
    // carried by the receipt rendering as ONE fact per QUANTITY rather than one per record,
    // and that is what the corpus below has to be able to reject. Every kind, every declared
    // status, with and without a receipt of 400 records.
    const many = receipt({
      tombstonedRecords: Array.from({ length: 400 }, (_unused, index) => ({
        recordId: `rec-${String(index).padStart(4, '0')}`,
        provenance: PROVENANCE,
      })),
    }) as ForgetReceiptV1

    for (const kind of ENTITY_KINDS) {
      for (const status of ENTITY_STATUSES[kind]) {
        const descriptor = descriptorFor(kind, {
          statusSource: status,
          ...(kind === 'TGT' ? { successorMachineId: 'checkout-v2' } : {}),
        })
        const card = produceEntityCard(descriptor)
        expect(card.keyFacts.length, `${kind}/${status}`)
          .toBeLessThanOrEqual(ENTITY_CARD_MAX_KEY_FACTS)
      }
    }
    const forgotten = produceEntityCard(descriptorFor('MEM'), { forgetReceipt: many })
    expect(forgotten.keyFacts.length).toBeLessThanOrEqual(ENTITY_CARD_MAX_KEY_FACTS)

    // …and the enumeration inside the fact that carries it is COMPLETE (D-19: nothing
    // silently partial). A truncation would have satisfied the bound and failed this.
    const ids = forgotten.keyFacts.find(
      (fact) => fact.label === FORGET_RECEIPT_FACT_LABELS.recordIds,
    )
    expect(ids?.value.split(', ')).toHaveLength(400)
  })

  it('shows a rename ONLY on the slug-addressed kind, decided by the table', () => {
    // The table is the one mechanism. Every kind is fed a descriptor carrying a successor —
    // the ordinal-addressed kinds cannot legally have one, which is exactly why a projection
    // that read the field for them would be building an unrepresentable address.
    for (const kind of ENTITY_KINDS) {
      const card = produceEntityCard(
        descriptorFor(kind, {
          ...(kind === 'TGT' ? { statusSource: 'renamed' } : {}),
          successorMachineId: 'checkout-v2',
        }),
      )
      const labels = card.keyFacts.map((fact) => fact.label)
      expect(labels.includes(ENTITY_RENAMED_TO_FACT_LABEL), kind).toBe(kind === 'TGT')
    }
  })
})

// ---- Test 2: D-04 honest status --------------------------------------------------------

describe('a minted address renders an honest card', () => {
  it('carries a tombstoned bundle forward as tombstoned, with its provenance', () => {
    const card = produceEntityCard(descriptorFor('MEM', { statusSource: 'tombstoned' }))
    expect(card.status).toBe('tombstoned')
    expect(card.keyFacts).toEqual([
      { label: ENTITY_IDENTITY_FACT_LABELS.MEM, value: MACHINE_IDS.MEM },
    ])
  })

  it("lets a forget receipt OVERRIDE a store status that has not caught up", () => {
    // The descriptor still says `active` because some projection is behind; the receipt is
    // what the permanent address resolves to afterwards, and it wins.
    const card = produceEntityCard(
      descriptorFor('MEM', { statusSource: 'active' }),
      { forgetReceipt: receipt() },
    )
    expect(card.status).toBe('forgotten')
    expect(card.keyFacts.map((fact) => fact.label)).toEqual([
      ENTITY_IDENTITY_FACT_LABELS.MEM,
      FORGET_RECEIPT_FACT_LABELS.records,
      FORGET_RECEIPT_FACT_LABELS.recordIds,
      FORGET_RECEIPT_FACT_LABELS.projections,
      FORGET_RECEIPT_FACT_LABELS.forgottenAt,
    ])
    expect(card.keyFacts.map((fact) => fact.value)).toContain('2')
    expect(card.keyFacts.map((fact) => fact.value)).toContain('rec-a, rec-b')
  })

  it('REFUSES a receipt attached to anything but a knowledge bundle', () => {
    expect(() => produceEntityCard(descriptorFor('RUN'), { forgetReceipt: receipt() }))
      .toThrow(ForgetReceiptKindError)
  })

  it('shows a renamed target its successor, as a resolvable link', () => {
    const card = produceEntityCard(
      descriptorFor('TGT', { statusSource: 'renamed', successorMachineId: 'checkout-v2' }),
    )
    expect(card.status).toBe('renamed')
    expect(card.keyFacts[1]).toEqual({
      label: ENTITY_RENAMED_TO_FACT_LABEL,
      value: 'checkout-v2',
      ref: 'agentqa://target/TGT-checkout-v2',
    })
  })

  it('never builds a rename link for an ordinal-addressed kind', () => {
    // `MEM-checkout-v2` is not a wrong link, it is an unrepresentable address. The
    // resolver only sets the field for TGT; this guards the producer's own input domain.
    const card = produceEntityCard(
      descriptorFor('MEM', { successorMachineId: 'checkout-v2' }),
    )
    expect(card.keyFacts.map((fact) => fact.label))
      .not.toContain(ENTITY_RENAMED_TO_FACT_LABEL)
  })
})

// ---- Test 3: D-10 url --------------------------------------------------------------------

describe('url is config-derived and absent by default', () => {
  it('omits the KEY on every kind when no dashboard base is configured', () => {
    for (const kind of ENTITY_KINDS) {
      const card = produceEntityCard(descriptorFor(kind))
      // Key presence, not value: `card.url === undefined` is also true of a card that
      // carries the key, which is the state a spread of an undefined optional produces.
      expect('url' in card, kind).toBe(false)
    }
  })

  it('renders the pinned route when base AND workspace are both configured', () => {
    const base = readDashboardUrlBase(maskedConfig([
      visibleEntry(DASHBOARD_BASE_URL_CONFIG_KEY, 'https://qa.example.com'),
      visibleEntry(DASHBOARD_WORKSPACE_CONFIG_KEY, 'acme'),
    ]))
    expect(base).toEqual({ baseUrl: 'https://qa.example.com', workspace: 'acme' })

    const card = produceEntityCard(descriptorFor('MEM', { title: 'Cart totals VAT' }), {
      ...(base === undefined ? {} : { urlBase: base }),
    })
    expect(card.url).toBe('https://qa.example.com/t/acme/memory/MEM-004/cart-totals-vat')
    // The rendering follows the PINNED template rather than a private string: every segment
    // name in the constant appears, filled, in the same order.
    expect(ENTITY_URL_ROUTE).toBe('/t/:workspace/:kind/:shortId/:slug')
  })

  it('uses the kind URI-SEGMENT word, not the prefix, in the route', () => {
    const urlBase = { baseUrl: 'https://qa.example.com', workspace: 'acme' }
    for (const kind of ENTITY_KINDS) {
      const card = produceEntityCard(descriptorFor(kind), { urlBase })
      expect(card.url, kind).toContain(`/${ENTITY_URI_SEGMENTS[kind]}/`)
      expect(card.url, kind).not.toContain(`/${kind}/`)
    }
  })

  it('treats a base the masker ALTERED as no base at all', () => {
    // `services.dashboard.baseUrl` is a registered address leaf, so a base carrying a path is
    // reduced to its origin and flagged. Rendering against the reduction would drop the path
    // prefix from every card link — a dead link shown with confidence, which is what D-10
    // forbids. The flag is read; the value's characters are never inspected.
    const base = readDashboardUrlBase(maskedConfig([
      {
        key: DASHBOARD_BASE_URL_CONFIG_KEY,
        value: 'https://qa.example.com',
        source: 'config-file',
        masked: true,
      },
      visibleEntry(DASHBOARD_WORKSPACE_CONFIG_KEY, 'acme'),
    ]))
    expect(base).toBeUndefined()
    expect('url' in produceEntityCard(descriptorFor('MEM'), {})).toBe(false)
  })

  it('requires BOTH halves — neither alone can be completed by a guess', () => {
    expect(readDashboardUrlBase(maskedConfig([
      visibleEntry(DASHBOARD_BASE_URL_CONFIG_KEY, 'https://qa.example.com'),
    ]))).toBeUndefined()
    expect(readDashboardUrlBase(maskedConfig([
      visibleEntry(DASHBOARD_WORKSPACE_CONFIG_KEY, 'acme'),
    ]))).toBeUndefined()
    expect(readDashboardUrlBase(maskedConfig([]))).toBeUndefined()
  })

  it('omits the url rather than emitting a broken one for an unusable base', () => {
    for (const baseUrl of ['not-a-url', 'mailto:qa@example.com', '/relative']) {
      const card = produceEntityCard(descriptorFor('MEM'), {
        urlBase: { baseUrl, workspace: 'acme' },
      })
      expect('url' in card, baseUrl).toBe(false)
    }
  })
})

// ---- Test 4: idempotence, the empty edge, and D-12's no-model law -------------------------

describe('rendering is pure (idempotency and empty edges)', () => {
  it('is deeply equal across renders that vary something the card must not read', () => {
    // The input domain again: two renders of ONE input are equal for any pure function, so
    // the case that can reject a producer here is one where something DID change — a context
    // whose only differing member is a receipt-free field the card has no business reading.
    const descriptor = descriptorFor('MEM')
    const first = produceEntityCard(descriptor, {})
    const second = produceEntityCard({ ...descriptor }, { urlBase: undefined })
    expect(second).toEqual(first)
    expect(second).not.toBe(first)
  })

  it('renders a sparse entity as schema-valid empty-ish arrays', () => {
    const card = produceEntityCard(descriptorFor('MEM', { title: '' }))
    expect(card.title).toBe('')
    expect(Array.isArray(card.keyFacts)).toBe(true)
    expect(Array.isArray(card.actions)).toBe(true)
  })

  it('has no model, LLM or provider import anywhere in the fact projections', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../key-facts.ts', import.meta.url)),
      'utf8',
    )
    expect(forbiddenModelImports(source)).toEqual([])

    // POSITIVE CONTROL: the scan is required to CATCH a planted model import. Without this
    // the assertion above is satisfied by a scanner that matches nothing at all.
    const planted = `import { chat } from '@vostride/agent-qa-model'\n${source}`
    expect(forbiddenModelImports(planted)).toEqual(['@vostride/agent-qa-model'])

    // INVERSE CONTROL: the module header names every one of those words in prose, and prose
    // must not be flagged — the `validate:arch` extractor's own known failure mode.
    expect(forbiddenModelImports('// this file must never import a model or an llm provider\n'))
      .toEqual([])
  })
})

// ---- Test N: the TST quarantine flip (390 D-11/D-12, the 387 D-12 status member) ----------
//
// The `'quarantined'` member has been in `ENTITY_STATUSES.TST` since 387; this is the wiring
// that serves it. Every leg below varies exactly ONE thing against the same fixture, because
// "renders active" is the answer to four genuinely different situations — no entry, a lapsed
// entry, a closed entry, and a store that never reported the durable identity — and a suite
// that pinned only "absent → active" could not tell them apart.

describe('the TST card serves quarantine state from the ledger', () => {
  const TEST_IDENTITY = {
    product: 'shop',
    filePath: 'tests/checkout.spec.ts',
    testName: 'adds to cart',
  }

  function entry(overrides: Partial<QuarantineEntryState> = {}): QuarantineEntryState {
    return {
      ...TEST_IDENTITY,
      fingerprint: '{"name":"submit","ordinal":0,"role":"button","t":"el"}::flake',
      verdictClass: 'flake',
      owner: 'unassigned',
      enteredAt: '2026-08-05T10:00:00.000Z',
      expiresAt: '2026-09-04T10:00:00.000Z',
      enteredCount: 1,
      firstEnteredAt: '2026-08-05T10:00:00.000Z',
      state: 'quarantined',
      ...overrides,
    }
  }

  function tstDescriptor(overrides: Partial<EntityDescriptor> = {}): EntityDescriptor {
    return descriptorFor('TST', { testIdentity: TEST_IDENTITY, ...overrides })
  }

  it('serves status quarantined with the owner, expiry and occurrence facts', () => {
    const card = produceEntityCard(tstDescriptor(), { quarantine: [entry()] })

    expect(card.status).toBe('quarantined')
    expect(card.keyFacts.slice(1)).toEqual([
      { label: QUARANTINE_FACT_LABELS.owner, value: 'unassigned' },
      { label: QUARANTINE_FACT_LABELS.expires, value: '2026-09-04T10:00:00.000Z' },
      {
        label: QUARANTINE_FACT_LABELS.occurrence,
        value: 'flake failures recurring; quarantined since 2026-08-05T10:00:00.000Z',
      },
    ])
  })

  // The FIRST-WINDOW arm above and the LATER-LAP arm below are ONE PAIR, and neither is
  // sufficient alone. A render that always states the lap count satisfies the leg below while
  // regressing every first-window card into announcing "1 window since <the instant the next
  // clause already named>"; a render that never states it satisfies the leg above while leaving
  // the card answering a different question than the queue sorted on. Both assert the WHOLE
  // fact list BY VALUE rather than by substring — the defect closed here is a sentence whose
  // two clauses disagreed, and a containment match cannot see a disagreement.
  it('states the re-entry HISTORY on a later lap — the instant the triage queue ordered on', () => {
    const laps = entry({
      enteredCount: 4,
      // Deliberately DISTINCT instants. `firstEnteredAt` defaults to `enteredAt` in the builder
      // because that is what a first entry folds to; a later-lap fixture that left them equal
      // could not tell the two renders apart, which is the whole defect.
      enteredAt: '2026-08-05T10:00:00.000Z',
      firstEnteredAt: '2026-06-01T09:00:00.000Z',
    })
    const card = produceEntityCard(tstDescriptor(), { quarantine: [laps] })

    expect(card.status).toBe('quarantined')
    expect(card.keyFacts.slice(1)).toEqual([
      { label: QUARANTINE_FACT_LABELS.owner, value: 'unassigned' },
      { label: QUARANTINE_FACT_LABELS.expires, value: '2026-09-04T10:00:00.000Z' },
      {
        label: QUARANTINE_FACT_LABELS.occurrence,
        value:
          'flake failures recurring; 4 quarantine windows since 2026-06-01T09:00:00.000Z; ' +
          'current window since 2026-08-05T10:00:00.000Z',
      },
    ])

    // ONE occurrence fact in both arms. The history rides in the sentence, not in a second
    // fact, so a test being quarantined more often cannot move a card's fact count — and
    // `ENTITY_CARD_MAX_KEY_FACTS`, which this file reasons about carefully elsewhere, is
    // untouched by this render.
    const firstWindow = produceEntityCard(tstDescriptor(), { quarantine: [entry()] })
    expect(card.keyFacts).toHaveLength(firstWindow.keyFacts.length)
    expect(card.keyFacts.length).toBeLessThanOrEqual(ENTITY_CARD_MAX_KEY_FACTS)
  })

  it('serves EXPIRED as active — suppression stopped, so the card must not claim it', () => {
    const card = produceEntityCard(tstDescriptor(), { quarantine: [entry({ state: 'expired' })] })

    expect(card.status).toBe('active')
    expect(card.keyFacts).toHaveLength(1)
  })

  it('serves a RELEASED entry as active — a closed window is history, not a state', () => {
    const card = produceEntityCard(tstDescriptor(), { quarantine: [entry({ state: 'released' })] })

    expect(card.status).toBe('active')
  })

  it('serves active when the ledger holds an entry for a DIFFERENT test', () => {
    const card = produceEntityCard(tstDescriptor(), {
      quarantine: [entry({ testName: 'checks out as a guest' })],
    })

    expect(card.status).toBe('active')
  })

  it('serves active when the store reported no durable identity to join on', () => {
    // The join is on `(product, filePath, testName)` — never on the machine id, which is the
    // per-run explicit test id and not a durable identity. A descriptor with no reported
    // identity is a store that cannot answer the question, and inventing a match from the
    // title is exactly the plausible-but-wrong attribution D-12 refuses.
    const card = produceEntityCard(descriptorFor('TST'), { quarantine: [entry()] })

    expect(card.status).toBe('active')
    expect(card.keyFacts).toHaveLength(1)
  })

  it('serves active with NO context at all — a host with no ledger renders the same card', () => {
    expect(produceEntityCard(tstDescriptor()).status).toBe('active')
    expect(produceEntityCard(tstDescriptor(), {}).status).toBe('active')
  })

  it('is TST-only: a same-identity entry never touches another kind\'s card', () => {
    for (const kind of ENTITY_KINDS) {
      if (kind === 'TST') continue
      const card = produceEntityCard(
        descriptorFor(kind, { testIdentity: TEST_IDENTITY }),
        { quarantine: [entry()] },
      )
      expect(card.status, kind).toBe(ENTITY_STATUSES[kind][0])
      expect(card.keyFacts.length, kind).toBeLessThanOrEqual(1)
    }
  })
})

/**
 * Import specifiers a deterministic projection may never name.
 *
 * Reads IMPORT STATEMENTS rather than scanning for words, because the words appear in this
 * module's own header by design and a substring scan would flag the documentation that
 * explains why the rule exists.
 */
function forbiddenModelImports(source: string): string[] {
  const forbidden = /model|llm|openai|anthropic|provider|inference/iu
  return source
    .split('\n')
    .flatMap((line) => {
      const match = /^\s*(?:import|export)\b[^'"]*from\s*['"]([^'"]+)['"]/u.exec(line)
      const specifier = match?.[1]
      return specifier !== undefined && forbidden.test(specifier) ? [specifier] : []
    })
}
