import { join } from 'node:path'
import pc from 'picocolors'

import { CliRefusal } from '../composition/cli-refusal.js'
import { CODING_AGENTS, type CodingAgent } from './agent-setup-manifest.js'
import { defaultProjectIo, type ProjectIo } from './project-host.js'
import { parseCodingAgentList } from './skills.js'

export interface InitAgentOption {
  value: CodingAgent
  label: string
  hint: string
}

export const INIT_AGENT_OPTIONS: readonly InitAgentOption[] = [
  { value: 'claude-code', label: 'Claude Code', hint: '.claude/skills, .mcp.json' },
  { value: 'codex', label: 'Codex', hint: '.agents/skills, .codex/config.toml' },
]

const PROJECT_MARKERS: Readonly<Record<CodingAgent, readonly string[]>> = {
  'claude-code': ['.claude', 'CLAUDE.md', '.mcp.json'],
  codex: ['.codex', '.agents'],
}

const HOME_MARKERS: Readonly<Record<CodingAgent, readonly string[]>> = {
  'claude-code': ['.claude', '.claude.json'],
  codex: ['.codex'],
}

const HOST_AGENTS: Readonly<Record<string, CodingAgent>> = {
  claude_code: 'claude-code',
  codex: 'codex',
}

export interface DetectCodingAgentsOptions {
  projectDir: string
  homeDir: string
  env: Record<string, string | undefined>
  io?: Pick<ProjectIo, 'exists'>
}

// Existence only: these files can hold account data, so nothing here reads them.
export async function detectCodingAgents(
  options: DetectCodingAgentsOptions,
): Promise<CodingAgent[]> {
  const io = options.io ?? defaultProjectIo
  // Loaded lazily, as init loads analytics.
  const { resolveAnalyticsAgentProduct } = await import('@vostride/agent-qa-analytics')
  const product = resolveAnalyticsAgentProduct(options.env)
  const host = product === undefined ? undefined : HOST_AGENTS[product]
  const detected = CODING_AGENTS.filter(
    (agent) =>
      agent === host ||
      PROJECT_MARKERS[agent].some((marker) => io.exists(join(options.projectDir, marker))) ||
      HOME_MARKERS[agent].some((marker) => io.exists(join(options.homeDir, marker))),
  )
  return detected.length === 0 ? [...CODING_AGENTS] : detected
}

const AGENT_NAMES_HINT = 'Use claude-code, codex, all or none.'
const ACCEPTED_ENTRIES: readonly string[] = [...CODING_AGENTS, 'all', 'none']

export function parseInitAgentsFlag(value: string): CodingAgent[] {
  const names = value.split(',').map((name) => name.trim())
  for (const name of names) {
    if (!ACCEPTED_ENTRIES.includes(name)) {
      throw new CliRefusal([pc.red(`Unknown coding agent "${name}". ${AGENT_NAMES_HINT}`)], 2)
    }
  }
  if (names.includes('none')) {
    if (names.length > 1) {
      throw new CliRefusal(
        [pc.red(`--agents none cannot be combined with other agents. ${AGENT_NAMES_HINT}`)],
        2,
      )
    }
    return []
  }
  return parseCodingAgentList(value) ?? [...CODING_AGENTS]
}
