import { CliRefusal, PromptCancelled } from '../composition/cli-refusal.js'
import type { InitUi, InitUiMode } from '../init-ui/init-ui.js'
import { readAgentSetupManifest } from './agent-setup-manifest.js'
import type { InitDocumentRecorder } from './init-document.js'
import type { InitFileResult } from './init-filesystem.js'
import {
  createInitStepRunner,
  rerunPlan,
  type InitStepResult,
  type InitStepRunner,
} from './init-steps.js'
import { declaredAgentQaVersion, findProjectAgentQa } from './project-agent-qa.js'
import type { ProjectHost } from './project-host.js'
import type { ProjectRange } from './project-range.js'

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

export async function runInitRerun(input: InitRerunInput): Promise<void> {
  // A malformed manifest is refused here, before anything is drawn or written.
  const manifest = readAgentSetupManifest(input.dir)
  input.recorder.agents(manifest?.agents ?? [])
  const summary = await versionLines(input)
  input.recorder.agentQa({ version: input.runningVersion, via: 'running' })

  const ui = await input.openUi()
  if (input.mode !== 'plain') ui.banner()
  ui.intro()
  ui.summary('This project', summary)

  const runner = createInitStepRunner({ ui, plan: rerunPlan(), mask: input.mask })
  input.onRunner(runner)
  await runner.run('validate', input.validateStep, input.validate)

  const outcomes: InitFileResult[] = []
  input.onComplete?.(outcomes)
  await input.emitInitCompleted(outcomes)
  if (runner.interrupted()) throw new PromptCancelled()

  ui.outro(input.outro)
  if (runner.failed()) throw new CliRefusal([], 3)
}
