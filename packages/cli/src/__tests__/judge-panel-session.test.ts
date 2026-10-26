import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Command } from 'commander'
import { AgentQaConfigSchema } from '@vostride/agent-qa-core'
import { assessPanelEligibility } from '@vostride/agent-qa-eval'
import * as composition from '../eval-session-composition.js'
import * as llm from '../llm-utils.js'
import { createEvalCommand } from '../commands/eval.js'

let root: string
const raw = (evalBlock?: unknown) => ({
  workspace: { testMatch: ['tests/*.yaml'], suiteMatch: ['suites/*.yaml'], hooksFile: 'hooks.yaml',
    envFile: '.env', secretsFile: 'secrets.fixture' },
  registry: { llms: [
    { name: 'planner', provider: 'openai-compatible', model: 'gpt-planner' },
    { name: 'a', provider: 'openai-compatible', model: 'claude-judge' },
    { name: 'alias', provider: 'openai-compatible', model: 'claude-judge' },
    { name: 'b', provider: 'openai-compatible', model: 'gemini-judge' },
    { name: 'same', provider: 'openai-compatible', model: 'gpt-judge' },
  ].map(config => ({ ...config, baseURL: 'http://127.0.0.1:1/v1' })) },
  use: { llm: 'planner', mobile: { appState: 'preserve' } },
  ...(evalBlock === undefined ? {} : { eval: evalBlock }),
})
async function fixture() {
  const configPath = join(root, 'agent-qa.config.yaml')
  await writeFile(configPath, JSON.stringify(raw()))
  await writeFile(join(root, 'secrets.fixture'), '')
  return configPath
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agent-qa-panel-session-'))
  vi.spyOn(llm, 'resolveModelAuth').mockImplementation(async name => ({
    kind: 'unauthenticated', credentialKey: name, provider: 'openai-compatible', optional: true,
    message: 'fixture',
  }))
})
afterEach(async () => { vi.restoreAllMocks(); process.exitCode = 0; await rm(root, { recursive: true, force: true }) })

describe('explicit judge declarations', () => {
  it.each([[], ['a'], ['a', 'b'], ['a', 'alias', 'b']].map(judges => [judges]))('admits a complete strict declaration %j', judges => {
    expect(AgentQaConfigSchema.safeParse(raw({ judges })).success).toBe(true)
  })
  it.each([{ judge: 'a', judges: [] }, { judges: ['a', 'b', 'a', 'b'] },
    { judges: [''] }, { judge: '' }, { judges: 'a' }, { judges: [3] }, { judges: ['a'], pooling: 'max' }])(
    'refuses malformed or ambiguous config %j', evalBlock => {
      expect(AgentQaConfigSchema.safeParse(raw(evalBlock)).success).toBe(false)
    })
  it('normalizes zero and one without auth work on key-only sessions', async () => {
    const configPath = await fixture()
    const empty = await composition.resolveEvalSession({ configPath, keyOnly: true, flags: { judge: [] } })
    expect(empty.evalConfig.judge).toBeUndefined()
    expect(empty.evalConfig.judges).toBeUndefined()
    expect((await composition.resolveEvalJudge(empty)).judge).toBeUndefined()
    const single = await composition.resolveEvalSession({ configPath, keyOnly: true, flags: { judge: ['a'] } })
    expect(single.evalConfig).toEqual({ judge: 'a' })
    expect(llm.resolveModelAuth).not.toHaveBeenCalled()
  })
  it('refuses malformed runtime flags and more than three names without pruning', async () => {
    const configPath = await fixture()
    await expect(composition.resolveEvalSession({ configPath, keyOnly: true,
      flags: { judge: ['a', 'b', 'a', 'b'] } })).rejects.toThrow(
      new composition.EvalJudgeDeclarationError('Pass at most 3 --judge names.'))
    for (const judge of [[''], [3], null, Array(2)]) {
      await expect(composition.resolveEvalSession({ configPath, keyOnly: true,
        flags: { judge: judge as unknown as string[] } })).rejects.toThrow(
        new composition.EvalJudgeDeclarationError('--judge needs a nonempty registry name.'))
    }
    expect(llm.resolveModelAuth).not.toHaveBeenCalled()
  })
  it('keeps repeated --judge names in order as a panel', async () => {
    const configPath = await fixture()
    const session = await composition.resolveEvalSession({ configPath, flags: { judge: ['b', 'a'] }, keyOnly: true })
    expect(session.evalConfig).toEqual({ judges: ['b', 'a'] })
    expect(llm.resolveModelAuth).not.toHaveBeenCalled()
  })
  it('preserves duplicate aliases for whole-panel eligibility refusal and ignores composite override', async () => {
    const configPath = await fixture()
    const resolved = await composition.resolveEvalJudge(await composition.resolveEvalSession({ configPath,
      flags: { judge: ['a', 'alias'], judgeAllowSameFamily: true } }))
    expect(resolved.judge).toHaveProperty('members')
    if (!resolved.judge || !('members' in resolved.judge)) throw new Error('expected panel')
    expect(resolved.judge.members.map(member => member.profile.model)).toEqual(['claude-judge', 'claude-judge'])
    expect(assessPanelEligibility({ memberModelIds: resolved.judge.members.map(member => member.profile.model),
      replayedModelId: 'gpt-planner' }).eligible).toBe(false)
    expect(resolved.judge.allowSameFamily).not.toBe(true)
    expect(resolved.notice).toBe('--judge-allow-same-family is ignored for a judge panel; every member '
      + 'must come from a different family than the planner.')
    expect(llm.resolveModelAuth).toHaveBeenCalledTimes(2)
  })
  it('keeps singleton same-family override on the direct path', async () => {
    const configPath = await fixture()
    const resolved = await composition.resolveEvalJudge(await composition.resolveEvalSession({ configPath,
      flags: { judge: ['same'], judgeAllowSameFamily: true } }))
    expect(resolved.judge).toMatchObject({ profile: { model: 'gpt-judge' }, allowSameFamily: true })
    expect(resolved.judge).not.toHaveProperty('members')
  })
  it('collects repeated --judge on replay and preserves global --config', async () => {
    const configPath = await fixture()
    const marker = new Error('fixture stops after session selection')
    const resolveSession = vi.spyOn(composition, 'resolveEvalSession').mockRejectedValue(marker)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const program = new Command().option('--config <path>').addCommand(createEvalCommand())
    await program.parseAsync(['--config', configPath, 'eval', 'replay', '--judge', 'b', '--judge', 'a',
      '--judge-allow-same-family'], { from: 'user' })
    expect(resolveSession).toHaveBeenCalledWith(expect.objectContaining({ configPath,
      flags: expect.objectContaining({ judge: ['b', 'a'], judgeAllowSameFamily: true }) }))
  })
})
