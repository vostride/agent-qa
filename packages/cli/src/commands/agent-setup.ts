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
import { classifyInitPath, writeScaffoldFileAtomic } from './init-filesystem.js'
import { projectHost, type ProjectHost } from './project-host.js'
import {
  readSkillFiles,
  resolveAgentQaSkillSource,
  sha256Of,
  stampSkillFrontmatter,
  type AgentQaSkillSource,
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

function planSkillFiles(source: AgentQaSkillSource, agents: readonly CodingAgent[]): PlannedFile[] {
  const planned: PlannedFile[] = []
  for (const skill of listAgentQaSkills(source.dir)) {
    const files = readSkillFiles(skill.path).map((file) =>
      file.path === 'SKILL.md'
        ? {
            path: file.path,
            bytes: Buffer.from(
              stampSkillFrontmatter(file.bytes.toString('utf-8'), { version: source.version }),
            ),
          }
        : file,
    )
    for (const agent of agents) {
      for (const file of files) {
        const path = `${AGENT_SKILL_ROOTS[agent]}/${skill.name}/${file.path}`
        if (agentOfManifestPath(path) === agent) planned.push({ path, bytes: file.bytes })
      }
    }
  }
  return planned.sort(byPath)
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

  const records: AgentSetupManifest['files'] = []
  const failures: string[] = []
  for (const file of planSkillFiles(source, chosen)) {
    const absolute = join(projectDir, file.path)
    try {
      const hash = sha256Of(file.bytes)
      const existing =
        classifyInitPath(absolute, projectDir) === 'regular' ? readFileSync(absolute) : undefined
      if (existing !== undefined && sha256Of(existing) === hash) {
        result.files.push({ path: file.path, outcome: 'unchanged' })
      } else {
        writeScaffoldFileAtomic({
          path: absolute,
          root: projectDir,
          content: file.bytes,
          force: true,
        })
        result.files.push({
          path: file.path,
          outcome: existing === undefined ? 'created' : 'updated',
        })
      }
      records.push({ path: file.path, sha256: hash })
    } catch (error) {
      failures.push(errorMessage(error))
    }
  }

  const manifest: AgentSetupManifest = {
    format: 1,
    version: source.version,
    agents: result.agents,
    files: records,
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
