import { readFileSync } from 'node:fs'
import { basename, dirname, join, relative, sep } from 'node:path'

import { resolveWorkspacePaths, type AgentQaConfig } from '@vostride/agent-qa-core'
import pc from 'picocolors'
import { parse } from 'yaml'

import { CliRefusal } from '../composition/cli-refusal.js'
import { resolveRawConfigKnowledgeRoot } from '../config.js'
import {
  AGENT_MCP_FILES,
  AGENT_SETUP_PARTS,
  AGENT_SKILL_ROOTS,
  AGENTS_MD_FILE,
  CODING_AGENTS,
  installAgentSetup,
  type AgentSetupFileOutcome,
  type AgentSetupFileResult,
  type AgentSetupPart,
  type AgentSetupResult,
  type CodingAgent,
} from './agent-setup.js'
import { readAgentSetupManifest } from './agent-setup-manifest.js'
import { versionMove, type VersionMove } from './agent-qa-upgrade.js'
import type { ChromiumResolver } from './browser-resolver.js'
import { INIT_AGENT_OPTIONS } from './init-agents.js'
import { isSubscriptionModel } from './init-model-choice.js'
import {
  KNOWLEDGE_GITIGNORE_PROBES,
  TARGET_GITIGNORE_PROBES,
  classifyInitPath,
  upsertManagedGitignoreBlock,
  verifyEffectiveGitignore,
  writeScaffoldFileAtomic,
  type InitFileOutcome,
  type InitPathPlan,
} from './init-filesystem.js'
import { InitRefusal } from './init-refusal.js'
import type { InitStepResult } from './init-steps.js'
import { buildKnowledgeAgentGuide } from './knowledge-guide.js'
import { composeManagedBlock, locateManagedBlock } from './managed-block.js'
import { installedPackageVersion } from './package-install.js'
import {
  isNonRegistrySpec,
  planPackageJson,
  projectDependencies,
  type PackageJsonPlan,
} from './package-json-plan.js'
import { projectHost, type ProjectHost, type ProjectIo } from './project-host.js'
import type { ProjectRange } from './project-range.js'
import {
  SUBSCRIPTION_AUTH_PACKAGE,
  buildGitignoreEntries,
  managedGitignoreContent,
  type InitPlatformInput,
  type InitPlatformSelection,
} from './scaffold-content.js'
import { getTargetPlatforms, hasWebTarget, resolveWebPlacement } from './web-placement.js'

// Every row this build has, in menu order.
export const SETUP_ROW_NAMES = [
  'upgrade',
  'deps',
  'skills',
  'mcp',
  'agents-md',
  'browsers',
  'gitignore',
  'scaffold',
] as const
export type SetupRowName = (typeof SETUP_ROW_NAMES)[number]
// The rows checked and run by their own code; the version rows install through init's own install.
export type CheckedRowName = Exclude<SetupRowName, 'upgrade' | 'deps'>
const CHECKED_ROW_NAMES = SETUP_ROW_NAMES.filter(
  (name): name is CheckedRowName => name !== 'upgrade' && name !== 'deps',
)

export type SetupSelection =
  { kind: 'all' } | { kind: 'none' } | { kind: 'names'; names: SetupRowName[] }

const SETUP_NAMES_HINT = `Use ${[...SETUP_ROW_NAMES, 'all'].join(', ')} or none.`

function isSetupRowName(name: string): name is SetupRowName {
  return (SETUP_ROW_NAMES as readonly string[]).includes(name)
}

export function parseSetupFlag(value: string): SetupSelection {
  const names = value.split(',').map((name) => name.trim())
  for (const name of names) {
    if (name !== 'all' && name !== 'none' && !isSetupRowName(name)) {
      throw new CliRefusal([pc.red(`Unknown setup row "${name}". ${SETUP_NAMES_HINT}`)], 2)
    }
  }
  for (const word of ['all', 'none'] as const) {
    if (!names.includes(word)) continue
    if (names.length > 1) {
      throw new CliRefusal(
        [pc.red(`--setup ${word} cannot be combined with other rows. ${SETUP_NAMES_HINT}`)],
        2,
      )
    }
    return { kind: word }
  }
  return { kind: 'names', names: [...new Set(names.filter(isSetupRowName))] }
}

export interface SetupRowState {
  name: SetupRowName
  shown: boolean
  // Why a row that cannot apply here is left out of the menu.
  hidden?: string
  state: string
  wouldChange: boolean
  prechecked: boolean
  // Its version move can break the config, so only naming it in --setup runs it.
  breaking?: true
}

export interface SetupRowCheckInput {
  projectDir: string
  configPath: string
  io: ProjectIo
  agents: readonly CodingAgent[]
  host: Partial<ProjectHost>
  chromium: ChromiumResolver
  // The real folder of the project's installed agent-qa, whose Playwright runs the web tests.
  projectAgentQaDir?: string
  scaffoldPlans: ScaffoldPlans
}

// The fresh init's scaffold for a platform, every file at its default path, overwriting none.
export type ScaffoldPlans = (platform: InitPlatformInput) => InitPathPlan[]

export const NOTHING_NEWER = 'nothing newer is published'
export const NO_VERSION_ANSWER = 'the version check did not answer'
export const BREAKING_NOT_IN_ALL = 'breaking: name it in --setup'
export const NOT_FROM_REGISTRY = 'agent-qa is not installed from the registry'

// A non-registry spec, such as file: or workspace:, is never compared with a published version.
export function isFromRegistry(agentQaSpec: string | undefined): boolean {
  return agentQaSpec === undefined || !isNonRegistrySpec(agentQaSpec)
}

export type UpgradeRowState = SetupRowState & { move?: VersionMove }

function movedPackages(plugins: number): string {
  if (plugins === 0) return 'agent-qa'
  return plugins === 1 ? 'agent-qa and the plugin' : `agent-qa and ${plugins} plugins`
}

// Shown only when the latest is newer than the running agent-qa; the move starts at the project's.
export function checkUpgradeRow(input: {
  projectVersion: string
  runningVersion: string
  latest: string | undefined
  // The first-party packages besides agent-qa that the bump moves.
  plugins: number
  // agent-qa's spec as package.json declares it.
  agentQaSpec?: string
}): UpgradeRowState {
  const hidden = (reason: string): UpgradeRowState => ({
    name: 'upgrade',
    shown: false,
    hidden: reason,
    state: reason,
    wouldChange: false,
    prechecked: false,
  })
  if (!isFromRegistry(input.agentQaSpec)) return hidden(NOT_FROM_REGISTRY)
  if (input.latest === undefined) return hidden(NO_VERSION_ANSWER)
  if (versionMove(input.runningVersion, input.latest) === undefined) return hidden(NOTHING_NEWER)
  const move = versionMove(input.projectVersion, input.latest)
  if (move === undefined) return hidden(NOTHING_NEWER)
  return {
    name: 'upgrade',
    shown: true,
    state: `${movedPackages(input.plugins)} ${move.from} → ${move.to}`,
    wouldChange: true,
    prechecked: !move.breaking,
    ...(move.breaking ? { breaking: true as const } : {}),
    move,
  }
}

// The packages the config makes the project need besides agent-qa.
export interface ProjectPackages {
  usesSubscription: boolean
  plugins: readonly { package?: unknown }[]
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

// Read from the config as written; one that does not parse names agent-qa alone.
export function configuredPackages(text: string | undefined): ProjectPackages {
  let config: Record<string, unknown> | undefined
  try {
    config = asObject(parse(text ?? '', { logLevel: 'error' }))
  } catch {
    config = undefined
  }
  const llms = asObject(config?.registry)?.llms
  const plugins = config?.plugins
  return {
    usesSubscription:
      Array.isArray(llms) &&
      llms.some((llm) => isSubscriptionModel(String(asObject(llm)?.provider))),
    plugins: Array.isArray(plugins)
      ? plugins.flatMap((plugin: unknown): Record<string, unknown>[] => {
          const entry = asObject(plugin)
          return entry === undefined ? [] : [entry]
        })
      : [],
  }
}

export interface DepsPackage {
  name: string
  declared: boolean
  // The version node_modules holds, when one is installed.
  installed?: string
}

export type DepsRowState = SetupRowState & {
  plan: PackageJsonPlan
  packages: DepsPackage[]
  move?: VersionMove
}

export function packageLabel(name: string): string {
  if (name === SUBSCRIPTION_AUTH_PACKAGE) return 'subscription plugin'
  const plugin = /^@vostride\/agent-qa-plugin-(.+)$/u.exec(name)?.[1]
  return plugin === undefined ? name : `${plugin} plugin`
}

// A package is missing when it is not declared, or declared and not installed at its version. A
// non-registry spec and a newer pin are never compared. Planned at a version newer than the
// project's, the row also moves agent-qa there.
export function checkDepsRow(input: {
  range: ProjectRange
  packageJson: { path: string; text: string | undefined }
  config: ProjectPackages
  version: string
  // The project's own version, which the move starts from.
  from?: string
  io: ProjectIo
}): DepsRowState {
  const plan = planPackageJson({
    ...input.packageJson,
    folderName: basename(input.range.start),
    dependencies: projectDependencies({ version: input.version, ...input.config }),
  })
  const fromDir = dirname(plan.path)
  const installed = new Map(
    plan.entries.map((entry) => [
      entry.name,
      installedPackageVersion(input.range, fromDir, entry.name, input.io) ?? undefined,
    ]),
  )
  const packages = plan.entries.map((entry): DepsPackage => {
    const version = installed.get(entry.name)
    return {
      name: entry.name,
      declared: entry.outcome !== 'added',
      ...(version === undefined ? {} : { installed: version }),
    }
  })
  const agentQa = plan.entries.find((entry) => entry.name === 'agent-qa')
  const move =
    agentQa?.outcome === 'pinned' && input.from !== undefined
      ? versionMove(input.from, input.version)
      : undefined
  const undeclared = plan.entries.filter((entry) => entry.outcome === 'added')
  // A pin the move rewrites is the move itself, not a missing package.
  const uninstalled = plan.entries.filter(
    (entry) =>
      (entry.outcome === 'unchanged' || (entry.outcome === 'pinned' && move === undefined)) &&
      installed.get(entry.name) !== entry.version,
  )
  const missing = [...undeclared, ...uninstalled]
  const oneMissing = undeclared.length === 1 ? 'missing' : 'not installed'
  const wouldChange = plan.changed || uninstalled.length > 0
  const missingState =
    missing.length > 1
      ? `${missing.length} packages missing`
      : missing.length === 1
        ? `${packageLabel(missing[0]!.name)} ${oneMissing}`
        : undefined
  const moveState =
    move === undefined
      ? undefined
      : `agent-qa ${move.from} → ${move.to}${move.breaking ? ' can change your config' : ''}`
  const parts = [missingState, moveState].filter((part) => part !== undefined)
  const state =
    parts.length > 0 ? parts.join('; ') : wouldChange ? 'package.json to update' : 'nothing missing'
  const breaking = move?.breaking === true
  return {
    name: 'deps',
    shown: true,
    state,
    wouldChange,
    prechecked: wouldChange && !breaking,
    ...(breaking ? { breaking: true as const } : {}),
    plan,
    packages,
    ...(move === undefined ? {} : { move }),
  }
}

export function checkGitignoreRow({
  projectDir,
  io,
}: Pick<SetupRowCheckInput, 'projectDir' | 'io'>): SetupRowState {
  const existing = io.readText(join(projectDir, '.gitignore'))
  // A malformed block is refused naming the file a person sees.
  const content = { ...managedGitignoreContent(buildGitignoreEntries()), target: '.gitignore' }
  const text = existing ?? ''
  const wouldChange = composeManagedBlock(text, content) !== text
  const state =
    existing === undefined
      ? 'no .gitignore'
      : !wouldChange
        ? 'current'
        : locateManagedBlock(text, content) === undefined
          ? 'block missing'
          : 'the block was edited'
  return { name: 'gitignore', shown: true, state, wouldChange, prechecked: wouldChange }
}

const NO_AGENT = 'no coding agent chosen'

// `unchanged` and `kept` leave the file as it is.
function isChange(outcome: AgentSetupFileOutcome): boolean {
  return outcome !== 'unchanged' && outcome !== 'kept'
}

export interface AgentPartCheck {
  files: AgentSetupFileResult[]
  wouldChange: boolean
}

export type AgentRowCheck = SetupRowState & { files: AgentSetupFileResult[] }

export type KnowledgeGuideState = 'missing' | 'differs' | 'current'

export interface AgentRowsCheck {
  // The version the installer would write; absent with no coding agent chosen.
  version?: string
  skills: AgentRowCheck
  mcp: AgentRowCheck
  'agents-md': AgentRowCheck
  guide: { path: string; state: KnowledgeGuideState }
  perAgent: Partial<Record<CodingAgent, { skills: AgentPartCheck; mcp: AgentPartCheck }>>
}

function partCheck(files: AgentSetupFileResult[]): AgentPartCheck {
  return { files, wouldChange: files.some((file) => isChange(file.outcome)) }
}

function isSkillFileOf(path: string, agent: CodingAgent): boolean {
  return path.startsWith(`${AGENT_SKILL_ROOTS[agent]}/`)
}

function isSkillFile(path: string): boolean {
  return CODING_AGENTS.some((agent) => isSkillFileOf(path, agent))
}

function isMcpFileOf(path: string, agents: readonly CodingAgent[]): boolean {
  return agents.some((agent) => path === AGENT_MCP_FILES[agent])
}

export function agentLabel(agent: CodingAgent): string {
  return INIT_AGENT_OPTIONS.find((option) => option.value === agent)?.label ?? agent
}

function fileCount(count: number): string {
  return `${count} ${count === 1 ? 'file' : 'files'}`
}

function chosenAgents(agents: readonly CodingAgent[]): CodingAgent[] {
  return CODING_AGENTS.filter((agent) => agents.includes(agent))
}

// Short enough for a narrow terminal; the files themselves are in --json.
export function skillsState(
  agents: readonly CodingAgent[],
  perAgent: AgentRowsCheck['perAgent'],
  version: string,
): string {
  const notSetUp = agents.filter((agent) => {
    const skillFiles = perAgent[agent]?.skills.files ?? []
    return skillFiles.length > 0 && skillFiles.every((file) => file.outcome === 'created')
  })
  if (notSetUp.length > 0) return `${notSetUp.map(agentLabel).join(' and ')} not set up`
  const all = agents.flatMap((agent) => perAgent[agent]?.skills.files ?? [])
  const count = (outcomes: readonly AgentSetupFileOutcome[]): number =>
    all.filter((file) => outcomes.includes(file.outcome)).length
  const replaced = count(['replaced'])
  if (replaced > 0) {
    const differ = replaced === 1 ? 'differs' : 'differ'
    return `${fileCount(replaced)} ${differ} from agent-qa ${version}'s copy`
  }
  const missing = count(['created'])
  if (missing > 0) return `${fileCount(missing)} missing`
  const updated = count(['updated', 'removed'])
  if (updated > 0) return `${fileCount(updated)} to update`
  return `current (${version})`
}

function mcpState(agents: readonly CodingAgent[], perAgent: AgentRowsCheck['perAgent']): string {
  const states = agents.flatMap((agent) => {
    const outcome = perAgent[agent]?.mcp.files[0]?.outcome
    if (outcome === 'created') return [`${agentLabel(agent)} entry missing`]
    if (outcome !== undefined && isChange(outcome)) return [`${agentLabel(agent)} entry differs`]
    return []
  })
  return states.length === 0 ? 'current' : states.join(', ')
}

function agentsMdState(
  block: AgentSetupFileResult | undefined,
  newAgents: readonly CodingAgent[],
  guide: KnowledgeGuideState,
): string {
  if (block?.outcome === 'created') return 'block missing'
  if (block?.outcome === 'replaced') return 'the block was edited'
  if (block?.outcome === 'updated') return 'block to update'
  if (newAgents.length > 0) return `${newAgents.map(agentLabel).join(' and ')} not set up`
  if (guide === 'missing') return 'knowledge guide missing'
  if (guide === 'differs') return 'knowledge guide differs'
  return 'current'
}

function hiddenRow(name: SetupRowName, reason: string): AgentRowCheck {
  return {
    name,
    shown: false,
    hidden: reason,
    state: reason,
    wouldChange: false,
    prechecked: false,
    files: [],
  }
}

function shownRow(
  name: SetupRowName,
  state: string,
  files: AgentSetupFileResult[],
  alsoChanges = false,
): AgentRowCheck {
  const wouldChange = alsoChanges || partCheck(files).wouldChange
  return { name, shown: true, state, wouldChange, prechecked: wouldChange, files }
}

const KNOWLEDGE_ROOT_DIR = 'agent-qa-knowledge'

// Null when the config does not parse; validate reports that.
function readRawConfig(configPath: string, io: ProjectIo): Record<string, unknown> | null {
  let raw: unknown
  try {
    raw = parse(io.readText(configPath) ?? '', { logLevel: 'error' })
  } catch {
    return null
  }
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : null
}

function rawWorkspace(config: Record<string, unknown> | null, configPath: string) {
  if (config === null) return undefined
  try {
    return resolveWorkspacePaths({ config: config as AgentQaConfig, configPath })
  } catch {
    return undefined
  }
}

// The knowledge root the config's `knowledge.dir` names, else the default one init scaffolds.
export function knowledgeGuidePath(projectDir: string, configPath: string, io: ProjectIo): string {
  const config = readRawConfig(configPath, io)
  const root =
    resolveRawConfigKnowledgeRoot(config, configPath) ?? join(projectDir, KNOWLEDGE_ROOT_DIR)
  return join(root, 'AGENTS.md')
}

function knowledgeGuideState(path: string, io: ProjectIo): KnowledgeGuideState {
  const text = io.readText(path)
  if (text === undefined) return 'missing'
  return text === buildKnowledgeAgentGuide() ? 'current' : 'differs'
}

// A malformed AGENTS.md block or MCP host file is refused before anything is drawn.
function refuseMalformed(planned: AgentSetupResult): void {
  for (const part of ['agents-md', 'mcp'] as const) {
    const outcome = planned.parts[part]
    if (outcome?.outcome === 'failed' && outcome.reason !== undefined) {
      throw new InitRefusal(outcome.reason)
    }
  }
}

// One dry run of the installer answers every agent row, so the menu says what running it changes.
export async function checkAgentRows({
  projectDir,
  configPath,
  io,
  agents,
  host,
}: Pick<
  SetupRowCheckInput,
  'projectDir' | 'configPath' | 'io' | 'agents' | 'host'
>): Promise<AgentRowsCheck> {
  const guidePath = knowledgeGuidePath(projectDir, configPath, io)
  const guide = { path: guidePath, state: knowledgeGuideState(guidePath, io) }
  const chosen = chosenAgents(agents)
  // An agent the manifest does not list yet has its share of the block to record.
  const setUp = readAgentSetupManifest(projectDir)?.agents ?? []
  const newAgents = chosen.filter((agent) => !setUp.includes(agent))
  const agentsMdRow = (blockFiles: AgentSetupFileResult[]): AgentRowCheck =>
    shownRow(
      'agents-md',
      agentsMdState(blockFiles[0], newAgents, guide.state),
      blockFiles,
      newAgents.length > 0 || guide.state !== 'current',
    )
  if (chosen.length === 0) {
    return {
      skills: hiddenRow('skills', NO_AGENT),
      mcp: hiddenRow('mcp', NO_AGENT),
      'agents-md': agentsMdRow([]),
      guide,
      perAgent: {},
    }
  }
  const planned = await installAgentSetup({
    projectDir,
    agents: chosen,
    parts: ['skills', 'mcp', 'agents-md'],
    host,
    dryRun: true,
  })
  refuseMalformed(planned)
  const perAgent: AgentRowsCheck['perAgent'] = {}
  for (const agent of chosen) {
    perAgent[agent] = {
      skills: partCheck(planned.files.filter((file) => isSkillFileOf(file.path, agent))),
      mcp: partCheck(planned.files.filter((file) => file.path === AGENT_MCP_FILES[agent])),
    }
  }
  return {
    version: planned.version,
    skills: shownRow(
      'skills',
      skillsState(chosen, perAgent, planned.version),
      planned.files.filter((file) => isSkillFile(file.path)),
    ),
    mcp: shownRow(
      'mcp',
      mcpState(chosen, perAgent),
      planned.files.filter((file) => isMcpFileOf(file.path, chosen)),
    ),
    'agents-md': agentsMdRow(planned.files.filter((file) => file.path === AGENTS_MD_FILE)),
    guide,
    perAgent,
  }
}

export const NO_WEB_TARGET = 'no web target'

// The resolver is asked only when this machine runs some web test itself.
export async function checkBrowsersRow({
  configPath,
  io,
  chromium,
  projectAgentQaDir,
}: Pick<
  SetupRowCheckInput,
  'configPath' | 'io' | 'chromium' | 'projectAgentQaDir'
>): Promise<SetupRowState> {
  const row = (state: string, wouldChange: boolean): SetupRowState => ({
    name: 'browsers',
    shown: true,
    state,
    wouldChange,
    prechecked: wouldChange,
  })
  const config = readRawConfig(configPath, io)
  if (!hasWebTarget(config)) {
    return { ...row(NO_WEB_TARGET, false), shown: false, hidden: NO_WEB_TARGET }
  }
  const placement = await resolveWebPlacement(config, rawWorkspace(config, configPath))
  if (placement.everyWebTestRemote) return row('every web run uses a remote', false)
  const answer = chromium(projectAgentQaDir === undefined ? {} : { projectAgentQaDir })
  return answer.found
    ? row('Chromium found', false)
    : row("no Chromium for agent-qa's Playwright", true)
}

function configPlatform(config: Record<string, unknown> | null): InitPlatformSelection {
  const platforms = getTargetPlatforms(config)
  const mobileRuntimes = (['android', 'ios'] as const).filter((name) => platforms.includes(name))
  return {
    capabilities: [
      ...(hasWebTarget(config) ? (['web'] as const) : []),
      ...(mobileRuntimes.length > 0 ? (['mobile'] as const) : []),
    ],
    mobileRuntimes,
  }
}

// The platforms the config's targets name.
export function projectPlatform(configPath: string, io: ProjectIo): InitPlatformSelection {
  return configPlatform(readRawConfig(configPath, io))
}

// The files runs and doctor read; any other scaffold file never pre-checks the row.
const WORKSPACE_FILE_KEYS: Readonly<Record<string, 'envFile' | 'secretsFile' | 'hooksFile'>> = {
  '.env': 'envFile',
  '.env.secrets.local': 'secretsFile',
  'hooks.yaml': 'hooksFile',
}
const KNOWLEDGE_GITIGNORE = `${KNOWLEDGE_ROOT_DIR}/.gitignore`

interface ScaffoldFile {
  plan: InitPathPlan
  label: string
  needed: boolean
}

function posixPath(path: string): string {
  return path.split(sep).join('/')
}

// Each needed file sits where the config points; the knowledge files sit under its knowledge root.
// A workspace file the config points outside the project is left to the person, as doctor says.
function scaffoldFiles({
  projectDir,
  configPath,
  io,
  scaffoldPlans,
}: Pick<SetupRowCheckInput, 'projectDir' | 'configPath' | 'io' | 'scaffoldPlans'>): {
  files: ScaffoldFile[]
  knowledgeRoot: string
} {
  const config = readRawConfig(configPath, io)
  const workspace = rawWorkspace(config, configPath)
  const knowledgeRoot =
    resolveRawConfigKnowledgeRoot(config, configPath) ?? join(projectDir, KNOWLEDGE_ROOT_DIR)
  const file = (plan: InitPathPlan, needed: boolean): ScaffoldFile => ({
    plan,
    needed,
    label: isInside(plan.path, projectDir) ? posixPath(relative(projectDir, plan.path)) : plan.path,
  })
  const files = scaffoldPlans(configPlatform(config)).flatMap((plan) => {
    const fromProject = posixPath(relative(projectDir, plan.path))
    const key = WORKSPACE_FILE_KEYS[fromProject]
    if (key !== undefined) {
      const path = workspace?.[key].absolutePath ?? plan.path
      return isInside(path, projectDir) ? [file({ ...plan, path, root: projectDir }, true)] : []
    }
    if (fromProject.startsWith(`${KNOWLEDGE_ROOT_DIR}/`)) {
      const path = join(knowledgeRoot, fromProject.slice(KNOWLEDGE_ROOT_DIR.length + 1))
      const root = isInside(path, projectDir) ? projectDir : dirname(knowledgeRoot)
      return [file({ ...plan, path, root }, fromProject === KNOWLEDGE_GITIGNORE)]
    }
    return [file(plan, false)]
  })
  return { files, knowledgeRoot }
}

export function checkScaffoldRow(
  input: Pick<SetupRowCheckInput, 'projectDir' | 'configPath' | 'io' | 'scaffoldPlans'>,
): SetupRowState {
  const missing = scaffoldFiles(input).files.filter((file) => !input.io.exists(file.plan.path))
  const needed = missing.filter((file) => file.needed)
  const state =
    needed.length === 1
      ? `${needed[0]!.label} missing`
      : needed.length > 1
        ? `${needed.length} needed files missing`
        : missing.length > 0
          ? 'nothing needed is missing'
          : 'nothing missing'
  return {
    name: 'scaffold',
    shown: true,
    state,
    wouldChange: missing.length > 0,
    prechecked: needed.length > 0,
  }
}

// Every row but upgrade, in menu order.
export async function checkSetupRows(input: SetupRowCheckInput): Promise<SetupRowState[]> {
  const agentRows = await checkAgentRows(input)
  const states: Record<CheckedRowName, SetupRowState> = {
    skills: agentRows.skills,
    mcp: agentRows.mcp,
    'agents-md': agentRows['agents-md'],
    browsers: await checkBrowsersRow(input),
    gitignore: checkGitignoreRow(input),
    scaffold: checkScaffoldRow(input),
  }
  return CHECKED_ROW_NAMES.map((name) => states[name])
}

export function setupRowLabel(row: SetupRowState, width: number): string {
  return `${row.name.padEnd(width)}  ${row.state}`
}

export interface SetupRowFile {
  path: string
  outcome: InitFileOutcome | AgentSetupFileOutcome
}

export type SetupRowRunResult = InitStepResult & { files: SetupRowFile[] }

export interface SetupRowRunInput {
  projectDir: string
  configPath: string
  agents: readonly CodingAgent[]
  host: Partial<ProjectHost>
  // The one real installer run every selected agent row shares.
  agentSetup: () => Promise<AgentSetupResult>
  // The fresh init's Chromium step.
  installChromium: () => Promise<InitStepResult>
  scaffoldPlans: ScaffoldPlans
}

export interface SetupRowRun {
  title: string
  run(input: SetupRowRunInput): Promise<SetupRowRunResult>
}

// The parts carry the agent rows' names, so the selected rows pick the installer's parts.
export function sharedAgentSetup({
  projectDir,
  agents,
  host,
  rows,
}: {
  projectDir: string
  agents: readonly CodingAgent[]
  host: Partial<ProjectHost>
  rows: readonly SetupRowName[]
}): () => Promise<AgentSetupResult> {
  const parts = AGENT_SETUP_PARTS.filter((part) => rows.includes(part))
  let pending: Promise<AgentSetupResult> | undefined
  return () => {
    pending ??= installAgentSetup({ projectDir, agents: chosenAgents(agents), parts, host })
    return pending
  }
}

function failedPart(result: AgentSetupResult, part: AgentSetupPart): string | undefined {
  const outcome = result.parts[part]
  if (outcome?.outcome !== 'failed') return undefined
  return outcome.reason ?? 'the coding agent setup failed'
}

function rowFiles(projectDir: string, files: readonly AgentSetupFileResult[]): SetupRowFile[] {
  return files.map((file) => ({ path: join(projectDir, file.path), outcome: file.outcome }))
}

function replacedSuffix(paths: readonly string[]): string {
  return paths.length === 0 ? '' : `; replaced ${paths.join(', ')}`
}

function replacedPaths(files: readonly AgentSetupFileResult[]): string[] {
  return files.filter((file) => file.outcome === 'replaced').map((file) => file.path)
}

async function runSkillsRow({
  projectDir,
  agents,
  agentSetup,
}: SetupRowRunInput): Promise<SetupRowRunResult> {
  const result = await agentSetup()
  const skillFiles = result.files.filter((file) => isSkillFile(file.path))
  const files = rowFiles(projectDir, skillFiles)
  const reason = failedPart(result, 'skills')
  if (reason !== undefined) {
    return { outcome: 'failed', reason, command: 'npx agent-qa init --setup skills', files }
  }
  const changed = skillFiles.filter((file) => isChange(file.outcome))
  if (changed.length === 0) {
    return { outcome: 'done', text: `skills: current (${result.version})`, files }
  }
  const names = chosenAgents(agents).map(agentLabel).join(' and ')
  return {
    outcome: 'done',
    text:
      `skills: put back agent-qa ${result.version}'s copy for ${names}` +
      replacedSuffix(replacedPaths(changed)),
    files,
  }
}

async function runMcpRow({
  projectDir,
  agents,
  agentSetup,
}: SetupRowRunInput): Promise<SetupRowRunResult> {
  const chosen = chosenAgents(agents)
  const result = await agentSetup()
  const mcpFiles = result.files.filter((file) => isMcpFileOf(file.path, chosen))
  const files = rowFiles(projectDir, mcpFiles)
  const reason = failedPart(result, 'mcp')
  if (reason !== undefined) {
    return { outcome: 'failed', reason, command: 'npx agent-qa init --setup mcp', files }
  }
  const changed = chosen.filter((agent) =>
    mcpFiles.some((file) => file.path === AGENT_MCP_FILES[agent] && isChange(file.outcome)),
  )
  if (changed.length === 0) return { outcome: 'done', text: 'mcp: current', files }
  return {
    outcome: 'done',
    text:
      `mcp: put back the agent-qa entry for ${changed.map(agentLabel).join(' and ')}` +
      replacedSuffix(replacedPaths(mcpFiles)),
    files,
  }
}

function isInside(path: string, folder: string): boolean {
  const fromFolder = relative(folder, path)
  return fromFolder !== '' && fromFolder !== '..' && !fromFolder.startsWith(`..${sep}`)
}

async function runAgentsMdRow({
  projectDir,
  configPath,
  agents,
  host,
  agentSetup,
}: SetupRowRunInput): Promise<SetupRowRunResult> {
  const restored: string[] = []
  const replaced: string[] = []
  const files: SetupRowFile[] = []
  if (chosenAgents(agents).length > 0) {
    const result = await agentSetup()
    const blockFiles = result.files.filter((file) => file.path === AGENTS_MD_FILE)
    files.push(...rowFiles(projectDir, blockFiles))
    const reason = failedPart(result, 'agents-md')
    if (reason !== undefined) {
      return { outcome: 'failed', reason, command: 'npx agent-qa init --setup agents-md', files }
    }
    if (blockFiles.some((file) => isChange(file.outcome))) {
      restored.push(`agent-qa's block in ${AGENTS_MD_FILE}`)
    }
    replaced.push(...replacedPaths(blockFiles))
  }
  const guidePath = knowledgeGuidePath(projectDir, configPath, projectHost(host).io)
  const root = isInside(guidePath, projectDir) ? projectDir : dirname(dirname(guidePath))
  // Decided from the file this run writes, as the installer decides its own files.
  const onDisk =
    classifyInitPath(guidePath, root) === 'regular' ? readFileSync(guidePath, 'utf-8') : undefined
  const guide = buildKnowledgeAgentGuide()
  if (onDisk !== guide) {
    files.push(writeScaffoldFileAtomic({ path: guidePath, root, content: guide, force: true }))
    restored.push('the knowledge guide')
    if (onDisk !== undefined) replaced.push(relative(projectDir, guidePath).split(sep).join('/'))
  }
  if (restored.length === 0) return { outcome: 'done', text: 'agents-md: current', files }
  return {
    outcome: 'done',
    text: `agents-md: put back ${restored.join(' and ')}${replacedSuffix(replaced)}`,
    files,
  }
}

async function runGitignoreRow({ projectDir }: SetupRowRunInput): Promise<SetupRowRunResult> {
  const file = upsertManagedGitignoreBlock(join(projectDir, '.gitignore'), buildGitignoreEntries())
  verifyEffectiveGitignore({
    cwd: projectDir,
    label: 'target .gitignore',
    probes: TARGET_GITIGNORE_PROBES,
    written: file.outcome === 'preserved' ? 'nothing' : 'managed-gitignore',
  })
  const text = {
    preserved: "gitignore: init's block is current",
    created: "gitignore: wrote init's block",
    updated: "gitignore: restored init's block",
  }[file.outcome]
  return { outcome: 'done', text, files: [file] }
}

async function runBrowsersRow({ installChromium }: SetupRowRunInput): Promise<SetupRowRunResult> {
  const step = await installChromium()
  return step.outcome === 'done'
    ? { outcome: 'done', text: `browsers: ${step.text}`, files: [] }
    : { ...step, files: [] }
}

// Only a missing file is written, so an existing one keeps its bytes and its mode.
async function runScaffoldRow({
  projectDir,
  configPath,
  host,
  scaffoldPlans,
}: SetupRowRunInput): Promise<SetupRowRunResult> {
  const { io } = projectHost(host)
  const { files, knowledgeRoot } = scaffoldFiles({ projectDir, configPath, io, scaffoldPlans })
  const written: SetupRowFile[] = []
  const labels: string[] = []
  let knowledgeGitignore: ScaffoldFile | undefined
  for (const file of files) {
    if (io.exists(file.plan.path)) continue
    const result = writeScaffoldFileAtomic({ ...file.plan, force: false })
    written.push(result)
    if (result.outcome === 'created') labels.push(file.label)
    if (file.plan.path === join(knowledgeRoot, '.gitignore')) knowledgeGitignore = file
  }
  if (knowledgeGitignore !== undefined) {
    verifyEffectiveGitignore({
      cwd: knowledgeRoot,
      label: knowledgeGitignore.label,
      probes: KNOWLEDGE_GITIGNORE_PROBES,
      written: 'managed-gitignore-and-scaffold',
    })
  }
  const text =
    labels.length === 0
      ? 'scaffold: nothing missing'
      : `scaffold: wrote ${labels.length === 1 ? labels[0] : fileCount(labels.length)}`
  return { outcome: 'done', text, files: written }
}

export const SETUP_ROW_RUNS: Record<CheckedRowName, SetupRowRun> = {
  skills: { title: "Putting back agent-qa's skills", run: runSkillsRow },
  mcp: { title: "Putting back the coding agents' MCP entries", run: runMcpRow },
  'agents-md': {
    title: "Putting back agent-qa's block in AGENTS.md and the knowledge guide",
    run: runAgentsMdRow,
  },
  browsers: { title: 'Installing Chromium', run: runBrowsersRow },
  gitignore: { title: "Restoring init's .gitignore block", run: runGitignoreRow },
  scaffold: { title: 'Writing the missing scaffold files', run: runScaffoldRow },
}
