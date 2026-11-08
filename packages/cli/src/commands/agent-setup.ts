import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import {
  AGENT_SKILL_ROOTS,
  agentOfManifestPath,
  CODING_AGENTS,
  readAgentSetupManifest,
  writeAgentSetupManifest,
  type AgentSetupManifest,
  type CodingAgent,
} from './agent-setup-manifest.js'
import {
  classifyInitPath,
  removeEmptyFoldersUpTo,
  removeFileInsideRoot,
  writeScaffoldFileAtomic,
} from './init-filesystem.js'
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
import { listAgentQaSkills } from './skills.js'

export { AGENT_SKILL_ROOTS, CODING_AGENTS, type CodingAgent } from './agent-setup-manifest.js'

export type AgentSetupPart = 'skills'
export const AGENT_SETUP_PARTS: readonly AgentSetupPart[] = ['skills']

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
  if (!parts.includes('skills')) return result
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
    if (agent !== undefined && !chosen.includes(agent)) records.set(path, sha256)
  }
  const failures: string[] = []
  const agentQaSkills = listAgentQaSkills(source.dir).map((skill) => ({
    folder: skill.name,
    files: stampedSkillFiles(skill.path, { version: source.version }),
  }))
  const planned = planSkillFiles(
    [...agentQaSkills, ...readPluginSkills(plugins, result.notes, held)],
    chosen,
  )

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
      if (removeFileInsideRoot({ path: absolute, root: projectDir }) === 'removed') {
        result.files.push({ path, outcome: 'removed' })
      }
      removeEmptyFoldersUpTo(absolute, join(projectDir, AGENT_SKILL_ROOTS[agent]))
    } catch (error) {
      failures.push(errorMessage(error))
      records.set(path, sha256)
    }
  }
  result.files.sort(byPath)

  const manifest: AgentSetupManifest = {
    format: 1,
    version: source.version,
    agents: result.agents,
    files: [...records].map(([path, sha256]) => ({ path, sha256 })),
    entries: previous?.entries ?? [],
  }
  try {
    writeAgentSetupManifest(projectDir, manifest)
  } catch (error) {
    failures.push(errorMessage(error))
  }
  result.parts.skills =
    failures.length === 0 ? { outcome: 'done' } : { outcome: 'failed', reason: failures[0] }
  return result
}
