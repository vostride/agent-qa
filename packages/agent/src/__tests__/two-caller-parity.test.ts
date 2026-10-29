// FUNC-03's one-shared-path claim, proven with data (Phase 384, Plan 05 — D-13 / SC3).
//
// The claim under test is that caller differences are DATA, never control flow: two callers
// hit ONE registry instance and ONE dispatch path. Until 432-20 every difference in what
// happened to them was explained by four permission-shaped fields on their records —
// `grantedScopes`, `safeMode`, `credential` and `origin`.
//
// EVERY DOOR CAN CALL EVERY OPERATION. The scope check, the
// human-origin check and the safe-mode listing filter are deleted, so the same four fields now
// explain NOTHING: two records that differ in all of them list the same catalogue and reach the
// same outcome for every op — success, or the ordinary input/binding refusal. `origin` and
// `surface` survive only as presentation data. The cells below keep their premise and measure
// the absence.
//
// Two things make this a proof rather than an illustration:
//
//   1. The premise is machine-checked. The first case computes which keys actually differ
//      between the two records and asserts the set is exactly those four. If a later edit
//      makes the callers differ in a fifth way, every conclusion below stops following and
//      the suite says so instead of quietly proving something weaker.
//   2. The registry is a single module-scope instance, shared by every caller in the file.
//      "One shared path" is therefore structural here, not a claim in a comment.
//
// there is no op gate. What a caller is refused for is decided by
// the input contract, the scope and origin checks and the binding check; nothing else is asked and
// no decision row is written. The credential axis below is re-spelled accordingly.
//
// `grantedScopes`, `safeMode` and `credential` are deleted from
// `FunctionCaller`, with the scope and trust-credential types. The records below still carry them,
// SMUGGLED past the type with a cast, because that is the only way the premise stays non-vacuous:
// two records that differ in fields nobody reads must still differ. A record that never carried them
// would prove nothing about whether they are read.

import * as safety from '@vostride/agent-qa-safety'
import {
  CURRENT_HANDOFF_SCHEMA_VERSION,
  MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
} from '@vostride/agent-qa-schema'
import type {
  CompletedRunHandoff,
  FunctionCaller,
  RunId,
  RunSummary,
} from '@vostride/agent-qa-schema'
import { beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import * as invokeModule from '../functions/invoke.js'
import {
  FunctionInputError,
  FunctionNotBoundError,
  invokeFunction,
} from '../functions/invoke.js'
import { createFunctionRegistry, createRegistryFromSpecs } from '../functions/registry.js'
import type { FunctionDeps, FunctionSpec } from '../functions/spec.js'

// no execution context is supplied anywhere in this file. The registry's context option is
// retired and unread, so a context could not change any outcome measured here.

const CREDENTIAL = { scope: { project: 'shop' } }

/**
 * The two synthetic callers. `surface` is deliberately IDENTICAL: attribution is not a
 * permission input, and holding it constant is what lets the difference set below come out
 * as exactly the three permission-shaped fields.
 */
const CALLER_A = {
  surface: 'synthetic',
  grantedScopes: ['read', 'run', 'config-write'],
  safeMode: false,
  credential: CREDENTIAL,
  origin: 'human',
} as FunctionCaller

const CALLER_B = {
  surface: 'synthetic',
  grantedScopes: ['read'],
  safeMode: true,
  origin: 'agent',
} as FunctionCaller

/** A differs from this one ONLY in `safeMode` — the isolate for "listing is cosmetic". */
const CALLER_A_SAFE = { ...CALLER_A, safeMode: true } as FunctionCaller

/** A differs from this one ONLY in `origin` — the isolate for the 391 D-06 refusal. */
const CALLER_A_AGENT: FunctionCaller = { ...CALLER_A, origin: 'agent' }

/** The would-be scope claimant: no `run` grant, and the record is the only thing read. */
const CALLER_C = {
  surface: 'synthetic',
  grantedScopes: ['read'],
  safeMode: false,
  origin: 'human',
} as FunctionCaller

/** C plus the one grant it lacked — the counterfactual for what the subset check reads. */
const CALLER_C_GRANTED = {
  ...CALLER_C,
  grantedScopes: ['read', 'run'],
} as FunctionCaller

function handoff(runId: string, buildOrdinal: number): CompletedRunHandoff {
  return {
    schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION,
    runId: runId as RunId,
    scope: { tier: 'product', key: 'shop' },
    buildOrdinal,
    executionContext: 'local-headless',
    aggregateVerdict: 'passed',
    configDigests: { suiteConfigDigest: 'suite', testConfigDigest: 'test' },
    startedAt: 1_000,
    endedAt: 2_000,
    tests: [],
  }
}

const DOCUMENTS: readonly CompletedRunHandoff[] = [
  handoff('run-beta', 12),
  handoff('run-alpha', 11),
]

const DEPS: FunctionDeps = {
  secretMask: (text: string) => text,
  runs: {
    list: () => Promise.resolve(DOCUMENTS),
    get: (runId) => Promise.resolve(DOCUMENTS.find((document) => document.runId === runId)),
    readEvents: () => Promise.resolve([]),
    readStepEvidence: () => Promise.resolve({ kind: 'run-not-recorded' } as const),
  },
  knowledge: {
    listBundles: () => Promise.resolve([]),
    inspectRecords: () => Promise.resolve([]),
    diffSince: () => Promise.resolve([]),
    showRecord: ({ recordId }) => Promise.resolve({ kind: 'not-found', schemaVersion: 2, recordId } as const),
  },
  // 387: `entities` is a REQUIRED read port on FunctionDeps. Stated here so the record
  // typechecks, and stated as an ANSWERING stub rather than a refusing one: these cases
  // exercise other ops, and nothing in this file mints an address, so an honest miss and a
  // reported absence are the truthful answers.
  entities: {
    resolve: () => Promise.resolve({ kind: 'none' as const, reason: 'no-match' as const }),
    get: () => Promise.resolve(undefined),
  },
  config: {
    getMasked: () => Promise.resolve({
      schemaVersion: MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
      configPath: 'agent-qa.config.yaml',
      entries: [],
    }),
  },
}

// the registry takes no audit sink, so no cell drains audit rows.

/**
 * ONE registry instance, built over the REAL built-in capability set and shared by every
 * caller in this file. Nothing here is per-caller: there is exactly one spec map and one deps
 * record, so a per-surface branch would have nowhere to live.
 */
const REGISTRY = createFunctionRegistry({
  deps: DEPS,
})

/** The shipped capability set, as both callers' listings are measured against it. */
const ALL_FUNCTION_IDS = [
  // the chat turn entry, first in SORT position (`agent.` precedes `analysis.`). It is
  // READ-tier and therefore survives safe-mode filtering, and that is a deliberate reading of what
  // safe mode is: the listing filter is cosmetic, so hiding the turn entry would hide the door
  // without closing it while every clause a turn runs stays gated server-side on its own scopes.
  'agent.ask',
  // the `agent.` domain's second member, in SORT position (`agent.explain` follows
  // `agent.ask`). READ-tier, so it survives safe-mode filtering — deliberately, because a person
  // who has locked the agent down to reads is exactly the person most likely to ask what is left.
  'agent.explain',
  // read-tier, so it survives safe-mode filtering like its analysis-domain-first
  // siblings never had to — the non-read drop-out set stays exactly `runs.start` plus the
  // four knowledge-write verbs.
  'analysis.get',
  // one more id in SORT position (`authoring.` falls between `analysis.` and `config.`).
  // It declares `run` AND `read`, so it is NON-read and drops out of safe-mode filtering with
  // `runs.start` and the write verbs — the derived drop-out set below grows by one and the filter
  // assertion keeps testing the RULE rather than a frozen list.
  // in SORT position BEFORE both its siblings (`edit` precedes `verify` precedes
  // `write`), not appended — this list is compared against the registry's lexicographic listing, so
  // an appended id would fail on ORDER while every member was present. It declares `test-write`
  // AND `read`, so it is non-read and joins the derived drop-out set; nothing below is edited,
  // which is what keeps the filter assertion a claim about the RULE rather than a frozen list.
  'authoring.draft.edit',
  'authoring.draft.verify',
  // in SORT position beside its sibling (`verify` precedes `write`), not appended —
  // this list is compared against the registry's lexicographic listing, so an appended id would
  // fail on ORDER while every member was present. It declares `test-write`, `run` AND `read`, so
  // it is non-read and joins the derived drop-out set; nothing below is edited, which is what
  // keeps the filter assertion a claim about the RULE rather than about a frozen list.
  'authoring.draft.write',
  // in SORT position after both `authoring.draft.*` ids (`draft` precedes `funnel`)
  // and before `config.` — this list is compared against the registry's lexicographic listing, so
  // an appended id would fail on ORDER while every member was present. It declares `read` ALONE,
  // so unlike its two authoring siblings it SURVIVES safe-mode filtering and the derived
  // drop-out set below is unchanged — which is what keeps the filter assertion a claim about the
  // RULE rather than about a frozen list.
  'authoring.funnel.get',
  // in SORT position — `config.field.set` and `config.proposal.apply` fall on
  // either side of `config.get` lexicographically (`field` < `get` < `proposal`), and this list is
  // compared against the registry's lexicographic listing, so an appended pair would fail on ORDER
  // while every member was present. Both declare `config-write` and NOT `read`, so both DROP OUT
  // of the safe-mode listing with the other non-read verbs — which is what keeps the filter
  // assertion below a claim about the RULE rather than about a frozen list.
  'config.auth.set',
  'config.field.set',
  'config.get',
  'config.hook.add',
  // one more id in SORT position. It declares `config-write` and NOT `read`, so it
  // joins the derived drop-out set with its siblings and the filter assertion stays a claim
  // about the RULE rather than about a list.
  'config.project.scaffold',
  // `config.proposal.apply` and `config.undo.propose` are deleted.
  // two more ids in SORT position — `target` follows `proposal` lexicographically, and
  // this list is compared against the registry's lexicographic listing, so a misplaced pair would
  // fail on ORDER while every member was present. Both declare `config-write` and NOT `read`, so
  // both join the derived drop-out set and the filter assertion stays a claim about the RULE.
  'config.target.create',
  'config.target.edit',
  // in SORT position (`editor.` falls between `config.` and `entities.`). Read-tier like
  // runs.liveurl, so it survives safe-mode filtering and the derived non-read set is unchanged.
  'editor.liveurl',
  // both read-tier, so both survive safe-mode filtering — which is what makes the
  // filter assertion below sharper rather than merely longer. `runs.start` is still the only
  // id that drops out, and it now drops out of a set two entries larger.
  'entities.get',
  'entities.resolve',
  // 391 PROP-01 / D-03 added `grants.list` and `grants.revoke` here; 432-18 deletes both ops.
  // four more read-tier ids, so they too survive safe-mode filtering and
  // the filter assertion below sharpens rather than merely lengthens — 'runs.start' is still
  // the one id that drops out, now out of a set six entries larger than 384 shipped.
  // the mutating half is knowledge-write-tier, so unlike its read siblings it
  // does NOT survive safe-mode filtering — which is what turns the assertion below from "one id
  // drops out" into "exactly the non-read ids drop out", a claim about the RULE rather than
  // about `runs.start`.
  // the three changes lose `.propose` and keep their sort positions.
  'knowledge.accept',
  'knowledge.brief.why',
  'knowledge.bundles.list',
  'knowledge.forget',
  // gate history is read-tier and remains visible in both caller listings.
  'knowledge.gates.list',
  'knowledge.record.show',
  'knowledge.records.diff',
  'knowledge.records.inspect',
  'knowledge.reject',
  // the four `proposals.` ids are deleted with the inbox.
  // three more ids, and they land in SORT position rather than appended —
  // this list is compared against the registry's lexicographic listing, so an appended id
  // would fail on order while every member was present. `quarantine.list` is read-tier and
  // survives safe-mode filtering; `release` and `add` are knowledge-write-tier and drop out
  // with the 387-08 verbs, so the derived non-read set below grows from five to seven and the
  // filter assertion keeps testing the RULE rather than a frozen list.
  'quarantine.add',
  'quarantine.list',
  'quarantine.release',
  // the per-run digest, in SORT position ahead of its `runs.` siblings. Read-tier, so
  // it survives safe-mode filtering and the derived non-read set below is unchanged — which is
  // what keeps the filter assertion a test of the RULE rather than of a frozen list.
  // in SORT position BEFORE `runs.digest` (`detail` precedes `digest`), not
  // appended — this list is compared against the registry's lexicographic listing, so an appended
  // id would fail on ORDER while every member was present. It declares `read` ALONE, so it
  // survives safe-mode filtering and the derived drop-out set below is unchanged, which is what
  // keeps the filter assertion a claim about the RULE rather than about a frozen list.
  // in SORT position BEFORE `runs.detail` (`artifact` precedes `detail`), not
  // appended — this list is compared against the registry's lexicographic listing, so an appended
  // id would fail on ORDER while every member was present. Read-tier like its `runs.` siblings, so
  // the derived non-read drop-out set below is unchanged.
  'runs.artifact',
  'runs.detail',
  'runs.digest',
  'runs.events',
  'runs.evidence',
  'runs.get',
  // in SORT position between `runs.get` and `runs.list`, not appended — this list is
  // compared against the registry's lexicographic listing, so an appended id would fail on ORDER
  // while every member was present. Read-tier like its `runs.` siblings, so the derived non-read
  // drop-out set below is unchanged, which keeps the filter assertion a claim about the RULE.
  'runs.knowledge',
  'runs.list',
  // read-tier like its `runs.` siblings — minting a VIEW-scoped, short-lived link is
  // a read of a run's live state, not a mutation of it — so it survives safe-mode filtering and
  // the derived non-read set below is unchanged, which is what keeps the filter assertion a test
  // of the RULE rather than of a frozen list.
  'runs.liveurl',
  // shared mutation; safe-mode listing excludes it by declared scope.
  'runs.mark',
  // read-tier preview of the mark above, so safe-mode listing keeps it.
  'runs.mark.preview',
  // read-tier, so it survives safe-mode filtering beside its runs. siblings.
  'runs.marks.history',
  // read-tier, in SORT position between `runs.marks.history` and `runs.postprocessing`.
  'runs.overview',
  // read-tier like its `runs.` siblings, so it too survives safe-mode filtering and
  // the filter assertion below sharpens rather than merely lengthens — `runs.start` plus the
  // four knowledge-write verbs are still exactly the ids that drop out.
  'runs.postprocessing',
  'runs.start',
] as const

/** Read one field of a caller record by name, so the premise can be computed generically. */
function field(caller: FunctionCaller, key: string): unknown {
  return (caller as unknown as Record<string, unknown>)[key]
}

describe('the premise: two records differing in exactly four fields', () => {
  it('differ in grantedScopes, safeMode, credential and origin — and in nothing else', () => {
    const keys = [...new Set([...Object.keys(CALLER_A), ...Object.keys(CALLER_B)])]
    const differing = keys.filter((key) => (
      JSON.stringify(field(CALLER_A, key)) !== JSON.stringify(field(CALLER_B, key))
    ))

    // If this goes red, every conclusion in this file stops following from its premise.
    expect(differing.sort()).toEqual(['credential', 'grantedScopes', 'origin', 'safeMode'])
    expect(CALLER_A.surface).toBe(CALLER_B.surface)
  })
})

describe('one shared path: the same op, the same dispatch, for both callers', () => {
  it('resolves runs.list identically for both callers, with identical audit trails', async () => {
    const resultA = (await invokeFunction(REGISTRY, 'runs.list', {}, CALLER_A)) as RunSummary[]
    const resultB = (await invokeFunction(REGISTRY, 'runs.list', {}, CALLER_B)) as RunSummary[]

    expect(resultA.map((summary) => summary.runId)).toEqual(['run-beta', 'run-alpha'])
    expect(resultB).toEqual(resultA)
  })

  it('ignores the originating surface entirely — attribution is never a permission input', async () => {
    const asCli = (await invokeFunction(
      REGISTRY,
      'runs.list',
      {},
      { ...CALLER_A, surface: 'cli' },
    )) as RunSummary[]
    const asMcp = (await invokeFunction(
      REGISTRY,
      'runs.list',
      {},
      { ...CALLER_A, surface: 'mcp' },
    )) as RunSummary[]

    // `if (caller.surface === ...)` is the anti-pattern this layer exists to abolish. The
    // proof that no such branch exists is that renaming the surface changes nothing at all.
    expect(asMcp).toEqual(asCli)
  })
})

// RE-SPELLED 2026-10-01 from 'safe mode filters the listing and enforces nothing
// '. The listing filter is deleted with the scopes; the claim that survives is that a
// caller record decides neither what is listed nor what is served.
describe('no caller field filters the listing or the dispatch', () => {
  it('lists every capability for A and for B — the same list, with no permission keys', () => {
    expect(REGISTRY.list(CALLER_A).map((declaration) => declaration.id))
      .toEqual([...ALL_FUNCTION_IDS])
    expect(REGISTRY.list(CALLER_B).map((declaration) => declaration.id))
      .toEqual([...ALL_FUNCTION_IDS])
    expect(REGISTRY.list(CALLER_B)).toEqual(REGISTRY.list(CALLER_A))

    // A's listing carries runs.start as UNBOUND, never as absent, and no declaration
    // carries a scope or an origin requirement.
    const runsStart = REGISTRY.list(CALLER_A).find((declaration) => declaration.id === 'runs.start')
    expect(runsStart).toMatchObject({ bindingStatus: 'unbound' })
    for (const declaration of REGISTRY.list(CALLER_B)) {
      expect(Object.keys(declaration), declaration.id).not.toContain('requiredScopes')
      expect(Object.keys(declaration), declaration.id).not.toContain('requiresHumanOrigin')
    }
  })

  it('is the same list for a safe-mode caller holding every grant and one holding none', () => {
    expect(REGISTRY.list(CALLER_A_SAFE).map((declaration) => declaration.id))
      .toEqual(REGISTRY.list(CALLER_B).map((declaration) => declaration.id))
    expect(REGISTRY.list({ ...CALLER_B, grantedScopes: [] } as FunctionCaller))
      .toEqual(REGISTRY.list(CALLER_A_SAFE))
  })

  it('changes nothing about enforcement: safe mode alone alters no invocation outcome', async () => {
    // A_SAFE differs from A ONLY in safeMode. Both reach exactly the same refusal — the binding check.
    await expect(invokeFunction(REGISTRY, 'runs.start', {}, CALLER_A))
      .rejects.toBeInstanceOf(FunctionNotBoundError)

    await expect(invokeFunction(REGISTRY, 'runs.start', {}, CALLER_A_SAFE))
      .rejects.toBeInstanceOf(FunctionNotBoundError)
  })

  // RE-SPELLED 2026-10-01 from 'refuses B server-side for the scope it lacks — the
  // hidden op is still enforced'. Nothing is hidden and no scope is checked: B reaches the same
  // binding check A does.
  it('serves B exactly as A — the formerly hidden op reaches its binding check', async () => {
    const refusal = invokeFunction(REGISTRY, 'runs.start', {}, CALLER_B)

    await expect(refusal).rejects.toBeInstanceOf(FunctionNotBoundError)
    await expect(refusal).rejects.not.toHaveProperty('missingScopes')
  })

  // RE-SPELLED 2026-10-01 from 'gives A and B DIFFERENT refusals for the same id,
  // explained by grants alone'.
  it('gives A and B the SAME refusal for the same id — grants explain nothing', async () => {
    await expect(invokeFunction(REGISTRY, 'runs.start', {}, CALLER_A))
      .rejects.toBeInstanceOf(FunctionNotBoundError)
    await expect(invokeFunction(REGISTRY, 'runs.start', {}, CALLER_B))
      .rejects.toBeInstanceOf(FunctionNotBoundError)
  })
})

// RE-SPELLED 2026-10-01 from 'a claimed scope is not a held scope (SC3 / T-384-13)'.
// No scope is held or checked any more; what survives is that the strict input contract is still
// the only thing a payload meets, so a payload can claim nothing.
describe('a payload can claim nothing, and a record grants nothing', () => {
  it('serves a caller whose record lacks the scope like any other caller', async () => {
    const outcome = invokeFunction(REGISTRY, 'runs.start', {}, CALLER_C)

    await expect(outcome).rejects.toBeInstanceOf(FunctionNotBoundError)
    await expect(outcome).rejects.not.toHaveProperty('missingScopes')
  })

  it('rejects every attempt to smuggle a grant through the input payload', async () => {
    // The strict input contract is the reason no "I have scope X" assertion can even be
    // expressed on the wire: an unrecognized key is a typed refusal, not a silent drop.
    const smuggled = [
      { grantedScopes: ['run'] },
      { scopes: ['run'] },
      { requiredScopes: [] },
      { safeMode: false },
      { credential: { scope: { project: 'shop' } } },
      { caller: { grantedScopes: ['run'] } },
    ]

    for (const payload of smuggled) {
      await expect(invokeFunction(REGISTRY, 'runs.start', payload, CALLER_C))
        .rejects.toBeInstanceOf(FunctionInputError)
    }
  })

  // RE-SPELLED 2026-10-01 from 'reads the composition-minted grants and nothing
  // else'. The counterfactual now shows the grants are not read: adding the missing grant moves
  // nothing.
  it('reads no grant: adding the missing one moves no outcome', async () => {
    await expect(invokeFunction(REGISTRY, 'runs.start', {}, CALLER_C_GRANTED))
      .rejects.toBeInstanceOf(FunctionNotBoundError)
    await expect(invokeFunction(REGISTRY, 'runs.start', {}, CALLER_C))
      .rejects.toBeInstanceOf(FunctionNotBoundError)
  })
})

/**
 * The credential axis.
 *
 * A synthetic op both callers can reach, so whatever could separate them would have to be the
 * credential.
 */
const credentialProbeSpec: FunctionSpec<Record<string, never>, { ok: true }> = {
  id: 'synthetic.probe',
  summary: 'Synthetic capability both callers reach, for observing the credential.',
  resultKind: 'unary',
  input: z.object({}).strict(),
  output: z.object({ ok: z.literal(true) }).strict(),
  risk: {
    name: 'fn:synthetic.probe',
    recognized: true,
  },
  // `classify` is a REQUIRED member now. A synthetic op's fold is the smallest honest
  // one — the shape has a single arm, so there is nothing to discriminate.
  classify: () => ({ status: 'executed' as const, outcome: '' }),
  invoke: () => Promise.resolve({ ok: true as const }),
}

describe('the credential flows to the gate untouched', () => {
  const probeRegistry = createRegistryFromSpecs([credentialProbeSpec as FunctionSpec], {
    deps: DEPS,
  })

  // Holding a credential and holding none reach the identical outcome, and the layer leaves the
  // credential as it found it.
  it('never reads or rewrites it — A and B are served identically', async () => {
    await expect(invokeFunction(probeRegistry, 'synthetic.probe', {}, CALLER_A))
      .resolves.toEqual({ ok: true })
    await expect(invokeFunction(probeRegistry, 'synthetic.probe', {}, CALLER_B))
      .resolves.toEqual({ ok: true })

    // And the object itself comes back out the way it went in — same reference, same value.
    expect(field(CALLER_A, 'credential')).toBe(CREDENTIAL)
    expect(field(CALLER_A, 'credential')).toEqual({ scope: { project: 'shop' } })
  })

  // RE-SPELLED 2026-10-01 from 'is decisive at the gate once an action scope exists
  // — the 384 boundary, stated'. That counterfactual drove the gate's `evaluate` with an action
  // scope to show the credential could flip a verdict there. The gate and its scope check are
  // deleted, so there is no layer at which the credential can be decisive: the case above is no
  // longer the inert half of a pair, it is the whole answer.
  it('is decisive nowhere — the gate that could read it is gone', async () => {
    expect(Object.keys(safety)).not.toContain('evaluate')
    expect(Object.keys(safety)).not.toContain('scopeMatches')
    // Served with and without the credential, in every context.
    await expect(invokeFunction(probeRegistry, 'synthetic.probe', {}, CALLER_A)).resolves.toEqual({ ok: true })
    const uncredentialed = { ...CALLER_A, credential: undefined } as FunctionCaller
    await expect(invokeFunction(probeRegistry, 'synthetic.probe', {}, uncredentialed))
      .resolves.toEqual({ ok: true })
  })
})

/**
 * The origin axis.
 *
 * Two fixtures that are IDENTICAL but for the declaration, because that is the only way the
 * "unaffected" leg means anything: an op with no declaration invoked by an agent-origin caller
 * proves nothing unless the very same invocation would have been refused had the op declared.
 * Both are read-tier and inside the `read` scope every caller here holds, so neither the gate
 * nor the scope check can be what separates them.
 */
// `requiresHumanOrigin` is deleted from the metadata type, so the
// declaration is smuggled past it with a cast; the cells below still prove nothing reads it.
const humanOnlySpec = {
  id: 'synthetic.human-only',
  summary: 'Synthetic capability that declares a human-origin requirement.',
  resultKind: 'unary',
  requiresHumanOrigin: true,
  input: z.object({}).strict(),
  output: z.object({ ok: z.literal(true) }).strict(),
  risk: { name: 'fn:synthetic.human-only', recognized: true, readOnly: true },
  // `classify` is a REQUIRED member now. A synthetic op's fold is the smallest honest
  // one — the shape has a single arm, so there is nothing to discriminate.
  classify: () => ({ status: 'executed' as const, outcome: '' }),
  invoke: () => Promise.resolve({ ok: true as const }),
} as FunctionSpec<Record<string, never>, { ok: true }>

/** The control: the same op minus the one field. */
const anyOriginSpec: FunctionSpec<Record<string, never>, { ok: true }> = {
  id: 'synthetic.any-origin',
  summary: 'Synthetic capability that declares nothing about origin.',
  resultKind: 'unary',
  input: z.object({}).strict(),
  output: z.object({ ok: z.literal(true) }).strict(),
  risk: { name: 'fn:synthetic.any-origin', recognized: true, readOnly: true },
  // `classify` is a REQUIRED member now. A synthetic op's fold is the smallest honest
  // one — the shape has a single arm, so there is nothing to discriminate.
  classify: () => ({ status: 'executed' as const, outcome: '' }),
  invoke: () => Promise.resolve({ ok: true as const }),
}

// RE-SPELLED 2026-10-01 from 'a declared human-origin requirement is enforced
// uniformly'. The check and its refusal class are deleted; a spec that still declares
// the key (smuggled past the type since 432-39 deleted it) is served to an agent-origin caller
// exactly as to a person.
describe('a declared human-origin requirement is read by nothing', () => {
  let dispatches = 0
  const countedHumanOnly: FunctionSpec<Record<string, never>, { ok: true }> = {
    ...humanOnlySpec,
    id: 'synthetic.human-only.counted',
    risk: { ...humanOnlySpec.risk },
    invoke: () => {
      dispatches += 1
      return Promise.resolve({ ok: true as const })
    },
  }
  const originRegistry = createRegistryFromSpecs(
    [humanOnlySpec as FunctionSpec, anyOriginSpec as FunctionSpec, countedHumanOnly as FunctionSpec],
    { deps: DEPS },
  )

  beforeEach(() => {
    dispatches = 0
  })

  // RE-SPELLED from 'refuses an agent-origin caller at a declaring op, with a typed error'.
  it('serves an agent-origin caller at a still-declaring op', async () => {
    await expect(invokeFunction(originRegistry, 'synthetic.human-only', {}, CALLER_A_AGENT))
      .resolves.toEqual({ ok: true })
  })

  // RE-SPELLED from 'names the op and the required origin, the way the scope refusal names its
  // scopes'. Neither refusal exists, and the dispatch module exports neither class.
  it('has no origin or scope refusal class to name', () => {
    expect(Object.keys(invokeModule)).not.toContain('FunctionOriginError')
    expect(Object.keys(invokeModule)).not.toContain('FunctionScopeError')
    // The declaration a listing renders does not carry the retired key either.
    const listed = originRegistry.list(CALLER_A_AGENT)
      .find((declaration) => declaration.id === 'synthetic.human-only')
    expect(listed).toBeDefined()
    expect(Object.keys(listed!)).not.toContain('requiresHumanOrigin')
  })

  it('admits the SAME op for a human-origin caller — the other corpus side', async () => {
    await expect(invokeFunction(originRegistry, 'synthetic.human-only', {}, CALLER_A))
      .resolves.toEqual({ ok: true })
  })

  it('leaves an op WITHOUT the declaration unaffected by origin', async () => {
    await expect(invokeFunction(originRegistry, 'synthetic.any-origin', {}, CALLER_A_AGENT))
      .resolves.toEqual({ ok: true })
    await expect(invokeFunction(originRegistry, 'synthetic.any-origin', {}, CALLER_A))
      .resolves.toEqual({ ok: true })
  })

  // RE-SPELLED from 'refuses BEFORE dispatch: an origin-refused caller leaves no audit row and runs
  // nothing'. Both origins now dispatch exactly once each.
  it('dispatches once per call for either origin and writes no audit row', async () => {
    await expect(invokeFunction(originRegistry, 'synthetic.human-only.counted', {}, CALLER_A_AGENT))
      .resolves.toEqual({ ok: true })
    await expect(invokeFunction(originRegistry, 'synthetic.human-only.counted', {}, CALLER_A))
      .resolves.toEqual({ ok: true })
    expect(dispatches).toBe(2)
  })

  // RE-SPELLED from 'refuses AFTER the scope check: a caller missing both is told about scopes
  // first'. A caller missing every scope and the human origin is served.
  it('serves a caller missing every scope and the human origin', async () => {
    const scopeless = { ...CALLER_A_AGENT, grantedScopes: [] } as FunctionCaller
    await expect(invokeFunction(originRegistry, 'synthetic.human-only', {}, scopeless))
      .resolves.toEqual({ ok: true })
  })

  it('never branches on surface: the outcome follows neither origin nor surface', async () => {
    for (const surface of ['cli', 'daemon', 'mcp', 'chat', 'synthetic']) {
      await expect(invokeFunction(originRegistry, 'synthetic.human-only', {}, {
        ...CALLER_A_AGENT,
        surface,
      })).resolves.toEqual({ ok: true })
      await expect(invokeFunction(originRegistry, 'synthetic.human-only', {}, {
        ...CALLER_A,
        surface,
      })).resolves.toEqual({ ok: true })
    }
  })
})

// ---- 432-20: the whole registry, for callers differing only in presentation ---------

/** A deps record whose every port method counts its calls, so "zero effects" is measured. */
function countingDeps(): { readonly deps: FunctionDeps; readonly calls: () => number } {
  let calls = 0
  const wrap = <Port extends object>(port: Port): Port => {
    const wrapped: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(port)) {
      wrapped[key] = typeof value === 'function'
        ? (...args: unknown[]) => {
          calls += 1
          return (value as (...inner: unknown[]) => unknown)(...args)
        }
        : value
    }
    return wrapped as Port
  }
  const deps: FunctionDeps = {
    runs: wrap(DEPS.runs),
    knowledge: wrap(DEPS.knowledge),
    entities: wrap(DEPS.entities),
    config: wrap(DEPS.config),
    secretMask: (text: string) => text,
  }
  return { deps, calls: () => calls }
}

/** One invocation's observable outcome, as comparable data. */
async function outcomeOf(
  registry: ReturnType<typeof createFunctionRegistry>,
  opId: string,
  input: unknown,
  caller: FunctionCaller,
): Promise<{ readonly settled: 'resolved' | 'rejected'; readonly detail: string }> {
  try {
    const value = await invokeFunction(registry, opId, input, caller)
    const isStream = typeof value === 'object' && value !== null && Symbol.asyncIterator in value
    return { settled: 'resolved', detail: isStream ? 'stream' : JSON.stringify(value) }
  } catch (error: unknown) {
    const named = error as { name?: unknown; message?: unknown }
    return { settled: 'rejected', detail: `${String(named.name)}: ${String(named.message)}` }
  }
}

/** The two callers differ in presentation (surface, origin) and in every retired permission field. */
const PRESENTATION_HUMAN = {
  surface: 'cli',
  origin: 'human',
  grantedScopes: ['read', 'run', 'config-write', 'knowledge-write', 'approval-write', 'test-write'],
  safeMode: false,
  credential: CREDENTIAL,
} as FunctionCaller
const PRESENTATION_AGENT: FunctionCaller = { surface: 'mcp', origin: 'agent' }

describe('every operation, every caller', () => {
  it('reaches the same outcome for every registered op whoever calls, and never a permission refusal', async () => {
    const counted = countingDeps()
    const registry = createFunctionRegistry({ deps: counted.deps })
    const ids = registry.list(PRESENTATION_AGENT).map((declaration) => declaration.id)
    expect(ids).toEqual([...ALL_FUNCTION_IDS])

    const permissionRefusals: string[] = []
    for (const opId of ids) {
      const asHuman = await outcomeOf(registry, opId, {}, PRESENTATION_HUMAN)
      const asAgent = await outcomeOf(registry, opId, {}, PRESENTATION_AGENT)
      expect(asAgent, opId).toEqual(asHuman)
      if (/FunctionScopeError|FunctionOriginError|requires a human-origin|lacks required scopes/
        .test(asAgent.detail)) {
        permissionRefusals.push(`${opId}: ${asAgent.detail}`)
      }
      if (asAgent.settled === 'rejected') {
        // The ordinary refusals: the strict input contract, the binding check, or the op's own
        // dependency answering. Never a refusal about who is calling.
        expect(asAgent.detail, opId).not.toMatch(/scope|origin/i)
      }
    }
    expect(permissionRefusals).toEqual([])
  })

  it('serves a bound read to both callers with identical results', async () => {
    const asHuman = await invokeFunction(REGISTRY, 'runs.list', {}, PRESENTATION_HUMAN)
    const asAgent = await invokeFunction(REGISTRY, 'runs.list', {}, PRESENTATION_AGENT)
    expect(asAgent).toEqual(asHuman)
    expect((asAgent as RunSummary[]).map((summary) => summary.runId)).toEqual(['run-beta', 'run-alpha'])
  })
})

describe('empty and null input', () => {
  it('refuses a null input to every op through its strict schema, with zero dependency calls', async () => {
    const counted = countingDeps()
    const registry = createFunctionRegistry({ deps: counted.deps })
    for (const declaration of registry.list(PRESENTATION_AGENT)) {
      await expect(invokeFunction(registry, declaration.id, null, PRESENTATION_AGENT), declaration.id)
        .rejects.toBeInstanceOf(FunctionInputError)
      await expect(invokeFunction(registry, declaration.id, null, PRESENTATION_HUMAN), declaration.id)
        .rejects.toBeInstanceOf(FunctionInputError)
    }
    // Zero reads, writes or starts: no port method was reached.
    expect(counted.calls()).toBe(0)
  })

  it('refuses an empty input to an op with a required field with zero starts', async () => {
    const counted = countingDeps()
    const registry = createFunctionRegistry({ deps: counted.deps })
    await expect(invokeFunction(registry, 'runs.get', {}, PRESENTATION_AGENT))
      .rejects.toBeInstanceOf(FunctionInputError)
    await expect(invokeFunction(registry, 'runs.start', null, PRESENTATION_AGENT))
      .rejects.toBeInstanceOf(FunctionInputError)
    expect(counted.calls()).toBe(0)
  })

  it('answers an optional empty read with its typed empty shape for every caller', async () => {
    const emptyRegistry = createFunctionRegistry({
      deps: { ...DEPS, runs: { ...DEPS.runs, list: () => Promise.resolve([]) } },
    })
    for (const caller of [PRESENTATION_HUMAN, PRESENTATION_AGENT]) {
      await expect(invokeFunction(emptyRegistry, 'runs.list', {}, caller)).resolves.toEqual([])
      await expect(invokeFunction(emptyRegistry, 'knowledge.bundles.list', {}, caller))
        .resolves.toEqual([])
    }
  })
})
