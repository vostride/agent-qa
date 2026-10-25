import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { calibrateLabels, canonicalJson } from '@vostride/agent-qa-eval'
import { CURRENT_RUN_NOTIFICATION_SCHEMA_VERSION, sha256hex, type PostProcessingStatus, type RunNotificationView } from '@vostride/agent-qa-schema'
import { createKnowledgeReader, DIGEST_JOB_ID_SOURCE } from '@vostride/agent-qa-agent-local'
import { markFixture } from '../../gates/__tests__/feedback-fixture.js'
import { renderChainTerminalLine, renderPostProcessingSummaryLine, type PostRunTailOperations } from '../post-run-tail.js'
import { composeCliPostRunTail } from '../post-run-tail-composition.js'
import { trustPriorsForHost, type TrustPriorDisclosure } from '../trust-priors.js'
import { emptyCanaryCreditCounters } from '../canary-credit.js'

vi.mock('@vostride/agent-qa-eval-local', async original => {
  const actual = await original<typeof import('@vostride/agent-qa-eval-local')>()
  return { ...actual, readLabelCalibration: vi.fn(actual.readLabelCalibration) }
})
import { LABEL_CALIBRATION_SCHEMA_VERSION, readLabelCalibration } from '@vostride/agent-qa-eval-local'
const roots: string[] = []
afterEach(() => { vi.clearAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const disclosure: TrustPriorDisclosure = { status: 'calibrated', digest: 'a'.repeat(64), nByOrigin: { 'agent-verified': 20, 'agent-observed': 25 } }
const priorText = (digest: string, observed = 25) => `trust priors: calibrated@${digest} (agent-verified n=20, agent-observed n=${observed})`
function notification(outcome: 'complete' | 'failed' = 'complete'): RunNotificationView {
  return { schemaVersion: CURRENT_RUN_NOTIFICATION_SCHEMA_VERSION, runId: 'fixture-run', outcome, verdictSummary: { total: 3, byClass: { app_bug: 3 } },
    stages: { analysis: { status: 'complete' }, curation: { status: outcome, curated: 2, deprecated: 1 } } } as RunNotificationView
}
it.each(['complete', 'failed'] as const)('renders exact cached priors on %s terminal without changing counts', outcome => {
  const line = renderChainTerminalLine(notification(outcome), { trustPriorDisclosure: disclosure,
    canary: { ...emptyCanaryCreditCounters(), rideAlongUncredited: 2 } })
  expect(line).toContain(priorText(disclosure.digest!))
  expect(line).toContain('verdicts 3 (app_bug 3)')
  expect(line).toContain('2 curated, 1 deprecated; canary: ride-along 2')
  expect(readLabelCalibration).not.toHaveBeenCalled()
})
it('keeps historical renderer callers explicit about provisional priors', () => {
  expect(renderChainTerminalLine(notification())).toContain('trust priors: provisional')
  expect(renderPostProcessingSummaryLine({ runId: 'fixture-run', chips: { analysis: 'pending', curation: 'pending' } }, 'none')).toContain('trust priors: provisional')
})
function artifact(root: string, precision: number) {
  const report = calibrateLabels({ snapshot: { entries: [], labelsById: new Map(), cassettesById: new Map(), blobPresentById: new Map() }, marks: [] })
  const body = { ...report, schemaVersion: LABEL_CALIBRATION_SCHEMA_VERSION, evidenceDigest: sha256hex('chain fixture'), targetRevisions: [],
    channels: { ...report.channels, 'recorded-verdict': { status: 'calibrated', n: 20, n_gold: 20, precision, wilson95: { lower: 0.1, upper: 0.9, halfWidth: 0.4 } } },
    priors: { 'agent-verified': { alpha: precision * 3, beta: (1 - precision) * 3 } } }
  const value = { ...body, generationId: sha256hex(canonicalJson(body)) }
  const path = join(root, 'agent-qa-eval/labels/calibration.json')
  mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value))
  return value
}
function tail(f: ReturnType<typeof markFixture>, snapshot: ReturnType<typeof trustPriorsForHost>, mode: 'complete' | 'failed' | 'partial' | 'handed-off') {
  const info = vi.fn(), warn = vi.fn()
  const operations = {
    loadCompletedRunHandoff: () => f.handoff, resolveKnowledgeRoot: () => f.knowledgeRoot,
    composeHost: () => ({ jobs: async () => ({ idSource: DIGEST_JOB_ID_SOURCE,
      store: { adoptEpoch: async () => ({ epoch: 7 }) },
      queue: { recoverAbandonedClaims: async () => ({ recovered: 0 }), runNextJob: async () => ({ ran: false, reason: 'no-job' }) } }), close: async () => undefined }),
    acquireWriterLease: () => mode === 'handed-off' ? { kind: 'held', holder: { pid: 42, leaseId: 'held', epoch: 1 } } : { kind: 'acquired', leaseId: 'fixture-lease', epoch: 7 },
    releaseLease: () => ({ kind: 'released' }), nudgeDaemon: async () => undefined,
    runCurationTail: async () => undefined, createChipEmitter: () => ({ observe: () => undefined }),
    readPostProcessingStatus: async (): Promise<PostProcessingStatus> => ({ runId: f.handoff.runId,
      chips: { analysis: 'complete', curation: mode === 'failed' ? 'failed' : 'pending' },
      ...(mode === 'complete' || mode === 'failed' ? { notification: { ...notification(mode), runId: f.handoff.runId } } : {}) }),
    readRunDigest: async () => ({ markChanges: [] }),
  } as unknown as PostRunTailOperations
  const handle = composeCliPostRunTail({ runId: f.handoff.runId, configDir: f.root, configFilePath: f.configPath,
    knowledgeConfig: { dir: 'agent-qa-knowledge' }, log: { info, warn }, operations, trustPriors: snapshot })
  return { handle, info, warn }
}
it.each(['complete', 'failed', 'partial', 'handed-off'] as const)('keeps old and fresh host disclosure and numerical reader consistent for %s', async mode => {
  const f = markFixture(); roots.push(f.root)
  const first = artifact(f.root, 0.75), old = trustPriorsForHost(f)
  const oldReader = createKnowledgeReader(() => f.knowledgeRoot, undefined, undefined, old.resolve)
  const before = await oldReader.candidateInjection!({ candidateId: f.published.id })
  const oldTail = tail(f, old, mode)
  const replacement = artifact(f.root, 0.25)
  await oldTail.handle.drain(); await oldTail.handle.finish()
  expect(oldTail.handle.report().drain).toBe(mode === 'handed-off' ? 'handed-off' : 'drained')
  expect(oldTail.info.mock.calls[0]?.[0]).toContain(priorText(first.generationId, 0))
  expect(await oldReader.candidateInjection!({ candidateId: f.published.id })).toEqual(before)
  expect(readLabelCalibration).toHaveBeenCalledTimes(1)
  const fresh = trustPriorsForHost(f), freshTail = tail(f, fresh, mode)
  const freshReader = createKnowledgeReader(() => f.knowledgeRoot, undefined, undefined, fresh.resolve)
  const after = await freshReader.candidateInjection!({ candidateId: f.published.id })
  expect(before.kind).toBe('found'); expect(after.kind).toBe('found')
  if (before.kind !== 'found' || after.kind !== 'found') throw new Error('fixture injection missing')
  expect(after.injection.line.trust).not.toBe(before.injection.line.trust)
  expect(after.injection.renderedLine).toBe(before.injection.renderedLine)
  await freshTail.handle.drain(); await freshTail.handle.finish()
  expect(freshTail.handle.report().drain).toBe(mode === 'handed-off' ? 'handed-off' : 'drained')
  expect(freshTail.info.mock.calls[0]?.[0]).toContain(priorText(replacement.generationId, 0))
  expect(readLabelCalibration).toHaveBeenCalledTimes(2)
})
