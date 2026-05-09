import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Command } from 'commander'
import { createValidateCommand } from '../commands/validate.js'

let workspaceDir: string
let originalCwd: string
let stdoutSpy: ReturnType<typeof vi.spyOn>

async function seedWorkspace() {
  await mkdir(path.join(workspaceDir, 'specs', 'web'), { recursive: true })
  await mkdir(path.join(workspaceDir, 'tests'), { recursive: true })
  await writeFile(path.join(workspaceDir, 'specs', 'web', 'login.yaml'), [
    'test-id: t_amber-birch-coral-delta-ember-falcon-garden-harbor-island-jungle',
    'name: Login',
    'target: demo-app',
    'steps:',
    '  - Open the login page',
    '',
  ].join('\n'))
  await writeFile(path.join(workspaceDir, 'tests', 'legacy.yaml'), [
    'test-id: t_aster-bloom-cloud-drift-ember-field-glade-hollow-ivory-jasper',
    'name: Legacy',
    'target: demo-app',
    'steps:',
    '  - This file must not be discovered',
    '',
  ].join('\n'))
  await mkdir(path.join(workspaceDir, 'hooks'), { recursive: true })
  await writeFile(path.join(workspaceDir, 'hooks', 'noop.js'), 'export default async function noop() {}\n')
  await writeFile(path.join(workspaceDir, 'hooks.yaml'), [
    'hooks:',
    '  - id: h_amber-birch-coral-delta-ember-falcon-garden-harbor-island-jungle',
    '    name: Noop',
    '    runtime: node',
    '    file: hooks/noop.js',
    '    timeout: 30s',
    '',
  ].join('\n'))
  await writeFile(path.join(workspaceDir, 'agent-rules.md'), '# rules\n')
  await writeFile(path.join(workspaceDir, '.env'), '')
  await writeFile(path.join(workspaceDir, '.env.secrets.local'), '')
  await writeFile(path.join(workspaceDir, 'agent-qa.config.yaml'), [
    'workspace:',
    '  testMatch:',
    '    - specs/web/**/*.yaml',
    '  suiteMatch:',
    '    - cases/**/*.suite.yaml',
    '  hooksFile: hooks.yaml',
    '  agentRules: agent-rules.md',
    '  envFile: .env',
    '  secretsFile: .env.secrets.local',
    'use:',
    '  mobile:',
    '    appState: preserve',
    '',
  ].join('\n'))
}

async function runValidate(...args: string[]) {
  const program = new Command()
  program.option('--config <path>', 'config file path', 'agent-qa.config.yaml')
  program.addCommand(createValidateCommand())
  await program.parseAsync([
    'node',
    'agent-qa',
    '--config',
    path.join(workspaceDir, 'agent-qa.config.yaml'),
    'validate',
    ...args,
  ])
}

function output() {
  return stdoutSpy.mock.calls.map((call: unknown[]) => call.join('')).join('')
}

describe('validate command workspace resolution', () => {
  beforeEach(async () => {
    originalCwd = process.cwd()
    workspaceDir = await mkdtemp(path.join(tmpdir(), 'agent-qa-validate-'))
    await seedWorkspace()
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

  it('discovers tests from workspace.testMatch relative to the config file', async () => {
    await runValidate()

    expect(output()).toContain('All files valid (1 file(s) checked)')
    expect(process.exitCode).toBe(0)
  })

  it('accepts explicit files only when they match workspace.testMatch', async () => {
    await runValidate('specs/web/login.yaml')

    expect(output()).toContain('All files valid (1 file(s) checked)')
    expect(process.exitCode).toBe(0)
  })

  it('rejects explicit files outside configured workspace patterns', async () => {
    await runValidate('tests/legacy.yaml')

    expect(output()).toContain('File is not matched by configured workspace testMatch or suiteMatch patterns')
    expect(process.exitCode).toBe(1)
  })
})
