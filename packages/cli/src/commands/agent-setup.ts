import { readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

import {
  AGENT_SETUP_MANIFEST_PATH,
  AGENT_SKILL_ROOTS,
  agentOfManifestPath,
  type AGENT_SETUP_ENTRY_FILES,
  CODING_AGENTS,
  readAgentSetupManifest,
  writeAgentSetupManifest,
  type AgentSetupManifest,
  type CodingAgent,
} from './agent-setup-manifest.js'
import {
  classifyInitPath,
  preflightManagedBlockRemoval,
  readHostFile,
  removeEmptyFoldersUpTo,
  removeFileInsideRoot,
  removeHostFile,
  removeManagedBlockFromFile,
  upsertManagedBlock,
  writeHostFile,
  writeScaffoldFileAtomic,
  type HostFileRead,
} from './init-filesystem.js'
import { InitRefusal } from './init-refusal.js'
import { buildAgentInstructionPointer, type AgentInstructionSkill } from './knowledge-guide.js'
import {
  AGENT_QA_INIT_MARKDOWN_BLOCK,
  locateManagedBlock,
  renderManagedBlock,
  type ManagedBlockContent,
} from './managed-block.js'
import {
  removeClaudeCodeMcpEntry,
  removeCodexMcpEntry,
  upsertClaudeCodeMcpEntry,
  upsertCodexMcpEntry,
  type McpEntryEdit,
  type McpEntryRemoval,
} from './mcp-entries.js'
import { projectHost, type ProjectHost } from './project-host.js'
import {
  PLUGIN_SKILL_FOLDER_PREFIX,
  pluginSkillSources,
  readSkillFiles,
  resolveAgentQaSkillSource,
  sha256Of,
  stampSkillFrontmatter,
  type PluginSkillSources,
  type SkillFile,
} from './skill-install.js'
import { listAgentQaSkills, skillSummary } from './skills.js'

export { AGENT_SKILL_ROOTS, CODING_AGENTS, type CodingAgent } from './agent-setup-manifest.js'

export type AgentSetupPart = 'skills' | 'agents-md' | 'mcp'
export const AGENT_SETUP_PARTS: readonly AgentSetupPart[] = ['skills', 'agents-md', 'mcp']

export const AGENTS_MD_FILE = 'AGENTS.md'
export const AGENTS_MD_BLOCK_KEY = 'agent-qa init block'

type EntryFile = (typeof AGENT_SETUP_ENTRY_FILES)[number]

export const AGENT_MCP_FILES: Readonly<Record<CodingAgent, EntryFile>> = {
  'claude-code': '.mcp.json',
  codex: '.codex/config.toml',
}
export const AGENT_MCP_ENTRY_KEYS: Readonly<Record<CodingAgent, string>> = {
  'claude-code': 'mcpServers.agent-qa',
  codex: 'mcp_servers.agent-qa',
}

const MCP_UPSERTS: Readonly<Record<CodingAgent, (text: string | undefined) => McpEntryEdit>> = {
  'claude-code': upsertClaudeCodeMcpEntry,
  codex: upsertCodexMcpEntry,
}

const MCP_REMOVALS: Readonly<
  Record<CodingAgent, (text: string | undefined) => McpEntryRemoval>
> = {
  'claude-code': removeClaudeCodeMcpEntry,
  codex: removeCodexMcpEntry,
}

export type AgentSetupFileOutcome =
  | 'created'
  | 'updated'
  | 'replaced'
  | 'unchanged'
  | 'removed'
  | 'kept'

export interface AgentSetupOptions {
  projectDir: string
  agents: readonly CodingAgent[]
  parts?: readonly AgentSetupPart[]
  host?: Partial<ProjectHost>
}

export interface AgentSetupPartResult {
  outcome: 'done' | 'skipped' | 'failed'
  reason?: string
}

export interface AgentSetupFileResult {
  path: string
  outcome: AgentSetupFileOutcome
}

export interface AgentSetupResult {
  source: 'project' | 'running'
  version: string
  agents: CodingAgent[]
  parts: Partial<Record<AgentSetupPart, AgentSetupPartResult>>
  files: AgentSetupFileResult[]
  notes: string[]
}

interface PlannedFile {
  path: string
  bytes: Buffer
}

function byPath<T extends { path: string }>(a: T, b: T): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0
}

interface SkillFiles {
  folder: string
  files: SkillFile[]
}

function stampedSkillFiles(dir: string, stamp: { version: string; name?: string }): SkillFile[] {
  return readSkillFiles(dir).map((file) =>
    file.path === 'SKILL.md'
      ? {
          path: file.path,
          bytes: Buffer.from(stampSkillFrontmatter(file.bytes.toString('utf-8'), stamp)),
        }
      : file,
  )
}

// One plugin's unreadable skill is held with a note; it never stops agent-qa's own skills.
function readPluginSkills(
  plugins: PluginSkillSources,
  notes: string[],
  held: Set<string>,
): SkillFiles[] {
  const skills: SkillFiles[] = []
  for (const plugin of plugins.sources) {
    try {
      skills.push({
        folder: plugin.folder,
        files: stampedSkillFiles(plugin.dir, { version: plugin.version, name: plugin.folder }),
      })
    } catch (error) {
      const entry = plugin.folder.slice(PLUGIN_SKILL_FOLDER_PREFIX.length)
      notes.push(`Plugin ${entry}: ${errorMessage(error)} Its skill is not installed.`)
      held.add(plugin.folder)
    }
  }
  return skills
}

function planSkillFiles(
  skills: readonly SkillFiles[],
  agents: readonly CodingAgent[],
): PlannedFile[] {
  const planned: PlannedFile[] = []
  for (const skill of skills) {
    for (const agent of agents) {
      for (const file of skill.files) {
        const path = `${AGENT_SKILL_ROOTS[agent]}/${skill.folder}/${file.path}`
        if (agentOfManifestPath(path) === agent) planned.push({ path, bytes: file.bytes })
      }
    }
  }
  return planned.sort(byPath)
}

function skillFolderOf(path: string, agent: CodingAgent): string {
  return path.split('/')[AGENT_SKILL_ROOTS[agent].split('/').length] ?? ''
}

// A listed file whose bytes still hash to its record is unedited; any other difference is an edit.
function fileOutcome(
  onDisk: string | undefined,
  wanted: string,
  listed: string | undefined,
): AgentSetupFileOutcome {
  if (onDisk === undefined) return 'created'
  if (onDisk === wanted) return 'unchanged'
  if (listed === undefined) return 'kept'
  return onDisk === listed ? 'updated' : 'replaced'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// Runs once the file is gone, so a folder left behind is named in a note, never as the file.
function tidyEmptyFolders(
  path: string,
  stop: string,
  projectDir: string,
  notes: string[],
): void {
  try {
    removeEmptyFoldersUpTo(path, stop)
  } catch (error) {
    const failed = (error as NodeJS.ErrnoException).path ?? dirname(path)
    const reason = (error as NodeJS.ErrnoException).code ?? errorMessage(error)
    const note = `Could not remove the empty folder ${relative(projectDir, failed)} (${reason})`
    if (!notes.includes(note)) notes.push(note)
  }
}

function byName<T extends { name: string }>(a: T, b: T): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
}

type ManifestEntry = AgentSetupManifest['entries'][number]

function isBlockEntry(entry: ManifestEntry): boolean {
  return entry.file === AGENTS_MD_FILE && entry.key === AGENTS_MD_BLOCK_KEY
}

function skillSummaries(skills: readonly SkillFiles[]): AgentInstructionSkill[] {
  return skills
    .map((skill) => {
      const file = skill.files.find((candidate) => candidate.path === 'SKILL.md')
      if (file === undefined) throw new Error(`The ${skill.folder} skill has no SKILL.md.`)
      return skillSummary(file.bytes.toString('utf-8'))
    })
    .sort(byName)
}

interface SkillsInstall {
  projectDir: string
  chosen: readonly CodingAgent[]
  planned: readonly PlannedFile[]
  listed: ReadonlyMap<string, string>
  records: Map<string, string>
  holds: (path: string, agent: CodingAgent) => boolean
  result: AgentSetupResult
}

function installSkillFiles(install: SkillsInstall): string[] {
  const { projectDir, chosen, planned, listed, records, holds, result } = install
  const failures: string[] = []
  for (const file of planned) {
    const absolute = join(projectDir, file.path)
    const wanted = sha256Of(file.bytes)
    const listedHash = listed.get(file.path)
    try {
      const existing =
        classifyInitPath(absolute, projectDir) === 'regular' ? readFileSync(absolute) : undefined
      const outcome = fileOutcome(
        existing === undefined ? undefined : sha256Of(existing),
        wanted,
        listedHash,
      )
      if (outcome === 'kept') {
        result.notes.push(
          `${file.path} exists and is not agent-qa's; remove it and run npx agent-qa init`,
        )
      } else {
        if (outcome !== 'unchanged') {
          writeScaffoldFileAtomic({
            path: absolute,
            root: projectDir,
            content: file.bytes,
            force: true,
          })
        }
        if (outcome === 'replaced') result.notes.push(`Replaced your edit: ${file.path}`)
        records.set(file.path, wanted)
      }
      result.files.push({ path: file.path, outcome })
    } catch (error) {
      failures.push(errorMessage(error))
      if (listedHash !== undefined) records.set(file.path, listedHash)
    }
  }

  const plannedPaths = new Set(planned.map((file) => file.path))
  for (const [path, sha256] of listed) {
    const agent = agentOfManifestPath(path)
    if (agent === undefined || !chosen.includes(agent) || plannedPaths.has(path)) continue
    if (holds(path, agent)) {
      records.set(path, sha256)
      continue
    }
    const absolute = join(projectDir, path)
    try {
      const onDisk =
        classifyInitPath(absolute, projectDir) === 'regular'
          ? sha256Of(readFileSync(absolute))
          : undefined
      if (removeFileInsideRoot({ path: absolute, root: projectDir }) === 'removed') {
        result.files.push({ path, outcome: 'removed' })
        if (onDisk !== undefined && onDisk !== sha256) {
          result.notes.push(`Removed your edit: ${path}`)
        }
      }
    } catch (error) {
      failures.push(errorMessage(error))
      records.set(path, sha256)
      continue
    }
    tidyEmptyFolders(absolute, join(projectDir, AGENT_SKILL_ROOTS[agent]), projectDir, result.notes)
  }
  return failures
}

function currentBlockText(projectDir: string, content: ManagedBlockContent): string | undefined {
  const path = join(projectDir, AGENTS_MD_FILE)
  if (classifyInitPath(path, projectDir) !== 'regular') return undefined
  const text = readFileSync(path, 'utf-8')
  const span = locateManagedBlock(text, content)
  return span === undefined ? undefined : text.slice(span.start, span.end)
}

// The block is agent-qa's by its markers: an edited one is rewritten and named, never kept.
function writeAgentsMdBlock(
  projectDir: string,
  skills: readonly AgentInstructionSkill[],
  version: string,
  listedHash: string | undefined,
  result: AgentSetupResult,
): string {
  const content: ManagedBlockContent = {
    descriptor: AGENT_QA_INIT_MARKDOWN_BLOCK,
    target: AGENTS_MD_FILE,
    body: buildAgentInstructionPointer(skills, version),
  }
  const wanted = renderManagedBlock(content)
  const current = currentBlockText(projectDir, content)
  const outcome: AgentSetupFileOutcome =
    current === undefined
      ? 'created'
      : current === wanted
        ? 'unchanged'
        : sha256Of(current) === listedHash
          ? 'updated'
          : 'replaced'
  if (outcome !== 'unchanged') {
    upsertManagedBlock({ path: join(projectDir, AGENTS_MD_FILE), root: projectDir, content })
  }
  if (outcome === 'replaced') {
    result.notes.push(`Replaced your edit: the agent-qa block in ${AGENTS_MD_FILE}`)
  }
  result.files.push({ path: AGENTS_MD_FILE, outcome })
  return sha256Of(wanted)
}

// The entry is agent-qa's by its server name: an edited or foreign one is rewritten and named.
// The host file is spliced in place; no host CLI runs, because each re-serialises the file.
function writeMcpEntry(
  projectDir: string,
  agent: CodingAgent,
  listedHash: string | undefined,
  result: AgentSetupResult,
): string {
  const file = AGENT_MCP_FILES[agent]
  const path = join(projectDir, file)
  const read = readHostFile(path, projectDir)
  const existing = read?.text
  const edit = MCP_UPSERTS[agent](existing)
  if ('refused' in edit) throw new Error(edit.refused)
  const outcome: AgentSetupFileOutcome =
    edit.previous === undefined
      ? 'created'
      : edit.previous === edit.entry
        ? 'unchanged'
        : sha256Of(edit.previous) === listedHash
          ? 'updated'
          : 'replaced'
  if (edit.text !== existing) {
    writeHostFile({
      path,
      root: projectDir,
      content: edit.text,
      read,
      rerun: 'rerun npx agent-qa init',
    })
  }
  if (outcome === 'replaced') {
    result.notes.push(
      listedHash === undefined
        ? `Replaced the agent-qa entry in ${file}, which differed from agent-qa's`
        : `Replaced your edit: the agent-qa entry in ${file}`,
    )
  }
  result.files.push({ path: file, outcome })
  return sha256Of(edit.entry)
}

function setEntry(entries: ManifestEntry[], entry: ManifestEntry): void {
  const at = entries.findIndex((listed) => listed.file === entry.file && listed.key === entry.key)
  if (at === -1) entries.push(entry)
  else entries[at] = entry
}

function partResult(
  chosen: readonly CodingAgent[],
  reason: string | undefined,
): AgentSetupPartResult {
  if (chosen.length === 0) return { outcome: 'skipped', reason: 'no coding agent is chosen' }
  return reason === undefined ? { outcome: 'done' } : { outcome: 'failed', reason }
}

export async function installAgentSetup(options: AgentSetupOptions): Promise<AgentSetupResult> {
  const projectDir = resolve(options.projectDir)
  const host = projectHost(options.host)
  const parts = options.parts ?? AGENT_SETUP_PARTS
  const chosen = CODING_AGENTS.filter((agent) => options.agents.includes(agent))

  const previous = readAgentSetupManifest(projectDir)
  const source = await resolveAgentQaSkillSource(projectDir, host)
  const result: AgentSetupResult = {
    source: source.source,
    version: source.version,
    agents: CODING_AGENTS.filter(
      (agent) => chosen.includes(agent) || (previous?.agents.includes(agent) ?? false),
    ),
    parts: {},
    files: [],
    notes: [],
  }
  if (source.source === 'running') {
    result.notes.push(
      'agent-qa is not installed in the project, so the skills come from the running ' +
        `agent-qa ${source.version}.`,
    )
  }
  const runSkills = parts.includes('skills')
  const runBlock = parts.includes('agents-md')
  const runMcp = parts.includes('mcp')
  if (!runSkills && !runBlock && !runMcp) return result
  const plugins = await pluginSkillSources(projectDir, source.version)
  result.notes.push(...plugins.notes)
  const held = new Set(plugins.held)
  const holds = (path: string, agent: CodingAgent): boolean => {
    const folder = skillFolderOf(path, agent)
    return (
      held.has(folder) || (!plugins.configLoaded && folder.startsWith(PLUGIN_SKILL_FOLDER_PREFIX))
    )
  }

  const listed = new Map((previous?.files ?? []).map((file) => [file.path, file.sha256]))
  const records = new Map<string, string>()
  for (const [path, sha256] of listed) {
    const agent = agentOfManifestPath(path)
    if (!runSkills || (agent !== undefined && !chosen.includes(agent))) records.set(path, sha256)
  }
  const agentQaSkills = listAgentQaSkills(source.dir).map((skill) => ({
    folder: skill.name,
    files: stampedSkillFiles(skill.path, { version: source.version }),
  }))
  const pluginSkills = readPluginSkills(plugins, result.notes, held)

  const skillFailures = runSkills
    ? installSkillFiles({
        projectDir,
        chosen,
        planned: planSkillFiles([...agentQaSkills, ...pluginSkills], chosen),
        listed,
        records,
        holds,
        result,
      })
    : []

  const entries = [...(previous?.entries ?? [])]
  let blockFailure: string | undefined
  if (runBlock && chosen.length > 0) {
    try {
      const sha256 = writeAgentsMdBlock(
        projectDir,
        [...skillSummaries(agentQaSkills), ...skillSummaries(pluginSkills)],
        source.version,
        entries.find(isBlockEntry)?.sha256,
        result,
      )
      setEntry(entries, { file: AGENTS_MD_FILE, key: AGENTS_MD_BLOCK_KEY, sha256 })
    } catch (error) {
      blockFailure = errorMessage(error)
    }
  }

  const mcpFailures: string[] = []
  if (runMcp) {
    for (const agent of chosen) {
      const file = AGENT_MCP_FILES[agent]
      const key = AGENT_MCP_ENTRY_KEYS[agent]
      const listedHash = entries.find((entry) => entry.file === file && entry.key === key)?.sha256
      try {
        const sha256 = writeMcpEntry(projectDir, agent, listedHash, result)
        setEntry(entries, { file, key, sha256 })
      } catch (error) {
        mcpFailures.push(errorMessage(error))
      }
    }
  }
  result.files.sort(byPath)

  const manifest: AgentSetupManifest = {
    format: 1,
    version: source.version,
    agents: result.agents,
    files: [...records].map(([path, sha256]) => ({ path, sha256 })),
    entries,
  }
  let manifestFailure: string | undefined
  try {
    // With no agent chosen and nothing installed before, there is nothing to record.
    if (chosen.length > 0 || previous !== undefined) writeAgentSetupManifest(projectDir, manifest)
  } catch (error) {
    manifestFailure = errorMessage(error)
  }
  if (runSkills) {
    const reason = skillFailures[0] ?? manifestFailure
    result.parts.skills = reason === undefined ? { outcome: 'done' } : { outcome: 'failed', reason }
  }
  if (runBlock) result.parts['agents-md'] = partResult(chosen, blockFailure ?? manifestFailure)
  if (runMcp) result.parts.mcp = partResult(chosen, mcpFailures[0] ?? manifestFailure)
  return result
}

export type AgentRemovalOutcome = 'removed' | 'missing'

export interface AgentRemovalFile {
  path: string
  outcome: AgentRemovalOutcome
  edited: boolean
}

export interface AgentRemovalEntry {
  file: string
  key: string
  outcome: AgentRemovalOutcome
  edited: boolean
}

export interface AgentRemovalAgent {
  agent: CodingAgent
  skillRoot: string
  skills: number
  files: AgentRemovalFile[]
  entries: AgentRemovalEntry[]
}

export interface AgentRemovalBlock {
  outcome: 'removed' | 'missing' | 'kept' | 'unlisted'
  edited: boolean
}

export type AgentRemovalResult =
  | { installed: false; projectDir: string; dryRun: boolean }
  | {
      installed: true
      projectDir: string
      dryRun: boolean
      removed: AgentRemovalAgent[]
      notInstalled: CodingAgent[]
      remaining: CodingAgent[]
      block: AgentRemovalBlock
      manifest: 'removed' | 'rewritten' | 'unchanged'
      notes: string[]
    }

export interface AgentRemovalOptions {
  projectDir: string
  agents?: readonly CodingAgent[]
  dryRun?: boolean
}

// A write failed after the plan was made; the manifest is written last, so a re-run continues.
export class AgentRemovalFailure extends Error {
  readonly target: string

  constructor(target: string, cause: unknown) {
    super(`Could not remove ${target}: ${errorMessage(cause).replace(/\s+/gu, ' ')}`, { cause })
    this.name = 'AgentRemovalFailure'
    this.target = target
  }
}

interface PlannedRemoval {
  path: string
  absolute: string
  outcome: AgentRemovalOutcome
}

interface PlannedHostEdit extends AgentRemovalEntry {
  agent: CodingAgent
  absolute: string
  read: HostFileRead | undefined
  text: string | undefined
}

function attempt(target: string, operation: () => unknown): void {
  try {
    operation()
  } catch (error) {
    throw new AgentRemovalFailure(target, error)
  }
}

function agentsBlockContent(): ManagedBlockContent {
  return { descriptor: AGENT_QA_INIT_MARKDOWN_BLOCK, target: AGENTS_MD_FILE, body: [] }
}

function installedAgents(manifest: AgentSetupManifest): CodingAgent[] {
  return CODING_AGENTS.filter(
    (agent) =>
      manifest.agents.includes(agent) ||
      manifest.files.some((file) => agentOfManifestPath(file.path) === agent) ||
      manifest.entries.some((entry) => entry.file === AGENT_MCP_FILES[agent]),
  )
}

function planHostEdit(
  projectDir: string,
  agent: CodingAgent,
  listed: ManifestEntry,
): PlannedHostEdit {
  const absolute = join(projectDir, listed.file)
  const read = readHostFile(absolute, projectDir)
  const removal = MCP_REMOVALS[agent](read?.text)
  if ('refused' in removal) throw new InitRefusal(removal.refused)
  return {
    agent,
    absolute,
    read,
    file: listed.file,
    key: listed.key,
    text: removal.text,
    outcome: removal.previous === undefined ? 'missing' : 'removed',
    edited: removal.previous !== undefined && sha256Of(removal.previous) !== listed.sha256,
  }
}

// Every read, parse and refusal happens before the first write; only listed paths are touched.
export async function removeAgentSetup(options: AgentRemovalOptions): Promise<AgentRemovalResult> {
  const projectDir = resolve(options.projectDir)
  const dryRun = options.dryRun === true
  const manifest = readAgentSetupManifest(projectDir)
  if (manifest === undefined) return { installed: false, projectDir, dryRun }

  const installed = installedAgents(manifest)
  const requested = options.agents ?? CODING_AGENTS
  const chosen = installed.filter((agent) => requested.includes(agent))
  const notInstalled =
    options.agents === undefined
      ? []
      : CODING_AGENTS.filter((agent) => requested.includes(agent) && !installed.includes(agent))
  const remaining = installed.filter((agent) => !chosen.includes(agent))
  const blockEntry = manifest.entries.find(isBlockEntry)
  let block: AgentRemovalBlock = {
    outcome: blockEntry === undefined ? 'unlisted' : 'kept',
    edited: false,
  }
  // A manifest that lists no agent goes whole, with any block it lists.
  if (chosen.length === 0 && installed.length > 0) {
    return {
      installed: true,
      projectDir,
      dryRun,
      removed: [],
      notInstalled,
      remaining,
      block,
      manifest: 'unchanged',
      notes: [],
    }
  }

  const removed: AgentRemovalAgent[] = chosen.map((agent) => ({
    agent,
    skillRoot: AGENT_SKILL_ROOTS[agent],
    skills: 0,
    files: [],
    entries: [],
  }))
  const reportOf = (agent: CodingAgent): AgentRemovalAgent =>
    removed.find((report) => report.agent === agent)!

  const files: PlannedRemoval[] = []
  for (const listed of [...manifest.files].sort(byPath)) {
    const agent = agentOfManifestPath(listed.path)
    if (agent === undefined || !chosen.includes(agent)) continue
    const absolute = join(projectDir, listed.path)
    const present = classifyInitPath(absolute, projectDir) === 'regular'
    const outcome: AgentRemovalOutcome = present ? 'removed' : 'missing'
    const edited = present && sha256Of(readFileSync(absolute)) !== listed.sha256
    files.push({ path: listed.path, absolute, outcome })
    reportOf(agent).files.push({ path: listed.path, outcome, edited })
  }
  for (const report of removed) {
    const folders = report.files
      .filter((file) => file.outcome === 'removed')
      .map((file) => skillFolderOf(file.path, report.agent))
    report.skills = new Set(folders).size
  }

  const hosts: PlannedHostEdit[] = []
  for (const agent of chosen) {
    const listed = manifest.entries.find(
      (entry) => entry.file === AGENT_MCP_FILES[agent] && entry.key === AGENT_MCP_ENTRY_KEYS[agent],
    )
    if (listed === undefined) continue
    const host = planHostEdit(projectDir, agent, listed)
    hosts.push(host)
    reportOf(agent).entries.push({
      file: host.file,
      key: host.key,
      outcome: host.outcome,
      edited: host.edited,
    })
  }

  const blockPlan = {
    path: join(projectDir, AGENTS_MD_FILE),
    root: projectDir,
    content: agentsBlockContent(),
  }
  if (remaining.length === 0 && blockEntry !== undefined) {
    const planned = preflightManagedBlockRemoval(blockPlan)
    const span =
      planned === undefined ? undefined : locateManagedBlock(planned.existing, blockPlan.content)
    block =
      planned === undefined || span === undefined
        ? { outcome: 'missing', edited: false }
        : {
            outcome: 'removed',
            edited: sha256Of(planned.existing.slice(span.start, span.end)) !== blockEntry.sha256,
          }
  }

  const next: AgentSetupManifest = {
    ...manifest,
    agents: manifest.agents.filter((agent) => !chosen.includes(agent)),
    files: manifest.files.filter((file) => {
      const agent = agentOfManifestPath(file.path)
      return agent === undefined || !chosen.includes(agent)
    }),
    entries: manifest.entries.filter(
      (entry) => !chosen.some((agent) => entry.file === AGENT_MCP_FILES[agent]),
    ),
  }
  const result: AgentRemovalResult = {
    installed: true,
    projectDir,
    dryRun,
    removed,
    notInstalled,
    remaining,
    block,
    manifest: remaining.length === 0 ? 'removed' : 'rewritten',
    notes: [],
  }
  if (dryRun) return result

  for (const file of files) {
    if (file.outcome !== 'removed') continue
    attempt(file.path, () => removeFileInsideRoot({ path: file.absolute, root: projectDir }))
    tidyEmptyFolders(file.absolute, projectDir, projectDir, result.notes)
  }
  for (const host of hosts) {
    if (host.outcome !== 'removed') continue
    const read = host.read!
    const rerun = 'rerun npx agent-qa skills uninstall'
    attempt(`the agent-qa entry from ${host.file}`, () => {
      if (host.text === undefined) {
        removeHostFile({ path: host.absolute, root: projectDir, read, rerun })
      } else {
        writeHostFile({ path: host.absolute, root: projectDir, content: host.text, read, rerun })
      }
    })
    if (host.text === undefined) {
      tidyEmptyFolders(host.absolute, projectDir, projectDir, result.notes)
    }
  }
  if (block.outcome === 'removed') {
    attempt(`the agent-qa block from ${AGENTS_MD_FILE}`, () =>
      removeManagedBlockFromFile(blockPlan),
    )
  }
  const manifestPath = join(projectDir, AGENT_SETUP_MANIFEST_PATH)
  attempt(AGENT_SETUP_MANIFEST_PATH, () => {
    if (remaining.length > 0) writeAgentSetupManifest(projectDir, next)
    else removeFileInsideRoot({ path: manifestPath, root: projectDir })
  })
  if (remaining.length === 0) tidyEmptyFolders(manifestPath, projectDir, projectDir, result.notes)
  return result
}
