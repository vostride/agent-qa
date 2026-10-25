import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as model from '@vostride/agent-qa-model'
import { canonicalizeInputLeg } from '@vostride/agent-qa-eval'
import { readCommittedCorpus } from '@vostride/agent-qa-eval-local'
import { asRef, screenStateHash, sha256hex } from '@vostride/agent-qa-schema'
import { files, markFixture } from '../gates/__tests__/feedback-fixture.js'
import { resolveEvalSession, runSeedVerb } from '../eval-session-composition.js'

const LONG = 'hunter2-gap3-441'
const SHORT = 'q^7'
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

function fixture() {
  const f = markFixture(); roots.push(f.root)
  writeFileSync(join(f.root, '.env.secrets.local'), `CODE_441=${LONG}\nSHORT_441=${SHORT}\n`)
  const member = f.handoff.tests[0]!, step = member.steps[0]!
  member.outcome = 'passed'
  f.handoff.aggregateVerdict = 'passed'
  step.verifierVerdict = { pass: true, reasoning: 'The access code was accepted' }
  step.stepText = `Type ${LONG} into the Access code field`
  const sub = step.subActions[0]!
  const codeRef = asRef('e-access-code')
  const template = sub.stateBefore.elements[0]!
  sub.stateBefore.elements.push({ ...structuredClone(template), ref: codeRef, role: 'textbox',
    name: `Access code ${SHORT}`, nameNormalized: `access code ${SHORT}`, labels: { ariaLabel: 'Access code' } })
  sub.stateBefore.refMap[codeRef] = structuredClone(sub.stateBefore.refMap[template.ref]!)
  sub.stateBefore.tree = `${sub.stateBefore.tree}\ntextbox "Access code": ${LONG}`
  sub.plannedAction = { type: 'fill', ref: codeRef, text: LONG, clearMode: 'replace', submit: false }
  f.save()
  return { ...f, rawState: structuredClone(sub.stateBefore), committedRoot: join(f.root, 'agent-qa-eval') }
}

async function seed(f: ReturnType<typeof fixture>) {
  const session = await resolveEvalSession({ configPath: f.configPath })
  const report = await runSeedVerb(session, {}, fractions)
  expect(report.runsSkipped).toEqual([])
  expect(report.refusals).toEqual([])
  expect(report.seededCount).toBeGreaterThan(0)
  return report
}

function holdingDeclaredValue(root: string): string[] {
  return files(root).filter(path => {
    const text = readFileSync(path).toString('utf8')
    return text.includes(LONG) || text.includes(SHORT)
  }).map(path => relative(root, path))
}

describe('C441-GAP3-CORPUS', () => {
  it('eval seed commits a declared value from the step text, the screen state and the typed text only as its marker', async () => {
    const f = fixture()
    await seed(f)
    expect(holdingDeclaredValue(f.committedRoot)).toEqual([])
    expect(files(f.committedRoot).some(path => path.endsWith('cassette.json')
      && readFileSync(path).toString('utf8').includes('[secret:CODE_441]'))).toBe(true)
  })

  it('every hash a seeded case commits is computed over the committed text, never over the raw screen state', async () => {
    const f = fixture()
    await seed(f)
    const read = readCommittedCorpus(f.committedRoot)
    expect(read.refusals).toEqual([])
    const leaves = [...read.snapshot.cassettesById.values()].filter(cassette => cassette.granularity === 'leaf')
    expect(leaves.length).toBeGreaterThan(0)
    for (const cassette of leaves) {
      expect(cassette.receipt.screenStateHash).toBe(screenStateHash(cassette.input.stateBefore))
      expect(cassette.receipt.promptInputHash).toBe(sha256hex(canonicalizeInputLeg(cassette.input)))
      expect(cassette.receipt.screenStateHash).not.toBe(screenStateHash(f.rawState))
    }
  })
})
