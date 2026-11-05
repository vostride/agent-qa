import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getAgentQaVersion } from '@vostride/agent-qa-core'

import { createValidateCommand } from '../commands/validate.js'

const FIRST_PARTY = '@vostride/agent-qa-plugin-scripted'
const THIRD_PARTY = '@acme/agent-qa-plugin-grid'
const SPARE = '@acme/agent-qa-plugin-spare'
const DRAFT = 'https://json-schema.org/draft/2020-12/schema'

let workspaceDir: string
let originalCwd: string
let stdoutSpy: ReturnType<typeof vi.spyOn>

function objectSchema(properties: Record<string, unknown>): Record<string, unknown> {
  return { $schema: DRAFT, type: 'object', properties, additionalProperties: false }
}

// The entry leaves a marker and throws, so a validate that ran plugin code shows it.
async function installPlugin(
  name: string,
  manifest: Record<string, unknown> = {},
  options: Record<string, unknown> = objectSchema({}),
): Promise<void> {
  const dir = path.join(workspaceDir, 'node_modules', ...name.split('/'))
  await mkdir(path.join(dir, 'dist'), { recursive: true })
  const plugin = {
    kind: 'remote',
    runs: 'process',
    protocol: 1,
    entry: './dist/main.js',
    serves: ['playwright'],
    methods: [],
    options: './dist/options.schema.json',
    settings: './dist/settings.schema.json',
    ...manifest,
  }
  await writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({ name, version: '1.0.0', 'agent-qa': { plugin } }),
  )
  const marker = JSON.stringify(path.join(workspaceDir, 'plugin-ran.marker'))
  await writeFile(
    path.join(dir, 'dist', 'main.js'),
    `require('node:fs').writeFileSync(${marker}, 'ran')\nthrow new Error('plugin code ran')\n`,
  )
  await writeFile(path.join(dir, 'dist', 'options.schema.json'), JSON.stringify(options))
  await writeFile(
    path.join(dir, 'dist', 'settings.schema.json'),
    JSON.stringify(objectSchema({})),
  )
}

async function writeConfig(plugins: readonly string[]): Promise<void> {
  await writeFile(
    path.join(workspaceDir, 'agent-qa.config.yaml'),
    [
      'workspace:',
      '  testMatch:',
      '    - tests/**/*.yaml',
      '  suiteMatch:',
      '    - suites/**/*.suite.yaml',
      '  hooksFile: hooks.yaml',
      '  envFile: .env',
      '  secretsFile: .env.secrets.local',
      'registry:',
      '  targets:',
      '    demo-app:',
      '      platform: web',
      '      url: http://127.0.0.1:1/',
      '  remotes:',
      '    - name: farm',
      '      plugin: kit',
      'plugins:',
      ...plugins,
      'use:',
      '  browser:',
      '    name: chromium',
      '    headless: true',
      '    remote: farm',
      '  mobile:',
      '    appState: preserve',
      '',
    ].join('\n'),
  )
}

async function runValidate(): Promise<void> {
  const program = new Command()
  program.option('--config <path>', 'config file path', 'agent-qa.config.yaml')
  program.addCommand(createValidateCommand())
  await program.parseAsync([
    'node',
    'agent-qa',
    '--config',
    path.join(workspaceDir, 'agent-qa.config.yaml'),
    'validate',
  ])
}

function output(): string {
  return stdoutSpy.mock.calls
    .map((call: unknown[]) => call.join(''))
    .join('')
    .replace(/\x1b\[[0-9;]*m/g, '')
}

describe('validate checks plugins entries', () => {
  beforeEach(async () => {
    originalCwd = process.cwd()
    workspaceDir = await mkdtemp(path.join(tmpdir(), 'agent-qa-validate-plugins-'))
    await mkdir(path.join(workspaceDir, 'tests'), { recursive: true })
    await writeFile(
      path.join(workspaceDir, 'tests', 'login.yaml'),
      [
        'test-id: t_amber-birch-coral-delta-ember-falcon-garden-harbor-island-jungle',
        'name: Login',
        'target: demo-app',
        'steps:',
        '  - Open the login page',
        '',
      ].join('\n'),
    )
    await writeFile(path.join(workspaceDir, 'hooks.yaml'), 'hooks: []\n')
    await writeFile(path.join(workspaceDir, '.env'), '')
    await writeFile(path.join(workspaceDir, '.env.secrets.local'), '')
    process.chdir(workspaceDir)
    process.exitCode = 0
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  })

  afterEach(async () => {
    process.chdir(originalCwd)
    stdoutSpy.mockRestore()
    process.exitCode = 0
    await rm(workspaceDir, { recursive: true, force: true })
  })

  it('refuses a remote whose first-party plugin is not installed, with the install line', async () => {
    await writeConfig(['  - name: kit', `    package: '${FIRST_PARTY}'`])

    await runValidate()

    expect(output()).toContain(
      `Remote farm cannot start: Plugin entry kit names ${FIRST_PARTY}, which is not installed. `
        + `Run npm install --save-dev --save-exact ${FIRST_PARTY}@${getAgentQaVersion()}.`,
    )
    expect(process.exitCode).toBe(1)
  })

  it('refuses a literal in a field the plugin marks as a credential, without running it', async () => {
    await installPlugin(
      THIRD_PARTY,
      {},
      objectSchema({ account: { type: 'string', credential: true } }),
    )
    await writeConfig([
      '  - name: kit',
      `    package: '${THIRD_PARTY}'`,
      '    options:',
      '      account: acct-literal-value',
    ])

    await runValidate()

    expect(output()).toContain(
      'Remote farm cannot start: Plugin entry kit: options.account is a credential; write it as a '
        + '{{secret:NAME}} reference to workspace.secretsFile.',
    )
    expect(output()).not.toContain('acct-literal-value')
    expect(existsSync(path.join(workspaceDir, 'plugin-ran.marker'))).toBe(false)
    expect(process.exitCode).toBe(1)
  })

  it('warns about an entry no remote uses and leaves the exit code 0', async () => {
    await installPlugin(THIRD_PARTY)
    await installPlugin(SPARE)
    await writeConfig([
      '  - name: kit',
      `    package: '${THIRD_PARTY}'`,
      '  - name: spare',
      `    package: '${SPARE}'`,
    ])

    await runValidate()

    expect(output()).toContain(
      'Plugin entry spare is used by no remote. Name it from a remote in registry.remotes, or '
        + 'remove it.',
    )
    expect(output()).toMatch(/warning\s+Plugin entry spare is used by no remote/)
    expect(output()).not.toContain('cannot start')
    expect(process.exitCode).toBe(0)
  })

  it('refuses a web pick of a remote whose plugin serves only appium', async () => {
    await installPlugin(THIRD_PARTY, { serves: ['appium'] })
    await writeConfig(['  - name: kit', `    package: '${THIRD_PARTY}'`])

    await runValidate()

    expect(output()).toContain(
      'Remote farm cannot start: plugin entry kit serves appium, and a web test needs playwright '
        + 'or cdp.',
    )
    expect(process.exitCode).toBe(1)
  })
})
