import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { stripVTControlCharacters } from 'node:util'

import { getAuthPath } from '@vostride/agent-qa-core'
import { parse, parseDocument } from 'yaml'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { InitDocument } from '../commands/init-document.js'
import { SETUP_MENU_QUESTION } from '../commands/init-rerun.js'
import type { RunResult } from '../commands/project-host.js'
import { resolveConfig } from '../config.js'
import { NoModelConfiguredError, resolveLLMModels } from '../llm-utils.js'
import type { FakeInitUiEntry } from './fake-init-ui.js'
import {
  cleanupTempProjects,
  fakeRunner,
  writeInstalledPackage,
  type FakeRunner,
  type RunnerCall,
} from './project-fixtures.js'
import { initializedProject, rerun, type InitializedProject } from './rerun-fixtures.js'

const { PROJECT_VERSION } = vi.hoisted(() => ({ PROJECT_VERSION: '0.3.0' }))

vi.mock('@vostride/agent-qa-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@vostride/agent-qa-core')>()),
  getAgentQaVersion: () => PROJECT_VERSION,
}))

afterEach(() => {
  cleanupTempProjects()
})

const NODE = '/fake/node'
const SUBSCRIPTION = '@vostride/agent-qa-subscription-auth'
const OK: RunResult = { code: 0, signal: null, output: '' }
const PLATFORM_LINE =
  "--platform sets up a new project; this one's platforms are its config's targets. " +
  'Run npx agent-qa init without --platform, or with --force to rebuild.'

function isProbe(args: readonly string[]): boolean {
  return args.length === 1 && args[0] === '--version'
}

// The install puts each named package in node_modules at the version package.json declares.
function installing(...names: string[]): FakeRunner {
  return fakeRunner(({ command, args, options }) => {
    if (isProbe(args)) return { code: 0, signal: null, output: '11.0.0\n' }
    if (command === NODE) return OK
    const declared = JSON.parse(readFileSync(join(options.cwd, 'package.json'), 'utf8')) as {
      devDependencies: Record<string, string>
    }
    for (const name of names) {
      writeInstalledPackage(options.cwd, name, declared.devDependencies[name] ?? '0.0.0')
    }
    return OK
  })
}

function installs(run: FakeRunner): RunnerCall[] {
  return run.calls.filter((call) => !isProbe(call.args) && call.command !== NODE)
}

function menuOf(entries: readonly FakeInitUiEntry[]) {
  const entry = entries.find(
    (item) => item.kind === 'multiselect' && item.text === SETUP_MENU_QUESTION,
  )
  return entry?.kind === 'multiselect' ? entry : undefined
}

function packageJsonOf(project: InitializedProject): { devDependencies: Record<string, string> } {
  return JSON.parse(readFileSync(join(project.root, 'package.json'), 'utf8'))
}

const DASHBOARD_FINISHES = 'the dashboard finishes setting it up'

function configPath(project: InitializedProject): string {
  return join(project.root, 'agent-qa.config.yaml')
}

function configText(project: InitializedProject): string {
  return readFileSync(configPath(project), 'utf8')
}

interface ModelConfig {
  registry?: { llms?: { name: string; provider: string; model: string; baseURL?: string }[] }
  use?: { llm?: string }
  plugins?: { name: string; package: string }[]
}

function configOf(project: InitializedProject): ModelConfig {
  return parse(configText(project)) as ModelConfig
}

function removeModel(project: InitializedProject): void {
  const doc = parseDocument(configText(project))
  doc.deleteIn(['registry', 'llms'])
  doc.deleteIn(['use', 'llm'])
  writeFileSync(configPath(project), doc.toString())
}

function saveCredentials(home: string, store: Record<string, unknown>): void {
  const authPath = getAuthPath({ env: {}, homeDir: home })
  mkdirSync(dirname(authPath), { recursive: true })
  writeFileSync(authPath, JSON.stringify(store))
}

function documentOf(stdout: string): InitDocument {
  return JSON.parse(stdout) as InitDocument
}

async function runModels(
  project: InitializedProject,
): Promise<ReturnType<typeof resolveLLMModels>> {
  const config = await resolveConfig({ configPath: configPath(project) })
  return resolveLLMModels(config)
}

describe('--llm on a re-run sets the model in the config', () => {
  it('writes the provider default model under gemini and records a done model step', async () => {
    const project = await initializedProject('rerun-llm-gemini')
    removeModel(project)

    const result = await rerun(project, ['--llm', 'gemini', '--yes', '--json'], { plain: true })

    expect(result.exit, result.stderr).toBe(0)
    const config = configOf(project)
    expect(config.registry?.llms).toEqual([
      { name: 'gemini', provider: 'gemini', model: expect.any(String) },
    ])
    expect(config.registry?.llms?.[0]?.model).not.toBe('')
    expect(config.use?.llm).toBe('gemini')
    const doc = documentOf(result.stdout)
    expect(doc.steps[0]).toEqual({ name: 'model', outcome: 'done' })
    expect(`${doc.model?.name} ${doc.model?.provider}`).toBe('gemini gemini')
  })

  it('asks nothing and draws the model step done with its provider and model', async () => {
    const project = await initializedProject('rerun-llm-asks-nothing')
    removeModel(project)

    const result = await rerun(project, ['--llm', 'gemini'])

    expect(result.exit, result.stderr).toBe(0)
    expect(result.entries.filter((entry) => entry.kind === 'select')).toEqual([])
    const model = configOf(project).registry?.llms?.[0]?.model
    expect(result.entries).toContainEqual({ kind: 'done', text: `Model gemini: gemini ${model}` })
  })

  it('changes only the model line of a config whose model it replaces, comments included', async () => {
    const project = await initializedProject('rerun-llm-keeps-bytes')
    writeFileSync(configPath(project), `# My own note.\n${configText(project)}`)
    const before = configText(project)
    const current = configOf(project).registry?.llms?.[0]?.model ?? ''

    const result = await rerun(project, ['--llm', 'gemini', '--model', 'gemini-custom', '--yes'])

    expect(result.exit, result.stderr).toBe(0)
    expect(configText(project)).toBe(
      before.replace(`model: ${current}\n`, 'model: gemini-custom\n'),
    )
  })

  it('reuses the name of the saved credential --llm names', async () => {
    const project = await initializedProject('rerun-llm-saved-name')
    removeModel(project)
    saveCredentials(project.home, {
      'gemini-work': { type: 'api', provider: 'gemini', key: 'DUMMY-KEY-REUSED' },
    })

    const result = await rerun(project, ['--llm', 'gemini-work', '--yes', '--json'], {
      plain: true,
    })

    expect(result.exit, result.stderr).toBe(0)
    const config = configOf(project)
    expect(config.registry?.llms?.map((entry) => `${entry.name} ${entry.provider}`)).toEqual([
      'gemini-work gemini',
    ])
    expect(config.use?.llm).toBe('gemini-work')
    expect(documentOf(result.stdout).model).toMatchObject({ name: 'gemini-work', status: 'ready' })
    expect(configText(project)).not.toContain('DUMMY-KEY-REUSED')
    expect(result.stdout).not.toContain('DUMMY-KEY-REUSED')
  })

  it('writes a complete endpoint entry from --base-url and --model', async () => {
    const project = await initializedProject('rerun-llm-endpoint')

    const result = await rerun(project, [
      '--llm',
      'openai-compatible',
      '--base-url',
      'https://llm.local/v1',
      '--model',
      'local-model',
      '--yes',
    ])

    expect(result.exit, result.stderr).toBe(0)
    const config = configOf(project)
    expect(config.registry?.llms?.at(-1)).toEqual({
      name: 'openai-compatible',
      provider: 'openai-compatible',
      model: 'local-model',
      baseURL: 'https://llm.local/v1',
    })
    expect(config.use?.llm).toBe('openai-compatible')
  })

  it('writes nothing for an endpoint without its flags and leaves it to the dashboard', async () => {
    const project = await initializedProject('rerun-llm-dashboard-only')
    removeModel(project)
    const before = configText(project)

    const result = await rerun(project, ['--llm', 'openai-compatible', '--yes', '--json'], {
      plain: true,
    })

    expect(result.exit, result.stderr).toBe(0)
    expect(configText(project)).toBe(before)
    const doc = documentOf(result.stdout)
    expect(doc.steps[0]).toEqual({ name: 'model', outcome: 'skipped', reason: DASHBOARD_FINISHES })
    expect(doc.model?.status).toBe('pending')
  })

  it('refuses an unknown --llm with one line and exit 2, drawing and writing nothing', async () => {
    const project = await initializedProject('rerun-llm-bogus')
    const before = configText(project)

    const result = await rerun(project, ['--llm', 'bogus'])

    expect(result.exit).toBe(2)
    expect(result.stderr.trim().split('\n')).toEqual([
      '--llm must be one of claude-code, codex, anthropic, openai, gemini, openai-compatible, ' +
        'anthropic-compatible, or the name of a saved credential',
    ])
    expect(result.entries).toEqual([])
    expect(configText(project)).toBe(before)
  })

  it('refuses --model without --llm with one line and exit 2, writing nothing', async () => {
    const project = await initializedProject('rerun-model-without-llm')
    const before = configText(project)

    const result = await rerun(project, ['--model', 'gemini-custom'])

    expect(result.exit).toBe(2)
    expect(result.stderr.trim().split('\n')).toHaveLength(1)
    expect(result.stderr).toContain('--llm')
    expect(result.entries).toEqual([])
    expect(configText(project)).toBe(before)
  })

  it('ends the no-model refusal a run gives: the run finds gemini after init --llm gemini', async () => {
    const project = await initializedProject('rerun-llm-ends-no-model')
    removeModel(project)
    await expect(runModels(project)).rejects.toBeInstanceOf(NoModelConfiguredError)

    const result = await rerun(project, ['--llm', 'gemini', '--yes'])

    expect(result.exit, result.stderr).toBe(0)
    expect((await runModels(project)).configName).toBe('gemini')
  })
})

describe('a subscription chosen on a re-run', () => {
  it('declares the subscription plugin beside the subscription model', async () => {
    const project = await initializedProject('rerun-llm-subscription')

    const result = await rerun(project, ['--llm', 'claude-code', '--yes'], {
      run: installing(SUBSCRIPTION),
    })

    expect(result.exit, result.stderr).toBe(0)
    const config = configOf(project)
    expect(config.registry?.llms?.at(-1)).toMatchObject({
      name: 'claude-code',
      provider: 'anthropic-subscription',
    })
    expect(config.use?.llm).toBe('claude-code')
    expect(config.plugins).toEqual([{ name: 'subscription', package: SUBSCRIPTION }])
  })

  it('keeps a plugins entry that already declares the subscription package as it is', async () => {
    const project = await initializedProject('rerun-llm-subscription-declared')
    const doc = parseDocument(configText(project))
    doc.set('plugins', [{ name: 'my-sign-in', package: SUBSCRIPTION }])
    writeFileSync(configPath(project), doc.toString())

    const result = await rerun(project, ['--llm', 'claude-code', '--yes'], {
      run: installing(SUBSCRIPTION),
    })

    expect(result.exit, result.stderr).toBe(0)
    expect(configOf(project).plugins).toEqual([{ name: 'my-sign-in', package: SUBSCRIPTION }])
  })

  it('pre-checks the deps row for the subscription plugin in the same run', async () => {
    const project = await initializedProject('rerun-llm-subscription-deps-menu')

    const result = await rerun(project, ['--llm', 'claude-code'], {
      hooks: { isTTY: true },
      answers: { [SETUP_MENU_QUESTION]: [] },
    })

    expect(result.exit, result.stderr).toBe(0)
    const menu = menuOf(result.entries)
    expect(menu?.labels.find((label) => label.startsWith('deps '))).toBe(
      'deps       subscription plugin missing',
    )
    expect(menu?.initialValues).toContain('deps')
  })

  it('with --yes declares the plugin in package.json and installs it', async () => {
    const project = await initializedProject('rerun-llm-subscription-deps-yes')
    const run = installing(SUBSCRIPTION)

    const result = await rerun(project, ['--llm', 'claude-code', '--yes', '--json'], { run })

    expect(result.exit, result.stderr).toBe(0)
    expect(packageJsonOf(project).devDependencies[SUBSCRIPTION]).toBe(PROJECT_VERSION)
    expect(installs(run)).toHaveLength(1)
    const doc = documentOf(result.stdout)
    expect(doc.steps.slice(0, 2)).toEqual([
      { name: 'model', outcome: 'done' },
      { name: 'deps', outcome: 'done' },
    ])
  })
})

describe('--platform on a re-run', () => {
  it('is refused with one line and exit 2, drawing and writing nothing', async () => {
    const project = await initializedProject('rerun-platform-refused')
    const before = configText(project)

    const result = await rerun(project, ['--platform', 'web'])

    expect(result.exit).toBe(2)
    expect(stripVTControlCharacters(result.stderr).trim().split('\n')).toEqual([PLATFORM_LINE])
    expect(result.entries).toEqual([])
    expect(configText(project)).toBe(before)
  })

  it('under --json prints one refused document with that line', async () => {
    const project = await initializedProject('rerun-platform-refused-json')

    const result = await rerun(project, ['--platform', 'android', '--json'], { plain: true })

    expect(result.exit).toBe(2)
    expect(documentOf(result.stdout)).toMatchObject({
      format: 1,
      outcome: 'refused',
      exitCode: 2,
      steps: [],
      message: PLATFORM_LINE,
    })
  })
})
