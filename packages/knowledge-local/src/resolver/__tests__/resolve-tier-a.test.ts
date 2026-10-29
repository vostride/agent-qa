// Edge inputs: an address naming nothing, an unpadded ordinal and free text.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { openAddressingLedger } from '../../addressing/ledger.js'
import type { AddressingLedger } from '../../addressing/ledger.js'
import { getEntityDescriptor, resolveEntityRef } from '../resolve.js'
import type { EntitySighting, EntitySightingSource, ResolveEntityRefDeps } from '../resolve.js'

function staticSource(
  kind: EntitySightingSource['kind'],
  rows: readonly EntitySighting[],
): EntitySightingSource {
  const find = (machineId: string): EntitySighting | undefined =>
    rows.find((row) => row.machineId === machineId)
  return { kind, sight: find, hydrate: find }
}

const MEMORIES: readonly EntitySighting[] = [
  { machineId: 'bundle-checkout', title: 'checkout selector', statusSource: 'active' },
  { machineId: 'bundle-login', title: 'login selector', statusSource: 'active' },
]

const TARGETS: readonly EntitySighting[] = [
  { machineId: 'checkout', title: 'Checkout target', statusSource: 'active' },
  { machineId: 'payment', title: 'Payment target', statusSource: 'active' },
]

describe('resolver tier (a)', () => {
  let root: string
  let ledger: AddressingLedger
  let deps: ResolveEntityRefDeps

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'agent-qa-tier-a-'))
    ledger = openAddressingLedger({ path: join(root, 'entity-addresses.db') })
    deps = {
      ledger,
      sources: [staticSource('MEM', MEMORIES), staticSource('TGT', TARGETS)],
    }
  })

  afterEach(() => {
    ledger.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('resolves a minted short-ID at 1.0', async () => {
    await resolveEntityRef('bundle-checkout', deps)

    expect(await resolveEntityRef('MEM-001', deps)).toMatchObject({
      kind: 'resolved',
      score: 1,
      descriptor: { kind: 'MEM', shortId: 'MEM-001', machineId: 'bundle-checkout' },
    })
  })

  it('resolves the agentqa:// URI to the same entity at 1.0', async () => {
    await resolveEntityRef('bundle-checkout', deps)

    expect(await resolveEntityRef('agentqa://memory/MEM-001', deps))
      .toEqual(await resolveEntityRef('MEM-001', deps))
  })

  it('accepts an unpadded ordinal and answers in the canonical spelling', async () => {
    await resolveEntityRef('bundle-checkout', deps)

    const unpadded = await resolveEntityRef('MEM-1', deps)

    expect(unpadded).toEqual(await resolveEntityRef('MEM-001', deps))
    // The ANSWER is canonical even though the input was not, which is what keeps `MEM-1` a
    // spelling of one address rather than a second one.
    if (unpadded.kind !== 'resolved') throw new Error('expected the resolved arm')
    expect(unpadded.descriptor.shortId).toBe('MEM-001')
    expect(unpadded.descriptor.uri).toBe('agentqa://memory/MEM-001')
  })

  it('returns the typed none arm for a well-formed address nothing minted — never a throw', async () => {
    await resolveEntityRef('bundle-checkout', deps)

    // MEM-002 is one ordinal past the only address that exists. It parses perfectly, and the
    // temptation an unguarded resolver has here is to answer with the nearest thing it holds.
    expect(await resolveEntityRef('MEM-002', deps)).toEqual({
      kind: 'none',
      reason: 'unknown-address',
    })
    // A rejected promise is not a throw, so the never-throw half is asserted on the
    // settled value: this path answers, it does not fail.
    await expect(resolveEntityRef('MEM-002', deps)).resolves.toBeDefined()
  })

  it('refuses free text rather than offering the entity it is nearest to', async () => {
    await resolveEntityRef('bundle-checkout', deps)

    // Every word of this reference appears in the fixture's only entity title. A ranker would
    // score it highly; tier (a) has no ranker and says so.
    expect(await resolveEntityRef('the checkout selector', deps))
      .toEqual({ kind: 'none', reason: 'no-match' })
    expect(await resolveEntityRef('bundle-checkou', deps)).toEqual({ kind: 'none', reason: 'no-match' })
  })

  it('mints once per entity and keeps first-mention order', async () => {
    // Ordinals reflect first MENTION, not creation: `bundle-login` is second in the source and
    // first in the ledger because it was referenced first.
    expect(await resolveEntityRef('bundle-login', deps)).toMatchObject({
      descriptor: { shortId: 'MEM-001' },
    })
    expect(await resolveEntityRef('bundle-checkout', deps)).toMatchObject({
      descriptor: { shortId: 'MEM-002' },
    })
    expect(await resolveEntityRef('bundle-login', deps)).toMatchObject({
      descriptor: { shortId: 'MEM-001' },
    })
  })

  it('names the successor slug on a renamed target, and only once recorded', async () => {
    await resolveEntityRef('checkout', deps)
    const before = await resolveEntityRef('TGT-checkout', deps)
    if (before.kind !== 'resolved') throw new Error('expected the resolved arm')
    // No link is inferred from the slugs alone.
    expect(before.descriptor.successorMachineId).toBeUndefined()

    ledger.recordTargetRename('checkout', 'payment')

    const after = await resolveEntityRef('TGT-checkout', deps)
    if (after.kind !== 'resolved') throw new Error('expected the resolved arm')
    // The old address STILL resolves — append-only — and now carries the rename, so a card
    // can show it rather than silently redirecting to the successor.
    expect(after.descriptor).toMatchObject({
      shortId: 'TGT-checkout',
      machineId: 'checkout',
      successorMachineId: 'payment',
    })
  })

  it('never mints through the get path', async () => {
    // `get` is handed an address that already exists. If it could sight, a card render on any
    // surface would become a write to the one store this system never rebuilds.
    expect(getEntityDescriptor('bundle-checkout', deps)).toBeUndefined()
    expect(ledger.lookup('MEM', 'bundle-checkout')).toBeUndefined()

    await resolveEntityRef('bundle-checkout', deps)
    expect(getEntityDescriptor('MEM-001', deps)).toMatchObject({ machineId: 'bundle-checkout' })
    expect(getEntityDescriptor('MEM-002', deps)).toBeUndefined()
  })
})
