import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as core from '@vostride/agent-qa-eval'
import * as local from '../index.js'
import {
  MARK_RECEIPT_SCHEMA_VERSION,
  asRunId,
  screenStateHash,
  sha256hex,
  type CompletedRunHandoff,
} from '@vostride/agent-qa-schema'
import { afterEach, describe, expect, it } from 'vitest'
import { makeLocalV2Handoff } from './fixtures/local-handoff-fixture.js'

export function recoveryHandoff(name = 'population-one', product = 'shop'): CompletedRunHandoff {
  const handoff = makeLocalV2Handoff({ runId: asRunId(name), scope: { tier: 'product', key: product } })
  const member = handoff.tests[0]!
  member.steps = [member.steps[0]!]
  const step = member.steps[0]!
  const failed = step.subActions[0]!
  failed.plannedAction = { type: 'navigate', to: 'url', url: 'https://example.test/first' }
  failed.result = { success: false, error: 'did not advance' }
  const recovering = structuredClone(failed)
  recovering.plannedAction = { type: 'navigate', to: 'url', url: 'https://example.test/second' }
  recovering.result = { success: true }
  step.subActions.push(recovering)
  step.selfHeal = {
    failedDecision: { plan: failed.plan, plannedAction: failed.plannedAction, result: failed.result },
    recoveringDecision: { plan: recovering.plan, plannedAction: recovering.plannedAction, result: recovering.result },
  }
  return handoff
}

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function root() { const dir = mkdtempSync(join(tmpdir(), 'label-evidence-')); roots.push(dir); return dir }
function persist(dir: string, handoff: CompletedRunHandoff, slug = core.deriveRunSlug(handoff.runId)) {
  const run = join(dir, 'runs', slug)
  mkdirSync(run, { recursive: true })
  writeFileSync(join(run, 'handoff.json'), JSON.stringify(handoff))
}
function snapshot(handoff: CompletedRunHandoff) {
  return {
    entries: [{ schemaVersion: 2 as const, cassetteId: 'logical-member', product: 'shop',
      captured_at_ordinal: 11, run_links: { runId: handoff.runId, runSlug: core.deriveRunSlug(handoff.runId) },
      receiptDigest: 'a'.repeat(64), split: 'natural' as const }],
    labelsById: new Map(), cassettesById: new Map(), blobPresentById: new Map(),
  }
}

describe('420 logical recovery population', () => {
  it('counts complete extraction-skipped handoff recovery once across repeated inputs', () => {
    const handoff = recoveryHandoff()
    const collect = Reflect.get(core, 'collectSoftPopulation')
    const result = collect?.({ handoffs: [handoff, structuredClone(handoff)] })
    expect(result?.observations).toHaveLength(1)
    expect(result.observations[0]).toMatchObject({ product: 'shop', runId: handoff.runId,
      failedScreenStateHash: screenStateHash(handoff.tests[0]!.steps[0]!.subActions[0]!.stateBefore),
      recoveringAction: { type: 'navigate', to: 'url', url: 'https://example.test/second' }, attempt: 0 })
  })

  it('isolates product and failed state and compares canonical actions with exact k/n', () => {
    const first = recoveryHandoff()
    const same = recoveryHandoff('population-two')
    same.tests[0]!.steps[0]!.selfHeal!.recoveringDecision.plannedAction = { url: 'https://example.test/second', type: 'navigate', to: 'url' }
    const otherAction = recoveryHandoff('population-three')
    const step = otherAction.tests[0]!.steps[0]!
    step.selfHeal!.recoveringDecision.plannedAction = step.subActions[1]!.plannedAction = { type: 'navigate', to: 'url', url: 'https://example.test/third' }
    const otherState = recoveryHandoff('population-four')
    otherState.tests[0]!.steps[0]!.subActions[0]!.stateBefore.url = 'https://example.test/other'
    const result = Reflect.get(core, 'collectSoftPopulation')?.({ handoffs: [first, same, otherAction, otherState, recoveryHandoff('population-five', 'other')] })
    expect(result?.observations).toHaveLength(5)
    const wanted = result.observations.find((row: { runId: string }) => row.runId === first.runId)!
    const population = result.observations.filter((row: typeof wanted) => row.product === wanted.product && row.failedScreenStateHash === wanted.failedScreenStateHash)
    expect(population).toHaveLength(3)
    expect(population.filter((row: typeof wanted) => core.canonicalJson(row.recoveringAction) === core.canonicalJson(wanted.recoveringAction))).toHaveLength(2)
  })

  it('counts rerun recovery and discloses absent original evidence without fabricating it', () => {
    const handoff = recoveryHandoff()
    Object.assign(handoff.tests[0]!, { isRerun: true, rerunAttempt: 2 })
    const result = Reflect.get(core, 'collectSoftPopulation')?.({ handoffs: [handoff] })
    expect(result?.observations).toHaveLength(1)
    expect(result.observations[0].rerun).toEqual({ attempt: 2 })
    expect(result.missingEvidenceCounts['missing-original']).toBe(1)
  })

  it.each(['missing-failed-state', 'missing-action', 'unverified-success', 'ambiguous-decision'] as const)('discloses %s without inventing an observation', reason => {
    const handoff = recoveryHandoff()
    const step = handoff.tests[0]!.steps[0]!
    if (reason === 'missing-failed-state') Reflect.deleteProperty(step.subActions[0]!, 'stateBefore')
    if (reason === 'missing-action') Reflect.deleteProperty(step.selfHeal!.recoveringDecision, 'plannedAction')
    if (reason === 'unverified-success') step.verifierVerdict.pass = false
    if (reason === 'ambiguous-decision') step.subActions.push(structuredClone(step.subActions[1]!))
    const result = Reflect.get(core, 'collectSoftPopulation')?.({ handoffs: [handoff] })
    expect(result?.observations).toEqual([])
    expect(result.missingEvidenceCounts[reason]).toBe(1)
  })

  it('attributes the recovering live planner only and makes immutable evidence order-stable', () => {
    const first = recoveryHandoff()
    const step = first.tests[0]!.steps[0]!
    step.modelProfile = { provider: 'openai', modelId: 'gpt-5', vision: true }
    step.subActions[1]!.callRecord = { resolvedModelId: 'gpt-5-mini' }
    const second = recoveryHandoff('population-two')
    const collect = Reflect.get(core, 'collectSoftPopulation')
    expect(collect).toBeTypeOf('function')
    const a = collect({ handoffs: [first, second] })
    const b = collect({ handoffs: [second, first, first] })
    expect(a.evidenceDigest).toEqual(b.evidenceDigest)
    expect(a.observations.find((row: { runId: string }) => row.runId === first.runId)!.recoveringDecision.modelIdentity).toEqual({ provider: 'openai', modelId: 'gpt-5-mini' })
    delete step.modelProfile
    const missing = collect({ handoffs: [first] }).observations[0]
    expect(missing.recoveringDecision.modelIdentity).toBeUndefined()
  })

  it('counts distinct original attempts once despite repeated decision snapshots', () => {
    const handoff = recoveryHandoff()
    const member = handoff.tests[0]!, evidence = structuredClone(member.steps[0]!)
    const decisions = evidence.subActions.map((sub, decisionOrdinal) => {
      const facts = { runId: handoff.runId, testId: member.testId, testIndex: member.testIndex,
        stepIndex: evidence.stepIndex, decisionOrdinal, evidence }
      return { ...facts, screenStateHash: screenStateHash(sub.stateBefore), evidenceDigest: sha256hex(core.canonicalJson(facts)) }
    })
    const facts = { attempt: 0, outcome: 'failed' as const, decisions }
    member.isRerun = true; member.rerunAttempt = 2
    member.rerunOrigin = { ...facts, evidenceDigest: sha256hex(core.canonicalJson(facts)) }
    const result = core.collectSoftPopulation({ handoffs: [handoff, handoff] })
    expect(result.observations.map(row => row.attempt).sort()).toEqual([0, 2])
    expect(result.missingEvidenceCounts).toEqual({})
    expect(result.observations.find(row => row.attempt === 2)!.rerun).toEqual({ attempt: 2,
      originalAttempt: 0, originalEvidenceDigest: member.rerunOrigin.evidenceDigest })
  })

  it('joins only the latest matching mark and never borrows another member or empty successor', () => {
    const handoff = recoveryHandoff()
    const sourceCassetteId = core.deriveLeafCassetteId({ runSlug: core.deriveRunSlug(handoff.runId), testIndex: 0, stepIndex: 0, decisionOrdinal: 1 })
    const mark: core.GoldMark = { schemaVersion: MARK_RECEIPT_SCHEMA_VERSION, markId: 'mark_aaaaaaaaaaaa', runId: handoff.runId,
      runSlug: core.deriveRunSlug(handoff.runId), testIndex: 0, stepIndex: 0, kind: 'false-pass',
      origin: 'user', ordinal: 1, markedAt: 1, disposition: { kind: 'quarantined', class: 'flake' },
      gold: [{ cassetteId: core.deriveGoldCassetteId({ leafCassetteId: sourceCassetteId, markOrdinal: 1 }), sourceCassetteId, channel: 'user-mark' }],
      evidence: { confirmed: 0, overturned: 1 } }
    const collect = (marks: core.GoldMark[]) => core.collectSoftPopulation({ handoffs: [handoff], marks }).observations[0]!.recoveringDecision
    expect(collect([mark]).governingMark).toEqual({ markId: mark.markId, kind: mark.kind })
    expect(collect([{ ...mark, testIndex: 1 }]).governingMark).toBeUndefined()
    expect(collect([mark, { ...mark, markId: 'mark_bbbbbbbbbbbb', ordinal: 2, gold: [] }]).governingMark).toBeUndefined()
  })

  it('refuses conflicting immutable observations independently of input order', () => {
    const first = recoveryHandoff(), conflicting = structuredClone(first)
    conflicting.tests[0]!.steps[0]!.modelProfile!.provider = 'different-provider'
    const a = core.collectSoftPopulation({ handoffs: [first, conflicting, first] })
    const b = core.collectSoftPopulation({ handoffs: [conflicting, first] })
    expect(a.observations).toEqual([])
    expect(a).toEqual(b)
    expect(a.missingEvidenceCounts['conflicting-observation']).toBe(1)
  })
})

describe('420 verified label evidence source', () => {
  it('loads one handoff for pair sides, gold clones, revisions and incoming reseeds', () => {
    const dir = root(), handoff = recoveryHandoff()
    persist(dir, handoff)
    const snap = snapshot(handoff)
    snap.entries.push(...Array.from({ length: 4 }, (_, i) => ({ ...snap.entries[0]!, cassetteId: `copy-${i}` })))
    const result = Reflect.get(local, 'loadLabelEvidence')?.({ snapshot: snap, agentQaRoot: dir, incoming: handoff })
    expect(result?.handoffs).toHaveLength(1)
    expect(result.refusals).toEqual([])
  })

  it.each(['identity', 'product', 'traversal', 'symlink', 'missing'])('refuses %s source links', mode => {
    const dir = root(), handoff = recoveryHandoff()
    const snap = snapshot(handoff)
    const alternate = recoveryHandoff('different-run')
    if (mode === 'identity') persist(dir, alternate, core.deriveRunSlug(handoff.runId))
    else if (mode === 'product') persist(dir, { ...handoff, scope: { tier: 'product', key: 'foreign' } })
    else if (mode === 'traversal') snap.entries[0]!.run_links.runSlug = '../outside'
    else if (mode === 'symlink') {
      const outside = root(); persist(outside, handoff)
      mkdirSync(join(dir, 'runs'), { recursive: true })
      symlinkSync(join(outside, 'runs', core.deriveRunSlug(handoff.runId)), join(dir, 'runs', core.deriveRunSlug(handoff.runId)))
    }
    const result = Reflect.get(local, 'loadLabelEvidence')?.({ snapshot: snap, agentQaRoot: dir })
    expect(result?.handoffs).toEqual([])
    expect(result.refusals).toHaveLength(1)
  })
})
