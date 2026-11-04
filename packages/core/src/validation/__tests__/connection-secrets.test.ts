import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { generateSuiteId, generateTestId } from '@vostride/agent-qa-ids'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { parse as parseYaml } from 'yaml'

import { connectionSecretMisuse } from '../../remote/connection-secrets.js'
import { AgentQaConfigSchema } from '../../schema/config-schema.js'
import type { AgentQaConfig } from '../../types/config.js'
import { resolveWorkspacePaths } from '../../workspace/workspace-paths.js'
import { validateProject, type ValidationDiagnostic } from '../validate.js'

const projects: string[] = []
afterAll(() => {
  for (const project of projects.splice(0)) rmSync(project, { recursive: true, force: true })
})

const remoteToken = new Set(['REMOTE_TOKEN'])

function configYaml(options: { remotes: boolean; targetUrl?: string }): string {
  return [
    'workspace:',
    '  testMatch:',
    "    - 'tests/**/*.yaml'",
    '  suiteMatch:',
    "    - 'suites/**/*.suite.yaml'",
    '  hooksFile: hooks.yaml',
    '  envFile: .env',
    '  secretsFile: .env.secrets.local',
    'registry:',
    '  targets:',
    '    shop:',
    '      platform: web',
    `      url: ${JSON.stringify(options.targetUrl ?? 'http://127.0.0.1:8080')}`,
    ...(options.remotes
      ? [
          '  remotes:',
          '    - name: grid',
          '      protocol: playwright',
          '      url: "ws://127.0.0.1:3000/?token={{secret:REMOTE_TOKEN}}"',
        ]
      : []),
    '',
  ].join('\n')
}

function testYaml(id: string, steps: readonly string[]): string {
  return [
    `test-id: ${id}`,
    'name: a checkout test',
    'target: shop',
    'steps:',
    ...steps.map((step) => `  - ${JSON.stringify(step)}`),
    '',
  ].join('\n')
}

function suiteYaml(entries: readonly { test: string; id: string }[]): string {
  return [
    `suite-id: ${generateSuiteId()}`,
    'name: checkout',
    'target: shop',
    'tests:',
    ...entries.flatMap((entry) => [`  - test: ${entry.test}`, `    id: ${entry.id}`]),
    '',
  ].join('\n')
}

interface Project {
  configPath: string
  file(relative: string): string
  validate(files?: string[]): Promise<ValidationDiagnostic[]>
}

function project(
  options: { remotes: boolean; targetUrl?: string },
  files: Record<string, string>,
): Project {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'connection-secrets-')))
  projects.push(dir)
  mkdirSync(path.join(dir, 'tests'))
  mkdirSync(path.join(dir, 'suites'))
  const configPath = path.join(dir, 'agent-qa.config.yaml')
  writeFileSync(configPath, configYaml(options))
  writeFileSync(path.join(dir, 'hooks.yaml'), 'hooks: []\n')
  writeFileSync(path.join(dir, '.env'), '')
  writeFileSync(path.join(dir, '.env.secrets.local'), 'REMOTE_TOKEN=t0ken\nLOGIN_PASSWORD=pw\n')
  for (const [relative, content] of Object.entries(files)) {
    writeFileSync(path.join(dir, relative), content)
  }
  // The workspace paths come from the config without its target refinement.
  const config = AgentQaConfigSchema.parse(
    parseYaml(configYaml({ remotes: options.remotes })),
  ) as AgentQaConfig
  const workspace = resolveWorkspacePaths({ config, configPath })
  return {
    configPath,
    file: (relative) => path.join(dir, relative),
    validate: async (only) => {
      const scope = only === undefined ? {} : { files: only }
      return (await validateProject({ configPath, workspace, ...scope })).diagnostics
    },
  }
}

function diagnostic(file: string, message: string): ValidationDiagnostic {
  return { file, line: 1, column: 1, message, severity: 'error' }
}

function runStartSentence(file: string, steps: readonly string[]): string[] {
  return connectionSecretMisuse({ names: remoteToken, file, steps })
}

describe("validateProject and a remote's secrets", () => {
  it('reports a step that uses a remote secret on the test file with the run-start sentence', async () => {
    const steps = ['Type {{secret:REMOTE_TOKEN}} into the field']
    const p = project({ remotes: true }, { 'tests/a.test.yaml': testYaml(generateTestId(), steps) })
    const [message] = runStartSentence('tests/a.test.yaml', steps)
    expect(message).toBe(
      "REMOTE_TOKEN is a remote's credential and only connects to it; tests/a.test.yaml uses it in a step. Use another secret there.",
    )
    expect(await p.validate()).toEqual([diagnostic(p.file('tests/a.test.yaml'), message!)])
  })

  it('reports an expected value a step states with a remote secret', async () => {
    const steps = ['Verify the banner reads "{{secret:REMOTE_TOKEN}}"']
    const p = project({ remotes: true }, { 'tests/a.test.yaml': testYaml(generateTestId(), steps) })
    expect(await p.validate()).toEqual(
      runStartSentence('tests/a.test.yaml', steps).map((message) =>
        diagnostic(p.file('tests/a.test.yaml'), message),
      ),
    )
  })

  it('reports a suite member that uses a remote secret on the member file once', async () => {
    const id = generateTestId()
    const steps = ['Type {{secret:REMOTE_TOKEN}} into the field']
    const p = project(
      { remotes: true },
      {
        'tests/a.test.yaml': testYaml(id, steps),
        'suites/checkout.suite.yaml': suiteYaml([{ test: 'tests/a.test.yaml', id }]),
      },
    )
    const expected = runStartSentence('tests/a.test.yaml', steps).map((message) =>
      diagnostic(p.file('tests/a.test.yaml'), message),
    )
    expect(await p.validate()).toEqual(expected)
    expect(await p.validate([p.file('suites/checkout.suite.yaml')])).toEqual(expected)
  })

  it("reports a target url naming a remote secret through the config's own refusal", async () => {
    const p = project(
      { remotes: true, targetUrl: 'http://127.0.0.1:8080/?k={{secret:REMOTE_TOKEN}}' },
      { 'tests/a.test.yaml': testYaml(generateTestId(), ['Open the home page']) },
    )
    expect(await p.validate()).toEqual([
      diagnostic(
        p.configPath,
        "registry.targets.shop.url: registry.targets.shop.url uses REMOTE_TOKEN, a remote's credential that only connects to it. Use another secret here.",
      ),
    ])
  })

  it('reports nothing for a step that uses another declared secret', async () => {
    const p = project(
      { remotes: true },
      {
        'tests/a.test.yaml': testYaml(generateTestId(), [
          'Type {{secret:LOGIN_PASSWORD}} into the password field',
        ]),
      },
    )
    expect(await p.validate()).toEqual([])
  })

  it('reports nothing in a project with no remotes', async () => {
    const p = project(
      { remotes: false },
      {
        'tests/a.test.yaml': testYaml(generateTestId(), [
          'Type {{secret:REMOTE_TOKEN}} into the field',
        ]),
      },
    )
    expect(await p.validate()).toEqual([])
  })

  it('validates a config whose remote url yaml would warn about without printing the warning', async () => {
    const p = project({ remotes: false }, {})
    writeFileSync(
      p.configPath,
      [
        'workspace:',
        '  testMatch:',
        "    - 'tests/**/*.yaml'",
        '  suiteMatch:',
        "    - 'suites/**/*.suite.yaml'",
        '  hooksFile: hooks.yaml',
        '  envFile: .env',
        '  secretsFile: .env.secrets.local',
        'registry:',
        '  llms:',
        '    - name: judge',
        '      provider: anthropic-compatible',
        '      model: m',
        '      baseURL: https://llm.example.com/v1',
        '      providerHeaders:',
        '        ? [ &u !endpoint wss://grid.example.com/routepart-5e21?team=queryvalue-a904 ]',
        '        : x',
        '  remotes:',
        '    - name: grid',
        '      protocol: playwright',
        '      url: *u',
        '',
      ].join('\n'),
    )
    const warned = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
    try {
      expect(await p.validate()).toEqual([])
      expect(warned).not.toHaveBeenCalled()
    } finally {
      warned.mockRestore()
    }
  })
})
