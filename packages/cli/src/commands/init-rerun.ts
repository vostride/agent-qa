import { dirname } from 'node:path'

import { compareSemverVersions, getAuthPath, validSemverVersion } from '@vostride/agent-qa-core'
import pc from 'picocolors'
import { parse } from 'yaml'

import { CliRefusal, PromptCancelled } from '../composition/cli-refusal.js'
import type { InitUi, InitUiMode } from '../init-ui/init-ui.js'
import { activeModelEntry } from '../llm-utils.js'
import { CODING_AGENTS, readAgentSetupManifest, type CodingAgent } from './agent-setup-manifest.js'
import { guideLines, versionMove } from './agent-qa-upgrade.js'
import type { ChromiumResolver } from './browser-resolver.js'
import { INIT_AGENT_OPTIONS, parseInitAgentsFlag } from './init-agents.js'
import type { InitDocumentLatest, InitDocumentRecorder } from './init-document.js'
import type { InitFileOutcome, InitFileResult } from './init-filesystem.js'
import { modelStatus, type InitModelEntry } from './init-model-choice.js'
import type { LatestVersionAsk } from './latest-version-ask.js'
import {
  createInitStepRunner,
  rerunPlan,
  type InitStepResult,
  type InitStepRunner,
} from './init-steps.js'
import {
  declaredAgentQaVersion,
  findProjectAgentQa,
  type ProjectAgentQa,
} from './project-agent-qa.js'
import type { ProjectHost } from './project-host.js'
import { nearestInstalledPackage, type ProjectRange } from './project-range.js'
import { SUBSCRIPTION_AUTH_PACKAGE } from './scaffold-content.js'
import {
  SETUP_ROW_RUNS,
  checkSetupRows,
  parseSetupFlag,
  sharedAgentSetup,
  setupRowLabel,
  type SetupRowFile,
  type ScaffoldPlans,
  type SetupRowName,
  type SetupRowState,
  type SetupSelection,
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
  setup?: string
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
  emitInitCompleted: (initMode: 'rerun', results: readonly InitFileResult[]) => Promise<void>
  onRunner: (runner: InitStepRunner) => void
  chromium: ChromiumResolver
  installChromium: () => Promise<InitStepResult>
  scaffoldPlans: ScaffoldPlans
  latestVersion: LatestVersionAsk
}

const SETUP_BROWSERS_WITH_NO_BROWSERS_LINE =
  '--setup browsers asks for Chromium and --no-browsers refuses it; drop one of them.'

// Only a semver-valid answer is printed or recorded; anything else counts as no answer.
async function askLatest(input: InitRerunInput): Promise<InitDocumentLatest> {
  try {
    const answer = await input.latestVersion(input.host.homedir)
    const version =
      answer.latestVersion === undefined ? undefined : validSemverVersion(answer.latestVersion)
    if (answer.source === 'none' || version === undefined) return { source: 'none' }
    return { source: answer.source, version }
  } catch {
    return { source: 'none' }
  }
}

function newerLines(project: string, newer: string): string[] {
  const move = versionMove(project, newer)
  if (move === undefined) return []
  return move.breaking ? guideLines(move) : [`agent-qa ${move.to} is out.`, ...move.links]
}

function versionLines(
  input: InitRerunInput,
  copy: ProjectAgentQa | undefined,
  latest: InitDocumentLatest,
): string[] {
  const project =
    copy?.version ?? declaredAgentQaVersion(input.packageJson.text) ?? input.runningVersion
  const running = input.runningVersion
  const differs = project !== running ? [`This agent-qa is ${running}.`] : []
  const onProject = `You're on agent-qa ${project}`
  if (latest.version === undefined) return [`${onProject}.`, ...differs]
  const newer = compareSemverVersions(latest.version, running) === 1 ? latest.version : running
  const order = compareSemverVersions(newer, project)
  if (order === 1) return [`${onProject}.`, ...differs, ...newerLines(project, newer)]
  if (order === undefined) return [`${onProject}.`, ...differs]
  return [`${onProject}, the latest.`, ...differs]
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

// The analytics outcome counts a replaced or removed agent file as an update.
function initFileResult(file: SetupRowFile): InitFileResult {
  const outcome: InitFileOutcome =
    file.outcome === 'created'
      ? 'created'
      : file.outcome === 'updated' || file.outcome === 'replaced' || file.outcome === 'removed'
        ? 'updated'
        : 'preserved'
  return { path: file.path, outcome }
}

export const SETUP_MENU_QUESTION = 'What should init set up here?'
export const CODING_AGENTS_QUESTION = 'Which coding agents should agent-qa set up?'

function inAgentOrder(agents: readonly CodingAgent[]): CodingAgent[] {
  return CODING_AGENTS.filter((agent) => agents.includes(agent))
}

// A re-run starts from the manifest's agents; it never detects agents from markers or the host.
async function chooseAgents(
  ui: InitUi,
  ask: boolean,
  setUp: readonly CodingAgent[],
): Promise<CodingAgent[]> {
  if (!ask) return [...setUp]
  const chosen = await ui.multiselect<CodingAgent>({
    message: CODING_AGENTS_QUESTION,
    options: INIT_AGENT_OPTIONS,
    initialValues: [...setUp],
    required: false,
  })
  return inAgentOrder(chosen)
}

async function chooseRows(
  ui: InitUi,
  ask: boolean,
  shown: readonly SetupRowState[],
  flagged: SetupSelection | undefined,
  noBrowsers: boolean,
): Promise<SetupRowName[]> {
  if (flagged !== undefined) {
    if (flagged.kind === 'none') return []
    return shown
      .map((row) => row.name)
      .filter((name) =>
        flagged.kind === 'all'
          ? !(noBrowsers && name === 'browsers')
          : flagged.names.includes(name),
      )
  }
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

// A row --setup names that is hidden here is skipped with its reason; all never names one.
function namedHidden(row: SetupRowState, flagged: SetupSelection | undefined): string | undefined {
  if (row.hidden === undefined || flagged?.kind !== 'names') return undefined
  return flagged.names.includes(row.name) ? row.hidden : undefined
}

export async function runInitRerun(input: InitRerunInput): Promise<void> {
  const flagged = input.opts.setup === undefined ? undefined : parseSetupFlag(input.opts.setup)
  const noBrowsers = input.opts.browsers === false
  if (noBrowsers && flagged?.kind === 'names' && flagged.names.includes('browsers')) {
    throw new CliRefusal([pc.red(SETUP_BROWSERS_WITH_NO_BROWSERS_LINE)], 2)
  }
  const flaggedAgents =
    input.opts.agents === undefined ? undefined : parseInitAgentsFlag(input.opts.agents)
  // A malformed manifest or managed block is refused here, before anything is drawn or written.
  const manifest = readAgentSetupManifest(input.dir)
  const setUp = manifest?.agents ?? []
  let agents = flaggedAgents === undefined ? [...setUp] : inAgentOrder(flaggedAgents)
  input.recorder.agents(agents)
  const latestAnswer = askLatest(input)
  const copy = await findProjectAgentQa(input.range, input.range.start, input.host.io)
  const checkRows = async (over: readonly CodingAgent[]): Promise<SetupRowState[]> => {
    const checked = await checkSetupRows({
      projectDir: input.dir,
      configPath: input.configPath,
      io: input.host.io,
      agents: over,
      host: input.host,
      chromium: input.chromium,
      scaffoldPlans: input.scaffoldPlans,
      ...(copy === undefined ? {} : { projectAgentQaDir: copy.realDir }),
    })
    return checked.map((row) =>
      noBrowsers && row.name === 'browsers' ? { ...row, prechecked: false } : row,
    )
  }
  let rows = await checkRows(agents)
  const model = await modelLine(input)
  const latest = await latestAnswer
  input.recorder.latest(latest)
  const summary = [
    ...versionLines(input, copy, latest),
    ...(model === undefined ? [] : [model]),
    agentsLine(setUp),
    ...(rows.some((row) => row.shown && row.wouldChange) ? [] : ['Everything is current.']),
  ]
  input.recorder.agentQa({ version: input.runningVersion, via: 'running' })

  const ui = await input.openUi()
  if (input.mode !== 'plain') ui.banner()
  ui.intro()
  ui.summary('This project', summary)
  if (flaggedAgents === undefined) {
    const chosen = await chooseAgents(ui, input.mode === 'interactive', setUp)
    if (chosen.join(',') !== agents.join(',')) {
      agents = chosen
      rows = await checkRows(agents)
    }
  }
  input.recorder.agents(agents)
  const shown = rows.filter((row) => row.shown)
  const selected = await chooseRows(ui, input.mode === 'interactive', shown, flagged, noBrowsers)
  input.recorder.setup(
    rows.map((row) => ({
      name: row.name,
      state: row.state,
      prechecked: row.prechecked,
      selected: selected.includes(row.name),
      ...(row.hidden === undefined ? {} : { hidden: row.hidden }),
    })),
  )

  const planned = rows.filter((row) => row.shown || namedHidden(row, flagged) !== undefined)
  const runner = createInitStepRunner({
    ui,
    plan: rerunPlan(planned.map((row) => row.name)),
    mask: input.mask,
  })
  input.onRunner(runner)
  const outcomes: InitFileResult[] = []
  const agentSetup = sharedAgentSetup({
    projectDir: input.dir,
    agents,
    host: input.host,
    rows: selected,
  })
  for (const row of planned) {
    const hidden = namedHidden(row, flagged)
    if (hidden !== undefined) {
      runner.skip(row.name, `${row.name}: skipped (${hidden})`, hidden)
      continue
    }
    if (noBrowsers && row.name === 'browsers' && !selected.includes(row.name)) {
      runner.skip(row.name, `${row.name}: skipped (--no-browsers)`, '--no-browsers')
      continue
    }
    if (!selected.includes(row.name)) {
      const reason = row.wouldChange ? 'not selected' : 'current'
      runner.skip(row.name, `${row.name}: ${reason}`, reason)
      continue
    }
    const { title, run } = SETUP_ROW_RUNS[row.name]
    await runner.run(row.name, { title }, async (): Promise<InitStepResult> => {
      const { files, ...step } = await run({
        projectDir: input.dir,
        configPath: input.configPath,
        agents,
        host: input.host,
        agentSetup,
        installChromium: input.installChromium,
        scaffoldPlans: input.scaffoldPlans,
      })
      for (const file of files) {
        outcomes.push(initFileResult(file))
        input.recorder.file(row.name, file)
      }
      return step
    })
  }
  await runner.run('validate', input.validateStep, input.validate)

  input.onComplete?.(outcomes)
  await input.emitInitCompleted('rerun', outcomes)
  if (runner.interrupted()) throw new PromptCancelled()

  ui.outro(input.outro)
  if (runner.failed()) throw new CliRefusal([], 3)
}
