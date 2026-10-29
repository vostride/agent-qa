// The standing-grant spine, end to end through the real composition (Phase 391, PROP-01 / D-11).
//
// RE-SPELLED 2026-10-01 (432-18, D-14/D-15/D-22): the append API, the event types and the ledger are
// deleted. The grant and its revoke are now planted as the bytes a pre-432 build committed, and
// the claim is unchanged: the change commits with no grant, a grant or revoke changes nothing about
// it, and the old file is left byte-identical (nothing reads or rewrites it).
//
// 2026-10-01 (432-17, D-05): the apply this spine was built around (`knowledge.proposal.apply`) is
// deleted with the inbox, so the subject is the direct `knowledge.forget` that replaced it. Every
// claim below keeps its shape: the change commits with no grant, and a grant or revoke changes
// nothing about it.
//
// 2026-09-30 (432-13, D-14/D-15): THE SPINE HAS NO READER. `invokeFunction` has no gate, so no grant
// is consulted: the headless apply commits with no grant, and appending a grant or a revoke changes
// nothing about it. The two cells are re-spelled as that absence; the ledger's own append-only
// property (both events survive, in order) is unchanged. 432-18 deletes the ledger.
//
// WHAT THIS FILE PROVES, and why it is one file rather than three. Before 391 no standing approval
// could be consumed through the function layer at all, for two independent reasons that would each
// have hidden the other:
//
//   1. `invokeFunction` called the gate with no reader and no action scope. The gate defaults an
//      absent scope to the empty object, and the scope comparison refuses an empty scope on EITHER
//      side, so every grant would have failed to match whatever a reader returned.
//   2. `knowledge.proposal.apply` classified to the recognized-mutating floor, whose base verdict
//      ALLOWS in every context. A standing approval can only ever satisfy an ASK, so there was no
//      ask for it to satisfy on the one verb in this layer that commits.
//
// Fixing either alone would have measured nothing. So the three legs below run against ONE live
// composition, in order, over ONE committed ledger:
//
//   leg 1  no grant recorded          -> the apply is REFUSED before dispatch
//   leg 2  a grant appended through the REAL append API -> the same apply COMMITS, and the audit
//                                        row names `standing-approval` as what satisfied the ask
//   leg 3  a revoke appended for the same grant id      -> the same apply is REFUSED again
//
// NOTHING IS HAND-WRITTEN INTO THE LEDGER. The grant and the revoke both go through
// `appendGrantLedgerEvents`, which is the function the mint verb will call in plan 04 — a JSONL line
// typed out by a test is a line no producer can necessarily emit, and a fixture like that pins a
// contract nothing actually has to satisfy. For the same reason the covered action class is READ OFF
// the registry's own declaration of the op rather than spelled here: the gate compares the grant's
// class against the op's action name with `===`, and a literal in this file would keep matching a
// name the op had stopped carrying.
//
// The execution context is pinned to `local-headless`, which is the module default anyway, so leg 1
// and leg 3 land on the fail-closed arm rather than on an interactive prompt. That is the honest
// posture to pin: the two hosts that run this composition in anger — CI and the daemon — are both
// fail-closed, and a test that pinned the prompt arm would be pinning the one context neither of
// them is ever in.

import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createFunctionRegistry,
  invokeFunction,
} from '@vostride/agent-qa-agent'
import type { FunctionRegistry } from '@vostride/agent-qa-agent'
import {
  publishBundleForTest,
  type BundleStoreConfig,
} from '@vostride/agent-qa-knowledge-local'
import {
  MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
} from '@vostride/agent-qa-schema'
import type {
  Anchor,
  FunctionCaller,
  KnowledgeChangeOutput,
  MaskedResolvedConfig,
} from '@vostride/agent-qa-schema'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  createKnowledgeReader,
  createKnowledgeReview,
  createRunsReader,
} from '../composition/compose-local-agent.js'

const APPLY_FUNCTION_ID = 'knowledge.forget'
const GRANT_ID = 'grant_tracer_proposal_apply'
const GRANTED_AT = '2026-08-07T12:00:00.000Z'
const REVOKED_AT = '2026-08-07T12:30:00.000Z'
// 2026-10-01 (432-21, D-12): `STANDING_APPROVAL_SCOPE` is deleted with the MCP bearer credential; a
// legacy grant line still carries the scope it was minted under, spelled here as its bytes.
const LEGACY_GRANT_SCOPE = { project: 'local-workspace' } as const

const ANCHOR: Anchor = { t: 'el', role: 'Button', name: 'Checkout' }

const MASKED_CONFIG: MaskedResolvedConfig = {
  schemaVersion: MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
  configPath: '/fixture/agent-qa.config.yaml',
  entries: [],
}

/** Granted EVERY scope, so a refusal below can only ever be the policy gate's. */
const CALLER: FunctionCaller = {
  surface: 'test',
  origin: 'agent',
}

describe('a committed standing grant is consumed by nothing', () => {
  let root: string
  let knowledgeRoot: string
  let agentQaRoot: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'grant-spine-'))
    knowledgeRoot = join(root, 'agent-qa-knowledge')
    agentQaRoot = join(root, '.agent-qa')
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function storeConfig(): BundleStoreConfig {
    return {
      knowledgeRoot,
      productKey: 'Grant Spine Product',
    }
  }

  /** A real published record, so the proposal below has something real to be about. */
  function publish(): string {
    const outcome = publishBundleForTest(storeConfig(), {
      draft: {
        kind: 'fact',
        subtype: 'selector',
        anchors: [ANCHOR],
        scope: { tier: 'product', key: 'grant-spine' },
        summary: 'checkout button',
        body: 'Selecting Checkout advances to the payment page.',
        distilledEvidenceRef: { id: 'grant-spine-evidence', sha: 'a'.repeat(64) },
        originStage: 'run-curation',
      },
      discriminant: {
        kind: 'fact',
        subtype: 'selector',
        elementRef: { role: 'Button', name: 'Checkout' },
      },
      originClass: 'agent-verified',
      createdAtOrdinal: 9,
      screenStates: [],
      initialEvents: [],
      relations: [],
      provenance: { mode: 'run-linked', runId: 'grant-spine', testId: 't', stepIndex: 0 },
      artifacts: [],
    })
    if (outcome.kind !== 'published') throw new Error(`fixture publish failed: ${outcome.kind}`)
    return outcome.id
  }

  /**
   * The composition under test. The reader is the REAL one over the REAL committed ledger, so every
   * leg below changes the gate's answer by changing a file rather than by changing a stub.
   */
  function host(): FunctionRegistry {
    return createFunctionRegistry({
      deps: {
        runs: createRunsReader(agentQaRoot),
        knowledge: createKnowledgeReader(() => knowledgeRoot),
        config: { getMasked: () => Promise.resolve(MASKED_CONFIG) },
        entities: {
          resolve: () => Promise.resolve({ kind: 'none' as const, reason: 'no-match' as const }),
          get: () => Promise.resolve(undefined),
        },
        knowledgeReview: createKnowledgeReview({
          agentQaRoot,
          resolveKnowledgeRoot: () => knowledgeRoot,
        }),
      },
    })
  }

  /**
   * The class the gate will compare against, taken from the op's OWN declaration.
   *
   * This is the produced-not-literal rule applied to the one field the whole loop turns on. The
   * declaration view carries `risk.name`, which is exactly the string `grantCovers` compares, so a
   * grant minted from it is a grant that can match by construction — and if the op ever renames
   * itself, this fixture follows it instead of quietly ceasing to cover anything.
   */
  function coveredActionClass(registry: FunctionRegistry): string {
    const declaration = registry.list(CALLER).find((entry) => entry.id === APPLY_FUNCTION_ID)
    if (declaration === undefined) throw new Error(`${APPLY_FUNCTION_ID} is not registered`)
    return declaration.risk.name
  }

  /** A legacy ledger line, as the bytes a pre-432 build committed. Nothing in this build reads it. */
  type LegacyEvent = Record<string, unknown> & { kind: 'grant' | 'revoke'; grantId: string }

  function ledgerPath(): string {
    return join(knowledgeRoot, 'grants.jsonl')
  }

  function append(events: readonly LegacyEvent[]): void {
    mkdirSync(knowledgeRoot, { recursive: true })
    appendFileSync(ledgerPath(), events.map((event) => `${JSON.stringify(event)}\n`).join(''), 'utf8')
  }

  // RE-SPELLED 2026-09-30 (432-13) from 'refuses the apply with no grant, commits it with one, and
  // refuses it again after the revoke'. The apply commits with no grant at all, and the grant and
  // revoke append to a ledger nothing reads.
  it('commits the headless apply with no grant, and the ledger is never consulted', async () => {
    const recordId = publish()
    const registry = host()
    const actionClass = coveredActionClass(registry)
    expect(actionClass).toBe(`fn:${APPLY_FUNCTION_ID}`)

    const input = { target: { grain: 'record' as const, recordId } }

    // ── LEG 1: no grant recorded, no ledger file — and the change commits in the call.
    const applied = (await invokeFunction(
      registry,
      APPLY_FUNCTION_ID,
      input,
      CALLER,
    )) as KnowledgeChangeOutput
    expect(applied.outcome).toBe('applied')

    // ── LEG 2/3: a grant and then its revoke, as committed bytes. Neither is read.
    append([
      {
        schemaVersion: 1,
        kind: 'grant',
        at: GRANTED_AT,
        grantId: GRANT_ID,
        actionClass,
        scope: LEGACY_GRANT_SCOPE,
      },
    ])
    append([
      {
        schemaVersion: 1,
        kind: 'revoke',
        at: REVOKED_AT,
        grantId: GRANT_ID,
      },
    ])

    // The record is tombstoned now, so the same call answers the already-tombstoned state: the
    // answer is dispatch's.
    await expect(
      invokeFunction(registry, APPLY_FUNCTION_ID, input, CALLER),
    ).resolves.toBeDefined()

    // The committed artifact still holds BOTH events, in the order they happened.
    const committed = readFileSync(ledgerPath(), 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as LegacyEvent)
    expect(committed.map((event) => event.kind)).toEqual(['grant', 'revoke'])
    expect(committed.map((event) => event.grantId)).toEqual([GRANT_ID, GRANT_ID])
  }, 60_000)

  // RE-SPELLED 2026-09-30 (432-13) from 'leaves the apply refused when a grant covers a DIFFERENT
  // action class'. No grant is matched against anything, so a neighbouring class leaves the apply
  // committing exactly as no grant does.
  it('commits the apply whatever class a committed grant names', async () => {
    const recordId = publish()
    const registry = host()
    append([
      {
        schemaVersion: 1,
        kind: 'grant',
        at: GRANTED_AT,
        grantId: 'grant_tracer_neighbouring_class',
        actionClass: 'fn:knowledge.reject',
        scope: LEGACY_GRANT_SCOPE,
      },
    ])
    const before = readFileSync(ledgerPath(), 'utf8')

    const applied = (await invokeFunction(
      registry,
      APPLY_FUNCTION_ID,
      { target: { grain: 'record', recordId } },
      CALLER,
    )) as KnowledgeChangeOutput
    expect(applied.outcome).toBe('applied')
    expect(readFileSync(ledgerPath(), 'utf8'), 'the old ledger was rewritten').toBe(before)
  }, 60_000)
})
