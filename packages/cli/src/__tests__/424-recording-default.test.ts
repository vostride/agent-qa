import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { generateRunId, generateSuiteId, generateTestId } from '@vostride/agent-qa-ids'
import { SecretRedactor, SecretStore } from '@vostride/agent-qa-runner'
import { createRunInvocationCore } from '@vostride/agent-qa-agent-local'
import { createRunCommand, produceDirectRunMembers, produceSuiteRunMembers } from '../commands/run.js'
import type { RunInvocationInputs, SuiteRunMemberProductionInput } from '../commands/run.js'
import { assembleCliRun } from '../composition/run-assembly.js'
import { RECORDING_STAGING_DIRNAME, resolveRecordingSetting as resolve, resolveRecordingStagingDir } from '../commands/recording-setting.js'

const runSource = readFileSync(new URL('../commands/run.ts', import.meta.url), 'utf8')

const boundary = vi.hoisted(() => ({
  setups: vi.fn(),
  member: vi.fn(),
  start: vi.fn(async () => ({})),
  stop: vi.fn(async () => undefined),
}))
vi.mock('@vostride/agent-qa-model', async importOriginal => ({
  ...await importOriginal<typeof import('@vostride/agent-qa-model')>(),
  createModel: () => ({ doGenerate: () => { throw new Error('Unexpected model call') } }),
}))
vi.mock('../llm-utils.js', async importOriginal => ({
  ...await importOriginal<typeof import('../llm-utils.js')>(),
  resolveModelAuth: async () => ({ kind: 'unauthenticated', credentialKey: 'fixture', provider: 'openai-compatible', optional: true, message: 'fixture' }),
}))
vi.mock('@vostride/agent-qa-runner', async importOriginal => {
  const original = await importOriginal<typeof import('@vostride/agent-qa-runner')>()
  return {
    ...original,
    runMemberTest: (...args: Parameters<typeof original.runMemberTest>) => {
      boundary.member(args[1].recording)
      return original.runMemberTest(...args)
    },
  }
})
vi.mock('@vostride/agent-qa-web', () => ({
  WebPlatformAdapter: class {
    platform = 'web' as const
    recording = { start: boundary.start, stop: boundary.stop }
    setup = boundary.setups
    async cleanup() {}
    async navigate() {}
    async execute() { return { success: true } }
  },
}))

it('REC-DEFAULT-ABSENT-KEY-ON: absent config and enabled both resolve on', () => {
  expect(resolve(undefined, undefined)).toEqual({ enabled: true, keepFailuresOnly: false })
  expect(resolve(undefined, {})).toEqual({ enabled: true, keepFailuresOnly: false })
})

it('REC-DEFAULT-EXPLICIT-FALSE-OFF: config false is respected', () => {
  expect(resolve(undefined, { enabled: false })).toEqual({ enabled: false, keepFailuresOnly: false })
  expect(resolve(true, { enabled: false }).enabled).toBe(true)
})

it('REC-DEFAULT-FLAG-NO-RECORD: the registered negated flag disables one run', () => {
  expect(resolve(false, { enabled: true }).enabled).toBe(false)
  for (const [argv, expected] of [[[], undefined], [['--record'], true], [['--no-record'], false]] as const) {
    const command = createRunCommand().exitOverride().action(() => {})
    command.parse([...argv], { from: 'user' })
    expect(command.opts().record).toBe(expected)
  }
})

it('REC-DEFAULT-META-FALSE-OFF: member false overrides flag and config', () => {
  expect(resolve(true, { enabled: true, keepFailuresOnly: true }, false))
    .toEqual({ enabled: false, keepFailuresOnly: true })
})

it('REC-DEFAULT-META-TRUE-ON: member true overrides flag and config', () => {
  expect(resolve(false, { enabled: false }, true)).toEqual({ enabled: true, keepFailuresOnly: false })
})

it('REC-DEFAULT-BOTH-PATHS-SHARE: both paths and member overrides use the resolver', () => {
  expect(runSource.match(/resolveRecordingSetting\(/g)?.length ?? 0).toBeGreaterThanOrEqual(4)
  expect(runSource).not.toMatch(/opts\.record\s*\?\?/)
  expect(runSource).not.toContain('resolveDashboardVideoDir')
  expect(runSource).not.toMatch(/(?:recordingCfg|recCfg2?)\?\.(?:videoDir|videoSize)/)
})

it('REC-STAGING-NOT-LEGACY-DIR: staging sits beside runs regardless of workspace name', () => {
  expect(RECORDING_STAGING_DIRNAME).toBe('recording-staging')
  for (const configDir of ['/tmp/project', '/tmp/videos', '/tmp/project with spaces']) {
    const staging = resolveRecordingStagingDir(configDir)
    expect(staging).toBe(join(configDir, '.agent-qa', 'recording-staging'))
    expect(basename(staging)).not.toBe('videos')
  }
})

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agent-qa-424-default-'))
  vi.clearAllMocks()
  for (const key of ['AGENT_QA_LLM_MODEL', 'AGENT_QA_LLM_PROVIDER', 'AGENT_QA_RUN_ATTRIBUTES_JSON']) vi.stubEnv(key, '')
  vi.stubEnv('AGENT_QA_RUN_ID', undefined)
})
afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

for (const path of ['suite', 'direct'] as const) {
  it.each([
    { config: undefined, flag: undefined, meta: undefined, enabled: true, keepFailuresOnly: false },
    { config: { enabled: false, keepFailuresOnly: true }, flag: undefined, meta: undefined, enabled: false, keepFailuresOnly: true },
    { config: { enabled: true, keepFailuresOnly: true }, flag: false, meta: undefined, enabled: false, keepFailuresOnly: true },
    { config: { enabled: true }, flag: true, meta: false, enabled: false, keepFailuresOnly: false },
    { config: { enabled: false, keepFailuresOnly: true }, flag: false, meta: true, enabled: true, keepFailuresOnly: true },
  ])(`REC-DEFAULT-KNOB-REACHES-RUNNER: ${path} $enabled / $keepFailuresOnly / $meta`, async setting => {
    const runId = generateRunId()
    const testId = generateTestId()
    const filePath = join(root, 'one.yaml')
    const suiteFile = join(root, 'one.suite.yaml')
    const configFilePath = join(root, 'agent-qa.config.yaml')
    const test = {
      'test-id': testId, name: 'Recording fixture', target: 'fixture',
      meta: setting.meta === undefined ? {} : { record: setting.meta },
      steps: ['{{appium: mobile: scroll, direction: down}}'],
    }
    const fileContent = JSON.stringify(test)
    writeFileSync(filePath, fileContent)
    writeFileSync(suiteFile, 'name: Recording suite\n')
    const config = {
      workspace: { testMatch: ['*.yaml'], suiteMatch: ['*.suite.yaml'], testPathIgnore: [] },
      registry: {
        llms: [{ name: 'fixture', provider: 'openai-compatible', model: 'gpt-4o', baseURL: 'http://127.0.0.1:1/v1' }],
        targets: { fixture: { platform: 'web', product: 'recording-fixture' } },
      },
      use: { llm: 'fixture', cache: false, timeout: { step: 1000, test: 5000 } },
      services: { logging: { level: 'silent' }, ...(setting.config ? { recording: setting.config } : {}) },
      knowledge: { dir: 'knowledge' },
    } as unknown as RunInvocationInputs['config']
    const configContent = JSON.stringify(config)
    writeFileSync(configFilePath, configContent)
    const secretStore = SecretStore.fromEnvContent('')
    const secretRedactor = new SecretRedactor(secretStore)
    const opts = { disableCache: true, reporter: ['console'], record: setting.flag }
    const inputs = {
      config, configDir: root, configFilePath, configContent,
      runtimeSecrets: { secretStore, secretRedactor, secretsFileMetadata: { path: null, status: 'missing' } },
      envFileVars: {}, inlineVars: {}, cliVars: {}, userRunAttributes: {},
      effectiveLogLevel: 'silent', resolvedHooks: new Map(),
      rawEnvFileContent: null, resolvedEnvFilePath: null,
    } as RunInvocationInputs
    const produced = path === 'direct'
      ? await produceDirectRunMembers({ inputs, bindings: [{ test, filePath, fileContent }] as never, opts })
      : await produceSuiteRunMembers({
          config, configDir: root, configFilePath, configContent, runId, opts,
          effectiveLogLevel: 'silent', suiteFiles: [suiteFile], loadPlugins: async () => {},
          preflight: {
            definitions: new Map([[suiteFile, { 'suite-id': generateSuiteId(), name: 'Recording suite', target: 'fixture', tests: [{ test: 'one.yaml', id: testId }] }]]),
            preloadedTests: new Map([[filePath, { fileContent, parseResult: { tests: [test], errors: [] } }]]),
            product: 'recording-fixture',
          },
          variableContext: { envFileVars: {}, inlineVars: {}, cliVars: {}, userRunAttributes: {}, secretStore, secretRedactor },
        } as SuiteRunMemberProductionInput)
    const core = createRunInvocationCore({
      configPath: configFilePath, agentQaRoot: join(root, '.agent-qa'), executionContext: 'ci',
      mintRunId: () => runId, isMintedRunId: () => true,
      assembleRun: async context => {
        const assembly = await assembleCliRun({
          ...context, knowledgeRoot: produced.knowledgeRoot, secretRedactor: produced.secretRedactor,
          members: produced.members, executor: produced.executor, configDigests: produced.configDigests,
          product: produced.product, warn: () => {},
        })
        produced.applyAssembly(assembly)
        produced.bindKnowledge?.(assembly.buildOrdinal)
        return assembly.config
      },
      onSession: session => produced.bindSession(session),
    })
    try {
      await core.execute({})
      await produced.finalize?.()
      expect(produced.takeFrameworkError()).toBeUndefined()
      expect(boundary.member).toHaveBeenCalledExactlyOnceWith({
        enabled: setting.enabled, keepFailuresOnly: setting.keepFailuresOnly,
      })
      expect(boundary.start).toHaveBeenCalledTimes(setting.enabled ? 1 : 0)
      if (setting.enabled) {
        expect(boundary.setups.mock.calls[0]?.[0].recording).toEqual({
          enabled: true, videoDir: join(root, '.agent-qa', 'recording-staging'),
        })
      }
    } finally {
      await produced.finalize?.()
    }
  })
}
