import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, symlinkSync, readlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import {
  asRunId,
  type CompletedRunHandoff,
} from '@vostride/agent-qa-schema'
import { buildSeedingPlan, committedFileText, extractRunCassettes, computeCorpusDigest } from '@vostride/agent-qa-eval'
import * as api from '../index.js'
import { committedCassettePath, committedCorpusPath, committedLabelPath } from '../committed-root-store.js'
import { makeLocalV2Handoff, LOCAL_FIXTURE_BLOB_BYTES } from './fixtures/local-handoff-fixture.js'

const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function write(root: string, path: string, text: string) { const full = join(root, path); mkdirSync(dirname(full), { recursive: true }); writeFileSync(full, text); return full }
function bytes(root: string): Record<string, string> {
  const result: Record<string, string> = {}
  if (!existsSync(root)) return result
  const walk = (dir: string, prefix = '') => { for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = prefix + entry.name
    if (entry.isSymbolicLink()) result[path] = 'symlink:' + readlinkSync(join(dir, entry.name))
    else if (entry.isDirectory()) walk(join(dir, entry.name), path + '/')
    else result[path] = readFileSync(join(dir, entry.name), 'utf8')
  } }
  walk(root); return result
}
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'agent-qa-calibration-write-')); roots.push(root)
  const committedRoot = join(root, 'committed'), agentQaRoot = join(root, 'runtime')
  const handoff = makeLocalV2Handoff({ runId: asRunId('calibration-producer'), scope: { tier: 'product', key: 'shop' } })
  handoff.tests = [handoff.tests[0]!]
  handoff.tests[0]!.steps = [handoff.tests[0]!.steps[0]!]
  const step = handoff.tests[0]!.steps[0]!, failed = step.subActions[0]!
  failed.stateBefore.timestamp = 1725000000
  failed.plannedAction = { type: 'navigate', to: 'url', url: 'https://example.test/first' }
  failed.result = { success: false, error: 'did not advance' }
  const recovery = structuredClone(failed)
  recovery.plannedAction = { type: 'navigate', to: 'url', url: 'https://example.test/second' }
  recovery.result = { success: true }
  step.subActions.push(recovery)
  step.selfHeal = { failedDecision: { plan: failed.plan, plannedAction: failed.plannedAction, result: failed.result }, recoveringDecision: { plan: recovery.plan, plannedAction: recovery.plannedAction, result: recovery.result } }
  const persistRun = (value: CompletedRunHandoff) => write(agentQaRoot, `runs/${value.runId}/handoff.json`, JSON.stringify(value))
  persistRun(handoff)
  const extracted = extractRunCassettes({ handoff, artifacts: { getBlob: () => LOCAL_FIXTURE_BLOB_BYTES } })
  const plan = buildSeedingPlan({ handoff, cassettes: extracted.cassettes, partition: { saltHex: 'a'.repeat(64), heldOutFraction: 0.2, privateFraction: 0.5 } })
  for (const item of plan.cases) {
    const label = structuredClone(item.labelRecord); delete label.weight
    write(committedRoot, committedLabelPath('shop', item.cassetteId), committedFileText(label))
    write(committedRoot, committedCorpusPath('shop', item.cassetteId), committedFileText(item.corpusEntry))
    write(committedRoot, committedCassettePath('shop', item.cassetteId), committedFileText(extracted.cassettes.find(row => row.cassette.id === item.cassetteId)!.cassette))
  }
  expect(plan.pairCounts.total).toBe(1)
  const invoke = (opts: Partial<api.RunLabelCalibrationInput> = {}) => api.runLabelCalibration({ committedRoot, agentQaRoot, ...opts })
  return { root, committedRoot, agentQaRoot, invoke, handoff, persistRun, plan }
}

it.each(['before-revision:0', 'before-revision:1', 'before-marker', 'before-rename', 'after-marker'])('recovers a complete generation after %s interruption', async boundary => {
  const f = setup(), planned = await f.invoke()
  expect(planned.kind).toBe('dry-run')
  if (planned.kind !== 'dry-run') throw new Error('fixture preparation failed')
  const visited: string[] = []
  const interrupted = await f.invoke({ commit: true, onBoundary: stage => {
    visited.push(stage)
    if (stage === boundary) throw new Error('injected publication interruption')
  } })
  expect(visited).toContain(boundary)
  expect(interrupted.kind).toBe('publication-failed')
  const read = api.readCommittedCorpus(f.committedRoot)
  expect(read.refusals).toEqual([])
  expect(read.snapshot.labelsById.size).toBe(2)
  expect([...read.snapshot.labelsById.values()].every(label => Boolean(label.weight) === (boundary === 'after-marker'))).toBe(true)
  expect(api.readLabelCalibration(f.committedRoot).kind).toBe(boundary === 'after-marker' ? 'loaded' : 'absent')
  const retry = await f.invoke({ commit: true })
  expect(retry).toMatchObject({ kind: boundary === 'after-marker' ? 'unchanged' : 'committed', artifact: planned.artifact })
  const published = bytes(f.root)
  expect(await f.invoke({ commit: true })).toMatchObject({ kind: 'unchanged', refreshedCount: 0, artifact: planned.artifact })
  expect(bytes(f.root)).toEqual(published)
  expect(api.readCommittedCorpus(f.committedRoot).snapshot.labelsById.size).toBe(2)
})

it.each(['before-revision:0', 'before-revision:1', 'before-marker', 'before-rename'])('preserves committed ancestry and ignores orphan replacements at %s', async boundary => {
  const f = setup(), first = await f.invoke({ commit: true })
  expect(first.kind).toBe('committed')
  const prior = api.readCommittedCorpus(f.committedRoot).snapshot.labelsById
  f.handoff.tests[0]!.steps[0]!.modelProfile!.modelId = 'gpt-5'
  f.handoff.tests[0]!.steps[0]!.subActions[1]!.callRecord!.resolvedModelId = 'gpt-5'
  f.persistRun(f.handoff)
  const previewBytes = bytes(f.root), desired = await f.invoke()
  expect(bytes(f.root)).toEqual(previewBytes)
  expect(await f.invoke({ commit: true })).toMatchObject({ kind: 'write-conflict' })
  expect(bytes(f.root)).toEqual(previewBytes)
  expect(await f.invoke({ commit: true, replace: true, onBoundary: stage => {
    if (stage === boundary) throw new Error('replacement interrupted')
  } })).toMatchObject({ kind: 'publication-failed' })
  expect(api.readCommittedCorpus(f.committedRoot).snapshot.labelsById).toEqual(prior)
  if (first.kind === 'committed') expect(api.readLabelCalibration(f.committedRoot)).toMatchObject({ kind: 'loaded', artifact: first.artifact })
  if (desired.kind !== 'dry-run') throw new Error('preview refused')
  expect(await f.invoke({ commit: true, replace: true })).toMatchObject({ kind: 'committed', refreshedCount: 2, artifact: desired.artifact })
  expect([...api.readCommittedCorpus(f.committedRoot).snapshot.labelsById.values()].map(label => label.weight?.capabilityTier)).toEqual(['full', 'full'])
  const final = bytes(f.root)
  expect(await f.invoke({ commit: true, replace: true })).toMatchObject({ kind: 'unchanged', refreshedCount: 0 })
  expect(bytes(f.root)).toEqual(final)
})

it('serializes two actual writers captured against the same input and converges on retry', async () => {
  const f = setup()
  const results = await Promise.all([f.invoke({ commit: true }), f.invoke({ commit: true })])
  expect(results.map(result => result.kind).sort()).toEqual(['committed', 'input-drift'])
  const winner = results.find(result => result.kind === 'committed')!
  if (winner.kind !== 'committed') throw new Error('no winning generation')
  const before = bytes(f.root)
  expect(await f.invoke({ commit: true })).toMatchObject({ kind: 'unchanged', refreshedCount: 0, artifact: winner.artifact })
  expect(bytes(f.root)).toEqual(before)
  const read = api.readCommittedCorpus(f.committedRoot)
  expect(read.refusals).toEqual([])
  expect(read.snapshot.labelsById.size).toBe(2)
  expect(new Set([...read.snapshot.labelsById.values()].map(label => label.revision?.generationId))).toEqual(new Set([winner.artifact.generationId]))
})

it('keeps artifact bytes independent of wall clock and file creation order', async () => {
  const f = setup(), initial = await f.invoke(), originals = bytes(f.committedRoot)
  for (const [path, text] of Object.entries(originals).reverse()) {
    rmSync(join(f.committedRoot, path))
    write(f.committedRoot, path, text)
  }
  vi.spyOn(Date, 'now').mockReturnValue(9_999_999_999_999)
  expect(await f.invoke()).toEqual(initial)
  expect(bytes(f.committedRoot)).toEqual(originals)
})

it.each(['labels', 'corpus', 'cassettes'])('refuses symlinked %s destinations without changing either tree', async directory => {
  const f = setup(), outside = join(f.root, 'outside')
  mkdirSync(outside)
  rmSync(join(f.committedRoot, directory), { recursive: true })
  symlinkSync(outside, join(f.committedRoot, directory))
  const before = bytes(f.root)
  expect(await f.invoke()).toMatchObject({ kind: 'refused' })
  expect(await f.invoke({ commit: true })).toMatchObject({ kind: 'refused' })
  expect(bytes(f.root)).toEqual(before)
})
