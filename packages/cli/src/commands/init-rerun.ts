import { dirname, relative } from 'node:path'

import {
  compareSemverVersions,
  getAuthPath,
  listSavedCredentials,
  validSemverVersion,
} from '@vostride/agent-qa-core'
import pc from 'picocolors'
import { parse } from 'yaml'

import { CliRefusal, PromptCancelled } from '../composition/cli-refusal.js'
import type { InitUi, InitUiMode } from '../init-ui/init-ui.js'
import { activeModelEntry } from '../llm-utils.js'
import { CODING_AGENTS, readAgentSetupManifest, type CodingAgent } from './agent-setup-manifest.js'
import { guideLines, versionMove, type VersionMove } from './agent-qa-upgrade.js'
import { configWithModelEntry } from './config-model-edit.js'
import type { ChromiumResolver } from './browser-resolver.js'
import { dashboardPage, dashboardPortOf, type InitDashboardStep } from './init-dashboard.js'
import { INIT_AGENT_OPTIONS, parseInitAgentsFlag } from './init-agents.js'
import type { InitDocumentLatest, InitDocumentRecorder } from './init-document.js'
import {
  readHostFile,
  writeHostFile,
  writeScaffoldFileAtomic,
  type HostFileRead,
  type InitFileOutcome,
  type InitFileResult,
} from './init-filesystem.js'
import {
  isSubscriptionModel,
  modelEntryFor,
  modelStatus,
  resolveLlmFlag,
  type InitModelEntry,
  type InitModelSetup,
  type InitModelStatus,
} from './init-model-choice.js'
import { INIT_COMMAND, initNextSteps, nextStepLines } from './init-next-steps.js'
import type { LatestVersionAsk } from './latest-version-ask.js'
import {
  createInitStepRunner,
  rerunPlan,
  type InitStepResult,
  type InitStepRunner,
} from './init-steps.js'
import type { PackageJsonPlan } from './package-json-plan.js'
import {
  HANDED_OFF_ENV,
  UPGRADED_FROM_ENV,
  declaredAgentQaVersion,
  findProjectAgentQa,
  runAsProjectAgentQa,
  type ProjectAgentQa,
} from './project-agent-qa.js'
import type { ProjectHost } from './project-host.js'
import { nearestInstalledPackage, type ProjectRange } from './project-range.js'
import { SUBSCRIPTION_AUTH_PACKAGE } from './scaffold-content.js'
import {
  BREAKING_NOT_IN_ALL,
  SETUP_ROW_NAMES,
  SETUP_ROW_RUNS,
  checkDepsRow,
  checkSetupRows,
  checkUpgradeRow,
  parseSetupFlag,
  projectPlatform,
  sharedAgentSetup,
  setupRowLabel,
  type DepsRowState,
  type ProjectPackages,
  type SetupRowFile,
  type ScaffoldPlans,
  type SetupRowName,
  type SetupRowState,
  type SetupSelection,
  type UpgradeRowState,
} from './setup-rows.js'

export interface InitRerunOptions {
  platform?: string
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
  upgrade: {
    // The packages the config text needs besides agent-qa; without one, the config file's.
    packages: (configText?: string) => ProjectPackages
    // package.json with agent-qa and every first-party package at the version.
    plan: (version: string) => PackageJsonPlan
    // The fresh init's install over that plan.
    install: (plan: PackageJsonPlan) => Promise<InitStepResult>
  }
  // Called once the newly installed copy has run: its document and exit code stand for this run.
  onHandOff: () => void
  // The fresh init's own dashboard step.
  dashboard: InitDashboardStep
}

const SETUP_BROWSERS_WITH_NO_BROWSERS_LINE =
  '--setup browsers asks for Chromium and --no-browsers refuses it; drop one of them.'
const PLATFORM_ON_RERUN_LINE =
  "--platform sets up a new project; this one's platforms are its config's targets. " +
  'Run npx agent-qa init without --platform, or with --force to rebuild.'
const MODEL_FLAGS_WITHOUT_LLM_LINE =
  '--model and --base-url set the model --llm names; pass --llm <choice> with them.'
const MODEL_TITLE = 'Setting the model'
const DASHBOARD_FINISHES = 'the dashboard finishes setting it up'
const MODEL_READY = 'model ready'
const CONFIG_UNREAD = 'the config does not parse'

function setupCommand(row: SetupRowName): string {
  return `${INIT_COMMAND} --setup ${row}`
}

// The model the flags set, resolved and edited in memory before anything is drawn.
interface ModelEdit {
  setup: InitModelSetup
  given: string
  read?: HostFileRead
  text?: string
}

async function modelEditOf(input: InitRerunInput): Promise<ModelEdit | undefined> {
  const { llm, model, baseUrl } = input.opts
  if (llm === undefined) {
    if (model !== undefined || baseUrl !== undefined) {
      throw new CliRefusal([pc.red(MODEL_FLAGS_WITHOUT_LLM_LINE)], 2)
    }
    return undefined
  }
  const saved = await listSavedCredentials(
    getAuthPath({ env: input.host.env, homeDir: input.host.homedir }),
  )
  const setup = modelEntryFor(resolveLlmFlag(llm, saved), { model, baseUrl, saved })
  const given = relative(input.dir, input.configPath) || input.configPath
  if (setup.entry === undefined) return { setup, given }
  const read = readHostFile(input.configPath, input.dir)
  const text = configWithModelEntry(read?.text ?? '', given, setup.entry, {
    subscription: isSubscriptionModel(setup.entry.provider),
  })
  return { setup, given, ...(read === undefined ? {} : { read }), text }
}

function modelChanges(edit: ModelEdit | undefined): boolean {
  return edit?.text !== undefined && edit.text !== edit.read?.text
}

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

function projectVersionOf(input: InitRerunInput, copy: ProjectAgentQa | undefined): string {
  return copy?.version ?? declaredAgentQaVersion(input.packageJson.text) ?? input.runningVersion
}

function versionLines(
  input: InitRerunInput,
  copy: ProjectAgentQa | undefined,
  latest: InitDocumentLatest,
  depsMove: VersionMove | undefined,
): string[] {
  const project = projectVersionOf(input, copy)
  const running = input.runningVersion
  const differs =
    project !== running
      ? [`The rows run as agent-qa ${running}, not the project's ${project}.`]
      : []
  const onProject = `You're on agent-qa ${project}`
  // With an answer, the newer-version lines below already carry the deps row's guide.
  if (latest.version === undefined) {
    return [`${onProject}.`, ...differs, ...(depsMove === undefined ? [] : guideLines(depsMove))]
  }
  const newer = compareSemverVersions(latest.version, running) === 1 ? latest.version : running
  const order = compareSemverVersions(newer, project)
  if (order === 1) return [`${onProject}.`, ...differs, ...newerLines(project, newer)]
  if (order === undefined) return [`${onProject}.`, ...differs]
  return [`${onProject}, the latest.`, ...differs]
}

// A non-registry spec stays as written, so only a pinned or added entry moves.
function movedPlugins(input: InitRerunInput, version: string): number {
  try {
    return input.upgrade
      .plan(version)
      .entries.filter(
        (entry) =>
          entry.name !== 'agent-qa' && (entry.outcome === 'pinned' || entry.outcome === 'added'),
      ).length
  } catch {
    return 0
  }
}

function upgradeRow(
  input: InitRerunInput,
  copy: ProjectAgentQa | undefined,
  latest: InitDocumentLatest,
): UpgradeRowState {
  const { version } = latest
  // package.json is planned only for a row that shows.
  const shows = version !== undefined && versionMove(input.runningVersion, version) !== undefined
  return checkUpgradeRow({
    projectVersion: projectVersionOf(input, copy),
    runningVersion: input.runningVersion,
    latest: version,
    plugins: shows ? movedPlugins(input, version) : 0,
  })
}

// With an upgrade row, deps adds the missing packages at the project's version; without one, it
// also moves a project behind this agent-qa to it. It reads the config as the model step leaves it.
function depsRow(
  input: InitRerunInput,
  copy: ProjectAgentQa | undefined,
  upgrade: UpgradeRowState,
  configText: string | undefined,
): DepsRowState {
  const from = projectVersionOf(input, copy)
  const behind = !upgrade.shown && versionMove(from, input.runningVersion) !== undefined
  return checkDepsRow({
    range: input.range,
    packageJson: input.packageJson,
    config: input.upgrade.packages(configText),
    version: behind ? input.runningVersion : from,
    from,
    io: input.host.io,
  })
}

const AGENT_ROWS: readonly SetupRowName[] = ['skills', 'mcp', 'agents-md']

// Only public flags reach the new copy, which may be another build than this one.
function handOffArgs(
  opts: InitRerunOptions,
  selected: readonly SetupRowName[],
  agents: readonly CodingAgent[],
): string[] {
  // The upgrade declares and installs every package, so the deps row has nothing left to do.
  const rows = SETUP_ROW_NAMES.filter(
    (name) =>
      name !== 'upgrade' &&
      name !== 'deps' &&
      (selected.includes(name) || (agents.length > 0 && AGENT_ROWS.includes(name))),
  )
  return [
    'init',
    '--setup',
    rows.length === 0 ? 'none' : rows.join(','),
    '--agents',
    agents.length === 0 ? 'none' : agents.join(','),
    ...(opts.json === true ? ['--json'] : []),
    ...(opts.yes === true ? ['--yes'] : []),
    ...(opts.pm === undefined ? [] : ['--pm', opts.pm]),
    ...(opts.dashboard === false ? ['--no-dashboard'] : []),
    ...(opts.browsers === false ? ['--no-browsers'] : []),
  ]
}

const UPGRADE_TITLE = 'Upgrading agent-qa'
const DEPS_TITLE = "Installing agent-qa's missing packages"
const INSTALL_FIRST = 'install first (--pm none)'

// The upgrade that handed this run over; it changes what is reported, never what runs.
function handedUpgrade(input: InitRerunInput): VersionMove | undefined {
  if (input.host.env[HANDED_OFF_ENV] !== '1') return undefined
  const from = input.host.env[UPGRADED_FROM_ENV]
  return from === undefined ? undefined : versionMove(from, input.runningVersion)
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
function readConfig(input: InitRerunInput): { config: JsonObject | undefined } | undefined {
  try {
    const raw: unknown = parse(input.host.io.readText(input.configPath) ?? '', {
      logLevel: 'error',
    })
    return { config: asObject(raw) }
  } catch {
    return undefined
  }
}

function configuredModels(
  input: InitRerunInput,
): { registry: { llms: InitModelEntry[] }; use: { llm?: string } } | undefined {
  const read = readConfig(input)
  if (read === undefined) return undefined
  const { config } = read
  const llms = asObject(config?.registry)?.llms
  const use = asObject(config?.use)?.llm
  return {
    registry: { llms: Array.isArray(llms) ? llms.flatMap(modelEntryOf) : [] },
    use: typeof use === 'string' ? { llm: use } : {},
  }
}

interface RecordedModel {
  setup: InitModelSetup
  status: InitModelStatus
  pluginInstalled: boolean
}

async function recordModel(input: InitRerunInput, setup: InitModelSetup): Promise<RecordedModel> {
  const pluginInstalled =
    nearestInstalledPackage(
      input.range,
      dirname(input.packageJson.path),
      SUBSCRIPTION_AUTH_PACKAGE,
      input.host.io,
    ) !== undefined
  const status = await modelStatus({
    ...setup,
    configPath: input.configPath,
    projectDir: input.dir,
    authPath: getAuthPath({ env: input.host.env, homeDir: input.host.homedir }),
    pluginInstalled,
  })
  const { entry } = setup
  input.recorder.model({
    ...(entry === undefined ? {} : { name: entry.name, provider: entry.provider }),
    ...status,
  })
  return { setup, status, pluginInstalled }
}

// The config's model before the run; undefined when the config does not parse.
async function configuredModel(input: InitRerunInput): Promise<RecordedModel | undefined> {
  const models = configuredModels(input)
  if (models === undefined) return undefined
  const entry = activeModelEntry(models)
  return await recordModel(input, entry === undefined ? {} : { entry })
}

function modelLine(model: RecordedModel | undefined): string | undefined {
  if (model === undefined) return undefined
  const { entry } = model.setup
  if (entry === undefined) return 'No model is set up.'
  return model.status.status === 'ready'
    ? `Model ${entry.name} is ready.`
    : `Model ${entry.name} is pending: ${model.status.reason}.`
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

function isBreaking(rows: readonly SetupRowState[], name: SetupRowName): boolean {
  return rows.some((row) => row.name === name && row.breaking === true)
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
          ? !(noBrowsers && name === 'browsers') && !isBreaking(shown, name)
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
  // A re-run's document carries both keys on every exit, a refusal's included.
  input.recorder.setup([])
  input.recorder.latest({ source: 'none' })
  if (input.opts.platform !== undefined) {
    throw new CliRefusal([pc.red(PLATFORM_ON_RERUN_LINE)], 2)
  }
  const flagged = input.opts.setup === undefined ? undefined : parseSetupFlag(input.opts.setup)
  const noBrowsers = input.opts.browsers === false
  if (noBrowsers && flagged?.kind === 'names' && flagged.names.includes('browsers')) {
    throw new CliRefusal([pc.red(SETUP_BROWSERS_WITH_NO_BROWSERS_LINE)], 2)
  }
  const modelEdit = await modelEditOf(input)
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
  const before = await configuredModel(input)
  const model = modelLine(before)
  const latest = await latestAnswer
  input.recorder.latest(latest)
  const upgrade = upgradeRow(input, copy, latest)
  const deps = depsRow(input, copy, upgrade, modelEdit?.text)
  const handed = handedUpgrade(input)
  const reported = handed ?? (upgrade.shown ? upgrade.move : undefined)
  if (reported !== undefined) input.recorder.upgrade({ ...reported, row: 'upgrade' })
  else if (deps.move !== undefined) input.recorder.upgrade({ ...deps.move, row: 'deps' })
  const knownMove = reported ?? deps.move
  rows = [upgrade, deps, ...rows]
  const summary = [
    ...(handed === undefined ? [] : [`Upgraded agent-qa ${handed.from} → ${handed.to}.`]),
    ...versionLines(input, copy, latest, deps.move),
    ...(model === undefined ? [] : [model]),
    agentsLine(setUp),
    ...(modelChanges(modelEdit) || rows.some((row) => row.shown && row.wouldChange)
      ? []
      : ['Everything is current.']),
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
      rows = [upgrade, deps, ...(await checkRows(agents))]
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

  const planned = rows.filter(
    (row) =>
      row.shown ||
      namedHidden(row, flagged) !== undefined ||
      (row.name === 'upgrade' && handed !== undefined),
  )
  const runner = createInitStepRunner({
    ui,
    plan: rerunPlan(
      planned.map((row) => row.name),
      { model: modelEdit !== undefined },
    ),
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
  let installFirst = false
  let modelSetup = before?.setup
  if (modelEdit !== undefined) {
    const { setup, given } = modelEdit
    const step = await runner.run(
      'model',
      { title: MODEL_TITLE },
      async (): Promise<InitStepResult> => {
        const { entry } = setup
        if (entry === undefined || modelEdit.text === undefined) {
          const text = `model: skipped (${DASHBOARD_FINISHES})`
          return { outcome: 'skipped', text, reason: DASHBOARD_FINISHES }
        }
        if (modelChanges(modelEdit)) {
          writeHostFile({
            path: input.configPath,
            root: input.dir,
            content: modelEdit.text,
            read: modelEdit.read,
            rerun: 'rerun npx agent-qa init',
          })
          const file = { path: given, outcome: 'updated' as const }
          outcomes.push(file)
          input.recorder.file('model', file)
        }
        return { outcome: 'done', text: `Model ${entry.name}: ${entry.provider} ${entry.model}` }
      },
    )
    if (step.outcome !== 'failed') modelSetup = setup
  }
  for (const row of planned) {
    if (row.name === 'upgrade' && handed !== undefined) {
      const text = `upgrade: agent-qa ${handed.from} → ${handed.to}`
      await runner.run('upgrade', { title: UPGRADE_TITLE }, async () => ({ outcome: 'done', text }))
      continue
    }
    const hidden = namedHidden(row, flagged)
    if (hidden !== undefined) {
      runner.skip(row.name, `${row.name}: skipped (${hidden})`, hidden)
      continue
    }
    // A row left out that would change something gives the command that runs it.
    const left = row.wouldChange ? setupCommand(row.name) : undefined
    if (noBrowsers && row.name === 'browsers' && !selected.includes(row.name)) {
      runner.skip(row.name, `${row.name}: skipped (--no-browsers)`, '--no-browsers', left)
      continue
    }
    if (flagged?.kind === 'all' && row.breaking === true) {
      const text = `${row.name}: skipped (${BREAKING_NOT_IN_ALL})`
      runner.skip(row.name, text, BREAKING_NOT_IN_ALL, left)
      continue
    }
    if (!selected.includes(row.name)) {
      const reason = row.wouldChange ? 'not selected' : 'current'
      runner.skip(row.name, `${row.name}: ${reason}`, reason, left)
      continue
    }
    if (row.name === 'upgrade') {
      const move = upgrade.move
      if (move === undefined) continue
      let newCopy: ProjectAgentQa | undefined
      await runner.run('upgrade', { title: UPGRADE_TITLE }, async (): Promise<InitStepResult> => {
        const plan = input.upgrade.plan(move.to)
        const file = writeScaffoldFileAtomic({
          root: plan.root,
          path: plan.path,
          content: plan.content,
          force: plan.existed && plan.changed,
        })
        outcomes.push(initFileResult(file))
        input.recorder.file('upgrade', file)
        const installed = await input.upgrade.install(plan)
        if (installed.outcome === 'failed') return installed
        if (installed.outcome === 'skipped' && installed.reason === '--pm none') {
          installFirst = true
          return { ...installed, text: `upgrade: ${installed.text}` }
        }
        const found = await findProjectAgentQa(input.range, input.range.start, input.host.io)
        if (found?.version !== move.to) {
          return {
            outcome: 'failed',
            reason:
              found === undefined
                ? `agent-qa ${move.to} was installed, but no copy of it was found`
                : `agent-qa ${move.to} was installed, but the project's copy is ${found.version}`,
            command: 'npx agent-qa init --setup upgrade',
          }
        }
        newCopy = found
        return { outcome: 'done', text: `upgrade: agent-qa ${move.from} → ${move.to}` }
      })
      if (newCopy === undefined) continue
      // The new copy runs every row after this one, so this run stops here.
      await runAsProjectAgentQa(
        newCopy,
        input.host,
        `Handing over to agent-qa ${move.to}, just installed, for the rest of this run.`,
        (text) => ui.line(text),
        input.onHandOff,
        {
          args: handOffArgs(input.opts, selected, agents),
          env: { [UPGRADED_FROM_ENV]: move.from },
        },
      )
      return
    }
    if (row.name === 'deps') {
      await runner.run('deps', { title: DEPS_TITLE }, async (): Promise<InitStepResult> => {
        const { plan } = deps
        if (!deps.wouldChange) return { outcome: 'done', text: 'deps: nothing missing' }
        if (plan.changed) {
          const file = writeScaffoldFileAtomic({
            root: plan.root,
            path: plan.path,
            content: plan.content,
            force: plan.existed,
          })
          outcomes.push(initFileResult(file))
          input.recorder.file('deps', file)
        }
        const installed = await input.upgrade.install(plan)
        if (installed.outcome === 'failed') return installed
        if (installed.outcome === 'skipped' && installed.reason === '--pm none') {
          if (plan.changed) installFirst = true
          return { ...installed, text: `deps: ${installed.text}` }
        }
        return { outcome: 'done', text: `deps: ${installed.text}` }
      })
      continue
    }
    const { title, run } = SETUP_ROW_RUNS[row.name]
    const command = setupCommand(row.name)
    await runner.run(row.name, { title, command }, async (): Promise<InitStepResult> => {
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
      return step.outcome === 'failed' && step.command === undefined ? { ...step, command } : step
    })
  }
  // package.json names packages that are not installed, so validate would check without them.
  if (installFirst) {
    runner.skip('validate', `validate: ${INSTALL_FIRST}`, INSTALL_FIRST, input.validateStep.command)
  } else {
    await runner.run('validate', input.validateStep, input.validate)
  }

  input.onComplete?.(outcomes)
  await input.emitInitCompleted('rerun', outcomes)
  if (runner.interrupted()) throw new PromptCancelled()

  // The model as the rows leave it: the deps row may have installed its plugin.
  const after = modelSetup === undefined ? undefined : await recordModel(input, modelSetup)
  const pending = after?.status.status === 'pending'
  const port = dashboardPortOf(readConfig(input)?.config ?? {})
  const dashboard = await input.dashboard.decide(runner, {
    port,
    ...(pending ? {} : { skip: after === undefined ? CONFIG_UNREAD : MODEL_READY }),
  })
  const records = runner.records()
  const agentRowFailed = records.some(
    (record) => AGENT_ROWS.includes(record.name as SetupRowName) && record.outcome === 'failed',
  )
  const entry = after?.setup.entry
  const platform = projectPlatform(input.configPath, input.host.io)
  const next = initNextSteps({
    steps: records,
    ...(after === undefined || entry === undefined
      ? {}
      : {
          model: {
            name: entry.name,
            provider: entry.provider,
            status: after.status.status,
            subscription: isSubscriptionModel(entry.provider),
            pluginInstalled: after.pluginInstalled,
          },
        }),
    web: platform.capabilities.includes('web'),
    mobile: platform.mobileRuntimes.length > 0,
    agents: agentRowFailed ? [] : agents,
    dashboard,
    ...(knownMove === undefined ? {} : { upgrade: knownMove }),
  })
  input.recorder.nextSteps(next.steps)
  ui.note('Next steps', nextStepLines(next.steps))
  for (const hint of next.hints) ui.line(hint)
  if (runner.interrupted()) throw new PromptCancelled()
  if (dashboard === 'starting') {
    await input.dashboard.start(runner, ui, {
      port,
      page: dashboardPage({ model: 'pending', dashboard: after?.setup.dashboard }),
    })
  }

  ui.outro(input.outro)
  if (runner.failed()) throw new CliRefusal([], 3)
}
