import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createPanelIdentity, createScoringContext, resolveScoringContext } from '@vostride/agent-qa-eval'
import { loadScoreRecord } from '../replay-read.js'
import { panelScoreFixture } from './fixtures/panel-score-fixture.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function root() { const dir = mkdtempSync(join(tmpdir(), 'panel-score-')); roots.push(dir); return dir }

it.each([false, true])('round-trips complete panel comparison groups (noConsensus=%s)', async noConsensus => {
  const f = await panelScoreFixture(root(), ['different', 'different'], noConsensus)
  const loaded = loadScoreRecord(f.written.dir)
  expect(loaded).toEqual({ kind: 'loaded', record: f.record })
  expect(f.record.judge?.panelSize).toBe(2)
  const raw = JSON.parse(readFileSync(f.written.file, 'utf8'))
  expect((raw.score.entry.score.judgeSettled ?? raw.score.entry.score.judgeOutcome).members).toHaveLength(noConsensus ? 6 : 2)
  expect(f.record.scoringContext.judgeRequest).toEqual(f.judgeRequest)
  expect(resolveScoringContext(f).compatible).toBe(true)
})

it.each(['cardinality', 'duplicate', 'family', 'override', 'outcome-member', 'outcome-kind', 'usage', 'incomplete-group', 'extra-group', 'version'])(
  'refuses malformed panel score metadata: %s', async corruption => {
    const f = await panelScoreFixture(root())
    const raw = JSON.parse(readFileSync(f.written.file, 'utf8'))
    const stamp = raw.score.entry.score.judgeSettled ?? raw.score.entry.score.judgeOutcome
    if (corruption === 'cardinality') raw.judge.panelSize++
    if (corruption === 'duplicate') raw.judge.members[1] = raw.judge.members[0]
    if (corruption === 'family') raw.judge.judgeFamily = 'forged'
    if (corruption === 'override') raw.judge.familyOverride = 'same-family-allowed'
    if (corruption === 'outcome-member') stamp.members[1].judgeModelId = 'foreign'
    if (corruption === 'outcome-kind') stamp.members[1].outcome.kind = 'unknown'
    if (corruption === 'usage') stamp.members[1].usage.inputTokens = null
    if (corruption === 'incomplete-group') stamp.members.pop()
    if (corruption === 'extra-group') stamp.members.push(...structuredClone(stamp.members))
    if (corruption === 'version') stamp.judgeVersion++
    writeFileSync(f.written.file, JSON.stringify(raw))
    expect(loadScoreRecord(f.written.dir).kind).toBe('refused')
  })

it.each(['finalScoreDigest', 'judgeIdentityDigest', 'inputsDigest', 'replayDigest', 'request', 'old-version'])(
  'refuses incompatible panel context: %s', async change => {
    const f = await panelScoreFixture(root())
    const record = structuredClone(f.record)
    if (change === 'request') record.scoringContext.judgeRequest = { judgeModelId: 'foreign', allowSameFamily: false }
    else if (change === 'old-version') record.judge!.judgeVersion = 1
    else record.scoringContext[change as 'finalScoreDigest'] = 'f'.repeat(64)
    expect(resolveScoringContext({ ...f, record }).compatible).toBe(false)
  })

it('refuses a self-consistent composite override request', async () => {
  const f = await panelScoreFixture(root())
  const judgeRequest = { ...f.judgeRequest, allowSameFamily: true }
  f.record.scoringContext = createScoringContext({ ...f, ...f.record, judgeRequest })
  expect(f.record.scoringContext.judgeRequest).toEqual(judgeRequest)
  expect(resolveScoringContext(f).compatible).toBe(false)
})

it.each(['incomplete', 'reordered', 'over-cap'])('refuses corrupted no-consensus groups: %s', async change => {
  const f = await panelScoreFixture(root(), ['different', 'different'], true)
  const raw = JSON.parse(readFileSync(f.written.file, 'utf8'))
  const stamp = raw.score.entry.score.judgeSettled ?? raw.score.entry.score.judgeOutcome
  if (change === 'incomplete') stamp.members.pop()
  if (change === 'reordered') [stamp.members[2], stamp.members[3]] = [stamp.members[3], stamp.members[2]]
  if (change === 'over-cap') stamp.members.push(...structuredClone(stamp.members.slice(0, 2)))
  writeFileSync(f.written.file, JSON.stringify(raw))
  expect(loadScoreRecord(f.written.dir).kind).toBe('refused')
})

it('keeps singleton identity and historical single bytes unchanged', async () => {
  const f = await panelScoreFixture(root(), ['different'])
  expect(f.record.judge).toEqual(createPanelIdentity(['claude-sonnet-4-5']))
  const historical = structuredClone(f.record)
  historical.judge!.judgeVersion = 1
  delete (historical as { scoringContext?: unknown }).scoringContext
  const bytes = JSON.stringify(historical, null, 2) + '\n'
  writeFileSync(f.written.file, bytes)
  expect(loadScoreRecord(f.written.dir)).toEqual({ kind: 'loaded', record: historical })
  expect(readFileSync(f.written.file, 'utf8')).toBe(bytes)
  expect(resolveScoringContext({ ...f, record: historical }).compatible).toBe(false)
})
