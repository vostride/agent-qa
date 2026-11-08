import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'

import { classifyInitPath, writeScaffoldFileAtomic } from './init-filesystem.js'
import { InitRefusal } from './init-refusal.js'
import { withoutBom } from './package-json-plan.js'

export const CODING_AGENTS = ['claude-code', 'codex'] as const
export type CodingAgent = (typeof CODING_AGENTS)[number]

export const AGENT_SKILL_ROOTS: Readonly<Record<CodingAgent, string>> = {
  'claude-code': '.claude/skills',
  codex: '.agents/skills',
}

export const AGENT_SETUP_MANIFEST_PATH = '.agents/agent-qa-skills.json'
export const AGENT_SETUP_ENTRY_FILES = ['.mcp.json', '.codex/config.toml', 'AGENTS.md'] as const

const EXACT_SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u
const SHA256 = /^[0-9a-f]{64}$/u

// A path must name a file inside one skill folder of one agent: <root>/<skill>/<file...>.
export function agentOfManifestPath(path: string): CodingAgent | undefined {
  if (path.includes('\\')) return undefined
  const segments = path.split('/')
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return undefined
  }
  return CODING_AGENTS.find((agent) => {
    const root = AGENT_SKILL_ROOTS[agent].split('/')
    return segments.length >= root.length + 2 && root.every((part, i) => segments[i] === part)
  })
}

const ManifestFileSchema = z
  .object({
    path: z.string().refine((path) => agentOfManifestPath(path) !== undefined, {
      message: 'must be a relative path inside .claude/skills/<skill>/ or .agents/skills/<skill>/',
    }),
    sha256: z.string().regex(SHA256, 'must be a lowercase sha256 hex digest'),
  })
  .strict()

const ManifestEntrySchema = z
  .object({
    file: z.enum(AGENT_SETUP_ENTRY_FILES),
    key: z.string().min(1),
    sha256: z.string().regex(SHA256, 'must be a lowercase sha256 hex digest'),
  })
  .strict()

export const AgentSetupManifestSchema = z
  .object({
    format: z.literal(1),
    version: z.string().regex(EXACT_SEMVER, 'must be an exact version'),
    agents: z.array(z.enum(CODING_AGENTS)),
    files: z.array(ManifestFileSchema).refine(
      (files) => new Set(files.map((file) => file.path)).size === files.length,
      { message: 'lists a path twice' },
    ),
    entries: z.array(ManifestEntrySchema),
  })
  .strict()

export type AgentSetupManifest = z.infer<typeof AgentSetupManifestSchema>

function malformed(reason: string): InitRefusal {
  return new InitRefusal(`Refusing malformed ${AGENT_SETUP_MANIFEST_PATH}: ${reason}.`)
}

export function readAgentSetupManifest(projectDir: string): AgentSetupManifest | undefined {
  const path = join(projectDir, AGENT_SETUP_MANIFEST_PATH)
  if (classifyInitPath(path, projectDir) === 'missing') return undefined
  let value: unknown
  try {
    value = JSON.parse(withoutBom(readFileSync(path, 'utf-8')))
  } catch (error) {
    // The parser quotes the offending text, which can span lines; the refusal stays on one.
    const message = (error instanceof Error ? error.message : String(error)).replace(/\s+/gu, ' ')
    throw malformed(`it is not valid JSON (${message.trim()})`)
  }
  const parsed = AgentSetupManifestSchema.safeParse(value)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const where = issue?.path.length ? `${issue.path.join('.')} ` : ''
    throw malformed(`${where}${issue?.message ?? 'does not match the manifest format'}`)
  }
  return parsed.data
}

export function writeAgentSetupManifest(projectDir: string, manifest: AgentSetupManifest): void {
  const ordered: AgentSetupManifest = {
    format: manifest.format,
    version: manifest.version,
    agents: CODING_AGENTS.filter((agent) => manifest.agents.includes(agent)),
    files: [...manifest.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    entries: manifest.entries,
  }
  writeScaffoldFileAtomic({
    path: join(projectDir, AGENT_SETUP_MANIFEST_PATH),
    root: projectDir,
    content: `${JSON.stringify(ordered, null, 2)}\n`,
    force: true,
  })
}
