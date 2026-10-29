// Whatever state an old `grants.jsonl` is in, the headless change dispatches and the file stays.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  UnknownFunctionError,
  createFunctionRegistry,
  invokeFunction,
} from '@vostride/agent-qa-agent'
import type { FunctionRegistry } from '@vostride/agent-qa-agent'
import * as knowledgeLocal from '@vostride/agent-qa-knowledge-local'
import {
  MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
} from '@vostride/agent-qa-schema'
import type {
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

const APPLY_ID = 'knowledge.accept'
const GRANTS_LIST_ID = 'grants.list'

// Spelled as the bytes a legacy ledger line holds; the candidate is computed against them.
const UNKNOWN_SCOPE_KEY_CANDIDATES = ['tenant', 'workspace', 'region', 'cell'] as const
const LEGACY_SCOPE_KEYS: readonly string[] = ['project', 'org']

function anUnknownScopeKey(): string {
  const declared = LEGACY_SCOPE_KEYS
  const found = UNKNOWN_SCOPE_KEY_CANDIDATES.find((candidate) => !declared.includes(candidate))
  if (found === undefined) {
    throw new Error(
      `every candidate scope key (${UNKNOWN_SCOPE_KEY_CANDIDATES.join(', ')}) is now legal in ` +
        `the legacy key set (${declared.join(', ')}); add a candidate rather than letting these cases pass`,
    )
  }
  return found
}

/** What a merge leaves behind when two branches both appended: a marker fused onto a real line. */
const CONFLICT_MARKER = '<<<<<<< HEAD'

const GRANT = '{"schemaVersion":1,"kind":"grant","at":"2026-08-08T12:00:00.000Z","grantId":"grant_damage_case","actionClass":"fn:knowledge.accept","scope":{"project":"local-workspace"}}'
const SIBLING = '{"schemaVersion":1,"kind":"grant","at":"2026-08-08T12:00:00.000Z","grantId":"grant_damage_sibling","actionClass":"fn:knowledge.forget","scope":{"project":"local-workspace"}}'
const REVOKE = '{"schemaVersion":1,"kind":"revoke","at":"2026-08-08T12:30:00.000Z","grantId":"grant_damage_case"}'
const UNKNOWN_KEY = `{"schemaVersion":1,"kind":"grant","at":"2026-08-08T12:00:00.000Z","grantId":"grant_unknown_key","actionClass":"fn:knowledge.accept","scope":{"project":"local-workspace","${anUnknownScopeKey()}":"smuggled"}}`

/** The ledger states the deleted reader and listing distinguished, as the bytes earlier builds left. */
const LEDGER_STATES = [
  ['CASE 1 — intact ledger, grant in force', `${GRANT}\n${SIBLING}\n`],
  ['CASE 2 — intact ledger, the grant revoked', `${GRANT}\n${SIBLING}\n${REVOKE}\n`],
  ['CASE 3 — the revoke line damaged in place', `${GRANT}\n${SIBLING}\n${CONFLICT_MARKER}${REVOKE}\n`],
  ['a grant line whose scope carries an UNKNOWN key', `${UNKNOWN_KEY}\n${SIBLING}\n`],
] as const

const MASKED_CONFIG: MaskedResolvedConfig = {
  schemaVersion: MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
  configPath: '/fixture/agent-qa.config.yaml',
  entries: [],
}

/** A person holding every scope, so a refusal below can only ever be the layer's. */
const HUMAN: FunctionCaller = {
  surface: 'test',
  origin: 'human',
}

describe('a grant ledger the build cannot fully read authorizes nothing, because nothing reads it', () => {
  let root: string
  let knowledgeRoot: string
  let agentQaRoot: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'grant-damage-'))
    knowledgeRoot = join(root, 'agent-qa-knowledge')
    agentQaRoot = join(root, '.agent-qa')
    mkdirSync(agentQaRoot, { recursive: true })
    mkdirSync(knowledgeRoot, { recursive: true })
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  /** The composition under test: the real readers and the real direct change door, no grant port. */
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
    })
  }

  function ledger(): string {
    return join(knowledgeRoot, 'grants.jsonl')
  }

  /** The direct change, asked the way a headless run asks it. */
  async function headlessApply(registry: FunctionRegistry): Promise<KnowledgeChangeOutput> {
    return (await invokeFunction(
      registry,
      APPLY_ID,
      { target: { grain: 'record', recordId: 'rec-never-published' } },
      HUMAN,
    )) as KnowledgeChangeOutput
  }

  it('the control: with no ledger file at all, the headless invocation is dispatched, with no row', async () => {
    const answered = await headlessApply(host('local-headless'))
    expect(answered.outcome).toBe('target-not-found')
    expect(existsSync(ledger()), 'a ledger was created where none existed').toBe(false)
  })

  for (const [name, bytes] of LEDGER_STATES) {
    it(`${name}: the headless invocation is dispatched exactly as with no file, and the file is untouched`, async () => {
      writeFileSync(ledger(), bytes, 'utf8')
      const answered = await headlessApply(host('local-headless'))
      expect(answered.outcome).toBe('target-not-found')
      expect(readFileSync(ledger(), 'utf8')).toBe(bytes)
    })

    it(`${name}: grants.list is an unknown function, and the file is untouched`, async () => {
      writeFileSync(ledger(), bytes, 'utf8')
      await expect(invokeFunction(host('local-headless'), GRANTS_LIST_ID, {}, HUMAN))
        .rejects.toBeInstanceOf(UnknownFunctionError)
      expect(readFileSync(ledger(), 'utf8')).toBe(bytes)
    })
  }

  it('no grant reader, writer or verb is exported to the composition', () => {
    const exported = Object.keys(knowledgeLocal)
    for (const name of [
      'createGrantOperations', 'createStandingApprovalReader', 'readGrantLedger', 'grantsLedgerPath',
      'appendGrantLedgerEvents', 'GrantLedgerDamagedError',
    ]) {
      expect(exported, name).not.toContain(name)
    }
    expect(host('local-headless').list(HUMAN).map((entry) => entry.id).filter((id) => id.startsWith('grants.')))
      .toEqual([])
  })
})
