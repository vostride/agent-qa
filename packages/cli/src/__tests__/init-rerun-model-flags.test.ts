import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { getAuthPath } from '@vostride/agent-qa-core'
import { parse, parseDocument } from 'yaml'

import { afterEach, describe, expect, it } from 'vitest'

import type { InitDocument } from '../commands/init-document.js'
import { resolveConfig } from '../config.js'
import { NoModelConfiguredError, resolveLLMModels } from '../llm-utils.js'
import { cleanupTempProjects } from './project-fixtures.js'
import { initializedProject, rerun, type InitializedProject } from './rerun-fixtures.js'

afterEach(() => {
  cleanupTempProjects()
})

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
