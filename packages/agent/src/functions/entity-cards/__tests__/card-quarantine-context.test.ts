// The ledger is read only for TST descriptors, and a refusal there propagates instead of `active`.

import { MASKED_RESOLVED_CONFIG_SCHEMA_VERSION } from '@vostride/agent-qa-schema'
import type {
  EntityDescriptor,
  MaskedResolvedConfig,
  QuarantineEntryState,
} from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'

import { entitiesGetSpec } from '../../ops/entities-get.js'
import type { FunctionDeps } from '../../spec.js'
import { readEntityCardContext } from '../card-context.js'

const TEST_IDENTITY = {
  product: 'shop',
  filePath: 'tests/checkout.spec.ts',
  testName: 'adds to cart',
}

const MASKED: MaskedResolvedConfig = {
  schemaVersion: MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
  configPath: 'agent-qa.config.yaml',
  entries: [],
}

const QUARANTINED: QuarantineEntryState = {
  ...TEST_IDENTITY,
  fingerprint: 'fp-card',
  verdictClass: 'flake',
  owner: 'unassigned',
  enteredAt: '2026-08-05T10:00:00.000Z',
  expiresAt: '2026-09-04T10:00:00.000Z',
  enteredCount: 1,
  firstEnteredAt: '2026-08-05T10:00:00.000Z',
  state: 'quarantined',
}

function descriptor(overrides: Partial<EntityDescriptor> = {}): EntityDescriptor {
  return {
    kind: 'TST',
    shortId: 'TST-001',
    uri: 'agentqa://test/TST-001',
    machineId: 't_checkout',
    title: 'adds to cart',
    statusSource: 'active',
    testIdentity: TEST_IDENTITY,
    ...overrides,
  } as EntityDescriptor
}

function deps(overrides: Partial<FunctionDeps> = {}): FunctionDeps {
  return {
    runs: {
      list: () => Promise.resolve([]),
      get: () => Promise.resolve(undefined),
      readEvents: () => Promise.resolve([]),
      readStepEvidence: () => Promise.resolve({ kind: 'run-not-recorded' } as const),
    },
    knowledge: {
      listBundles: () => Promise.resolve([]),
      inspectRecords: () => Promise.resolve([]),
      diffSince: () => Promise.resolve([]),
      showRecord: ({ recordId }) =>
        Promise.resolve({ kind: 'not-found', schemaVersion: 2, recordId } as const),
    },
    entities: {
      resolve: () => Promise.resolve({ kind: 'none' as const, reason: 'no-match' as const }),
      get: () => Promise.resolve(undefined),
    },
    config: { getMasked: () => Promise.resolve(MASKED) },
    ...overrides,
  }
}

function quarantinePort(list: () => Promise<readonly QuarantineEntryState[]>) {
  return {
    list,
    release: () => Promise.resolve({ kind: 'no-entry' } as const),
    add: () => Promise.reject(new Error('not used by this fixture')),
  }
}

describe('the card render context reads quarantine at the op boundary', () => {
  it('omits the member entirely when no quarantine port is bound — no throw, no guess', async () => {
    const context = await readEntityCardContext(deps(), [descriptor()])

    expect('quarantine' in context).toBe(false)
  })

  it('reads the ledger when a TST descriptor is about to be rendered', async () => {
    let reads = 0
    const context = await readEntityCardContext(
      deps({
        quarantine: quarantinePort(() => {
          reads += 1
          return Promise.resolve([QUARANTINED])
        }),
      }),
      [descriptor()],
    )

    expect(reads).toBe(1)
    expect(context.quarantine).toEqual([QUARANTINED])
  })

  it('does NOT consult the port for a render with no test in it', async () => {
    // The scoping property, pinned with a port that THROWS: a MEM card must not depend on the
    // quarantine ledger being readable, and a reader that consulted it unconditionally would
    // fail this case rather than merely doing extra work.
    const context = await readEntityCardContext(
      deps({
        quarantine: quarantinePort(() => Promise.reject(new Error('ledger unreadable'))),
      }),
      [descriptor({ kind: 'MEM', shortId: 'MEM-004', uri: 'agentqa://memory/MEM-004' })],
    )

    expect('quarantine' in context).toBe(false)
  })

  it('propagates an unreadable ledger for a TST render rather than answering active', async () => {
    await expect(readEntityCardContext(
      deps({
        quarantine: quarantinePort(() => Promise.reject(new Error('ledger unreadable'))),
      }),
      [descriptor()],
    )).rejects.toThrow('ledger unreadable')
  })

  it('entities.get serves the quarantined status end to end through the one producer', async () => {
    const card = await entitiesGetSpec.invoke(
      { ref: 'TST-001' },
      deps({
        entities: {
          resolve: () => Promise.resolve({ kind: 'none' as const, reason: 'no-match' as const }),
          get: () => Promise.resolve(descriptor()),
        },
        quarantine: quarantinePort(() => Promise.resolve([QUARANTINED])),
      }),
    )

    expect(card.status).toBe('quarantined')
  })

  it('entities.get serves active on a host with no quarantine port at all', async () => {
    const card = await entitiesGetSpec.invoke(
      { ref: 'TST-001' },
      deps({
        entities: {
          resolve: () => Promise.resolve({ kind: 'none' as const, reason: 'no-match' as const }),
          get: () => Promise.resolve(descriptor()),
        },
      }),
    )

    expect(card.status).toBe('active')
  })
})
