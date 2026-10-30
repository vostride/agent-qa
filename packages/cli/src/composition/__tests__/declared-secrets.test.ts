import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { generateText, simulateReadableStream, streamText, wrapLanguageModel } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { SecretStore } from '@vostride/agent-qa-runner'
import { createMaskingMiddleware } from '@vostride/agent-qa-safety'

import { createDeclaredSecretMask, DeclaredSecretsUnavailableError } from '../declared-secrets.js'

const LONG = 'L0ng-Declared-Value-0123456789-abcdefghij'
const roots: string[] = []

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

afterEach(() => {
  vi.restoreAllMocks()
})

interface Project {
  readonly root: string
  readonly configPath: string
  readonly secretsPath: string
}

function project(secrets: string | null, options: { secretsFile?: string | null } = {}): Project {
  const root = mkdtempSync(join(tmpdir(), 'agent-qa-loader-'))
  roots.push(root)
  const secretsFile = options.secretsFile === undefined ? '.secrets.local' : options.secretsFile
  const workspace = [
    'workspace:',
    "  testMatch: ['tests/**/*.yaml']",
    "  suiteMatch: ['suites/**/*.yaml']",
    '  hooksFile: hooks.yaml',
    '  envFile: .env.local',
    ...(secretsFile === null ? [] : [`  secretsFile: ${secretsFile}`]),
  ]
  const configPath = join(root, 'agent-qa.config.yaml')
  writeFileSync(configPath, `${workspace.join('\n')}\n`)
  writeFileSync(join(root, 'hooks.yaml'), '')
  writeFileSync(join(root, '.env.local'), 'ENV_ONLY=envfile-value-1\n')
  const secretsPath = join(root, '.secrets.local')
  if (secrets !== null) writeFileSync(secretsPath, secrets)
  return { root, configPath, secretsPath }
}

function filesUnder(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else out.push(relative(root, path))
    }
  }
  walk(root)
  return out.sort()
}

function refusalOf(run: () => unknown): DeclaredSecretsUnavailableError {
  try {
    run()
  } catch (err) {
    expect(err).toBeInstanceOf(DeclaredSecretsUnavailableError)
    return err as DeclaredSecretsUnavailableError
  }
  throw new Error('expected a DeclaredSecretsUnavailableError')
}

describe('the declared secrets loader', () => {
  it('the mask names each value declared in workspace.secretsFile', () => {
    const { configPath } = project(`SHORT=q^7\nLONG=${LONG}\n`)
    const { mask } = createDeclaredSecretMask(configPath)

    expect(mask(`a q^7 b ${LONG}`)).toBe('a [secret:SHORT] b [secret:LONG]')
  })

  it('nothing outside the secrets file is masked', () => {
    const { root, configPath } = project(`SHORT=q^7\nLONG=${LONG}\n`)
    const authDir = join(root, '.agent-qa', 'auth', 'web', 'default')
    mkdirSync(authDir, { recursive: true })
    writeFileSync(
      join(authDir, 'storage-state.json'),
      JSON.stringify({ cookies: [{ name: 'sid', value: 'cookie-value-9' }], origins: [] }),
    )
    vi.stubEnv('AGENT_QA_X_PASSWORD', 'env-password-7')
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-env-value')
    const { mask } = createDeclaredSecretMask(configPath)

    const text = 'envfile-value-1 env-password-7 sk-ant-env-value cookie-value-9'
    expect(mask(text)).toBe(text)
    vi.unstubAllEnvs()
  })

  it('a changed file is re-read and an unchanged one is not', () => {
    const { configPath, secretsPath } = project('FIRST=aa1\n')
    const parse = vi.spyOn(SecretStore, 'fromEnvContent')
    const { mask } = createDeclaredSecretMask(configPath)

    for (let i = 0; i < 10; i++) expect(mask('aa1 zz9')).toBe('[secret:FIRST] zz9')
    expect(parse).toHaveBeenCalledTimes(1)

    appendFileSync(secretsPath, 'THIRD=zz9\n')
    const later = new Date(statSync(secretsPath).mtimeMs + 5_000)
    utimesSync(secretsPath, later, later)

    expect(mask('aa1 zz9')).toBe('[secret:FIRST] [secret:THIRD]')
    expect(parse).toHaveBeenCalledTimes(2)
  })

  it("a missing, unreadable or invalid secrets file refuses with the run's sentences", () => {
    const missing = project(null)
    const unreadable = project(null)
    mkdirSync(unreadable.secretsPath)
    const invalid = project('bad-name!=x\n')
    const unset = project('A=b\n', { secretsFile: null })

    const cases: Array<[Project, string[]]> = [
      [
        missing,
        [
          `Error: Secrets file not found: ${missing.secretsPath}`,
          'Create the file before running tests. It may be empty, but it must exist.',
        ],
      ],
      [
        unreadable,
        [
          `Error: Secrets file could not be read: ${unreadable.secretsPath}`,
          'Check the path and file permissions before running tests.',
        ],
      ],
      [invalid, ['Error: Secrets file is invalid: Invalid secret name: bad-name!']],
      [
        unset,
        [
          'Error: workspace.secretsFile is required. Run `agent-qa init` or set it in agent-qa.config.yaml.',
        ],
      ],
    ]
    for (const [fixture, lines] of cases) {
      const loader = createDeclaredSecretMask(fixture.configPath)
      const viaMask = refusalOf(() => loader.mask('anything'))
      const viaRedactor = refusalOf(() => loader.redactor())
      expect(viaMask.lines).toEqual(lines)
      expect(viaRedactor.lines).toEqual(lines)
      expect(viaMask.message).toBe(lines.join(' '))
    }
  })

  it('the loader writes nothing', () => {
    const { root, configPath } = project(`SHORT=q^7\nLONG=${LONG}\n`)
    const before = filesUnder(root)
    const loader = createDeclaredSecretMask(configPath)

    loader.mask(`q^7 ${LONG}`)
    loader.redactor().redactString('q^7')

    expect(filesUnder(root)).toEqual(before)
  })
})

describe('the loader follows a rewritten config', () => {
  it('one mask follows the secrets file a rewritten config names', () => {
    const { root, configPath } = project(null, { secretsFile: 'a.secrets' })
    writeFileSync(join(root, 'a.secrets'), 'A_KEY=alpha-value-1\n')
    writeFileSync(join(root, 'bb.secrets'), 'B_KEY=bravo-value-22\n')
    const { mask } = createDeclaredSecretMask(configPath)

    expect(mask('alpha-value-1 bravo-value-22')).toBe('[secret:A_KEY] bravo-value-22')

    const body = readFileSync(configPath, 'utf8')
    writeFileSync(configPath, body.replace('secretsFile: a.secrets', 'secretsFile: bb.secrets'))

    expect(mask('alpha-value-1 bravo-value-22')).toBe('alpha-value-1 [secret:B_KEY]')
  })

  it('a rewritten config that names no secrets file refuses', () => {
    const { root, configPath } = project(null, { secretsFile: 'a.secrets' })
    writeFileSync(join(root, 'a.secrets'), 'A_KEY=alpha-value-1\n')
    const { mask } = createDeclaredSecretMask(configPath)

    expect(mask('alpha-value-1')).toBe('[secret:A_KEY]')

    const body = readFileSync(configPath, 'utf8')
    writeFileSync(configPath, body.replace('  secretsFile: a.secrets\n', ''))

    expect(refusalOf(() => mask('alpha-value-1')).lines).toEqual([
      'Error: workspace.secretsFile is required. Run `agent-qa init` or set it in agent-qa.config.yaml.',
    ])
  })
})

const usage = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
}

describe('a declared value at model egress', () => {
  it('a declared value reaches a recording model as its named marker', async () => {
    const { configPath } = project(`SHORT=q^7\nLONG=${LONG}\n`)
    const { mask } = createDeclaredSecretMask(configPath)
    const recorder = new MockLanguageModelV3({
      doGenerate: {
        content: [{ type: 'text', text: 'ok' }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage,
        warnings: [],
      },
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start' as const, warnings: [] },
            { type: 'text-start' as const, id: 't' },
            { type: 'text-delta' as const, id: 't', delta: 'ok' },
            { type: 'text-end' as const, id: 't' },
            {
              type: 'finish' as const,
              finishReason: { unified: 'stop' as const, raw: 'stop' },
              usage,
            },
          ],
        }),
      }),
    })
    const model = wrapLanguageModel({ model: recorder, middleware: createMaskingMiddleware(mask) })
    const request = {
      system: `You may sign in with ${LONG}.`,
      messages: [{ role: 'user' as const, content: 'Type q^7 into the code field.' }],
    }

    await generateText({ model, ...request })
    await streamText({ model, ...request }).consumeStream()

    const sent = [recorder.doGenerateCalls[0]?.prompt, recorder.doStreamCalls[0]?.prompt]
    for (const prompt of sent) {
      expect(prompt).toEqual([
        { role: 'system', content: 'You may sign in with [secret:LONG].' },
        {
          role: 'user',
          content: [{ type: 'text', text: 'Type [secret:SHORT] into the code field.' }],
        },
      ])
      const wire = JSON.stringify(prompt)
      expect(wire).not.toContain(LONG)
      expect(wire).not.toContain('q^7')
    }
  })
})
