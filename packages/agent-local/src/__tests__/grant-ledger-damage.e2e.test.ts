// A damaged grant ledger authorizes NOTHING, proven through the composed host
// (Phase 391 plan 08, closing 391-VERIFICATION gap 2).
//
// 2026-09-30 (432-13, D-14/D-15): NO LEDGER AUTHORIZES ANYTHING NOW. `invokeFunction` has no gate, so
// the headless invocation is dispatched whatever the ledger holds and no decision row is written.
//
// RE-SPELLED 2026-10-01 (432-18, D-14/D-15/D-22): NOTHING READS THE LEDGER NOW. The reader, the
// listing (`grants.list`) and the two write verbs (record, revoke) are deleted with the ledger, so
// the cells that measured the reader's refusal of a damaged file, the listing's damage report and
// the write verbs' `GrantLedgerDamagedError` lost their subject. The write-side refusals moved to the
// direct writers (knowledge-local `grants/__tests__/ledger.test.ts`, C432-GRANTS-UNREAD-WRITER-ABSENT).
// What this file keeps is the composed half of the claim, over the same three cases and the same
// unknown-scope-key line: whatever state the old `grants.jsonl` is in — intact, revoked, damaged in
// place or carrying a key the wire contract never admitted — the headless direct change is
// dispatched exactly as it is with no file at all, the listing verb is an unknown function, and the
// file is left byte-identical.
//
// THE SUBJECT is `knowledge.accept` over a record that was never published (432-17): it answers a
// typed `target-not-found` without writing, so an invocation that resolves is the dispatch this file
// asks about.

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

/**
 * A scope key OUTSIDE the legacy key set. 2026-10-02 (432-42, D-12): the published constant is
 * deleted, so the two legacy keys a pre-432 ledger line could carry are spelled here as the bytes
 * such a line holds, and the candidate is still computed against them rather than typed.
 */
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
    // RE-SPELLED 2026-10-01 (432-18): each of these was a reader/listing/write-verb differential over
    // the same bytes. The invocation answers exactly as the no-file control does.
    it(`${name}: the headless invocation is dispatched exactly as with no file, and the file is untouched`, async () => {
      writeFileSync(ledger(), bytes, 'utf8')
      const answered = await headlessApply(host('local-headless'))
      expect(answered.outcome).toBe('target-not-found')
      expect(readFileSync(ledger(), 'utf8')).toBe(bytes)
    })

    // RE-SPELLED 2026-10-01 (432-18) from "`grants.list` carries the explanation the denial does
    // not" and "`grants.list` RESOLVES, naming the refused line beside the grant that folds": there is
    // no listing to explain anything; it is an unknown function and the file stays as it was.
    it(`${name}: grants.list is an unknown function, and the file is untouched`, async () => {
      writeFileSync(ledger(), bytes, 'utf8')
      await expect(invokeFunction(host('local-headless'), GRANTS_LIST_ID, {}, HUMAN))
        .rejects.toBeInstanceOf(UnknownFunctionError)
      expect(readFileSync(ledger(), 'utf8')).toBe(bytes)
    })
  }

  // RE-SPELLED 2026-10-01 (432-18) from 'the write verbs still refuse by THROWING, not by answering
  // an arm': the write verbs are deleted, so the composition binds no grant port at all.
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
