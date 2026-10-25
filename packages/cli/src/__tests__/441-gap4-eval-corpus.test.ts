import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as model from '@vostride/agent-qa-model'
import { canonicalizeInputLeg } from '@vostride/agent-qa-eval'
import { readCommittedCorpus } from '@vostride/agent-qa-eval-local'
import {
  asRef,
  computeBriefDigest,
  guardLosslessServedBrief,
  sha256hex,
  type ServedBrief,
  SERVED_BRIEF_PROOF_SCHEMA_VERSION,
} from '@vostride/agent-qa-schema'
import { files, markFixture } from '../gates/__tests__/feedback-fixture.js'
import { resolveEvalSession, runSeedVerb } from '../eval-session-composition.js'

const PIN = '7'
const RUN_DATE = '2026-10-17'
const CONTEXT_TIER = 'Keypad with 7 keys'
const VOLATILE_TIER = `Current date: ${RUN_DATE}`
const FREE_TEXT = ['Enter 7 on the keypad', 'Key 7', 'button "7"', CONTEXT_TIER, VOLATILE_TIER]
const MINTED_ID_MEMBERS = new Set([
  'id', 'runId', 'runSlug', 'testId', 'cassetteId', 'pairedCassetteId', 'seedCassetteId', 'sourceCassetteId',
  'markId', 'generationId', 'attributedObservationId',
])
const DIGEST = /^[0-9a-f]{64}$/
const DATE = /^\d{4}-\d{2}-\d{2}$/
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const roots: string[] = []
const fractions = { heldOutFraction: 0.4, privateFraction: 0.5 }

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('provider access forbidden') })
  vi.spyOn(model, 'createModel').mockImplementation(() => { throw new Error('model creation forbidden') })
})
afterEach(() => {
  expect(globalThis.fetch).not.toHaveBeenCalled()
  expect(model.createModel).not.toHaveBeenCalled()
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

// Built the way captureServedPromptTurn builds a production turn.
function losslessBrief(brief: ServedBrief): ServedBrief {
  const unstamped: ServedBrief = {
    ...brief,
    proof: {
      schemaVersion: SERVED_BRIEF_PROOF_SCHEMA_VERSION,
      completeness: 'lossless',
      recordCap: 0,
      combinedBudget: 0,
      admissionEvents: [],
      promptTurns: [{
        ordinal: 0,
        turnOrdinal: 0,
        runDate: RUN_DATE,
        policyL0: '',
        learnedL1: '',
        learnedL2: '',
        contextTier: CONTEXT_TIER,
        volatileTier: VOLATILE_TIER,
        policyDigest: sha256hex(''),
        contextTierDigest: sha256hex(CONTEXT_TIER),
        volatileTierDigest: sha256hex(VOLATILE_TIER),
      }],
    },
  }
  return { ...unstamped, briefDigest: computeBriefDigest(unstamped) }
}

function fixture() {
  const f = markFixture(); roots.push(f.root)
  writeFileSync(join(f.root, '.env.secrets.local'), `PIN_441=${PIN}\n`)
  const member = f.handoff.tests[0]!, step = member.steps[0]!
  member.outcome = 'passed'
  f.handoff.aggregateVerdict = 'passed'
  step.verifierVerdict = { pass: true, reasoning: 'The keypad accepted the entry' }
  step.stepText = 'Enter 7 on the keypad'
  const sub = step.subActions[0]!
  const keyRef = asRef('e-keypad-seven')
  const template = sub.stateBefore.elements[0]!
  sub.stateBefore.elements.push({ ...structuredClone(template), ref: keyRef, name: 'Key 7', nameNormalized: 'key 7',
    labels: { ariaLabel: 'Keypad key' } })
  sub.stateBefore.refMap[keyRef] = structuredClone(sub.stateBefore.refMap[template.ref]!)
  sub.stateBefore.tree = `${sub.stateBefore.tree}\nbutton "7"`
  sub.plannedAction = { type: 'click', ref: keyRef }
  // GAP3-02's model-identity limit is not under test here.
  sub.callRecord!.resolvedModelId = 'eval-local-fixture-planner'
  step.servedBrief = losslessBrief(step.servedBrief)
  f.save()
  return { ...f, committedRoot: join(f.root, 'agent-qa-eval') }
}

interface Leaf { path: string; member: string; text: string }

function jsonLeaves(value: unknown, path: string, member: string): Leaf[] {
  if (typeof value === 'string') return [{ path, member, text: value }]
  if (Array.isArray(value)) return value.flatMap((item, index) => jsonLeaves(item, `${path}[${index}]`, member))
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([key, item]) => jsonLeaves(item, `${path}.${key}`, key))
  }
  return []
}

function parsed(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    const lines = text.split('\n').filter(line => line.trim() !== '')
    try {
      return lines.map(line => JSON.parse(line) as unknown)
    } catch {
      return undefined
    }
  }
}

function committedDocuments(root: string): { name: string; text: string; leaves?: Leaf[] }[] {
  return files(root).filter(path => !relative(root, path).split(sep).includes('blobs')).map(path => {
    const name = relative(root, path)
    const text = readFileSync(path).toString('utf8')
    const json = parsed(text)
    return json === undefined ? { name, text } : { name, text, leaves: jsonLeaves(json, '$', '') }
  })
}

function derivedOrMinted(leaf: Leaf): boolean {
  return DIGEST.test(leaf.text) || DATE.test(leaf.text) || TIMESTAMP.test(leaf.text) || UUID.test(leaf.text)
    || MINTED_ID_MEMBERS.has(leaf.member)
}

describe('C441-GAP4-CORPUS', () => {
  it('under a one-character declared value, eval seed seeds a run whose lossless served brief holds it, while its free text commits only as the marker', async () => {
    const f = fixture()
    const brief = f.handoff.tests[0]!.steps[0]!.servedBrief
    expect(() => guardLosslessServedBrief(brief)).not.toThrow()
    const turn = brief.proof!.promptTurns[0]!
    for (const derived of [turn.policyDigest, turn.contextTierDigest, turn.volatileTierDigest, turn.runDate]) {
      expect(derived).toContain(PIN)
    }

    const session = await resolveEvalSession({ configPath: f.configPath })
    const report = await runSeedVerb(session, {}, fractions)
    expect(report.runsSkipped).toEqual([])
    expect(report.refusals).toEqual([])
    expect(report.seededCount).toBeGreaterThan(0)

    const documents = committedDocuments(f.committedRoot)
    expect(documents.length).toBeGreaterThan(0)
    const rawFreeText = documents.flatMap(document => document.leaves === undefined
      ? FREE_TEXT.some(probe => document.text.includes(probe)) ? [document.name] : []
      : document.leaves.filter(leaf => FREE_TEXT.some(probe => leaf.text.includes(probe)))
        .map(leaf => `${document.name}:${leaf.path}`))
    expect(rawFreeText).toEqual([])
    const unexplained = documents.flatMap(document => (document.leaves ?? [])
      .filter(leaf => leaf.text.includes(PIN) && !derivedOrMinted(leaf))
      .map(leaf => `${document.name}:${leaf.path}`))
    expect(unexplained).toEqual([])

    const read = readCommittedCorpus(f.committedRoot)
    expect(read.refusals).toEqual([])
    const leaves = [...read.snapshot.cassettesById.values()].filter(cassette => cassette.granularity === 'leaf')
    expect(leaves.length).toBeGreaterThan(0)
    expect(leaves.some(cassette => cassette.input.stepText.includes('[secret:PIN_441]')
      && cassette.input.servedBrief.proof?.promptTurns[0]?.volatileTier.includes('[secret:PIN_441]'))).toBe(true)
    for (const cassette of leaves) {
      expect(() => guardLosslessServedBrief(cassette.input.servedBrief)).not.toThrow()
      expect(cassette.receipt.memoryBriefDigest).toBe(cassette.input.servedBrief.briefDigest)
      expect(cassette.receipt.promptInputHash).toBe(sha256hex(canonicalizeInputLeg(cassette.input)))
    }
  })
})
