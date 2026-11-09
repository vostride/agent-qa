import { dirname } from 'node:path'

import { getAuthPath } from '@vostride/agent-qa-core'
import { parse } from 'yaml'

import { CliRefusal, PromptCancelled } from '../composition/cli-refusal.js'
import type { InitUi, InitUiMode } from '../init-ui/init-ui.js'
import { activeModelEntry } from '../llm-utils.js'
import { readAgentSetupManifest, type CodingAgent } from './agent-setup-manifest.js'
import { INIT_AGENT_OPTIONS } from './init-agents.js'
import type { InitDocumentRecorder } from './init-document.js'
import type { InitFileResult } from './init-filesystem.js'
import { modelStatus, type InitModelEntry } from './init-model-choice.js'
import {
  createInitStepRunner,
  rerunPlan,
  type InitStepResult,
  type InitStepRunner,
} from './init-steps.js'
import { declaredAgentQaVersion, findProjectAgentQa } from './project-agent-qa.js'
import type { ProjectHost } from './project-host.js'
import { nearestInstalledPackage, type ProjectRange } from './project-range.js'
import { SUBSCRIPTION_AUTH_PACKAGE } from './scaffold-content.js'
import {
  SETUP_ROW_RUNS,
  checkSetupRows,
  setupRowLabel,
  type SetupRowName,
  type SetupRowState,
} from './setup-rows.js'

export interface InitRerunOptions {
  llm?: string
  model?: string
  baseUrl?: string
  agents?: string
  browsers?: boolean
  dashboard?: boolean
  pm?: string
  yes?: boolean
  json?: boolean
}

export interface InitRerunInput {
  dir: string
  configPath: string
  host: ProjectHost
  range: ProjectRange
  packageJson: { path: string; text: string | undefined }
  runningVersion: string
  opts: InitRerunOptions
  mode: InitUiMode
  openUi: () => Promise<InitUi>
  recorder: InitDocumentRecorder
  validate: () => Promise<InitStepResult>
  validateStep: { title: string; command: string }
  mask: (text: string) => Promise<string>
  outro: string
  onComplete?: (outcomes: readonly InitFileResult[]) => void
  emitInitCompleted: (results: readonly InitFileResult[]) => Promise<void>
  onRunner: (runner: InitStepRunner) => void
}

async function versionLines(input: InitRerunInput): Promise<string[]> {
  const copy = await findProjectAgentQa(input.range, input.range.start, input.host.io)
  const project =
    copy?.version ?? declaredAgentQaVersion(input.packageJson.text) ?? input.runningVersion
  const lines = [`You're on agent-qa ${project}.`]
  if (project !== input.runningVersion) lines.push(`This agent-qa is ${input.runningVersion}.`)
  return lines
}

type JsonObject = Record<string, unknown>

function asObject(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined
}

function modelEntryOf(value: unknown): InitModelEntry[] {
  const entry = asObject(value)
  const { name, provider, model, baseURL } = entry ?? {}
  if (typeof name !== 'string' || typeof provider !== 'string' || typeof model !== 'string') {
    return []
  }
  return [{ name, provider, model, ...(typeof baseURL === 'string' ? { baseURL } : {}) }]
}

// Undefined when the config does not parse; validate reports that.
function configuredModels(
  input: InitRerunInput,
): { registry: { llms: InitModelEntry[] }; use: { llm?: string } } | undefined {
  let raw: unknown
  try {
    raw = parse(input.host.io.readText(input.configPath) ?? '', { logLevel: 'error' })
  } catch {
    return undefined
  }
  const config = asObject(raw)
  const llms = asObject(config?.registry)?.llms
  const use = asObject(config?.use)?.llm
  return {
    registry: { llms: Array.isArray(llms) ? llms.flatMap(modelEntryOf) : [] },
    use: typeof use === 'string' ? { llm: use } : {},
  }
}

async function modelLine(input: InitRerunInput): Promise<string | undefined> {
  const models = configuredModels(input)
  if (models === undefined) return undefined
  const entry = activeModelEntry(models)
  const pluginInstalled =
    nearestInstalledPackage(
      input.range,
      dirname(input.packageJson.path),
      SUBSCRIPTION_AUTH_PACKAGE,
      input.host.io,
    ) !== undefined
  const status = await modelStatus({
    ...(entry === undefined ? {} : { entry }),
    configPath: input.configPath,
    projectDir: input.dir,
    authPath: getAuthPath({ env: input.host.env, homeDir: input.host.homedir }),
    pluginInstalled,
  })
  input.recorder.model({
    ...(entry === undefined ? {} : { name: entry.name, provider: entry.provider }),
    ...status,
  })
  if (entry === undefined) return 'No model is set up.'
  return status.status === 'ready'
    ? `Model ${entry.name} is ready.`
    : `Model ${entry.name} is pending: ${status.reason}.`
}

function agentsLine(agents: readonly CodingAgent[]): string {
  const labels = INIT_AGENT_OPTIONS.filter((option) => agents.includes(option.value)).map(
    (option) => option.label,
  )
  return labels.length === 0 ? 'No coding agent is set up.' : `Coding agents: ${labels.join(', ')}.`
}

export const SETUP_MENU_QUESTION = 'What should init set up here?'

async function chooseRows(
  ui: InitUi,
  ask: boolean,
  shown: readonly SetupRowState[],
): Promise<SetupRowName[]> {
  const prechecked = shown.filter((row) => row.prechecked).map((row) => row.name)
  if (!ask) return prechecked
  const width = Math.max(...shown.map((row) => row.name.length))
  return await ui.multiselect<SetupRowName>({
    message: SETUP_MENU_QUESTION,
    options: shown.map((row) => ({ value: row.name, label: setupRowLabel(row, width) })),
    initialValues: prechecked,
    required: false,
  })
}

export async function runInitRerun(input: InitRerunInput): Promise<void> {
  // A malformed manifest or managed block is refused here, before anything is drawn or written.
  const manifest = readAgentSetupManifest(input.dir)
  const agents = manifest?.agents ?? []
  input.recorder.agents(agents)
  const rows = checkSetupRows({ projectDir: input.dir, io: input.host.io })
  const shown = rows.filter((row) => row.shown)
  const model = await modelLine(input)
  const summary = [
    ...(await versionLines(input)),
    ...(model === undefined ? [] : [model]),
    agentsLine(agents),
  ]
  input.recorder.agentQa({ version: input.runningVersion, via: 'running' })

  const ui = await input.openUi()
  if (input.mode !== 'plain') ui.banner()
  ui.intro()
  ui.summary('This project', summary)
  const selected = await chooseRows(ui, input.mode === 'interactive', shown)

  const runner = createInitStepRunner({
    ui,
    plan: rerunPlan(shown.map((row) => row.name)),
    mask: input.mask,
  })
  input.onRunner(runner)
  const outcomes: InitFileResult[] = []
  for (const row of shown) {
    if (!selected.includes(row.name)) {
      const reason = row.wouldChange ? 'not selected' : 'current'
      runner.skip(row.name, `${row.name}: ${reason}`, reason)
      continue
    }
    const { title, run } = SETUP_ROW_RUNS[row.name]
    await runner.run(row.name, { title }, async (): Promise<InitStepResult> => {
      const { text, files } = run({ projectDir: input.dir })
      for (const file of files) {
        outcomes.push(file)
        input.recorder.file(row.name, file)
      }
      return { outcome: 'done', text }
    })
  }
  await runner.run('validate', input.validateStep, input.validate)

  input.onComplete?.(outcomes)
  await input.emitInitCompleted(outcomes)
  if (runner.interrupted()) throw new PromptCancelled()

  ui.outro(input.outro)
  if (runner.failed()) throw new CliRefusal([], 3)
}
