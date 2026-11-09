import { join } from 'node:path'

import pc from 'picocolors'

import { CliRefusal } from '../composition/cli-refusal.js'
import {
  AGENT_MCP_FILES,
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
import { INIT_AGENT_OPTIONS } from './init-agents.js'
import {
  TARGET_GITIGNORE_PROBES,
  upsertManagedGitignoreBlock,
  verifyEffectiveGitignore,
  type InitFileOutcome,
} from './init-filesystem.js'
import type { InitStepResult } from './init-steps.js'
import { composeManagedBlock, locateManagedBlock } from './managed-block.js'
import type { ProjectHost, ProjectIo } from './project-host.js'
import { buildGitignoreEntries, managedGitignoreContent } from './scaffold-content.js'

// Every row this build has, in menu order.
export const SETUP_ROW_NAMES = ['skills', 'gitignore'] as const
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

export interface AgentRowsCheck {
  // The version the installer would write; absent with no coding agent chosen.
  version?: string
  skills: SetupRowState
  mcp: AgentPartCheck
  'agents-md': AgentPartCheck
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

function agentLabel(agent: CodingAgent): string {
  return INIT_AGENT_OPTIONS.find((option) => option.value === agent)?.label ?? agent
}

function fileCount(count: number): string {
  return `${count} ${count === 1 ? 'file' : 'files'}`
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

function hiddenRow(name: SetupRowName, reason: string): SetupRowState {
  return {
    name,
    shown: false,
    hidden: reason,
    state: reason,
    wouldChange: false,
    prechecked: false,
  }
}

// One dry run of the installer answers every agent row, so the menu says what running it changes.
export async function checkAgentRows({
  projectDir,
  agents,
  host,
}: Pick<SetupRowCheckInput, 'projectDir' | 'agents' | 'host'>): Promise<AgentRowsCheck> {
  const chosen = CODING_AGENTS.filter((agent) => agents.includes(agent))
  if (chosen.length === 0) {
    return {
      skills: hiddenRow('skills', NO_AGENT),
      mcp: partCheck([]),
      'agents-md': partCheck([]),
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
  const perAgent: AgentRowsCheck['perAgent'] = {}
  for (const agent of chosen) {
    perAgent[agent] = {
      skills: partCheck(planned.files.filter((file) => isSkillFileOf(file.path, agent))),
      mcp: partCheck(planned.files.filter((file) => file.path === AGENT_MCP_FILES[agent])),
    }
  }
  const skills = partCheck(planned.files.filter((file) => isSkillFile(file.path)))
  return {
    version: planned.version,
    skills: {
      name: 'skills',
      shown: true,
      state: skillsState(chosen, perAgent, planned.version),
      wouldChange: skills.wouldChange,
      prechecked: skills.wouldChange,
    },
    mcp: partCheck(
      planned.files.filter((file) => chosen.some((agent) => file.path === AGENT_MCP_FILES[agent])),
    ),
    'agents-md': partCheck(planned.files.filter((file) => file.path === AGENTS_MD_FILE)),
    perAgent,
  }
}

export async function checkSetupRows(input: SetupRowCheckInput): Promise<SetupRowState[]> {
  const agentRows = await checkAgentRows(input)
  const states: Record<SetupRowName, SetupRowState> = {
    skills: agentRows.skills,
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
  agents: readonly CodingAgent[]
  host: Partial<ProjectHost>
}

export interface SetupRowRun {
  title: string
  run(input: SetupRowRunInput): Promise<SetupRowRunResult>
}

const SKILLS_FIX = 'npx agent-qa init --setup skills'

function failedPart(result: AgentSetupResult, part: AgentSetupPart): string | undefined {
  const outcome = result.parts[part]
  if (outcome?.outcome !== 'failed') return undefined
  return outcome.reason ?? 'the coding agent setup failed'
}

async function runSkillsRow({
  projectDir,
  agents,
  host,
}: SetupRowRunInput): Promise<SetupRowRunResult> {
  const chosen = CODING_AGENTS.filter((agent) => agents.includes(agent))
  const result = await installAgentSetup({ projectDir, agents: chosen, parts: ['skills'], host })
  const skillFiles = result.files
    .filter((file) => isSkillFile(file.path))
    .map((file) => ({ path: join(projectDir, file.path), outcome: file.outcome }))
  const reason = failedPart(result, 'skills')
  if (reason !== undefined) {
    return { outcome: 'failed', reason, command: SKILLS_FIX, files: skillFiles }
  }
  const changed = result.files.filter((file) => isSkillFile(file.path) && isChange(file.outcome))
  if (changed.length === 0) {
    return { outcome: 'done', text: `skills: current (${result.version})`, files: skillFiles }
  }
  const replaced = changed.filter((file) => file.outcome === 'replaced').map((file) => file.path)
  const names = chosen.map(agentLabel).join(' and ')
  return {
    outcome: 'done',
    text:
      `skills: put back agent-qa ${result.version}'s copy for ${names}` +
      (replaced.length === 0 ? '' : `; replaced ${replaced.join(', ')}`),
    files: skillFiles,
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
  gitignore: { title: "Restoring init's .gitignore block", run: runGitignoreRow },
}
