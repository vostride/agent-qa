import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Command } from 'commander'
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, expect, it, vi } from 'vitest'
import { calibrateLabels, canonicalJson } from '@vostride/agent-qa-eval'
import { sha256hex } from '@vostride/agent-qa-schema'
import { chainJobIdsForRun } from '@vostride/agent-qa-agent'
import { DIGEST_JOB_ID_SOURCE } from '@vostride/agent-qa-agent-local'
import { markFixture } from '../../gates/__tests__/feedback-fixture.js'
import { defaultPostRunTailOperations, type PostRunTailHostInput, type PostRunTailOperations } from '../post-run-tail.js'
import { composeCliPostRunTail } from '../post-run-tail-composition.js'
import { createKnowledgeCommand } from '../../commands/knowledge.js'

vi.mock('@vostride/agent-qa-eval-local', async original => {
  const actual = await original<typeof import('@vostride/agent-qa-eval-local')>()
  return { ...actual, readLabelCalibration: vi.fn(actual.readLabelCalibration) }
})
vi.mock('@vostride/agent-qa-agent-local', async original => {
  const actual = await original<typeof import('@vostride/agent-qa-agent-local')>()
  return { ...actual, composeLocalAgent: vi.fn(actual.composeLocalAgent),
    LOCAL_CURATION_CAPABILITIES: { ...actual.LOCAL_CURATION_CAPABILITIES,
      openKnowledgeReader: vi.fn(actual.LOCAL_CURATION_CAPABILITIES.openKnowledgeReader),
      drainQueue: vi.fn(actual.LOCAL_CURATION_CAPABILITIES.drainQueue),
    } }
})
vi.mock('@vostride/agent-qa-knowledge-local', async original => {
  const actual = await original<typeof import('@vostride/agent-qa-knowledge-local')>()
  return { ...actual, drainQueue: vi.fn(actual.drainQueue), rebuildIndex: vi.fn(actual.rebuildIndex), acquireWriterLease: vi.fn(actual.acquireWriterLease) }
})
import { LABEL_CALIBRATION_SCHEMA_VERSION, readLabelCalibration } from '@vostride/agent-qa-eval-local'
import { composeLocalAgent, LOCAL_CURATION_CAPABILITIES } from '@vostride/agent-qa-agent-local'
import { drainQueue, rebuildIndex, acquireWriterLease, readWriterLease } from '@vostride/agent-qa-knowledge-local'
import * as registration from '../../daemon/registration.js'

const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
afterAll(async () => {
  const { removeInProcessFixtures } = await import('../../composition/__tests__/in-process-run-fixture.js')
  removeInProcessFixtures()
})
function fixture() {
  const f = markFixture()
  roots.push(f.root)
  writeFileSync(join(f.root, '.env.secrets.local'), '')
  return f
}
function artifact(root: string, precision = 0.75) {
  const report = calibrateLabels({ snapshot: { entries: [], labelsById: new Map(), cassettesById: new Map(), blobPresentById: new Map() }, marks: [] })
  const body = { ...report, schemaVersion: LABEL_CALIBRATION_SCHEMA_VERSION, evidenceDigest: sha256hex('tail fixture'), targetRevisions: [],
    channels: { ...report.channels, 'recorded-verdict': { status: 'calibrated', n: 20, n_gold: 20, precision, wilson95: { lower: 0.1, upper: 0.9, halfWidth: 0.4 } } },
    priors: { 'agent-verified': { alpha: precision * 3, beta: (1 - precision) * 3 } } }
  const value = { ...body, generationId: sha256hex(canonicalJson(body)) }
  const path = join(root, 'agent-qa-eval/labels/calibration.json')
  mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value))
  return value
}
function tail(f: ReturnType<typeof fixture>, held = false) {
  const defaults = defaultPostRunTailOperations()
  let hostInput: PostRunTailHostInput | undefined
  let pumped = false
  const close = vi.fn<() => Promise<void>>(async () => undefined)
  const fold = vi.fn(defaults.curateCompletedRun)
  const sweep = vi.fn(defaults.runCurationTail)
  const release = vi.fn(defaults.releaseLease)
  const acquire = vi.fn(() => held
    ? { kind: 'held' as const, holder: { pid: 9876, leaseId: 'held', epoch: 1 } } as ReturnType<PostRunTailOperations['acquireWriterLease']>
    : defaults.acquireWriterLease(f.knowledgeRoot))
  const nudge = vi.fn(async () => undefined)
  const warn = vi.fn(); const info = vi.fn()
  const ops: Partial<PostRunTailOperations> = {
    composeHost: input => {
      hostInput = input
      const host = defaults.composeHost(input)
      close.mockImplementation(() => host.close())
      return { ...host, close, jobs: async () => ({
        idSource: DIGEST_JOB_ID_SOURCE,
        store: { adoptEpoch: async (epoch: number) => ({ epoch }) },
        queue: { recoverAbandonedClaims: async () => ({ recovered: 0 }), runNextJob: async () => {
          if (pumped) return { ran: false, reason: 'no-job' }
          pumped = true
          await input.curateRun({ runId: f.handoff.runId, executionContext: f.handoff.executionContext })
          return { ran: true, disposition: 'completed', job: { id: chainJobIdsForRun(f.handoff.runId, DIGEST_JOB_ID_SOURCE).curateMemory, kind: 'curate-memory' } }
        } },
      } as never) }
    },
    acquireWriterLease: acquire, releaseLease: release, nudgeDaemon: nudge,
    curateCompletedRun: fold, runCurationTail: sweep,
    createChipEmitter: () => ({ observe: vi.fn() }) as never,
    readPostProcessingStatus: async () => ({ runId: f.handoff.runId, analysis: 'pending', curation: 'pending' }) as never,
  }
  const handle = composeCliPostRunTail({ runId: f.handoff.runId, configDir: f.root, configFilePath: f.configPath,
    knowledgeConfig: { dir: 'agent-qa-knowledge' },
    log: { warn, info }, operations: ops })
  return { handle, fold, sweep, release, acquire, nudge, warn, info, hostInput: () => hostInput! }
}

it('keeps one snapshot across inline job fold, reader, drain, janitor and local review host', async () => {
  const f = fixture(); const old = artifact(f.root)
  const h = tail(f)
  artifact(f.root, 0.25)
  await h.handle.drain()
  expect(h.handle.report().drain).toBe('drained')
  const local = vi.mocked(composeLocalAgent).mock.calls.at(-1)![0]
  expect(local.resolveTrustPriors?.()).toEqual(old.priors)
  expect(h.hostInput().trustPriors?.resolve).toBe(local.resolveTrustPriors)
  expect(h.fold.mock.calls[0]![0].resolveTrustPriors).toBe(local.resolveTrustPriors)
  expect(h.sweep.mock.calls[0]![0].resolveTrustPriors).toBe(local.resolveTrustPriors)
  const read = vi.mocked(LOCAL_CURATION_CAPABILITIES.openKnowledgeReader).mock.calls.at(-1)![0] as unknown as { priors?: unknown }
  expect(read.priors).toEqual(old.priors)
  expect(vi.mocked(LOCAL_CURATION_CAPABILITIES.drainQueue).mock.calls.at(-1)![0].priors).toBe(local.resolveTrustPriors?.())
  expect(h.fold.mock.calls[0]![0].authority).toEqual(h.sweep.mock.calls[0]![0].authority)
  expect(h.release).toHaveBeenCalledTimes(1)
  expect(readLabelCalibration).toHaveBeenCalledTimes(1)
  await h.handle.finish()
  expect(readLabelCalibration).toHaveBeenCalledTimes(1)
})

it.each([false, true])('retains detached or handed-off snapshot and adopts replacement only on a fresh tail (held=%s)', async held => {
  const f = fixture(); const old = artifact(f.root)
  const h = tail(f, held)
  artifact(f.root, 0.25)
  if (held) await h.handle.drain()
  await h.handle.finish({ detached: !held })
  expect(h.handle.report().drain).toBe(held ? 'handed-off' : 'detached')
  expect(vi.mocked(composeLocalAgent).mock.calls.at(-1)![0].resolveTrustPriors?.()).toEqual(old.priors)
  expect(h.fold).not.toHaveBeenCalled(); expect(h.release).not.toHaveBeenCalled()
  expect(h.nudge).toHaveBeenCalledTimes(held ? 1 : 0)
  expect(readLabelCalibration).toHaveBeenCalledTimes(1)
  const fresh = tail(f)
  await fresh.handle.finish({ detached: true })
  expect(vi.mocked(composeLocalAgent).mock.calls.at(-1)![0].resolveTrustPriors?.()).toEqual(artifact(f.root, 0.25).priors)
  expect(readLabelCalibration).toHaveBeenCalledTimes(2)
})

it('reports malformed tail calibration without acquiring authority or changing the verdict contract', async () => {
  const f = fixture(); artifact(f.root)
  writeFileSync(join(f.root, 'agent-qa-eval/labels/calibration.json'), '{"private":"bad"}')
  const h = tail(f); const takeLease = vi.fn()
  await expect(h.handle.drain({ takeLease })).resolves.toBeUndefined()
  expect(takeLease).not.toHaveBeenCalled(); expect(h.acquire).not.toHaveBeenCalled()
  expect(h.warn).toHaveBeenCalledWith(expect.stringContaining('Trust prior calibration is invalid or unavailable'))
  expect(h.handle.report().drain).toBe('not-attempted')
})

it.each([false, true])('carries the selected local snapshot into its delayed tail (other project=%s)', async otherProject => {
  const { createInProcessFixture } = await import('../../composition/__tests__/in-process-run-fixture.js')
  const { composeCliLocalAgent } = await import('../../composition/local-agent-host.js')
  const driveModule = await import('../../composition/in-process-run-execution.js')
  const tailModule = await import('../post-run-tail-composition.js')
  const f = createInProcessFixture({ origin: 'http://127.0.0.1:1', environment: 'local' }); roots.push(f.project)
  const old = artifact(f.project)
  const selected = otherProject ? createInProcessFixture({ origin: 'http://127.0.0.1:1', environment: 'local' }) : f
  if (otherProject) roots.push(selected.project)
  const selectedArtifact = otherProject ? artifact(selected.project, 0.5) : old
  const drive = vi.spyOn(driveModule, 'runInProcessCliRun').mockResolvedValue({ runId: 'fixture-run' } as never)
  const composed = vi.spyOn(tailModule, 'composeCliPostRunTail').mockReturnValue({ drain: vi.fn(async () => undefined), finish: vi.fn(async () => undefined), report: vi.fn() })
  const host = composeCliLocalAgent({ configPath: f.configPath, agentQaRoot: f.agentQaRoot })
  try {
    const local = vi.mocked(composeLocalAgent).mock.calls.at(-1)![0]
    artifact(f.project, 0.25)
    await local.runExecution!.execute({ configPath: selected.configPath, patterns: [selected.testPattern] })
    const invocation = drive.mock.calls[0]![0]
    writeFileSync(join(selected.project, 'agent-qa-eval/labels/calibration.json'), '{"private":"malformed replacement"}')
    await invocation.postRunTail!({ runId: 'fixture-run', configDir: selected.project, configFilePath: selected.configPath,
      postVerdict: { takeAcquiredLease: () => undefined } } as never)
    const ready = composed.mock.calls[0]![0].trustPriors
    if (!otherProject) expect(ready?.resolve).toBe(local.resolveTrustPriors)
    expect(ready?.resolve).toBe(invocation.resolveTrustPriors)
    expect(ready?.resolve()).toEqual(selectedArtifact.priors)
    expect(ready?.disclosure.digest).toBe(selectedArtifact.generationId)
    expect(local.resolveTrustPriors?.()).toEqual(old.priors)
    expect(readLabelCalibration).toHaveBeenCalledTimes(otherProject ? 2 : 1)
  } finally { await host.close() }
})

async function command(f: ReturnType<typeof fixture>, verb: string) {
  const previous = process.exitCode
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  process.exitCode = undefined
  try {
    const program = new Command().option('--config <path>').addCommand(createKnowledgeCommand())
    await program.parseAsync(['node', 'agent-qa', '--config', f.configPath, 'knowledge', verb, '--json'])
    return { exit: process.exitCode ?? 0, errors: stderr.mock.calls.map(call => String(call[0])).join('') }
  } finally { process.exitCode = previous; log.mockRestore(); stderr.mockRestore(); stdout.mockRestore() }
}

it('uses one invocation snapshot for operator reindex even when calibration changes at lease acquisition', async () => {
  const f = fixture(); const old = artifact(f.root)
  const acquire = vi.mocked(acquireWriterLease)
  const actual = await vi.importActual<typeof import('@vostride/agent-qa-knowledge-local')>('@vostride/agent-qa-knowledge-local')
  acquire.mockImplementationOnce(root => { artifact(f.root, 0.25); return actual.acquireWriterLease(root) })
  expect((await command(f, 'rebuild-index')).exit).toBe(0)
  expect(vi.mocked(rebuildIndex).mock.calls[0]![0].priors).toEqual(old.priors)
  expect(vi.mocked(rebuildIndex).mock.calls[0]![0].writerAuthority).toBeDefined()
  expect(readWriterLease(f.knowledgeRoot).kind).toBe('absent')
  expect(readLabelCalibration).toHaveBeenCalledTimes(1)
  expect((await command(f, 'rebuild-index')).exit).toBe(0)
  expect(vi.mocked(rebuildIndex).mock.calls[1]![0].priors).toEqual(artifact(f.root, 0.25).priors)
})

it.each(['absent', 'unreachable-lease-stale'] as const)('keeps invocation priors through inline maintenance routing and daemon recovery (%s)', async kind => {
  const f = fixture(); const old = artifact(f.root)
  if (kind !== 'absent') registration.writeDaemonRegistration(f.agentQaRoot, {
    schemaVersion: registration.DAEMON_REGISTRATION_SCHEMA_VERSION, instanceId: randomUUID(),
    pid: 9876, socketPath: join(f.agentQaRoot, 'daemon.sock'), startedAtMs: 1,
  })
  const classifyHost = registration.classifyDaemonRegistration
  const classify = vi.spyOn(registration, 'classifyDaemonRegistration').mockImplementationOnce(async input => {
    artifact(f.root, 0.25)
    return classifyHost({ ...input, operations: { fetchIdentity: async () => { throw new Error('fixture daemon unreachable') } } })
  })
  const remove = vi.spyOn(registration, 'removeRegistrationIfOwned')
  expect((await command(f, 'drain')).exit).toBe(0)
  expect(vi.mocked(drainQueue).mock.calls.at(-1)![0].priors).toEqual(old.priors)
  expect(classify).toHaveBeenCalledTimes(1)
  expect(remove).toHaveBeenCalledTimes(kind === 'absent' ? 0 : 1)
  expect(registration.readDaemonRegistration(f.agentQaRoot).kind).toBe('absent')
  expect(readLabelCalibration).toHaveBeenCalledTimes(1)
})

it.each(['drain', 'rebuild-index'])('refuses malformed operator calibration before authority or recovery (%s)', async verb => {
  const f = fixture(); artifact(f.root)
  writeFileSync(join(f.root, 'agent-qa-eval/labels/calibration.json'), '{"private":"bad"}')
  const before = readFileSync(join(f.root, 'agent-qa-eval/labels/calibration.json'), 'utf8')
  const classify = vi.spyOn(registration, 'classifyDaemonRegistration')
  const result = await command(f, verb)
  expect(result.exit).toBe(1)
  expect(result.errors).toContain('Trust prior calibration is invalid or unavailable')
  expect(acquireWriterLease).not.toHaveBeenCalled(); expect(classify).not.toHaveBeenCalled()
  expect(readFileSync(join(f.root, 'agent-qa-eval/labels/calibration.json'), 'utf8')).toBe(before)
})
