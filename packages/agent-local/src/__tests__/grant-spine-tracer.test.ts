// Planted legacy grant and revoke bytes change nothing: the change commits and the file stays.

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
// A legacy grant line carries its minting scope, spelled here as its bytes.
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

  /** A legacy ledger line, as committed bytes. Nothing in this build reads it. */
  type LegacyEvent = Record<string, unknown> & { kind: 'grant' | 'revoke'; grantId: string }

  function ledgerPath(): string {
    return join(knowledgeRoot, 'grants.jsonl')
  }

  function append(events: readonly LegacyEvent[]): void {
    mkdirSync(knowledgeRoot, { recursive: true })
    appendFileSync(ledgerPath(), events.map((event) => `${JSON.stringify(event)}\n`).join(''), 'utf8')
  }

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
