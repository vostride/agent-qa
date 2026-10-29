import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import {
  resolveEvalJudge,
  resolveEvalSession,
  resolveReplayPlanner,
} from '../eval-session-composition.js'


let tmpRoot: string
let savedXdgDataHome: string | undefined

function configYaml(options: { useLlm?: boolean } = {}): string {
  const useLlm = options.useLlm ?? true
  return [
    'workspace:',
    '  testMatch: ["tests/**/*.yaml"]',
    '  suiteMatch: ["suites/**/*.suite.yaml"]',
    '  hooksFile: hooks.yaml',
    '  envFile: .env',
    '  secretsFile: .env.secrets.local',
    'registry:',
    '  llms:',
    '    - name: planner',
    '      provider: openai-compatible',
    '      model: gpt-4o',
    '      baseURL: https://compat.example/v1',
    '    - name: j',
    '      provider: openai-compatible',
    '      model: claude-judge',
    '      baseURL: https://compat.example/v1',
    '    - name: other',
    '      provider: openai-compatible',
    '      model: mistral-large',
    '      baseURL: https://compat.example/v1',
    '    - name: same-family',
    '      provider: openai-compatible',
    '      model: gpt-4o-mini',
    '      baseURL: https://compat.example/v1',
    '    - name: unknown-family',
    '      provider: openai-compatible',
    '      model: zz-mystery-model',
    '      baseURL: https://compat.example/v1',
    'use:',
    '  mobile:',
    '    appState: preserve',
    ...(useLlm ? ['  llm: planner'] : []),
    '',
  ].join('\n')
}

async function writeFixture(options: {
  useLlm?: boolean
  secrets?: string | null
} = {}): Promise<{ dir: string; configPath: string }> {
  const dir = await mkdtemp(join(tmpRoot, 'fixture-'))
  const configPath = join(dir, 'agent-qa.config.yaml')
  await writeFile(configPath, configYaml(options))
  if (options.secrets !== null) {
    await writeFile(join(dir, '.env.secrets.local'), options.secrets ?? '')
  }
  return { dir, configPath }
}

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'agent-qa-eval-session-'))
  savedXdgDataHome = process.env.XDG_DATA_HOME
  // An empty auth store makes openai-compatible entries resolve to `unauthenticated`.
  process.env.XDG_DATA_HOME = join(tmpRoot, 'xdg-data')
})

afterEach(async () => {
  if (savedXdgDataHome === undefined) delete process.env.XDG_DATA_HOME
  else process.env.XDG_DATA_HOME = savedXdgDataHome
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('AGENT_QA_')) delete process.env[key]
  }
  await rm(tmpRoot, { recursive: true, force: true })
})

describe('resolveEvalSession takes replay settings from flags', () => {
  it('builds the replay settings from the flags alone', async () => {
    const { configPath } = await writeFixture()

    const session = await resolveEvalSession({ configPath })
    expect(session.evalConfig).toEqual({})

    const flagged = await resolveEvalSession({
      configPath,
      flags: { judge: 'other', judgeAllowSameFamily: true, k: 3, seed: 7 },
    })
    expect(flagged.evalConfig).toEqual({ judge: 'other', judgeAllowSameFamily: true, k: 3, seed: 7 })
  })

  it('exposes configDir and executionContext on the session', async () => {
    const { dir, configPath } = await writeFixture()
    const session = await resolveEvalSession({ configPath })
    expect(session.configDir).toBe(resolve(dir))
    expect(session.configPath).toBe(configPath)
    expect(['local-interactive', 'local-headless', 'ci', 'cloud']).toContain(session.executionContext)
  })
})

describe('eval session masking', () => {
  it('the eval session masks with its secrets file and nothing else', async () => {
    process.env.AGENT_QA_X_PASSWORD = 'env-password-not-declared-77'
    const { configPath } = await writeFixture({ secrets: 'PW_441=Hunter-42-zz\n' })
    const session = await resolveEvalSession({ configPath })

    expect(session.mask('pw Hunter-42-zz env env-password-not-declared-77'))
      .toBe('pw [secret:PW_441] env env-password-not-declared-77')
  })
})

describe('resolveEvalJudge — named-LLM chain + family preflight', () => {
  it('resolves a named judge to { profile, auth } through the named-LLM chain', async () => {
    const { configPath } = await writeFixture()
    const session = await resolveEvalSession({ configPath, flags: { judge: 'j' } })

    const resolved = await resolveEvalJudge(session)
    expect(resolved.judge).toBeDefined()
    if (!resolved.judge || 'members' in resolved.judge) throw new Error('expected direct singleton')
    expect(resolved.judge?.profile.model).toBe('claude-judge')
    expect(resolved.judge?.profile.provider).toBe('openai-compatible')
    expect(resolved.judge?.auth.kind).toBe('none')
    expect(resolved.notice).toBeUndefined()
  })

  it('returns a typed no-judge notice when no --judge is given', async () => {
    const { configPath } = await writeFixture()
    const session = await resolveEvalSession({ configPath })

    const resolved = await resolveEvalJudge(session)
    expect(resolved.judge).toBeUndefined()
    expect(resolved.notice).toBe(
      'no --judge given — unresolved ties will record not-invoked{no-judge-configured}',
    )
  })

  it('yields a family warning notice when the judge shares the planner family', async () => {
    const { configPath } = await writeFixture()
    const session = await resolveEvalSession({ configPath, flags: { judge: 'same-family' } })

    const resolved = await resolveEvalJudge(session)
    expect(resolved.judge).toBeDefined()
    expect(resolved.notice).toContain('family')
  })

  it('yields a family warning notice when the judge family is unknown', async () => {
    const { configPath } = await writeFixture()
    const session = await resolveEvalSession({ configPath, flags: { judge: 'unknown-family' } })

    const resolved = await resolveEvalJudge(session)
    expect(resolved.judge).toBeDefined()
    expect(resolved.notice).toContain('family')
  })
})

describe('resolveEvalJudge — the --judge-allow-same-family flag', () => {
  it('carries allowSameFamily on the judge bundle and yields the same-family notice for known-same families', async () => {
    const { configPath } = await writeFixture()
    const session = await resolveEvalSession({
      configPath,
      flags: { judge: 'same-family', judgeAllowSameFamily: true },
    })
    expect(session.evalConfig.judgeAllowSameFamily).toBe(true)

    const resolved = await resolveEvalJudge(session)
    expect(resolved.judge?.allowSameFamily).toBe(true)
    expect(resolved.notice).toBe(
      'same-family judging allowed (--judge-allow-same-family): judge model "gpt-4o-mini" and ' +
      "planner model \"gpt-4o\" share the judge family 'openai'; every scored entry discloses " +
      'familyOverride: same-family-allowed',
    )
  })

  it('keeps the refusal-style notice for unknown families even when the flag is set', async () => {
    const { configPath } = await writeFixture()
    const session = await resolveEvalSession({
      configPath,
      flags: { judge: 'unknown-family', judgeAllowSameFamily: true },
    })

    const resolved = await resolveEvalJudge(session)
    expect(resolved.judge).toBeDefined()
    expect(resolved.notice).toContain('will refuse')
    expect(resolved.notice).not.toContain('--judge-allow-same-family')
  })

  it('leaves the refusal-style notice in place when the flag is absent or false', async () => {
    const { configPath } = await writeFixture()
    const session = await resolveEvalSession({ configPath, flags: { judge: 'same-family' } })
    const resolved = await resolveEvalJudge(session)
    expect(resolved.judge?.allowSameFamily).toBeUndefined()
    expect(resolved.notice).toContain('resolve to the same or unknown family')

    const falseSession = await resolveEvalSession({
      configPath,
      flags: { judge: 'same-family', judgeAllowSameFamily: false },
    })
    expect(falseSession.evalConfig.judgeAllowSameFamily).toBeUndefined()
    const falseResolved = await resolveEvalJudge(falseSession)
    expect(falseResolved.judge?.allowSameFamily).toBeUndefined()
    expect(falseResolved.notice).toContain('resolve to the same or unknown family')
  })
})

describe('resolveReplayPlanner — use.llm named entry', () => {
  it('resolves the use.llm planner entry through the same chain', async () => {
    const { configPath } = await writeFixture()
    const session = await resolveEvalSession({ configPath })

    const planner = await resolveReplayPlanner(session)
    expect(planner.profile.model).toBe('gpt-4o')
    expect(planner.auth.kind).toBe('none')
  })

  it('throws a typed Error when use.llm is absent', async () => {
    const { configPath } = await writeFixture({ useLlm: false })
    const session = await resolveEvalSession({ configPath })

    await expect(resolveReplayPlanner(session)).rejects.toThrow(/use\.llm/)
  })
})

describe('resolveEvalSession — typed config errors', () => {
  it('throws a typed Error naming the path when the secrets file is missing', async () => {
    const { dir, configPath } = await writeFixture({ secrets: null })
    const expectedPath = resolve(dir, '.env.secrets.local')

    await expect(resolveEvalSession({ configPath })).rejects.toThrow(expectedPath)
  })
})
