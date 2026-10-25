import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReplayGatePort, KnowledgeReaderPort } from '@vostride/agent-qa-agent'
import * as local from '@vostride/agent-qa-agent-local'
import type { ComposeLocalAgentInput, LocalAgentHost } from '@vostride/agent-qa-agent-local'
import { createPanelIdentity } from '@vostride/agent-qa-eval'
import { asRecordId, asRef, stampReceiptDigest, MASKED_RESOLVED_CONFIG_SCHEMA_VERSION } from '@vostride/agent-qa-schema'
import * as evalLocal from '@vostride/agent-qa-eval-local'
import * as model from '@vostride/agent-qa-model'
import type { GateReceipt } from '@vostride/agent-qa-schema'
import * as session from '../../eval-session-composition.js'
import * as llm from '../../llm-utils.js'
import * as bridge from '../replay-gate-host.js'
import * as posture from '../../curation/promotion-posture.js'
import { composeCliLocalAgent } from '../../composition/local-agent-host.js'
import { defaultPostRunTailOperations, runPostRunTail } from '../../curation/post-run-tail.js'
import { runDaemonHost } from '../../daemon/host.js'
import type { DaemonHostOperations } from '../../daemon/host.js'
import { registerKnowledgeMaintainCommands } from '../../commands/knowledge-maintain.js'

vi.mock('@vostride/agent-qa-agent-local', async importOriginal => {
  const actual = await importOriginal<typeof import('@vostride/agent-qa-agent-local')>()
  return { ...actual, composeLocalAgent: vi.fn(actual.composeLocalAgent),
    LOCAL_CURATION_CAPABILITIES: { ...actual.LOCAL_CURATION_CAPABILITIES,
      drainQueue: vi.fn(async () => ({ kind: 'drained', processed: 0, failures: 0, quarantined: 0, promotions: [] })),
    } }
})

const { completeGate1Receipt } = await import(new URL(
  '../../../../knowledge-local/src/curator/__tests__/fixtures/promotion-floor-fixture.js', import.meta.url,
).href)
const { makeReplayHandoff, memArtifacts, extractStoreLoad, capturingStub,
  actionGenerateResult, judgeGenerateResult } = await import(new URL(
  '../../../../eval-local/src/__tests__/fixtures/replay-fixtures.js', import.meta.url,
).href)

const INITIAL = ['claude-fixture', 'gemini-fixture']
const CHANGED = ['claude-fixture', 'mistral-fixture', 'qwen-fixture']
const candidateId = asRecordId('panel-host-candidate')
const realHost = bridge.createReplayGateHost
const realPosture = posture.buildPromotionPostureResolver
let root: string
let configPath: string
let agentQaRoot: string
let knowledgeRoot: string

function writeConfig(ids = INITIAL) {
  writeFileSync(configPath, `workspace:
  testMatch: [tests/**/*.yaml]
  suiteMatch: [suites/**/*.suite.yaml]
  hooksFile: hooks.yaml
  envFile: .env
  secretsFile: .env.secrets.local
registry:
  llms:
${[{ name: 'planner', model: 'gpt-fixture' }, ...ids.map((model, i) => ({ name: `judge-${i}`, model }))]
    .map(row => `    - name: ${row.name}\n      provider: openai-compatible\n      model: ${row.model}\n      baseURL: http://127.0.0.1:1/v1\n`).join('')}use:
  llm: planner
  mobile:
    appState: preserve
knowledge:
  dir: agent-qa-knowledge
eval:
  judges: [${ids.map((_, i) => `judge-${i}`).join(', ')}]
`)
}

function fakeHost(): LocalAgentHost {
  return { jobs: async () => ({
    queue: { runNextJob: async () => ({ ran: false, reason: 'no-job' }),
      recoverAbandonedClaims: async () => ({ recovered: 0 }),
      nextRunnableAt: async () => undefined },
    store: { adoptEpoch: async () => ({ epoch: 1 }) }, idSource: local.DIGEST_JOB_ID_SOURCE,
  }), close: async () => undefined, registry: {} } as unknown as LocalAgentHost
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'panel-host-'))
  configPath = join(root, 'agent-qa.config.yaml')
  agentQaRoot = join(root, '.agent-qa')
  knowledgeRoot = join(root, 'agent-qa-knowledge')
  mkdirSync(knowledgeRoot)
  mkdirSync(join(root, 'agent-qa-eval'))
  writeConfig()
  writeFileSync(join(root, '.env.secrets.local'), '')
  vi.spyOn(llm, 'resolveModelAuth').mockImplementation(async () => { throw new Error('unexpected credentials') })
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('unexpected network') })
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

/** Invoke the actual shared port, actual key-only verb, and actual validated recording bridge. */
async function exercisePort(port: ReplayGatePort) {
  const recorded: GateReceipt[] = []
  const identities: string[] = []
  const resolve = vi.spyOn(session, 'resolveEvalSession')
  const record = vi.fn(async (input: { receipt: GateReceipt }) => {
    recorded.push(input.receipt)
    return { kind: 'appended' as const }
  })
  vi.spyOn(bridge, 'createReplayGateHost').mockImplementation(input => realHost({ ...input,
    reader: { candidateInjection: async () => ({ kind: 'found', injection: { candidateId } }) } as unknown as KnowledgeReaderPort,
    curation: { recordGateReceipt: record,
      maintenance: { acquireWriterLease: () => ({ kind: 'acquired', leaseId: 'fixture', epoch: 1 }),
        releaseLease: () => ({ kind: 'released' }) } } as unknown as bridge.ReplayGateHostDeps['curation'],
    runReplayGate: async execution => {
      const ids = recorded.length === 0 ? INITIAL : CHANGED
      const identity = createPanelIdentity(ids)
      expect(execution.judgeMembers?.map(member => member.profile.model)).toEqual(ids)
      expect(execution.identity.judgeMemberModelIds).toEqual(ids)
      expect(execution.identity.plannerModelId).toBe('gpt-fixture')
      expect(execution.identity.judgeModelId).toBe(identity.judgeModelId)
      identities.push(execution.identity.profileKey)
      // The invocation accepted these declarations already. Disk changes cannot replace its bag.
      writeConfig(CHANGED)
      await Promise.resolve()
      expect(execution.judgeMembers?.map(member => member.profile.model)).toEqual(ids)
      expect(execution.identity.judgeModelId).toBe(identity.judgeModelId)
      const { receiptDigest: _digest, ...body } = completeGate1Receipt(candidateId)
      const receipt = stampReceiptDigest({ ...body,
        judgeId: `${identity.judgeModelId}|family=${identity.judgeFamily}|judgeVersion=2`,
        judge: { eligibility: 'eligible', overrideConfigured: false, panelSize: ids.length, members: identity.members },
      })
      return { kind: 'receipt', receipt, lines: [], notices: [], refusals: [], modelCalls: 0, wallClockMs: 0 }
    },
  }))
  expect(resolve).not.toHaveBeenCalled()
  const first = await port.runReplayGate(candidateId)
  const second = await port.runReplayGate(candidateId)
  expect(resolve.mock.calls).toEqual([
    [{ configPath, keyOnly: true }], [{ configPath, keyOnly: true }],
  ])
  expect(identities[0]).not.toBe(identities[1])
  expect(recorded).toEqual([first, second])
  expect(record).toHaveBeenCalledTimes(2)
  expect(llm.resolveModelAuth).not.toHaveBeenCalled()
  expect(globalThis.fetch).not.toHaveBeenCalled()
}

function capturePosture() {
  const ports: ReplayGatePort[] = []
  const shared = vi.spyOn(bridge, 'createReplayGatePortForHost')
  const build = vi.spyOn(posture, 'buildPromotionPostureResolver').mockImplementation(async input => {
    expect(input.replayGate).toBeDefined()
    ports.push(input.replayGate!)
    return realPosture(input)
  })
  return { build, ports, shared }
}

describe('421 production panel host paths', () => {
  it('public replay and saved report retain the same complete panel without report-time binding or auth', async () => {
    vi.mocked(llm.resolveModelAuth).mockImplementation(async name => ({ kind: 'unauthenticated',
      credentialKey: name, provider: 'openai-compatible', optional: true, message: 'fixture' }))
    const handoff = makeReplayHandoff({ vision: false })
    const step = handoff.tests[0]!.steps[0]!
    step.modelProfile!.modelId = 'gpt-recorded'
    const state = step.subActions[0]!.stateBefore!
    state.elements.push({ ...state.elements[0]!, ref: asRef('e-next'), name: 'Next', nameNormalized: 'next' })
    state.refMap[asRef('e-next')] = state.refMap[asRef('e-continue')]!
    extractStoreLoad(handoff, memArtifacts(), agentQaRoot)
    const order: string[] = []
    const planner = capturingStub(() => actionGenerateResult('web', 'e-next'), 'gpt-fixture')
    const judges = INITIAL.map(id => capturingStub(() => { order.push(id); return judgeGenerateResult('equivalent', 'high') }, id))
    const sweep = vi.spyOn(evalLocal, 'sweepCassetteReplays')
    writeFileSync(join(root, '.env.secrets.local'), '')
    const resolved = await session.resolveEvalSession({ configPath })
    expect(llm.resolveModelAuth).not.toHaveBeenCalled()
    const replay = await session.runReplayVerb(resolved, {}, { source: 'staged',
      plannerOverrides: { languageModels: planner.languageModels },
      judgeOverrides: { languageModels: Object.assign({}, ...judges.map(row => row.languageModels)) } })
    expect(replay.replayed).toBe(1)
    expect(replay.judge.invoked).toBeGreaterThan(0)
    expect(sweep).toHaveBeenCalledTimes(1)
    expect(sweep.mock.calls[0]![0].judge).toMatchObject({ members: INITIAL.map(id => ({ profile: { model: id } })) })
    expect(order).toEqual(INITIAL.flatMap(id => [id, id]))
    vi.mocked(llm.resolveModelAuth).mockClear()
    const factory = vi.spyOn(model, 'createModel').mockImplementation(() => { throw new Error('report model forbidden') })
    const bind = vi.spyOn(evalLocal, 'bindJudgePanel').mockImplementation(() => { throw new Error('report binding forbidden') })
    const report = await session.runReportVerb(resolved, {}, { source: 'staged' })
    expect(report.report.judge).toMatchObject(createPanelIdentity(INITIAL))
    expect(report.judgeIdentity).toBe('present')
    expect(factory).not.toHaveBeenCalled()
    expect(bind).not.toHaveBeenCalled()
    expect(llm.resolveModelAuth).not.toHaveBeenCalled()
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('operator calibration crosses the sanctioned composition seam with actual key-only planner and complete members', async () => {
    vi.mocked(llm.resolveModelAuth).mockImplementation(async name => ({ kind: 'api-key',
      credentialKey: name, provider: 'openai-compatible', apiKey: 'operator-fixture-value' }))
    const named = vi.spyOn(llm, 'resolveNamedConfig')
    const factory = vi.spyOn(model, 'createModel').mockImplementation(() => { throw new Error('unexpected factory') })
    const run = vi.spyOn(evalLocal, 'runJudgeCalibration').mockRejectedValue(new Error('captured operator boundary'))
    writeFileSync(join(root, '.env.secrets.local'), '')
    const resolved = await session.resolveEvalSession({ configPath })
    expect(llm.resolveModelAuth).not.toHaveBeenCalled()
    await expect(session.runJudgeCalibrateVerb(resolved)).rejects.toThrow('captured operator boundary')
    expect(run).toHaveBeenCalledTimes(1)
    expect(run.mock.calls[0]![0]).toMatchObject({ kind: 'probe', probe: {
      profile: { plannerModelId: 'gpt-fixture', judgeModelId: createPanelIdentity(INITIAL).judgeModelId, judgeVersion: 2 },
      replayProfile: { model: 'gpt-fixture' }, members: INITIAL.map(id => ({ profile: { model: id } })),
    } })
    expect(named.mock.calls.every(call => call[2]?.keyOnly === true)).toBe(true)
    expect(vi.mocked(llm.resolveModelAuth).mock.calls.map(call => call[0])).toEqual(['judge-0', 'judge-1'])
    expect(factory).not.toHaveBeenCalled()
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('local-agent host supplies the shared lazy port to its operation resolver', async () => {
    const proof = capturePosture()
    let composed: ComposeLocalAgentInput | undefined
    vi.mocked(local.composeLocalAgent).mockImplementation(input => { composed = input; return fakeHost() })
    composeCliLocalAgent({ configPath, agentQaRoot,
      model: () => ({ modelId: 'fixture', generate: async () => { throw new Error('unexpected model') } }) })
    expect(proof.shared).not.toHaveBeenCalled()
    await composed!.resolvePromotionPosture!()
    expect(proof.shared).toHaveBeenCalledTimes(1)
    await exercisePort(proof.ports[0])
  })

  it('one-shot tail host composes the same local-agent operation route', async () => {
    const proof = capturePosture()
    let composed: ComposeLocalAgentInput | undefined
    vi.mocked(local.composeLocalAgent).mockImplementation(input => { composed = input; return fakeHost() })
    const host = defaultPostRunTailOperations().composeHost({ configPath, agentQaRoot,
      curateRun: async () => ({ curated: 0, deprecated: 0, complete: true }) })
    await composed!.resolvePromotionPosture!()
    expect(proof.shared).toHaveBeenCalledTimes(1)
    await exercisePort(proof.ports[0])
    await host.close()
  })

  it('post-run tail prepares the shared snapshot for its sweep', async () => {
    const proof = capturePosture()
    const swept = vi.fn(async () => undefined)
    const tail = runPostRunTail({ runId: 'panel-host-run', configPath, configDir: root, agentQaRoot,
      knowledgeConfig: { dir: 'agent-qa-knowledge' }, log: { warn: vi.fn() },
      operations: { resolveKnowledgeRoot: () => knowledgeRoot,
        composeHost: () => fakeHost(),
        acquireWriterLease: () => ({ kind: 'acquired', leaseId: 'fixture', epoch: 1 }),
        releaseLease: () => ({ kind: 'released' }), runCurationTail: swept },
    } as unknown as Parameters<typeof runPostRunTail>[0])
    await tail.drain()
    expect(swept).toHaveBeenCalledTimes(1)
    expect(proof.shared).toHaveBeenCalledTimes(1)
    await exercisePort(proof.ports[0])
  })

  it('knowledge-maintain drain supplies the shared panel-aware port', async () => {
    const proof = capturePosture()
    const program = new Command().option('--config <path>').exitOverride()
    const knowledge = new Command('knowledge')
    registerKnowledgeMaintainCommands(knowledge)
    program.addCommand(knowledge)
    const exit = process.exitCode
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      await program.parseAsync(['node', 'agent-qa', '--config', configPath, 'knowledge', 'drain'])
      expect(process.exitCode).toBe(exit)
      expect(proof.shared).toHaveBeenCalledTimes(1)
      expect(local.LOCAL_CURATION_CAPABILITIES.drainQueue).toHaveBeenCalled()
      await exercisePort(proof.ports[0])
    } finally { process.exitCode = exit }
  })

  it('daemon host publishes the shared operation resolver without a worker or provider', async () => {
    const proof = capturePosture()
    let composed: ComposeLocalAgentInput | undefined
    let stop: (() => void) | undefined
    let markReady!: () => void
    const ready = new Promise<void>(resolve => { markReady = resolve })
    const running = runDaemonHost({ configPath, agentQaRoot, knowledgeRoot,
      config: { getMasked: async () => ({ schemaVersion: MASKED_RESOLVED_CONFIG_SCHEMA_VERSION, configPath, entries: [] }) },
      model: () => ({ modelId: 'fixture', generate: async () => { throw new Error('unexpected model') } }),
      runExecution: {} as NonNullable<Parameters<typeof runDaemonHost>[0]['runExecution']>,
      logger: { info: vi.fn(), error: vi.fn() },
      operations: {
        setInterval: () => 1 as unknown as ReturnType<typeof setInterval>, clearInterval: () => undefined,
        setTimeout: () => 1 as unknown as ReturnType<typeof setTimeout>, clearTimeout: () => undefined,
        onSignal: (signal, listener) => { if (signal === 'SIGTERM') stop = listener },
        offSignal: () => undefined,
        trace: step => { if (step === 'registration-written') markReady() },
        startHeartbeatSupervisor: async () => ({ exited: Promise.resolve(), stop: async () => undefined }),
        startInvokeServer: async () => ({ socketPath: join(agentQaRoot, 'fake.sock'), close: async () => undefined }),
        writeDaemonRegistration: () => undefined,
        composeLocalAgent: input => { composed = input; return fakeHost() },
        drainQueue: (async () => ({ kind: 'drained', failures: 0, quarantined: 0, promotions: [] })) as unknown as DaemonHostOperations['drainQueue'],
      } as Partial<DaemonHostOperations>,
    })
    await Promise.race([ready, running.then(code => { throw new Error(`daemon exited early: ${code}`) })])
    try {
      await composed!.resolvePromotionPosture!()
      expect(proof.shared).toHaveBeenCalled()
      await exercisePort(proof.ports.at(-1)!)
    } finally { stop!(); await expect(running).resolves.toBe(0) }
  })
})
