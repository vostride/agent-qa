import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { KnowledgeReaderPort } from '@vostride/agent-qa-agent'
import { createKnowledgeReader, LOCAL_CURATION_CAPABILITIES } from '@vostride/agent-qa-agent-local'
import { renderGate1Line } from '@vostride/agent-qa-eval'
import {
  GATE_RECEIPT_SCHEMA_VERSION,
  asEvidenceToken,
  asRecordId,
  asRef,
  slugBranch,
  GATE1_REASONS,
  GateReceiptSchema,
  receiptDigestOf,
  stampReceiptDigest,
} from '@vostride/agent-qa-schema'
import { gateReceiptsFor } from '@vostride/agent-qa-knowledge-local/reader'
import {
  CorruptEpochStateError,
  createLocalKnowledgeStore,
} from '@vostride/agent-qa-knowledge-local'
import {
  resolveEvalSession,
  runReplayGate,
  runReplayGateVerb,
  serializeReplayGateReceipt,
} from '../../eval-session-composition.js'
import {
  createReplayGateHost,
  type ReplayGateHostDeps,
} from '../replay-gate-host.js'
import * as bridge from '../replay-gate-host.js'
import * as evalSession from '../../eval-session-composition.js'
import * as llm from '../../llm-utils.js'
import * as fsPromises from 'node:fs/promises'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, readFile: vi.fn(actual.readFile) }
})
// Runtime-only fixture reuse keeps another package's source outside the CLI tsc rootDir.
const { completeGate1Receipt, createPromotionFloorFixture } =
  await import(
    new URL(
      '../../../../knowledge-local/src/curator/__tests__/fixtures/promotion-floor-fixture.js',
      import.meta.url,
    ).href
  )
const { publishBundle } = await import(
  new URL('../../../../knowledge-local/src/bundle-publish.test-helper.js', import.meta.url).href
)
const { makeProcedureBundleDraftFixture } = await import(
  new URL('../../../../knowledge-local/src/__tests__/fixtures/bundle-fixture.js', import.meta.url)
    .href
)
const { writeGate1Fixture } = await import(
  new URL('../../../../eval-local/src/__tests__/fixtures/gate1-fixtures.js', import.meta.url).href
)

describe('DATA replay gate host', () => {
  let root: string
  let knowledgeRoot: string
  let candidateId: string
  let candidateDir: string
  let deps: ReplayGateHostDeps
  let calls: string[]
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'agent-qa-gate-host-'))
    knowledgeRoot = join(root, 'agent-qa-knowledge')
    const fixture = createPromotionFloorFixture({
      knowledgeRoot,
    })
    const published = fixture.publishHeldCandidate('rg').published
    candidateId = published.id
    candidateDir = published.dir
    const configPath = join(root, 'agent-qa.config.yaml')
    writeFileSync(
      configPath,
      'workspace:\n  testMatch: [tests/**/*.yaml]\n  suiteMatch: [suites/**/*.suite.yaml]\n  hooksFile: hooks.yaml\n  envFile: .env\n  secretsFile: .env.secrets.local\nuse:\n  mobile:\n    appState: preserve\n',
    )
    const session = await resolveEvalSession({ configPath, keyOnly: true })
    calls = []
    deps = {
      configPath,
      agentQaRoot: join(root, '.agent-qa'),
      record: true,
      session,
      composition: {
        identity: {
          plannerModelId: 'gpt-stub',
          matcherVersion: 1,
          fingerprint: 'f'.repeat(64),
          profileKey: 'p',
        },
        planner: {
          profile: { provider: 'openai-compatible', model: 'gpt-stub', auth: { mode: 'none' } },
          resolveAuth: async () => {
            throw new Error('fake bridge must not resolve auth')
          },
        },
        k: 3,
        kSource: 'default',
        maxScreens: 64,
        judgeOverrideConfigured: false,
        baselineSeed: { floorSeeds: [11, 29] },
      },
      runReplayGate: vi.fn<NonNullable<ReplayGateHostDeps['runReplayGate']>>(async (input) => ({
        kind: 'receipt',
        receipt: completeGate1Receipt(input.injection.candidateId),
        lines: ['gate 1 · pass'],
        notices: [],
        refusals: [],
        modelCalls: 0,
        wallClockMs: 0,
      })),
      curation: {
        recordGateReceipt: vi.fn(async () => {
          calls.push('write')
          return { kind: 'appended' as const }
        }),
        maintenance: {
          acquireWriterLease: vi.fn(() => {
            calls.push('acquire')
            return { kind: 'acquired' as const, leaseId: 'L', epoch: 1 }
          }),
          releaseLease: vi.fn(() => {
            calls.push('release')
            return { kind: 'released' as const }
          }),
        },
      },
    }
  })
  afterEach(() => {
    vi.mocked(fsPromises.readFile).mockClear()
    vi.restoreAllMocks()
    rmSync(root, { recursive: true, force: true })
  })

  it('records DATA with the actual lease epoch, then releases', async () => {
    const host = createReplayGateHost(deps)
    const result = await host.run(candidateId)
    expect(result).toMatchObject({ kind: 'receipt', recorded: 'appended', exit: 0 })
    expect(deps.curation!.recordGateReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        lease: { leaseId: 'L', epoch: 1 },
        knowledgeRoot,
        executionContext: deps.session.executionContext,
        receipt: completeGate1Receipt(candidateId),
        sourceBuildOrdinal: 44,
      }),
    )
    expect(calls).toEqual(['acquire', 'write', 'release'])
    expect(deps.runReplayGate).toHaveBeenCalledWith(
      expect.objectContaining({
        injection: expect.objectContaining({ candidateId }),
        producedBy: { opId: 'eval.replay-gate' },
        committedRoot: join(root, 'agent-qa-eval'),
        mask: deps.session.mask,
      }),
    )
  })
  it.each([
    ['fail', 1],
    ['abstain', 2],
  ] as const)('maps %s to exit %s', async (verdict, exit) => {
    deps.runReplayGate = async () => ({
      kind: 'receipt',
      receipt: completeGate1Receipt(candidateId, { verdict }),
      lines: [],
      notices: [],
      refusals: [],
      modelCalls: 0,
      wallClockMs: 0,
    })
    expect(await createReplayGateHost(deps).run(candidateId)).toMatchObject({
      exit,
      recorded: 'appended',
    })
    expect(deps.curation!.recordGateReceipt).toHaveBeenCalledOnce()
  })
  it.each(GATE1_REASONS)('preserves typed reason %s on a recorded receipt', async (reason) => {
    const { receiptDigest: _previousDigest, ...base } = completeGate1Receipt(candidateId, {
      verdict: 'abstain',
    })
    const receipt = stampReceiptDigest({
      ...base,
      // This cell tests transport preservation, not the verdict fold. Judge refusal is
      // supplemental disclosure, so it accompanies the inconclusive abstention here.
      reasons: reason === 'same-family-refused' ? ['inconclusive', reason] : [reason],
    })
    deps.runReplayGate = async () => ({
      kind: 'receipt',
      receipt,
      lines: [renderGate1Line(receipt)],
      notices: [],
      refusals: [],
      modelCalls: 0,
      wallClockMs: 0,
    })
    expect(await createReplayGateHost(deps).run(candidateId)).toMatchObject({
      recorded: 'appended',
      exit: 2,
    })
    expect(deps.curation!.recordGateReceipt).toHaveBeenCalledWith(
      expect.objectContaining({ receipt }),
    )
  })
  it('uses the supplied runtime root for execution and audit while retaining config-relative data roots', async () => {
    const runtimeRoot = join(root, 'custom-runtime')
    await createReplayGateHost({ ...deps, agentQaRoot: runtimeRoot }).run(candidateId)
    expect(deps.runReplayGate).toHaveBeenCalledWith(
      expect.objectContaining({
        agentQaRoot: runtimeRoot,
        committedRoot: join(root, 'agent-qa-eval'),
      }),
    )
    expect(deps.curation!.recordGateReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        knowledgeRoot,
      }),
    )
  })
  it('dry-run never acquires a lease', async () => {
    expect(await createReplayGateHost({ ...deps, record: false }).run(candidateId)).toMatchObject({
      recorded: 'dry-run',
    })
    expect(calls).toEqual([])
    expect(existsSync(join(candidateDir, 'evidence/gates.jsonl'))).toBe(false)
    expect(gateReceiptsFor({ knowledgeRoot, candidateId })).toMatchObject({
      kind: 'found',
      lines: [],
    })
  })
  it('refuses missing reader support and unknown candidates without a lease', async () => {
    await expect(
      createReplayGateHost({ ...deps, reader: {} as KnowledgeReaderPort }).run(candidateId),
    ).rejects.toThrow('knowledge reader binds no candidateInjection')
    const host = createReplayGateHost(deps)
    expect(await host.run('missing')).toMatchObject({
      kind: 'refused',
      exit: 2,
      refusal: { reason: 'candidate missing not found' },
    })
    expect(calls).toEqual([])
  })
  it('reports lease-refused and preserves the receipt without recording or releasing', async () => {
    deps.curation = {
      ...deps.curation!,
      maintenance: {
        ...deps.curation!.maintenance,
        acquireWriterLease: vi.fn(() => ({
          kind: 'refused' as const,
          reason: 'corrupt-epoch-state' as const,
          error: new CorruptEpochStateError(join(knowledgeRoot, '.epoch'), 'malformed', 'fixture'),
        })),
      },
    }
    const result = await createReplayGateHost(deps).run(candidateId)
    expect(result).toMatchObject({
      kind: 'receipt',
      receipt: completeGate1Receipt(candidateId),
      recorded: 'lease-refused',
      exit: 2,
      notices: ['writer lease refused: corrupt-epoch-state; receipt printed, not recorded'],
    })
    expect(deps.curation!.recordGateReceipt).not.toHaveBeenCalled()
    expect(deps.curation!.maintenance.releaseLease).not.toHaveBeenCalled()
  })
  it('passes a composition refusal through without acquiring a lease', async () => {
    deps.runReplayGate = async () => ({
      kind: 'refused',
      refusal: { path: root, reason: 'no-floor' },
      notices: [],
    })
    expect(await createReplayGateHost(deps).run(candidateId)).toMatchObject({
      kind: 'refused',
      exit: 2,
    })
    expect(calls).toEqual([])
  })
  it('reports lease-held without writing or releasing another writer lease', async () => {
    deps.curation = {
      ...deps.curation!,
      maintenance: {
        ...deps.curation!.maintenance,
        acquireWriterLease: vi.fn(() => ({
          kind: 'held' as const,
          holder: {
            leaseId: 'other',
            epoch: 5,
            pid: 1,
            heartbeatAtMs: 0,
          },
        })),
      },
    }
    const result = await createReplayGateHost(deps).run(candidateId)
    expect(result).toMatchObject({
      kind: 'receipt',
      receipt: completeGate1Receipt(candidateId),
      recorded: 'lease-held',
      exit: 2,
      notices: [
        'writer lease held by another process; receipt printed, not recorded — re-run when the daemon releases it',
      ],
    })
    expect(calls).toEqual([])
    expect(deps.curation!.recordGateReceipt).not.toHaveBeenCalled()
    expect(deps.curation!.maintenance.releaseLease).not.toHaveBeenCalled()
  })
  it('releases the acquired lease even when recording fails', async () => {
    deps.curation = {
      ...deps.curation!,
      recordGateReceipt: vi.fn(async () => {
        calls.push('write')
        throw new Error('write refused')
      }),
    }
    await expect(createReplayGateHost(deps).run(candidateId)).rejects.toThrow('write refused')
    expect(calls).toEqual(['acquire', 'write', 'release'])
  })
  it('rejects a foreign receipt before writing', async () => {
    deps.runReplayGate = async () => ({
      kind: 'receipt',
      receipt: completeGate1Receipt('foreign'),
      lines: [],
      notices: [],
      refusals: [],
      modelCalls: 0,
      wallClockMs: 0,
    })
    await expect(createReplayGateHost(deps).run(candidateId)).rejects.toThrow('foreign candidate')
    expect(calls).toEqual([])
  })
  it('rejects a foreign candidate projection before replay or credential work', async () => {
    const reader = createKnowledgeReader(() => knowledgeRoot)
    const found = await reader.candidateInjection!({ candidateId })
    if (found.kind !== 'found') throw new Error('fixture candidate missing')
    deps.reader = { ...reader, candidateInjection: async () => ({ ...found,
      injection: { ...found.injection, candidateId: 'foreign' } }) }
    await expect(createReplayGateHost(deps).run(candidateId)).rejects.toThrow('foreign candidate')
    expect(deps.runReplayGate).not.toHaveBeenCalled()
    expect(calls).toEqual([])
  })
  it('refuses another gate even when candidate and digest are valid', async () => {
    const receipt = stampReceiptDigest({ schemaVersion: GATE_RECEIPT_SCHEMA_VERSION, gate: 3 as const,
      candidateId, verdict: 'pass' as const, producedAtOrdinal: 44, producedBy: {},
      runId: 'fixture-run', mark: 'confirmed-bug' as const })
    deps.runReplayGate = vi.fn(async () => ({ kind: 'receipt', receipt,
      lines: [], notices: [], refusals: [], modelCalls: 0, wallClockMs: 0 })) as unknown as ReplayGateHostDeps['runReplayGate']
    await expect(createReplayGateHost(deps).run(candidateId)).rejects.toThrow('Gate 1')
    expect(calls).toEqual([])
  })
  it.each(['panel', 'singleton', 'lineage', 'provider-error'] as const)(
    'the replay-gate verb records real %s evidence from both replay arms', async mode => {
      const local = await import('@vostride/agent-qa-eval-local')
      writeFileSync(join(root, '.env.secrets.local'), '')
      const { createPanelIdentity } = await import('@vostride/agent-qa-eval')
      const { familyStubProfile, respondingStub, actionGenerateResult, judgeGenerateResult, noneAuth } =
        await import(new URL('../../../../eval-local/src/__tests__/fixtures/replay-fixtures.js', import.meta.url).href)
      const f = writeGate1Fixture(join(root, 'replay-fixture'))
      renameSync(f.committedRoot, join(root, 'agent-qa-eval'))
      f.committedRoot = join(root, 'agent-qa-eval')
      f.cassettesRoot = join(f.committedRoot, 'cassettes')
      // The real published candidate owns this receipt; the fixture reader supplies
      // its reproducible target and rendered injection DATA, without replacing the host.
      f.injection.candidateId = candidateId
      f.injection.line.id = asRecordId(candidateId)
      const ids = mode === 'singleton' ? ['claude-fixture'] : mode === 'lineage'
        ? ['deepseek-r1-distill-qwen-32b', 'claude-fixture'] : ['claude-fixture', 'gemini-fixture']
      writeFileSync(deps.configPath, readFileSync(deps.configPath, 'utf8').replace('use:\n', 'use:\n  llm: planner\n') +
        '\nregistry:\n  llms:\n' + [{ name: 'planner', model: 'gpt-fixture' },
          ...ids.map((model, i) => ({ name: `judge-${i}`, model }))].map(row =>
          `    - name: ${row.name}\n      provider: openai-compatible\n      model: ${row.model}\n      baseURL: http://localhost:1/v1\n`).join('') +
        '\neval:\n  judges: [' + ids.map((_, i) => `judge-${i}`).join(', ') + ']\n')
      const auth = vi.spyOn(llm, 'resolveModelAuth').mockResolvedValue({ kind: 'unauthenticated',
        credentialKey: 'fixture', provider: 'openai-compatible', optional: true, message: 'fixture' })
      for (const { cassette } of f.selected) {
        cassette.receipt.model.declared.modelId = 'qwen-recorded'
        if (cassette.id === f.targetId) {
          cassette.input.stateBefore.elements.push({ ...structuredClone(cassette.input.stateBefore.elements[0]), ref: asRef('e-twin') })
          cassette.input.stateBefore.refMap[asRef('e-twin')] = structuredClone(cassette.input.stateBefore.refMap[asRef('e-continue')])
        }
        new local.FsCassetteStore({ root, outputDir: f.cassettesRoot }).write({ cassette, blobs: [] })
      }
      const planner = respondingStub((call: { prompt: unknown }) => {
        const text = JSON.stringify(call.prompt)
        return actionGenerateResult('web', text.includes('gate1-target-run') && !text.includes(f.injection.renderedLine)
          ? 'e-twin' : 'e-continue')
      }, 'gpt-fixture')
      let warmed = false
      const judges = ids.map((id, index) => respondingStub(() => {
        if (warmed && mode === 'provider-error' && index === 1) throw new Error('fixture provider unavailable')
        return judgeGenerateResult('different', 'high')
      }, id))
      const plannerOverrides = { languageModels: planner.languageModels }
      const judgeOverrides = { languageModels: Object.assign({}, ...judges.map(judge => judge.languageModels)) }
      const session = await resolveEvalSession({ configPath: deps.configPath, keyOnly: true })
      const identity = await evalSession.resolveGateProfileIdentity(session, plannerOverrides)
      const { judgeMemberModelIds: _members, ...floorIdentity } = identity
      expect(local.writeNoiseFloorArtefact({ artefact: { ...f.artefact, ...floorIdentity },
        committedRoot: f.committedRoot }).kind).toBe('written')
      const runRoot = join(deps.agentQaRoot, 'eval/gate', slugBranch(identity.profileKey))
      await local.replayCorpusOnce({ selected: f.selected, cassettesRoot: f.cassettesRoot, agentQaRoot: deps.agentQaRoot,
        runRoot, profile: familyStubProfile('gpt-fixture'), auth: noneAuth, modelOverrides: plannerOverrides,
        judge: { members: ids.map(id => ({ profile: familyStubProfile(id), auth: noneAuth, modelOverrides: judgeOverrides })) },
        seed: 11, k: 1, mask: (text: string) => text, source: 'committed', corpusDigest: f.corpusDigest })
      warmed = true
      for (const judge of judges) judge.captured.length = 0
      auth.mockClear()
      const originalHost = bridge.createReplayGateHost
      const bound = vi.spyOn(bridge, 'createReplayGateHost').mockImplementation(input => originalHost({ ...input,
        reader: { ...createKnowledgeReader(() => knowledgeRoot), candidateInjection: async () => ({ kind: 'found', injection: f.injection }) },
        curation: LOCAL_CURATION_CAPABILITIES }))
      expect(bound).not.toHaveBeenCalled()
      const keyOnly = await resolveEvalSession({ configPath: deps.configPath, keyOnly: true })
      expect(auth).not.toHaveBeenCalled()
      const result = await runReplayGateVerb(keyOnly, candidateId, {
        agentQaRoot: deps.agentQaRoot, plannerOverrides, judgeOverrides,
      })
      expect(bound).toHaveBeenCalledOnce()
      if (result.kind !== 'receipt') throw new Error('expected a recorded receipt')
      expect(result.recorded).toBe('appended')
      const receipt = result.receipt
      expect(receipt.gate).toBe(1)
      if (receipt.gate !== 1) throw new Error('expected Gate 1')
      expect(receipt.crossCheck).toBe(mode === 'lineage' ? 'not-run' : 'flipped')
      const panel = createPanelIdentity(ids)
      if (mode === 'lineage') {
        expect(receipt).toMatchObject({ degradation: 'replay-diff', reasons: expect.arrayContaining(['same-family-refused']),
          judge: { eligibility: 'no-eligible-judge', panelSize: 2, members: panel.members } })
        expect(judges.every(judge => judge.captured.length === 0)).toBe(true)
        expect(auth.mock.calls.map(([name]) => name)).toEqual(['planner'])
      } else {
        expect(receipt.judgeId).toBe(`${panel.judgeModelId}|family=${panel.judgeFamily}|judgeVersion=2`)
        expect(auth.mock.calls.map(([name]) => name)).toEqual(['planner', ...ids.map((_, i) => `judge-${i}`)])
        expect(judges.every(judge => judge.captured.length > 0)).toBe(true)
        if (mode === 'singleton') expect(Object.keys(receipt.judge!).sort()).toEqual(['eligibility', 'overrideConfigured'])
        else expect(receipt.judge).toMatchObject({ panelSize: 2, members: panel.members })
      }
      const read = gateReceiptsFor({ knowledgeRoot, candidateId })
      expect(read).toMatchObject({ kind: 'found', lines: [receipt], status: 'candidate' })
      expect(GateReceiptSchema.parse(receipt)).toEqual(receipt)
      expect(receiptDigestOf(receipt)).toBe(receipt.receiptDigest)
      const without = local.loadScoreRecord(join(deps.agentQaRoot, 'eval/gate1', slugBranch(candidateId),
        'cross-check/without/sample-1/replays', f.targetId))
      if (mode === 'provider-error') expect(without).toMatchObject({ kind: 'loaded', record: { score: { entry: { score: {
        kind: 'unresolved-tie', judgeOutcome: { kind: 'abstained', cause: 'below-quorum' } } } } } })
    })
  it('reads the real appended receipt and duplicate back', async () => {
    // A Gate 1 pass cannot bypass the independent confirmed-evidence prerequisite.
    const lease = LOCAL_CURATION_CAPABILITIES.maintenance.acquireWriterLease(knowledgeRoot)
    if (lease.kind !== 'acquired')
      throw new Error('fixture confirmation needs its own writer lease')
    try {
      const store = createLocalKnowledgeStore({
        knowledgeRoot,
        executionContext: 'local-interactive',
        writerLeaseId: lease.leaseId,
        epoch: lease.epoch,
        sourceBuildOrdinal: 43,
      })
      await store.commit([
        {
          kind: 'Confirm',
          origin: 'agent',
          scope: { tier: 'product', key: 'storefront' },
          citedIds: [asRecordId(candidateId)],
          targetId: asRecordId(candidateId),
          evidenceToken: asEvidenceToken('417-fixture-confirmation'),
          authorship: { path: 'deterministic-fallback', executionContext: 'local-interactive' },
        },
      ])
    } finally {
      LOCAL_CURATION_CAPABILITIES.maintenance.releaseLease({
        knowledgeRoot,
        leaseId: lease.leaseId,
      })
    }
    const host = createReplayGateHost({
      ...deps,
      curation: LOCAL_CURATION_CAPABILITIES,
    })
    expect(await host.run(candidateId)).toMatchObject({ recorded: 'appended' })
    expect(await host.run(candidateId)).toMatchObject({ recorded: 'duplicate' })
    const read = gateReceiptsFor({ knowledgeRoot, candidateId })
    expect(read).toMatchObject({
      kind: 'found',
      lines: [{ gate: 1, verdict: 'pass' }],
      standing: [{ gate: 1 }],
    })
    if (read.kind !== 'found') throw new Error('missing persisted receipt')
    expect(read.lines).toHaveLength(1)
    expect(GateReceiptSchema.parse(read.lines[0]).receiptDigest).toBe(
      receiptDigestOf(read.lines[0]!),
    )
  })
  it.each(['procedure', 'unknown'] as const)(
    'records the real %s tier abstention and reads its kind-excluded hold',
    async (kind) => {
      const f = writeGate1Fixture(root)
      renameSync(f.committedRoot, join(root, 'agent-qa-eval'))
      const published = publishBundle(
        {
          knowledgeRoot,
          productKey: 'storefront',
          commitArtifacts: 'none',
          writerLeaseId: '417-kind-fixture',
        },
        {
          draft:
            kind === 'procedure'
              ? makeProcedureBundleDraftFixture({ scope: { tier: 'product', key: 'storefront' } })
              : {
                  kind: 'unknown',
                  anchors: [{ t: 'flow', name: 'Unresolved checkout' }],
                  scope: { tier: 'product', key: 'storefront' },
                  summary: 'Checkout remains unresolved',
                  body: 'The observations do not establish a reliable checkout flow.',
                  distilledEvidenceRef: { id: '417-kind-evidence', sha: 'a'.repeat(64) },
                  originStage: 'run-curation',
                },
          discriminant:
            kind === 'procedure'
              ? { kind, flowName: 'Sign in flow', stepSignature: 'email>password>submit' }
              : { kind, conflictRecordIds: [] },
          originClass: 'agent-verified',
          createdAtOrdinal: 42,
          screenStates: [],
          initialEvents: [],
          relations: [],
          artifacts: [],
          provenance: { mode: 'standalone', sourceDescription: '417 excluded-kind fixture' },
        },
      )
      expect(published.kind).toBe('published')
      if (published.kind !== 'published') throw new Error('fixture bundle publication failed')
      const id = published.id
      // The fixture has actual confirmed evidence, independent of its new gate receipt.
      const lease = LOCAL_CURATION_CAPABILITIES.maintenance.acquireWriterLease(knowledgeRoot)
      if (lease.kind !== 'acquired') throw new Error('fixture confirmation needs a writer lease')
      try {
        const store = createLocalKnowledgeStore({
          knowledgeRoot,
          executionContext: 'local-interactive',
          writerLeaseId: lease.leaseId,
          epoch: lease.epoch,
          sourceBuildOrdinal: 43,
        })
        await store.commit([
          {
            kind: 'Confirm',
            origin: 'agent',
            scope: { tier: 'product', key: 'storefront' },
            citedIds: [asRecordId(id)],
            targetId: asRecordId(id),
            evidenceToken: asEvidenceToken('417-excluded-kind-confirmation'),
            authorship: { path: 'deterministic-fallback', executionContext: 'local-interactive' },
          },
        ])
      } finally {
        LOCAL_CURATION_CAPABILITIES.maintenance.releaseLease({
          knowledgeRoot,
          leaseId: lease.leaseId,
        })
      }
      const auth = vi.fn(async () => {
        throw new Error('tier abstention must not resolve auth')
      })
      const result = await createReplayGateHost({
        ...deps,
        reader: createKnowledgeReader(() => knowledgeRoot),
        curation: LOCAL_CURATION_CAPABILITIES,
        runReplayGate,
        composition: {
          ...deps.composition,
          identity: f.identity,
          planner: { ...deps.composition.planner, resolveAuth: auth },
        },
      }).run(id)
      expect(result).toMatchObject({ kind: 'receipt', recorded: 'appended', exit: 2 })
      if (result.kind !== 'receipt') throw new Error('expected excluded-kind receipt')
      if (result.receipt.gate !== 1) throw new Error('expected Gate 1 receipt')
      expect(result.lines[0]).toBe(renderGate1Line(result.receipt))
      expect(result.lines[0]).toBe(
        'gate 1 · abstain · replay-diff · crossCheck not-run · k=3 · 0/64 screens · 0 calls · reason tier-not-implemented',
      )
      expect(auth).not.toHaveBeenCalled()
      const read = gateReceiptsFor({ knowledgeRoot, candidateId: id })
      expect(read).toMatchObject({
        kind: 'found',
        recordKind: kind,
        status: 'candidate',
        lines: [{ gate: 1, verdict: 'abstain', degradation: 'tier-not-implemented' }],
        live: { verdict: 'hold', reason: 'kind-excluded' },
      })
      if (read.kind !== 'found') throw new Error('missing recorded abstention')
      expect(read.lines).toHaveLength(1)
      expect(read.lines[0]).toEqual(result.receipt)
      expect(
        GateReceiptSchema.parse(JSON.parse(serializeReplayGateReceipt(result.receipt))),
      ).toEqual(result.receipt)
    },
  )
  it('defers auth and full masking setup until the spend boundary, then masks workspace secrets', async () => {
    writeFileSync(
      deps.configPath,
      readFileSync(deps.configPath, 'utf8') +
        '\nregistry:\n  llms:\n    - name: planner\n      provider: openai-compatible\n      model: gpt-stub\n      baseURL: http://localhost:9999/v1\n    - name: judge\n      provider: openai-compatible\n      model: claude-stub\n      baseURL: http://localhost:9999/v1\neval:\n  judge: judge\n',
    )
    const config = readFileSync(deps.configPath, 'utf8').replace('use:\n', 'use:\n  llm: planner\n')
    writeFileSync(deps.configPath, config)
    const secret = 'fixture-masking-token-417-only'
    writeFileSync(join(root, '.env.secrets.local'), `FIXTURE_SECRET=${secret}\n`)
    const session = await resolveEvalSession({ configPath: deps.configPath, keyOnly: true })
    const auth = vi.spyOn(llm, 'resolveModelAuth').mockResolvedValue({
      kind: 'unauthenticated',
      credentialKey: 'fixture',
      provider: 'openai-compatible',
      optional: true,
      message: 'fixture',
    })
    const reads = vi.spyOn(fsPromises, 'readFile')
    let spend = false
    vi.spyOn(bridge, 'createReplayGateHost').mockImplementation((input) => ({
      port: { runReplayGate: async () => completeGate1Receipt(candidateId) },
      run: async () => {
        expect(input.agentQaRoot).toBe(join(root, 'custom-runtime'))
        expect(input.configPath).toBe(deps.configPath)
        expect(input.session.configDir).toBe(root)
        expect(auth).not.toHaveBeenCalled()
        expect(reads.mock.calls.some(([path]) => String(path).endsWith('.env.secrets.local'))).toBe(
          false,
        )
        expect(input.composition.judge).toBeDefined()
        if (spend) {
          await input.composition.planner.resolveAuth()
          expect(auth).toHaveBeenCalledTimes(1)
          expect(auth).toHaveBeenNthCalledWith(1, 'planner', expect.objectContaining({ model: 'gpt-stub' }))
          expect(input.session.mask(secret)).toBe('[secret:FIXTURE_SECRET]')
          expect(auth).toHaveBeenCalledTimes(1)
          await input.composition.judge!.resolveAuth()
          // Identity preparation is declaration-only: each model resolves credentials
          // only when its own lazy callback reaches the spend boundary.
          expect(auth).toHaveBeenCalledTimes(2)
          expect(auth).toHaveBeenNthCalledWith(2, 'judge', expect.objectContaining({ model: 'claude-stub' }))
        }
        return {
          kind: 'refused',
          refusal: { path: root, reason: 'fixture-preflight' },
          notices: [],
          exit: 2,
        }
      },
    }))
    await runReplayGateVerb(session, candidateId, { agentQaRoot: join(root, 'custom-runtime') })
    expect(auth).not.toHaveBeenCalled()
    spend = true
    reads.mockClear()
    await runReplayGateVerb(session, candidateId, { agentQaRoot: join(root, 'custom-runtime') })
    expect(auth.mock.calls.map(([name]) => name)).toEqual(['planner', 'judge'])
  })

  it('keeps the bridge behind the existing eval session seam with DATA-only imports', () => {
    const source = readFileSync(new URL('../replay-gate-host.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/from ['"]@vostride\/agent-qa-(eval|knowledge)/)
    expect(source).toContain("await import('../eval-session-composition.js')")
    expect(source).toMatch(
      /import type \{\s+EvalSession,\s+RunReplayGateInput,\s+RunReplayGateResult,?\s+\} from '\.\.\/eval-session-composition.js'/,
    )
  })
})
