// The cross-spelling pin between schema's closed protected set and the registry it protected (Phase
// 391, PROP-05, plan 05), RE-SPELLED 2026-10-01 (432-18, D-15) as the set's absence.
//
// The set (`['fn:proposals.accept', 'fn:grants.revoke']`) named the action classes no standing grant
// could cover. 432-17 deleted `proposals.accept` and 432-18 deletes `grants.revoke`, the grant
// ledger and the set itself, so claims 1-3 below (each member names exactly one registered op, and
// its bare spelling none) lost their subject. What is kept: no op is protected because nothing
// mints a grant, and the three knowledge change ops are registered with no propose class beside them.

import * as schema from '@vostride/agent-qa-schema'
import {
  MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
} from '@vostride/agent-qa-schema'
import type { FunctionCaller } from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'

import { createFunctionRegistry } from '../registry.js'
import type { FunctionDeclaration, FunctionDeps } from '../spec.js'

/**
 * The four REQUIRED ports, answering emptily.
 *
 * This file reads DECLARATIONS and never dispatches, so what these return is irrelevant — what
 * matters is that every op the catalogue carries is LISTED, including the ones this fixture leaves
 * `unbound`. Binding is a property of a composition; membership of the protected set is a property
 * of the catalogue, and conflating them would make the pin miss exactly the ops that are unbound
 * in the host a reader happens to be looking at.
 */
function listingDeps(): FunctionDeps {
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
    config: {
      getMasked: () =>
        Promise.resolve({
          schemaVersion: MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
          configPath: 'agent-qa.config.yaml',
          entries: [],
        }),
    },
  }
}

/**
 * Every scope, human origin — so a capability missing from the listing below is missing because it
 * is not registered, never because this caller could not be shown it. The safe-mode filter is the
 * only thing `list` withholds anything for, and this caller is not in it.
 */
const FULLY_GRANTED: FunctionCaller = {
  surface: 'test',
  origin: 'human',
}

function declarations(): readonly FunctionDeclaration[] {
  return createFunctionRegistry({ deps: listingDeps() }).list(FULLY_GRANTED)
}

describe('the protected action classes name real registered ops', () => {
  // RE-SPELLED 2026-10-01 (432-18) from 'is not vacuous: the catalogue and the protected set are both
  // non-empty': the catalogue still is, and the set is gone.
  it('the catalogue is non-empty and no protected-class set is published', () => {
    expect(declarations().length).toBeGreaterThan(0)
    const exported = Object.keys(schema)
    expect(exported.filter((name) => /protected/i.test(name)), 'a protected-class member is exported')
      .toEqual([])
  })

  // RE-SPELLED 2026-10-01 (432-18) from 'each member is the risk.name of EXACTLY ONE registered op'
  // and 'the BARE spelling of each member matches no registered op': both members' ops are deleted.
  it('neither former protected class names a registered op, prefixed or bare', () => {
    const names = declarations().flatMap((declaration) => [declaration.risk.name, declaration.id])
    for (const member of ['fn:proposals.accept', 'fn:grants.revoke']) {
      expect(names, member).not.toContain(member)
      expect(names, member.replace(/^fn:/, '')).not.toContain(member.replace(/^fn:/, ''))
    }
  })

  // The three knowledge changes apply in the call; the retired propose classes name no registered op.
  it('registers the three knowledge change ops and no propose class beside them', () => {
    const listed = declarations()
    for (const id of ['knowledge.accept', 'knowledge.reject', 'knowledge.forget']) {
      const declaration = listed.find((row) => row.id === id)
      expect(declaration, id).toBeDefined()
      expect(listed.filter((row) => row.risk.name === `fn:${id}.propose`), `${id}.propose`).toEqual([])
    }
  })
})
