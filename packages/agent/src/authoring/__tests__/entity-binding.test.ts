// The low-confidence cell catches a lone candidate bound regardless of its confidence.

import type { EntityDescriptor, EntityResolution } from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'

import type {
  AmbiguousEntityNameError as AmbiguousEntityNameErrorType,
  EntityBinding,
  UnresolvedEntityNameError as UnresolvedEntityNameErrorType,
} from '../entity-binding.js'
import type { EntityDirectoryPort } from '../../functions/spec.js'

// Imported lazily so a missing module fails each named cell, not the whole file at load.
async function subject() {
  return await import('../entity-binding.js')
}

async function bind(
  names: readonly string[],
  entities: EntityDirectoryPort,
): Promise<readonly EntityBinding[]> {
  const { bindEntityNames } = await subject()
  return await bindEntityNames(names, { entities })
}

function descriptor(options: {
  shortId: string
  title: string
  filePath?: string
  testName?: string
}): EntityDescriptor {
  return {
    kind: 'TST',
    shortId: options.shortId,
    uri: `agentqa://TST/${options.shortId}`,
    machineId: `machine-${options.shortId}`,
    title: options.title,
    statusSource: 'active',
    ...(options.filePath === undefined || options.testName === undefined
      ? {}
      : {
          testIdentity: {
            product: 'local-form',
            filePath: options.filePath,
            testName: options.testName,
          },
        }),
  }
}

/** A resolver whose answer is scripted, and which RECORDS what it was asked. */
function directory(answer: EntityResolution): EntityDirectoryPort & { readonly asked: string[] } {
  const asked: string[] = []
  return {
    asked,
    resolve(ref: string): Promise<EntityResolution> {
      asked.push(ref)
      return Promise.resolve(answer)
    },
    get: () => Promise.resolve(undefined),
  }
}

const NEVER_ASKED: EntityDirectoryPort & { readonly asked: string[] } = {
  asked: [],
  resolve(): Promise<EntityResolution> {
    throw new Error('an exact address must never reach the fuzzy resolver')
  },
  get: () => Promise.resolve(undefined),
}

describe('a unique high-confidence hit binds', () => {
  it('binds a resolved descriptor and carries the identity its store reported', async () => {
    const entities = directory({
      kind: 'resolved',
      descriptor: descriptor({
        shortId: 'TST-4A2',
        title: 'Sign in on the local account form',
        filePath: 'tests/local-form.yaml',
        testName: 'Sign in on the local account form',
      }),
      score: 0.91,
    })

    const bound = await bind(['the local form sign-in test'], entities)

    expect(bound).toEqual([
      {
        name: 'the local form sign-in test',
        source: 'resolver',
        ref: 'agentqa://TST/TST-4A2',
        identity: {
          filePath: 'tests/local-form.yaml',
          testName: 'Sign in on the local account form',
        },
      },
    ])
    // The SHIPPED resolver was consulted, with the name as given. A binder that pre-processed the
    // name would be deciding something about the match before the resolver saw it.
    expect(entities.asked).toEqual(['the local form sign-in test'])
  })

  it('binds an exact <filePath>::<testName> address WITHOUT consulting the fuzzy resolver', async () => {
    // The spelling a dedup refusal already prints, so "edit that one" round-trips deterministically.
    // The fake THROWS if it is reached, which is what makes the claim about the resolver rather than
    // about the answer a resolver happened to give.
    const bound = await bind(
      ['tests/local-form.yaml::Sign in on the local account form'],
      NEVER_ASKED,
    )

    expect(bound).toEqual([
      {
        name: 'tests/local-form.yaml::Sign in on the local account form',
        source: 'exact-ref',
        ref: 'tests/local-form.yaml::Sign in on the local account form',
        identity: {
          filePath: 'tests/local-form.yaml',
          testName: 'Sign in on the local account form',
        },
      },
    ])
  })
})

describe('a name that matches several entities refuses, and NAMES them', () => {
  it('refuses with the candidate identities on the error, not merely with a message', async () => {
    const entities = directory({
      kind: 'ambiguous',
      candidates: [
        { descriptor: descriptor({ shortId: 'TST-111', title: 'Checkout with a coupon' }), score: 0.62 },
        { descriptor: descriptor({ shortId: 'TST-222', title: 'Checkout with a saved card' }), score: 0.59 },
      ],
    })

    const { AmbiguousEntityNameError, UnresolvedEntityNameError } = await subject()
    const refusal = await bind(['the checkout test'], entities).catch((error: unknown) => error)

    expect(refusal).toBeInstanceOf(AmbiguousEntityNameError)
    const ambiguous = refusal as AmbiguousEntityNameErrorType
    expect(ambiguous.entityName).toBe('the checkout test')
    // A caller renders the disambiguation card off these candidates, so they must survive.
    expect(ambiguous.candidates).toEqual([
      { ref: 'agentqa://TST/TST-111', title: 'Checkout with a coupon', score: 0.62 },
      { ref: 'agentqa://TST/TST-222', title: 'Checkout with a saved card', score: 0.59 },
    ])
    // A DIFFERENT CLASS from the unresolved refusal, so a caller branches without reading a string.
    expect(refusal).not.toBeInstanceOf(UnresolvedEntityNameError)
  })
})

describe('a name that matches nothing refuses', () => {
  it('refuses an honest miss by name', async () => {
    const entities = directory({ kind: 'none', reason: 'no-match' })

    const { UnresolvedEntityNameError } = await subject()
    const refusal = await bind(['a test that was never written'], entities)
      .catch((error: unknown) => error)

    expect(refusal).toBeInstanceOf(UnresolvedEntityNameError)
    const unresolved = refusal as UnresolvedEntityNameErrorType
    expect(unresolved.entityName).toBe('a test that was never written')
    expect(unresolved.reason).toBe('no-match')
    expect(unresolved.closestSuggestion).toBeUndefined()
  })
})

describe('a LONE WEAK match refuses rather than binding — the direction that matters', () => {
  it('does not promote closestSuggestion to a binding', async () => {
    // What the shipped resolver answers for a single candidate that ranked but cleared neither the
    // absolute score nor the margin: `none`, WITH the near miss attached so a surface can ask. This
    // is the one input on which a permissive binder looks helpful and is wrong.
    const entities = directory({
      kind: 'none',
      reason: 'no-match',
      closestSuggestion: 'TST-903',
    })

    const { UnresolvedEntityNameError } = await subject()
    const refusal = await bind(['the chekout test'], entities).catch((error: unknown) => error)

    expect(refusal).toBeInstanceOf(UnresolvedEntityNameError)
    const unresolved = refusal as UnresolvedEntityNameErrorType
    // The suggestion SURVIVES as evidence — so this cell cannot be satisfied by an implementation
    // that simply discards it, which would be a refusal nobody can act on.
    expect(unresolved.closestSuggestion).toBe('TST-903')
    // …and it is stated in the message as a question rather than as an outcome.
    expect(unresolved.message).toContain('offered as a question rather than applied')
  })

  it('refuses the WHOLE set when one name of several cannot be bound', async () => {
    const entities = directory({ kind: 'none', reason: 'no-match', closestSuggestion: 'TST-903' })

    const { UnresolvedEntityNameError } = await subject()
    const refusal = await bind(
      ['tests/local-form.yaml::Sign in on the local account form', 'the chekout test'],
      entities,
    ).catch((error: unknown) => error)

    // Not a partial answer. A caller handed the bound half of a two-name edit is a caller who
    // eventually applies it, which is the shape the applier and the repair fence both already refuse.
    expect(refusal).toBeInstanceOf(UnresolvedEntityNameError)
    expect((refusal as UnresolvedEntityNameErrorType).entityName).toBe('the chekout test')
  })
})

describe('the binder adds no matcher of its own', () => {
  it('reaches the shipped resolver for every name it does not hold an exact address for', async () => {
    const entities = directory({ kind: 'none', reason: 'no-match' })

    await bind(['one name'], entities).catch(() => undefined)
    await bind(['another name'], entities).catch(() => undefined)

    // Every non-address name reached the resolver verbatim. A second matcher here — a threshold, a
    // token overlap, a similarity pass — would show up as a name that never got asked about, or as
    // a binding produced for one the resolver refused.
    expect(entities.asked).toEqual(['one name', 'another name'])
  })
})
