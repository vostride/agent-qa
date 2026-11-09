import { readFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'

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
import { INIT_AGENT_OPTIONS } from './init-agents.js'
import {
  TARGET_GITIGNORE_PROBES,
  classifyInitPath,
  upsertManagedGitignoreBlock,
  verifyEffectiveGitignore,
  writeScaffoldFileAtomic,
  type InitFileOutcome,
} from './init-filesystem.js'
import { InitRefusal } from './init-refusal.js'
import type { InitStepResult } from './init-steps.js'
import { buildKnowledgeAgentGuide } from './knowledge-guide.js'
import { composeManagedBlock, locateManagedBlock } from './managed-block.js'
import { projectHost, type ProjectHost, type ProjectIo } from './project-host.js'
import { buildGitignoreEntries, managedGitignoreContent } from './scaffold-content.js'

// Every row this build has, in menu order.
export const SETUP_ROW_NAMES = ['skills', 'mcp', 'agents-md', 'gitignore'] as const
export type SetupRowName = (typeof SETUP_ROW_NAMES)[number]

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
}

export interface SetupRowCheckInput {
  projectDir: string
  configPath: string
  io: ProjectIo
  agents: readonly CodingAgent[]
  host: Partial<ProjectHost>
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

function agentLabel(agent: CodingAgent): string {
  return INIT_AGENT_OPTIONS.find((option) => option.value === agent)?.label ?? agent
}

function fileCount(count: number): string {
  return `${count} ${count === 1 ? 'file' : 'files'}`
}

function chosenAgents(agents: readonly CodingAgent[]): CodingAgent[] {
  return CODING_AGENTS.filter((agent) => agents.includes(agent))
}

// Short enough for a narrow terminal; the files themselves are in --json.
function skillsState(
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

// The knowledge root the config's `knowledge.dir` names, else the default one init scaffolds.
export function knowledgeGuidePath(projectDir: string, configPath: string, io: ProjectIo): string {
  let raw: unknown
  try {
    raw = parse(io.readText(configPath) ?? '', { logLevel: 'error' })
  } catch {
    raw = undefined
  }
  const config =
    raw !== null && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : null
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
}: SetupRowCheckInput): Promise<AgentRowsCheck> {
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

export async function checkSetupRows(input: SetupRowCheckInput): Promise<SetupRowState[]> {
  const agentRows = await checkAgentRows(input)
  const states: Record<SetupRowName, SetupRowState> = {
    skills: agentRows.skills,
    mcp: agentRows.mcp,
    'agents-md': agentRows['agents-md'],
    gitignore: checkGitignoreRow(input),
  }
  return SETUP_ROW_NAMES.map((name) => states[name])
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

export const SETUP_ROW_RUNS: Record<SetupRowName, SetupRowRun> = {
  skills: { title: "Putting back agent-qa's skills", run: runSkillsRow },
  mcp: { title: "Putting back the coding agents' MCP entries", run: runMcpRow },
  'agents-md': {
    title: "Putting back agent-qa's block in AGENTS.md and the knowledge guide",
    run: runAgentsMdRow,
  },
  gitignore: { title: "Restoring init's .gitignore block", run: runGitignoreRow },
}
