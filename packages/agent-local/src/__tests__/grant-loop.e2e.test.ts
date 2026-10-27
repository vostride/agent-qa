// THE grant loop, end to end over one composition and one committed ledger (Phase 391, PROP-01).
//
// 2026-09-30 (432-13, D-14/D-15): THE LOOP HAS NO CONSUMER. `invokeFunction` reads no standing
// approval, asks no confirm port and writes no decision row.
//
// 2026-10-01 (432-17, D-05/D-22): THE LOOP HAS NO MINT EITHER. The only door that wrote a grant was
// `proposals.accept`'s always form, deleted with the inbox (C432-NO-PROPOSAL-OPS).
//
// RE-SPELLED 2026-10-01 (432-18, D-14/D-15/D-22): THE LOOP HAS NO VERBS. `grants.list` and
// `grants.revoke` are deleted with the ledger, so the revoke half this file kept after 432-17 (a
// revoke appends rather than rewrites, an agent-origin revoke is refused before dispatch, a headless
// revoke runs with no confirmation) lost its subject. What is measured instead, over the same
// composition: neither grant id is a capability of the host, every door refuses both as unknown
// functions, a workspace's old `grants.jsonl` is left byte-identical, and a headless direct change
// still runs with no confirmation.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  UnknownFunctionError,
  createFunctionRegistry,
  invokeFunction,
} from '@vostride/agent-qa-agent'
import type { FunctionRegistry } from '@vostride/agent-qa-agent'
import { publishBundleForTest } from '@vostride/agent-qa-knowledge-local'
import type { BundleStoreConfig } from '@vostride/agent-qa-knowledge-local'
import {
  MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
} from '@vostride/agent-qa-schema'
import type {
  Anchor,
  ExecutionContext,
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

/** The deleted grant verbs, spelled as a caller spells them, each with an input its contract took. */
const RETIRED_GRANT_DOORS = [
  ['grants.list', {}],
  ['grants.revoke', { grantId: 'grant_loop_revoke' }],
] as const
/** The deleted mint door and the apply its grants covered, spelled as a caller spells them. */
const RETIRED_DOORS = ['proposals.accept', 'knowledge.proposal.apply', 'proposals.list'] as const

const ANCHOR: Anchor = { t: 'el', role: 'Button', name: 'Checkout' }

const MASKED_CONFIG: MaskedResolvedConfig = {
  schemaVersion: MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
  configPath: '/fixture/agent-qa.config.yaml',
  entries: [],
}

/** A person holding every scope, so a refusal below can only ever be origin's. */
const HUMAN: FunctionCaller = {
  surface: 'test',
  origin: 'human',
}

/** The same permissions, on behalf of the agent. ONLY `origin` differs. */
const AGENT: FunctionCaller = { ...HUMAN, origin: 'agent' }

/** An old ledger as a pre-432 build left it: a grant and its revoke, plus a damaged line. */
const LEGACY_LEDGER_BYTES = [
  '{"schemaVersion":1,"kind":"grant","at":"2026-08-07T12:00:00.000Z","grantId":"grant_loop_revoke","actionClass":"fn:knowledge.forget","scope":{"project":"local-workspace"}}',
  '{"schemaVersion":1,"kind":"revoke","at":"2026-08-07T12:30:00.000Z","grantId":"grant_loop_revoke"}',
  '<<<<<<< HEAD{"schemaVersion":1,"kind":"grant","at"',
  '',
].join('\n')

describe('C432-NO-GRANT-OPS: the grant loop has no verbs left on the composed host', () => {
  let root: string
  let knowledgeRoot: string
  let agentQaRoot: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'grant-loop-'))
    knowledgeRoot = join(root, 'agent-qa-knowledge')
    agentQaRoot = join(root, '.agent-qa')
    mkdirSync(agentQaRoot, { recursive: true })
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function storeConfig(): BundleStoreConfig {
    return {
      knowledgeRoot,
      productKey: 'Grant Loop Product',
    }
  }

  /** A real published record, so each proposal below has something real to be about. */
  function publish(seed: string): string {
    const outcome = publishBundleForTest(storeConfig(), {
      draft: {
        kind: 'fact',
        subtype: 'selector',
        anchors: [ANCHOR],
        scope: { tier: 'product', key: `grant-loop-${seed}` },
        summary: `checkout button ${seed}`,
        body: `Selecting Checkout advances to the payment page (${seed}).`,
        distilledEvidenceRef: { id: `grant-loop-${seed}`, sha: 'a'.repeat(64) },
        originStage: 'run-curation',
      },
      discriminant: {
        kind: 'fact',
        subtype: 'selector',
        elementRef: { role: 'Button', name: `Checkout ${seed}` },
      },
      originClass: 'agent-verified',
      createdAtOrdinal: 9,
      screenStates: [],
      initialEvents: [],
      relations: [],
      provenance: { mode: 'run-linked', runId: 'grant-loop', testId: 't', stepIndex: 0 },
      artifacts: [],
    })
    if (outcome.kind !== 'published') throw new Error(`fixture publish failed: ${outcome.kind}`)
    return outcome.id
  }

  /** The composition under test: the real readers and the real direct knowledge change door. */
  // 2026-10-02 (432-39, D-12): the registry takes no context; `_context` names the posture a cell
  // describes and reaches nothing.
  function host(_context: ExecutionContext): FunctionRegistry {
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
      // 432-13: no standing-approval reader and no confirm port — `invokeFunction` asks nobody.
    })
  }

  function legacyLedger(): string {
    return join(knowledgeRoot, 'grants.jsonl')
  }

  function plantLegacyLedger(): void {
    mkdirSync(knowledgeRoot, { recursive: true })
    writeFileSync(legacyLedger(), LEGACY_LEDGER_BYTES, 'utf8')
  }

  it('C432-NO-PROPOSAL-OPS: the mint door and the apply it covered are not capabilities of this host', async () => {
    const interactive = host('local-interactive')
    publish('retired')
    const ids = interactive.list(HUMAN).map((entry) => entry.id)
    expect(RETIRED_DOORS.filter((id) => ids.includes(id))).toEqual([])
    for (const id of RETIRED_DOORS) {
      await expect(invokeFunction(interactive, id, {}, HUMAN), id).rejects.toBeInstanceOf(UnknownFunctionError)
    }
    expect(existsSync(legacyLedger())).toBe(false)
  })

  // RE-SPELLED 2026-10-01 (432-18) from 'revokes by appending: both events survive, in order': the
  // revoke verb is deleted, so neither grant id is listed and both answer as unknown functions.
  it('C432-NO-GRANT-OPS: neither grant verb is listed, and both are unknown functions on every context', async () => {
    plantLegacyLedger()
    for (const context of ['local-interactive', 'local-headless', 'ci', 'cloud'] as const) {
      const registry = host(context)
      const ids = registry.list(HUMAN).map((entry) => entry.id)
      expect(ids.length, `${context}: the listing is empty, so the absence is vacuous`).toBeGreaterThan(0)
      expect(ids.filter((id) => id.startsWith('grants.')), context).toEqual([])
      for (const [id, input] of RETIRED_GRANT_DOORS) {
        await expect(invokeFunction(registry, id, input, HUMAN), `${context} ${id}`)
          .rejects.toBeInstanceOf(UnknownFunctionError)
      }
    }
    expect(readFileSync(legacyLedger(), 'utf8')).toBe(LEGACY_LEDGER_BYTES)
  }, 120_000)

  // RE-SPELLED 2026-10-01 (432-18) from 'refuses an agent-origin revoke, leaving the committed ledger
  // untouched': there is no revoke to refuse. Agent and human origin get the same unknown-function
  // answer, and the old ledger is untouched either way.
  it('C432-NO-GRANT-OPS: an agent-origin and a human-origin revoke get the same unknown-function answer', async () => {
    plantLegacyLedger()
    const interactive = host('local-interactive')
    for (const caller of [AGENT, HUMAN]) {
      await expect(invokeFunction(interactive, 'grants.revoke', { grantId: 'grant_loop_revoke' }, caller), caller.origin)
        .rejects.toBeInstanceOf(UnknownFunctionError)
    }
    expect(readFileSync(legacyLedger(), 'utf8')).toBe(LEGACY_LEDGER_BYTES)
  }, 120_000)

  // RE-SPELLED 2026-10-01 (432-18): the headless revoke this cell drove is deleted. The surviving
  // claim — a decision verb runs headless with no confirmation — is measured on the direct change,
  // beside an old ledger that names a grant for exactly that class.
  it('C432-INVOKE-DIRECT: both decision verbs run in a headless context with no confirmation', async () => {
    plantLegacyLedger()
    const recordId = publish('headless')
    const headless = host('local-headless')
    const changed = (await invokeFunction(
      headless,
      'knowledge.forget',
      { target: { grain: 'record', recordId } },
      HUMAN,
    )) as KnowledgeChangeOutput
    expect(changed).toMatchObject({ outcome: 'applied', recordIds: [recordId] })
    expect(readFileSync(legacyLedger(), 'utf8')).toBe(LEGACY_LEDGER_BYTES)
  }, 120_000)
})
