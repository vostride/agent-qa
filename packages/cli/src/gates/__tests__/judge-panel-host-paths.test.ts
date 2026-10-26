import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPanelIdentity } from '@vostride/agent-qa-eval'
import { asRef } from '@vostride/agent-qa-schema'
import * as evalLocal from '@vostride/agent-qa-eval-local'
import * as model from '@vostride/agent-qa-model'
import * as session from '../../eval-session-composition.js'
import * as llm from '../../llm-utils.js'

const { makeReplayHandoff, memArtifacts, extractStoreLoad, capturingStub,
  actionGenerateResult, judgeGenerateResult } = await import(new URL(
  '../../../../eval-local/src/__tests__/fixtures/replay-fixtures.js', import.meta.url,
).href)

const INITIAL = ['claude-fixture', 'gemini-fixture']
let root: string
let configPath: string
let agentQaRoot: string

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
`)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'panel-host-'))
  configPath = join(root, 'agent-qa.config.yaml')
  agentQaRoot = join(root, '.agent-qa')
  mkdirSync(join(root, 'agent-qa-knowledge'))
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

describe('production panel host paths', () => {
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
    const resolved = await session.resolveEvalSession({ configPath,
      flags: { judge: INITIAL.map((_, i) => `judge-${i}`) } })
    expect(llm.resolveModelAuth).not.toHaveBeenCalled()
    const replay = await session.runReplayVerb(resolved, {}, {
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
    const report = await session.runReportVerb(resolved)
    expect(report.report.judge).toMatchObject(createPanelIdentity(INITIAL))
    expect(report.judgeIdentity).toBe('present')
    expect(factory).not.toHaveBeenCalled()
    expect(bind).not.toHaveBeenCalled()
    expect(llm.resolveModelAuth).not.toHaveBeenCalled()
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })
})
