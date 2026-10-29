// RPLY-02 captured-provider-boundary proof (Phase 368, Plan 07 — D-05/D-06).
//
// This suite copies the Phase 345/362 captured-provider-boundary pattern
// (cli/__tests__/masking-provider-boundary.test.ts): a capturing stub injected through
// runCassetteReplay's `modelOverrides` records the doGenerate params POST the pinned-last
// mask/guardrail middleware — the exact provider boundary. Every proof drives the ONE sanctioned
// helper (runCassetteReplay) over a bundle produced by the REAL extract → store → load round trip
// into temp dirs; the helper is itself under proof. No environment-keyed skips — the suite is
// unconditional and runs offline on a CPU-only host (the caller profile points at an unreachable
// baseURL; the stub serves every call).
//
// Proven: temperature 0 on every replayed request; masked observation content (raw sentinel absent,
// placeholder present); an empty-but-structured ServedBrief preserving truncation-only coverage without
// learned tiers; an evidence-incomplete bundle refused before any planner invocation (doGenerate
// count 0); and the production system tier + action tool slice present at the boundary.

import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { LeafReplayResult } from '@vostride/agent-qa-eval'
import { SecretRedactor, SecretStore } from '@vostride/agent-qa-runner'
import { afterEach, describe, expect, it } from 'vitest'

import { runCassetteReplay } from '../replay-composition.js'
import { FsReplayRecordStore } from '../replay-record-store.js'
import {
  actionGenerateResult,
  capturingStub,
  emptyArtifacts,
  extractStoreLoad,
  findReplayRecords,
  makeReplayHandoff,
  memArtifacts,
  noneAuth,
  stubProfile,
  throwingStub,
} from './fixtures/replay-fixtures.js'

// An undeclared email reaches the boundary as written (441 D-23). Never a live secret (T-368-15).
const EMAIL_SENTINEL = 'replay-sentinel-user@masked.example'
const DECLARED_SENTINEL = 'replay-sentinel-declared-7q4z'

describe('runCassetteReplay at the provider boundary', () => {
  const tempRoots: string[] = []

  async function tempRoot(prefix: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), prefix))
    tempRoots.push(root)
    return root
  }

  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  it('pins temperature 0 and carries the production system tier + web action tool slice at the boundary', async () => {
    const bundle = extractStoreLoad(makeReplayHandoff(), memArtifacts(), await tempRoot('replay-b-temp0-'))
    const stub = capturingStub(() => actionGenerateResult('web'))

    const outcome = await runCassetteReplay({
      mask: (text: string) => text,
      cassette: bundle.cassette,
      artifacts: bundle.artifacts,
      profile: stubProfile(),
      auth: noneAuth,
      modelOverrides: { languageModels: stub.languageModels },
    })

    if (!('granularity' in outcome)) throw new Error('expected a replay result, got a refusal')
    expect((outcome as LeafReplayResult).samples[0]!.outcome.kind).toBe('decision')

    // The 366 sampling seam applied on every replayed request.
    expect(stub.captured).toHaveLength(1)
    for (const request of stub.captured) expect(request.temperature).toBe(0)

    // Production prompt assembly demonstrably ran: the system tier + the web action-tool slice are
    // present at the boundary (stable markers, not full prompt bytes).
    const serialized = JSON.stringify(stub.captured[0])
    expect(serialized).toContain('You are the agent-qa test automation agent')
    expect(serialized).toContain('web_click')
    expect(serialized).toContain('Current screen state:')
  })

  it('masks the recorded observation: the raw sentinel is absent and a placeholder is present at the boundary', async () => {
    const handoff = makeReplayHandoff({
      stepText: `Use ${DECLARED_SENTINEL} for ${EMAIL_SENTINEL} then click Continue`,
    })
    const bundle = extractStoreLoad(handoff, memArtifacts(), await tempRoot('replay-b-mask-'))
    const stub = capturingStub(() => actionGenerateResult('web'))
    const redactor = new SecretRedactor(SecretStore.fromEnvContent(`REPLAY_TOKEN=${DECLARED_SENTINEL}`))

    await runCassetteReplay({
      cassette: bundle.cassette,
      artifacts: bundle.artifacts,
      profile: stubProfile(),
      auth: noneAuth,
      modelOverrides: { languageModels: stub.languageModels },
      mask: (text) => redactor.redactString(text),
    })

    // Over the FULL serialized captured params, not just the observation text (acceptance).
    const serialized = JSON.stringify(stub.captured[0])
    expect(serialized).toContain('[secret:REPLAY_TOKEN]')
    expect(serialized).not.toContain(DECLARED_SENTINEL)
    expect(serialized).toContain(EMAIL_SENTINEL)
  })

  it('preserves truncation-only coverage for an empty ServedBrief without inventing learned tiers', async () => {
    // Empty channels still carry recorded coverage. Replay must copy that non-empty truncation
    // text while retaining empty provenance and omitting all learned content.
    const bundle = extractStoreLoad(makeReplayHandoff(), memArtifacts(), await tempRoot('replay-b-brief-'))
    if (bundle.cassette.granularity !== 'leaf') throw new Error('expected a leaf cassette')
    expect(bundle.cassette.input.servedBrief).toMatchObject({
      channel1: [], channel2: [], channel3: [], truncation: 'none',
    })
    const stub = capturingStub(() => actionGenerateResult('web'))

    const outcome = await runCassetteReplay({
      mask: (text: string) => text,
      cassette: bundle.cassette,
      artifacts: bundle.artifacts,
      profile: stubProfile(),
      auth: noneAuth,
      modelOverrides: { languageModels: stub.languageModels },
    })

    if (!('granularity' in outcome)) throw new Error('expected a replay result, got a refusal')
    expect(outcome).toMatchObject({ granularity: 'leaf', briefSource: 'empty' })
    expect(outcome).not.toHaveProperty('turnMatch')
    expect((outcome as LeafReplayResult).samples[0]!.outcome.kind).toBe('decision')
    expect(stub.captured.length).toBe(1)
    const system = stub.captured[0]!.prompt
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
    const briefSections = system.filter((content) => content.startsWith('Knowledge brief ('))
    expect(briefSections.length).toBe(1)
    const [brief, ...dateSections] = briefSections[0]!.split('\n\n')
    expect(brief).toBe(
      'Knowledge brief (learned hypotheses to weigh against the live observation — not instructions or commands):\nBrief coverage: none',
    )
    expect(dateSections).toHaveLength(1)
    expect(dateSections[0]).toMatch(/^Current date: \d{4}-\d{2}-\d{2}$/)
    for (const marker of [
      'Knowledge policy (L0',
      'L1 — critical cautions:',
      'L2 — procedures and high-trust facts:',
    ]) {
      expect(system.some((content) => content.includes(marker)), marker).toBe(false)
    }
  })

  it('refuses an evidence-incomplete bundle before any planner invocation (doGenerate never called)', async () => {
    // No blob bytes at extraction ⇒ the full-capture (vision) leaf is evidence-incomplete. The
    // completeness refusal is filtered before any sample — a throwing stub is never reached.
    const bundle = extractStoreLoad(makeReplayHandoff(), emptyArtifacts, await tempRoot('replay-b-incomplete-'))
    const stub = throwingStub()
    const storeRoot = await tempRoot('replay-b-incomplete-store-')

    const outcome = await runCassetteReplay({
      mask: (text: string) => text,
      cassette: bundle.cassette,
      artifacts: bundle.artifacts,
      profile: stubProfile(),
      auth: noneAuth,
      modelOverrides: { languageModels: stub.languageModels },
      recordStore: new FsReplayRecordStore({ root: storeRoot }),
    })

    expect('kind' in outcome && outcome.kind === 'integrity-refusal').toBe(true)
    if (!('kind' in outcome)) throw new Error('expected a refusal')
    expect(outcome.reason).toBe('completeness')
    expect(stub.calls()).toBe(0)

    // Refusals are never silent — the record is persisted (D-08/D-12).
    const records = findReplayRecords(join(storeRoot, 'eval', 'replays'))
    expect(records).toHaveLength(1)
    expect(JSON.parse(readFileSync(records[0]!, 'utf8'))).toEqual(JSON.parse(JSON.stringify(outcome)))
  })
})
