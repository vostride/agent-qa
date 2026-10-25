// Phase 372-04 — eval-session-composition behaviors (D-03 flag precedence, 441 D-06 declared
// mask, D-03/D-10 judge preflight, D-08 typed errors).
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

function configYaml(options: { evalBlock?: string; useLlm?: boolean } = {}): string {
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
    ...(options.evalBlock ? [options.evalBlock] : []),
    '',
  ].join('\n')
}

async function writeFixture(options: {
  evalBlock?: string
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
  // Point the auth store at an empty temp location so the real named-LLM chain resolves
  // openai-compatible entries to `unauthenticated` deterministically (no host auth store reads).
  // 2026-10-20 (445-16, D-41): only off the public provider API, hence compat.example.
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

describe('resolveEvalSession — eval config + flag overrides (D-03)', () => {
  it('returns the config eval block and applies flag overrides field-wise', async () => {
    const { configPath } = await writeFixture({
      evalBlock: 'eval:\n  judge: j\n  k: 2',
    })

    const session = await resolveEvalSession({ configPath })
    expect(session.evalConfig.judge).toBe('j')
    expect(session.evalConfig.k).toBe(2)
    expect(session.evalConfig.seed).toBeUndefined()

    const overridden = await resolveEvalSession({
      configPath,
      flags: { judge: 'other', k: 3, silverCap: 5 },
    })
    expect(overridden.evalConfig.judge).toBe('other')
    expect(overridden.evalConfig.k).toBe(3)
    expect(overridden.evalConfig.seeding?.silverPerTestCap).toBe(5)
  })

  it('exposes configDir and executionContext on the session', async () => {
    const { dir, configPath } = await writeFixture()
    const session = await resolveEvalSession({ configPath })
    expect(session.configDir).toBe(resolve(dir))
    expect(session.configPath).toBe(configPath)
    expect(['local-interactive', 'local-headless', 'ci', 'cloud']).toContain(session.executionContext)
  })
})

describe('C441-EGRESS', () => {
  it('the eval session masks with its secrets file and nothing else', async () => {
    process.env.AGENT_QA_X_PASSWORD = 'env-password-not-declared-77'
    const { configPath } = await writeFixture({ secrets: 'PW_441=Hunter-42-zz\n' })
    const session = await resolveEvalSession({ configPath })

    expect(session.mask('pw Hunter-42-zz env env-password-not-declared-77'))
      .toBe('pw [secret:PW_441] env env-password-not-declared-77')
  })

  it('a key-only session refuses to mask', async () => {
    const { configPath } = await writeFixture({ secrets: 'PW_441=Hunter-42-zz\n' })
    const session = await resolveEvalSession({ configPath, keyOnly: true })

    expect(() => session.mask('Hunter-42-zz'))
      .toThrow('A key-only eval session has no declared secrets to mask with')
  })
})

describe('resolveEvalJudge — named-LLM chain + family preflight (D-03/D-10)', () => {
  it('resolves a named judge to { profile, auth } through the named-LLM chain', async () => {
    const { configPath } = await writeFixture({ evalBlock: 'eval:\n  judge: j' })
    const session = await resolveEvalSession({ configPath })

    const resolved = await resolveEvalJudge(session)
    expect(resolved.judge).toBeDefined()
    if (!resolved.judge || 'members' in resolved.judge) throw new Error('expected direct singleton')
    expect(resolved.judge?.profile.model).toBe('claude-judge')
    expect(resolved.judge?.profile.provider).toBe('openai-compatible')
    expect(resolved.judge?.auth.kind).toBe('none')
    expect(resolved.notice).toBeUndefined()
  })

  it('returns a typed no-judge notice when eval.judge is absent', async () => {
    const { configPath } = await writeFixture()
    const session = await resolveEvalSession({ configPath })

    const resolved = await resolveEvalJudge(session)
    expect(resolved.judge).toBeUndefined()
    expect(resolved.notice).toContain('no judge configured')
  })

  it('yields a family warning notice when the judge shares the planner family', async () => {
    const { configPath } = await writeFixture({ evalBlock: 'eval:\n  judge: same-family' })
    const session = await resolveEvalSession({ configPath })

    const resolved = await resolveEvalJudge(session)
    expect(resolved.judge).toBeDefined()
    expect(resolved.notice).toContain('family')
  })

  it('yields a family warning notice when the judge family is unknown', async () => {
    const { configPath } = await writeFixture({ evalBlock: 'eval:\n  judge: unknown-family' })
    const session = await resolveEvalSession({ configPath })

    const resolved = await resolveEvalJudge(session)
    expect(resolved.judge).toBeDefined()
    expect(resolved.notice).toContain('family')
  })
})

describe('resolveEvalJudge — judgeAllowSameFamily opt-in (owner override of D-10, 2026-07-12)', () => {
  it('carries allowSameFamily on the judge bundle and yields the override advisory for known-same families', async () => {
    const { configPath } = await writeFixture({
      evalBlock: 'eval:\n  judge: same-family\n  judgeAllowSameFamily: true',
    })
    const session = await resolveEvalSession({ configPath })
    expect(session.evalConfig.judgeAllowSameFamily).toBe(true)

    const resolved = await resolveEvalJudge(session)
    expect(resolved.judge?.allowSameFamily).toBe(true)
    expect(resolved.notice).toContain('D-10 override')
    expect(resolved.notice).toContain('same-family')
    expect(resolved.notice).not.toContain('will refuse')
  })

  it('keeps the refusal-style notice for unknown families even when the opt-in is true', async () => {
    const { configPath } = await writeFixture({
      evalBlock: 'eval:\n  judge: unknown-family\n  judgeAllowSameFamily: true',
    })
    const session = await resolveEvalSession({ configPath })

    const resolved = await resolveEvalJudge(session)
    expect(resolved.judge).toBeDefined()
    expect(resolved.notice).toContain('will refuse')
    expect(resolved.notice).not.toContain('D-10 override')
  })

  it('leaves current behavior identical when the flag is absent or false', async () => {
    const { configPath } = await writeFixture({ evalBlock: 'eval:\n  judge: same-family' })
    const session = await resolveEvalSession({ configPath })
    const resolved = await resolveEvalJudge(session)
    expect(resolved.judge?.allowSameFamily).toBeUndefined()
    expect(resolved.notice).toContain('resolve to the same or unknown family')
    expect(resolved.notice).not.toContain('D-10 override')

    const { configPath: falsePath } = await writeFixture({
      evalBlock: 'eval:\n  judge: same-family\n  judgeAllowSameFamily: false',
    })
    const falseSession = await resolveEvalSession({ configPath: falsePath })
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

describe('resolveEvalSession — typed config errors (D-08)', () => {
  it('throws a typed Error naming the path when the secrets file is missing', async () => {
    const { dir, configPath } = await writeFixture({ secrets: null })
    const expectedPath = resolve(dir, '.env.secrets.local')

    await expect(resolveEvalSession({ configPath })).rejects.toThrow(expectedPath)
  })
})
