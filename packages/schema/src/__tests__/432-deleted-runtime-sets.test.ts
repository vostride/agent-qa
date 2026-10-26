// 2026-09-30, 432-09 (D-03/D-04/D-15/D-22/D-25): the runtime key sets beside the types they pin.
//
// First created by 432-09, which narrows the mark, marks-history, preview, digest and run-knowledge
// outputs to applied changes and the mark refusal to a plain reason. Later owners (432-18/19/22/39/42)
// extend this file with their own removed members only. Every expected set is spelled by hand, so no
// expectation is derived from the production value it checks.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import * as schema from '../index'
import * as safety from '../safety/index'

type Shaped = { shape: Record<string, { value?: unknown }> }
type Options = { options: readonly Shaped[] }

const keysOf = (value: unknown): string[] => Object.keys((value as Shaped).shape).sort()
const armOf = (union: unknown, key: string, literal: string): Shaped | undefined =>
  (union as Options).options.find(option => option.shape[key]?.value === literal)
const sorted = (values: readonly string[]) => [...values].sort()
const exported = (name: string) => (schema as Record<string, unknown>)[name]

describe('432-09 applied output key sets', () => {
  it('C432-RUNTIME-SETS: marks, history, preview, digest and run knowledge carry applied changes and no inbox member', () => {
    // 2026-10-03 (quick 261003-mqc): `not-applied` closes a mark whose planned fix was refused.
    expect(exported('MARK_DISPOSITIONS'), 'the written dispositions')
      .toEqual(['quarantined', 'applied', 'no-draftable-fix', 'confirmed-bug', 'not-applied'])
    expect(exported('MARK_HISTORICAL_DISPOSITIONS'), 'read, never written').toEqual(['drafted'])
    expect(exported('MARK_APPLIED_CHANGE_KINDS')).toEqual(['knowledge', 'test-file'])

    const dispositions = exported('MarkDispositionSchema')
    expect(armOf(dispositions, 'kind', 'applied'), 'the applied arm').toBeDefined()
    expect((dispositions as Options).options.map(option => option.shape.kind!.value))
      .toEqual(['quarantined', 'applied', 'no-draftable-fix', 'confirmed-bug', 'not-applied', 'drafted'])
    expect(keysOf(armOf(dispositions, 'kind', 'applied')), 'an applied fix names its change, never a proposal')
      .toEqual(sorted(['kind', 'fix', 'change']))

    const changes = exported('MarkAppliedChangeSchema')
    expect(keysOf(armOf(changes, 'kind', 'knowledge'))).toEqual(sorted(['kind', 'changeId', 'recordIds']))
    expect(keysOf(armOf(changes, 'kind', 'test-file'))).toEqual(sorted(['kind', 'filePath', 'contentDigest']))

    expect(keysOf(exported('MarkHistoryEntrySchema')), 'history projects the applied change, not an inbox state')
      .toEqual(sorted([
        'markId', 'runId', 'testIndex', 'testId', 'stepIndex', 'kind', 'origin', 'ordinal', 'markedAt',
        'rootCause', 'isRerun', 'disposition', 'evidence', 'supersedes', 'note',
        'active', 'supersededBy', 'changedRecords',
      ]))

    const preview = exported('RunsMarkPreviewResultSchema')
    expect(keysOf(armOf(preview, 'kind', 'consequences')), 'a later mark withdraws nothing')
      .toEqual(sorted([
        'kind', 'runId', 'prospective', 'markKind', 'member', 'resolvedStep', 'latest', 'basis',
        'knowledge', 'draft',
      ]))

    expect(keysOf(exported('RunDigestSchema')), 'the digest reads applied mark changes, never the inbox')
      .toEqual(sorted([
        'runId', 'verdictClusters', 'chain', 'markChanges', 'candidates', 'quarantine', 'lines',
      ]))
    expect(keysOf(exported('RunDigestMarkChangeSchema'))).toEqual(sorted(['markId', 'ordinal', 'fix', 'change']))

    expect(keysOf(armOf(exported('RunKnowledgeProjectionSchema'), 'kind', 'ready')), 'no pending inbox count')
      .toEqual(sorted([
        'kind', 'runId', 'buildOrdinal', 'knowledgeStore', 'retrievalRung', 'steps', 'curation', 'learned',
      ]))

    for (const name of [
      'MARK_PROPOSAL_STATES', 'MarkProposalCurrentSchema', 'MarkPreviewWithdrawalSchema',
      'RunDigestProposalRowSchema',
    ]) expect(exported(name), `${name} is gone from the schema barrel`).toBeUndefined()
  })

  // RE-SPELLED 2026-10-02 (432-42, D-15) under the same title: the 403 refusal body this pinned had
  // one producer, the execution gate's denial (deleted by 432-19), so the DTO is deleted with the
  // dashboard branch that read it. A failed mark is now an ordinary refusal of the request, and no
  // mark contract carries anything a caller must act on.
  it('C432-PLAIN-REFUSAL: a refused mark answers a plain reason and nothing a caller must act on', () => {
    expect(exported('MarkRefusalSchema'), 'the gate-era mark refusal DTO is published again').toBeUndefined()
    expect(Object.keys(schema).filter((name) => /Mark(Refusal|Denied|Denial)/u.test(name))).toEqual([])
    expect(exported('RunsMarkOutcomeSchema'), 'non-vacuity: the mark outcome contract is the real one').toBeDefined()
  })
})

// 2026-10-01, 432-18 (D-03/D-14/D-15/D-22): the standing-grant ledger, the grant op contracts, the
// protected-class set and the chat pin overlay leave the schema. Two members stayed on purpose, each
// until its last consumer leaves: `StandingApprovalGrant` (type only, `standing-approval.ts`) for the
// safety ports, and `TrustScopeSchema` (`grant-ops.ts`) for the run-service DTO 432-22 deletes.
// 2026-10-01, 432-19 (D-03/D-15): the safety gate, its standing-approval reader and its scope check
// are deleted, so `StandingApprovalGrant` and `standing-approval.ts` leave with them and the census
// below now asserts their absence. TrustScopeSchema stays until 432-22. `STANDING_APPROVAL_SCOPE` was the scope the MCP bearer credential carried
// (`cli/src/composition/mcp-token-resolution.ts`), so it moved beside `TrustScope` and stayed until the
// token owner removed that credential. 2026-10-01, 432-21 (D-12): the resolver and the bearer credential
// are deleted, so the constant joins the absence set below. 2026-10-01, 432-22 (D-03/D-12): the
// run-service token DTO, `TrustScopeSchema`'s last consumer, is deleted with its config key, so the
// projection, its module and its barrel exports join the absence set too. The `TrustScope` and
// `TrustCredential` caller types stayed until 432-39, which deletes them (see the 432-39 block at the
// end of this file). No later absence is asserted here early.
const SRC = join(dirname(fileURLToPath(import.meta.url)), '..')

const RETIRED_GRANT_RUNTIME_EXPORTS = [
  'CURRENT_GRANT_LEDGER_SCHEMA_VERSION',
  'GRANT_LEDGER_EVENT_KINDS',
  'GRANT_LEDGER_MIGRATIONS',
  'GrantLedgerVersionError',
  'guardGrantLedgerEvent',
  'hasGrantEventShape',
  'isGrantLedgerEventKind',
  'PROTECTED_ACTION_CLASSES',
  'isProtectedActionClass',
  'GrantRecordInputSchema',
  'GrantRecordOutcomeSchema',
  'GrantsListInputSchema',
  'GrantsListOutputSchema',
  'GrantsRevokeInputSchema',
  'GrantsRevokeOutputSchema',
  'StandingGrantSchema',
  'pinDenies',
  // 432-21: the scope the MCP bearer credential carried, deleted with that credential.
  'STANDING_APPROVAL_SCOPE',
  // 432-22: the trust-scope wire projection, deleted with the run-service token DTO.
  'TrustScopeSchema',
] as const

const RETIRED_GRANT_MODULES = [
  'safety/grant-ledger.ts',
  'safety/protected-classes.ts',
  'chat/pin-overlay.ts',
  // 432-19: the last grant-shaped contract, with the safety ports that read it.
  'safety/standing-approval.ts',
  // 432-22: the projection module, with its last consumer.
  'safety/grant-ops.ts',
] as const

describe('C432-NO-GRANT-CONTRACTS: the grant ledger, grant op, protected-class and pin contracts are gone', () => {
  it('C432-NO-GRANT-CONTRACTS: neither the root nor the safety barrel exports a retired grant or pin member', () => {
    const root = new Set(Object.keys(schema))
    const safetyBarrel = new Set(Object.keys(safety))
    expect(RETIRED_GRANT_RUNTIME_EXPORTS.filter(name => root.has(name)), 'root barrel').toEqual([])
    expect(RETIRED_GRANT_RUNTIME_EXPORTS.filter(name => safetyBarrel.has(name)), 'safety barrel').toEqual([])
  })

  it('C432-NO-GRANT-CONTRACTS: the ledger, protected-class, pin and standing-approval modules are deleted', () => {
    expect(RETIRED_GRANT_MODULES.filter(path => existsSync(join(SRC, path)))).toEqual([])
  })

  it('C432-NO-GRANT-CONTRACTS: no schema source names the standing-approval grant any more', () => {
    // A source census rather than a barrel read, because the member was TYPE-only: a runtime key set
    // can never see it, and a type re-export from any module would bring it back.
    const sources: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) {
          if (entry.name !== '__tests__') walk(path)
        } else if (entry.name.endsWith('.ts')) {
          sources.push(readFileSync(path, 'utf8'))
        }
      }
    }
    walk(SRC)
    expect(sources.length).toBeGreaterThan(50)
    expect(sources.filter(text => text.includes('StandingApproval' + 'Grant'))).toEqual([])
    expect(sources.filter(text => text.includes("from './standing-" + "approval'"))).toEqual([])
  })

  it('C432-NO-GRANT-CONTRACTS: the interim members stay until their own owners remove them', () => {
    // Not vacuous: the census above would pass over an empty barrel. 432-22 removed `TrustScopeSchema`
    // and 432-39 the caller types. RE-SPELLED 2026-10-02 (432-42, D-12) under the same title: the last
    // interim member, the key set, is deleted by its owner, so no interim member is left; the
    // barrels are the real ones (each still publishes a surviving member).
    expect(exported('TRUST_SCOPE_KEYS')).toBeUndefined()
    expect(Object.keys(safety)).not.toContain('TRUST_SCOPE_KEYS')
    expect(exported('FUNCTION_CALLER_ORIGINS')).toBeDefined()
    expect(Object.keys(safety)).toContain('scrubDisclosureText')
  })

  it('C432-NO-GRANT-CONTRACTS: no schema source imports the deleted projection module', () => {
    // Replaces "grant-ops.ts holds only the trust-scope projection" (432-18): the module is gone.
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) walk(path)
        else if (entry.name.endsWith('.ts') && /from '(\.\.?\/)+(safety\/)?grant-ops'/.test(readFileSync(path, 'utf8'))) {
          offenders.push(path)
        }
      }
    }
    walk(SRC)
    expect(offenders).toEqual([])
  })
})

// 2026-10-01, 432-22 (D-03/D-12/D-22): the token declaration DTOs leave with their config keys, and
// with them the trust-scope projection. Spelled by hand; no member is derived from a production value.
const RETIRED_TOKEN_CONFIG_EXPORTS = [
  'McpTokenEntrySchema',
  'McpStdioGrantSchema',
  'RunServiceTokenEntrySchema',
  'TrustScopeSchema',
] as const

describe('C432-NO-TRUST-CONTRACT: token declarations and the trust-scope projection are gone', () => {
  it('C432-NO-TRUST-CONTRACT: neither barrel exports a token DTO or the projection, and the modules are deleted', () => {
    const root = new Set(Object.keys(schema))
    const safetyBarrel = new Set(Object.keys(safety))
    expect(RETIRED_TOKEN_CONFIG_EXPORTS.filter(name => root.has(name)), 'root barrel').toEqual([])
    expect(RETIRED_TOKEN_CONFIG_EXPORTS.filter(name => safetyBarrel.has(name)), 'safety barrel').toEqual([])
    expect(['config/mcp.ts', 'config/run-service.ts', 'safety/grant-ops.ts'].filter(path => existsSync(join(SRC, path))))
      .toEqual([])
  })

  it('C432-NO-TRUST-CONTRACT: the run-service readiness answer carries no credential fact', () => {
    const readiness = exported('RunServiceReadinessSchema')
    expect(keysOf(readiness)).toEqual(sorted(['service', 'hostComposed', 'contractVersion']))
    const parse = (value: unknown) => (readiness as { safeParse(value: unknown): { success: boolean } }).safeParse(value)
    expect(parse({ service: 'up', hostComposed: true, contractVersion: 2 }).success).toBe(true)
    expect(parse({ service: 'up', hostComposed: true, authConfigured: false, contractVersion: 2 }).success,
      'the retired member is refused by the strict wire contract').toBe(false)
  })

  // 2026-10-02 (quick 261002-ctr): the readiness and refusal changes above moved the door's version.
  it('C261002-CTR-RUN-SERVICE-V2: the run-service contract is version 2, the shape version 1 lacked', () => {
    expect(exported('RUN_SERVICE_CONTRACT_VERSION')).toBe(2)
    const codes = exported('RUN_SERVICE_ERROR_CODES') as readonly string[]
    expect(codes).toContain('cross_site_refused')
    expect(codes.filter(code => /bearer|token|credential/u.test(code))).toEqual([])
    const readiness = exported('RunServiceReadinessSchema') as { parse(value: unknown): unknown }
    expect(readiness.parse({ service: 'up', hostComposed: true, contractVersion: 2 }))
      .toEqual({ service: 'up', hostComposed: true, contractVersion: 2 })
    expect(() => readiness.parse({ service: 'up', hostComposed: true, contractVersion: 1 })).toThrow()
  })

  it('C432-NO-TRUST-CONTRACT: the config write door names no token list and no safety root', () => {
    expect(exported('CONFIG_NAMED_ARRAYS')).toEqual(['registry.llms'])
    expect(exported('CONFIG_WRITE_DENIED_ROOTS')).toEqual(['plugins'])
  })
})

// 2026-10-01, 432-22 (D-14/D-15/D-22): an ask turn answers no approval or trust refusal. The only
// target policy sentence is the plain production refusal; an old session's recorded approval
// decision stays readable and nothing writes a new one.
describe('C432-ASK-PLAIN-REFUSAL: the ask contract carries no approval or trust refusal', () => {
  it('C432-ASK-PLAIN-REFUSAL: a turn result has no denial, remedy or approval member', () => {
    expect(keysOf(exported('AgentAskResultSchema'))).toEqual(sorted([
      'sessionId', 'turnId', 'status', 'answer', 'receipts', 'results', 'unhandled', 'refusedLineCount',
    ]))
    expect(keysOf(exported('AgentAskInputSchema'))).toEqual(sorted(['message', 'sessionId']))
    const turn = exported('AgentAskResultSchema') as { safeParse(value: unknown): { success: boolean; data?: unknown } }
    const failClosed = {
      sessionId: 's', turnId: 't', status: 'fail_closed', receipts: [], results: [],
      unhandled: { clause: 'delete the run', reason: 'no capability matched' },
    }
    const parsed = turn.safeParse({ ...failClosed, denials: [{ remedies: [] }] })
    expect(parsed.success).toBe(true)
    expect(Object.keys(parsed.data as object)).not.toContain('denials')
  })

  it('C432-ASK-PLAIN-REFUSAL: the production refusal is one plain sentence naming the target and the opt-in line', () => {
    const build = exported('buildProductionRefusal') as (names: readonly string[]) => string
    const optIn = exported('ALLOW_PRODUCTION_OPT_IN') as string
    const message = build(['shop'])
    expect(message).toContain('shop')
    expect(message).toContain(optIn)
    expect(message).not.toMatch(/approv|confirm|grant|trust|--yes|\[y\/N\]|remed/i)
  })

  it('C432-ASK-PLAIN-REFUSAL: an old recorded approval_decision event stays readable by the session reader', () => {
    expect(exported('CHAT_SESSION_EVENT_KINDS') as readonly string[]).toContain('approval_decision')
    const guard = exported('guardChatSessionEvent') as (value: unknown, version: number) => { kind: string }
    const version = exported('CURRENT_CHAT_SESSION_SCHEMA_VERSION') as number
    const recorded = {
      kind: 'approval_decision', turnId: 't-1', at: '2026-09-01T00:00:00.000Z',
      actionClass: 'fn:knowledge.accept', decision: 'approved', source: 'gate',
    }
    expect(guard(recorded, version).kind).toBe('approval_decision')
  })
})

// C432-NO-GRANT-CONTRACTS, type level: each line fails `pnpm typecheck` the moment the type returns.
// @ts-expect-error the grant ledger event is deleted
export type RetiredGrantLedgerEvent = import('../index').GrantLedgerEvent
// @ts-expect-error the folded standing grant is deleted
export type RetiredActiveStandingGrant = import('../index').ActiveStandingGrant
// @ts-expect-error the standing-grants port is deleted
export type RetiredStandingGrantsPort = import('../index').StandingGrantsPort
// @ts-expect-error the grant list output is deleted
export type RetiredGrantsListOutput = import('../index').GrantsListOutput
// @ts-expect-error the grant revoke output is deleted
export type RetiredGrantsRevokeOutput = import('../index').GrantsRevokeOutput
// @ts-expect-error the grant mint outcome is deleted
export type RetiredGrantRecordOutcome = import('../index').GrantRecordOutcome
// @ts-expect-error the protected class is deleted
export type RetiredProtectedActionClass = import('../index').ProtectedActionClass
// @ts-expect-error the chat pin overlay is deleted
export type RetiredChatPinOverlay = import('../index').ChatPinOverlay
// @ts-expect-error 432-19: the standing-approval grant is deleted with the safety ports that read it
export type RetiredStandingApprovalGrant = import('../index').StandingApprovalGrant
// @ts-expect-error 432-19: and it is gone from the safety barrel too
export type RetiredSafetyStandingApprovalGrant = import('../safety/index').StandingApprovalGrant
// 2026-10-02 (432-39, D-02/D-12): the caller types are deleted with the caller's `credential` member.
// @ts-expect-error C432-NO-PERMISSION-TYPES: the trust scope is deleted
export type RetiredTrustScope = import('../index').TrustScope
// @ts-expect-error C432-NO-PERMISSION-TYPES: the trust credential is deleted
export type RetiredTrustCredential = import('../index').TrustCredential
// C432-NO-TRUST-CONTRACT, type level (432-22).
// @ts-expect-error the MCP token entry is deleted with services.mcp.tokens
export type RetiredMcpTokenEntry = import('../index').McpTokenEntry
// @ts-expect-error the stdio grant is deleted with services.mcp.stdio.grantConfigWrite
export type RetiredMcpStdioGrant = import('../index').McpStdioGrant
// @ts-expect-error the run-service token entry is deleted with services.dashboard.runServiceTokens
export type RetiredRunServiceTokenEntry = import('../index').RunServiceTokenEntry
// @ts-expect-error the readiness answer has no credential fact
export type RetiredAuthConfigured = import('../index').RunServiceReadiness['authConfigured']

// 2026-10-02, 432-39 (D-02/D-10/D-12/D-22): the permission contracts leave the schema. The caller
// record keeps `surface` and `origin`, which receipts consume; `grantedScopes`, `safeMode`,
// `credential` and `sessionId` are deleted with the capability-scope union and the trust-credential
// DTOs. The capability catalogue's scope column and the agent manifest's grant, safe-mode and token
// members go with them. `ExecutionContext` stays (a run still records the context it ran in), and so
// does the historical `approval_decision` reader (C432-ASK-PLAIN-REFUSAL above). Every expected set
// is spelled by hand.
type ExactKeys<T, K extends PropertyKey> = [keyof T] extends [K]
  ? ([K] extends [keyof T] ? true : false)
  : false
type Caller = import('../index').FunctionCaller
const CALLER_TYPE_IS_SURFACE_AND_ORIGIN: ExactKeys<Caller, 'surface' | 'origin'> = true
type Context = import('../index').ExecutionContext
const CONTEXT_TYPE_IS_RETAINED: [Context] extends [string] ? true : false = true

const RETIRED_PERMISSION_RUNTIME_EXPORTS = [
  'FunctionScopeSchema',
  'AgentManifestTokenRefSchema',
] as const

describe('C432-RUNTIME-SETS: the caller, catalogue and manifest sets after the permission removal (432-39)', () => {
  it('C432-RUNTIME-SETS: a caller record is exactly surface and origin, at the type and in a literal', () => {
    expect(CALLER_TYPE_IS_SURFACE_AND_ORIGIN).toBe(true)
    const caller: import('../index').FunctionCaller = { surface: 'cli', origin: 'human' }
    expect(Object.keys(caller).sort()).toEqual(['origin', 'surface'])
    expect(exported('FUNCTION_CALLER_ORIGINS')).toEqual(['human', 'agent'])
  })

  it('C432-RUNTIME-SETS: a catalogue op row has no scope column, and the strict row refuses one', () => {
    expect(keysOf(exported('CatalogOpRowSchema'))).toEqual(sorted([
      'kind', 'id', 'description', 'params', 'surfaces', 'mcpTool', 'mcpUnprojectedReasonKey',
      'docPath', 'docAnchor', 'docAbsentReason', 'exampleCall', 'exampleCallAbsentReason',
    ]))
    const row = exported('CatalogOpRowSchema') as { safeParse(value: unknown): { success: boolean } }
    const valid = {
      kind: 'op', id: 'runs.list', description: 'List runs.', params: {}, surfaces: ['chat'],
      docPath: null, exampleCall: { arguments: {} },
    }
    expect(row.safeParse(valid).success).toBe(true)
    expect(row.safeParse({ ...valid, requiredScopes: ['read'] }).success, 'the retired column parsed').toBe(false)
  })

  it('C432-RUNTIME-SETS: the manifest posture is exactly its configuration answer', () => {
    expect(keysOf(exported('AgentManifestPostureSchema'))).toEqual(['configuration'])
    const posture = exported('AgentManifestPostureSchema') as { safeParse(value: unknown): { success: boolean } }
    expect(posture.safeParse({ configuration: 'absent' }).success).toBe(true)
    for (const retired of [
      { defaultScopes: ['read'] }, { safeMode: false }, { tokenEnvRefs: [] },
    ]) {
      expect(posture.safeParse({ configuration: 'absent', ...retired }).success, JSON.stringify(retired))
        .toBe(false)
    }
  })
})

describe('C432-NO-PERMISSION-TYPES: no scope or trust-credential contract is left (432-39)', () => {
  it('C432-NO-PERMISSION-TYPES: the scope module is deleted and no schema source declares a permission type', () => {
    expect(existsSync(join(SRC, 'functions/function-scope.ts')), 'functions/function-scope.ts').toBe(false)
    const sources: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) {
          if (entry.name !== '__tests__') walk(path)
        } else if (entry.name.endsWith('.ts')) {
          sources.push(readFileSync(path, 'utf8'))
        }
      }
    }
    walk(SRC)
    expect(sources.length).toBeGreaterThan(50)
    for (const declaration of [
      'const FunctionScopeSchema', 'type FunctionScope ', 'interface TrustCredential',
      'interface TrustScope ', 'const AgentManifestTokenRefSchema',
    ]) {
      expect(sources.filter(text => text.includes(declaration)), declaration).toEqual([])
    }
  })

  it('C432-NO-PERMISSION-TYPES: the execution context and the historical reader vocabulary stay', () => {
    expect(CONTEXT_TYPE_IS_RETAINED).toBe(true)
    expect(exported('CHAT_SESSION_EVENT_KINDS') as readonly string[]).toContain('approval_decision')
  })
})

describe('C432-NO-DEAD-BARREL-EXPORTS: neither barrel exports a deleted permission value (432-39)', () => {
  it('C432-NO-DEAD-BARREL-EXPORTS: the root and safety barrels carry no retired permission value', () => {
    const root = new Set(Object.keys(schema))
    const safetyBarrel = new Set(Object.keys(safety))
    expect(RETIRED_PERMISSION_RUNTIME_EXPORTS.filter(name => root.has(name)), 'root barrel').toEqual([])
    expect(RETIRED_PERMISSION_RUNTIME_EXPORTS.filter(name => safetyBarrel.has(name)), 'safety barrel').toEqual([])
    // Non-vacuity: the surviving neighbours of each deleted value are still exported.
    expect(root.has('AgentManifestPostureSchema')).toBe(true)
    expect(root.has('FUNCTION_CALLER_ORIGINS')).toBe(true)
  })
})

// C432-NO-PERMISSION-TYPES / C432-NO-DEAD-BARREL-EXPORTS, type level (432-39): each line fails
// `pnpm typecheck` the moment the type returns to a barrel.
// @ts-expect-error the capability-scope type is deleted
export type RetiredFunctionScope = import('../index').FunctionScope
// @ts-expect-error and gone from the functions barrel too
export type RetiredFunctionsBarrelScope = import('../functions/index').FunctionScope
// @ts-expect-error the trust credential is gone from the safety barrel
export type RetiredSafetyTrustCredential = import('../safety/index').TrustCredential
// @ts-expect-error the trust scope is gone from the safety barrel
export type RetiredSafetyTrustScope = import('../safety/index').TrustScope
// @ts-expect-error the manifest token ref is deleted with the posture's token member
export type RetiredAgentManifestTokenRef = import('../index').AgentManifestTokenRef
// @ts-expect-error the caller's scope set is deleted
export type RetiredCallerGrantedScopes = import('../index').FunctionCaller['grantedScopes']
// @ts-expect-error the caller's safe-mode flag is deleted
export type RetiredCallerSafeMode = import('../index').FunctionCaller['safeMode']
// @ts-expect-error the caller's credential is deleted
export type RetiredCallerCredential = import('../index').FunctionCaller['credential']
// @ts-expect-error the caller's session id is deleted
export type RetiredCallerSessionId = import('../index').FunctionCaller['sessionId']

// 2026-10-02 (432-42, D-12/D-14/D-15/D-22): the routed leftovers and the scope key set. Runtime sets
// pinned beside their types: the descriptor's exact key set (compile-checked), the scrub that
// survives it, the masking classes kept with a dated rationale, and the deleted runtime exports.
const DESCRIPTOR_KEYS = ['name', 'recognized', 'surface', 'destructive', 'readOnly'] as const
const DESCRIPTOR_TYPE_IS_EXACT: ExactKeys<import('../index').RiskActionDescriptor, (typeof DESCRIPTOR_KEYS)[number]> = true

describe('C432-RUNTIME-SETS: the 432-42 leftovers are absent and the retained neighbours are exact', () => {
  it('the risk descriptor carries exactly its five static keys', () => {
    expect(DESCRIPTOR_TYPE_IS_EXACT).toBe(true)
    expect([...DESCRIPTOR_KEYS].sort()).toEqual([
      'destructive',
      'name',
      'readOnly',
      'recognized',
      'surface',
    ])
    const source = readFileSync(join(SRC, 'safety', 'action-descriptor.ts'), 'utf8')
    const declared = /export interface RiskActionDescriptor \{([\s\S]*?)\n\}/u.exec(source)?.[1] ?? ''
    expect(declared, 'the descriptor declaration was not found').not.toBe('')
    const members = [...declared.matchAll(/^\s{2}(\w+)\??:/gmu)].map((match) => match[1]).sort()
    expect(members).toEqual([...DESCRIPTOR_KEYS].sort())
    // The scrub outlives the field it was written for: the production refusal applies it.
    expect(typeof exported('scrubDisclosureText')).toBe('function')
    expect(typeof exported('buildProductionRefusal')).toBe('function')
  })

  it('C432-RUNTIME-SETS: the scope key set, the mark refusal body and their types are published by no barrel', () => {
    for (const name of ['TRUST_SCOPE_KEYS', 'MarkRefusalSchema']) {
      expect(exported(name), `${name} is back on the root barrel`).toBeUndefined()
      expect(Object.keys(safety), `${name} is back on the safety barrel`).not.toContain(name)
    }
    expect(existsSync(join(SRC, 'safety', 'trust-credential.ts')), 'trust-credential.ts is back').toBe(false)
  })

  // 2026-10-15 (441-40, D-29): the masking classes cell, which kept `env-var-name` in the class
  // vocabulary, is deleted with the classes and the map; the leaf list survives in config/leaves.ts.
})

// @ts-expect-error C432-RUNTIME-SETS (432-42): the scope key type is deleted
export type RetiredTrustScopeKey = import('../index').TrustScopeKey
// @ts-expect-error C432-RUNTIME-SETS (432-42): the mark refusal type is deleted
export type RetiredMarkRefusal = import('../index').MarkRefusal
// @ts-expect-error C432-RUNTIME-SETS (432-42): the descriptor has no command member
export type RetiredDescriptorCommand = import('../index').RiskActionDescriptor['command']
// @ts-expect-error C432-RUNTIME-SETS (432-42): the descriptor has no disclosure member
export type RetiredDescriptorDisclosure = import('../index').RiskActionDescriptor['disclosure']
