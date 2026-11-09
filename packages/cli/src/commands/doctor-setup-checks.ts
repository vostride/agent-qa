import { dirname, resolve } from 'node:path'

import { AGENT_MCP_FILES, CODING_AGENTS, type CodingAgent } from './agent-setup.js'
import { AGENT_SETUP_MANIFEST_PATH, readAgentSetupManifest } from './agent-setup-manifest.js'
import type { CheckResult, DoctorCheck } from './doctor.js'
import { projectHost, type ProjectHost } from './project-host.js'
import {
  agentLabel,
  checkAgentRows,
  skillsState,
  type AgentRowsCheck,
  type SetupRowName,
} from './setup-rows.js'

export interface SetupChecksInput {
  configPath: string
  host: Partial<ProjectHost>
}

function setupFix(row: SetupRowName): string {
  return `Run \`npx agent-qa init --setup ${row}\`.`
}

function refusedFix(row: SetupRowName): string {
  return `Repair the file the message names, then run \`npx agent-qa init --setup ${row}\`.`
}

const MANIFEST_FIX = `Repair or remove ${AGENT_SETUP_MANIFEST_PATH}, then run \`npx agent-qa init --setup skills\`.`

function oneLine(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/gu, ' ').trim()
}

function changed(wouldChange: boolean, message: string, row: SetupRowName): CheckResult {
  return wouldChange
    ? { status: 'warn', message, fix: setupFix(row) }
    : { status: 'pass', message }
}

function mcpMessage(agent: CodingAgent, rows: AgentRowsCheck): string {
  const file = AGENT_MCP_FILES[agent]
  const outcome = rows.perAgent[agent]?.mcp.files[0]?.outcome
  if (outcome === 'created') return `no agent-qa entry in ${file}`
  if (rows.perAgent[agent]?.mcp.wouldChange === true) return `the agent-qa entry in ${file} differs`
  return 'current'
}

// The project folder is the config's, where init sets up the coding agents. Every agent row reads
// one dry run of the installer, the same one the re-run's menu pre-checks with.
export function createSetupChecks(input: SetupChecksInput): DoctorCheck[] {
  const host = projectHost(input.host)
  const configPath = resolve(input.configPath)
  const projectDir = dirname(configPath)
  let agents: CodingAgent[]
  try {
    const setUp = readAgentSetupManifest(projectDir)?.agents ?? []
    agents = CODING_AGENTS.filter((agent) => setUp.includes(agent))
  } catch (error) {
    return [
      {
        name: 'Coding agents',
        fixInstructions: MANIFEST_FIX,
        check: async () => ({ status: 'warn', message: oneLine(error) }),
      },
    ]
  }
  if (agents.length === 0) {
    return [
      {
        name: 'Coding agents',
        fixInstructions: setupFix('skills'),
        check: async () => ({ status: 'skip', message: 'no coding agent set up' }),
      },
    ]
  }

  let pending: Promise<AgentRowsCheck> | undefined
  const agentRows = (): Promise<AgentRowsCheck> =>
    (pending ??= checkAgentRows({ projectDir, configPath, io: host.io, agents, host: input.host }))
  const row = (
    name: string,
    setupRow: SetupRowName,
    read: (rows: AgentRowsCheck) => CheckResult,
  ): DoctorCheck => ({
    name,
    fixInstructions: setupFix(setupRow),
    check: async () => {
      let rows: AgentRowsCheck
      try {
        rows = await agentRows()
      } catch (error) {
        return { status: 'warn', message: oneLine(error), fix: refusedFix(setupRow) }
      }
      return read(rows)
    },
  })

  return [
    ...agents.map((agent) =>
      row(`Skills (${agentLabel(agent)})`, 'skills', (rows) =>
        changed(
          rows.perAgent[agent]?.skills.wouldChange === true,
          skillsState([agent], rows.perAgent, rows.version ?? ''),
          'skills',
        ),
      ),
    ),
    ...agents.map((agent) =>
      row(`MCP entry (${agentLabel(agent)})`, 'mcp', (rows) =>
        changed(rows.perAgent[agent]?.mcp.wouldChange === true, mcpMessage(agent, rows), 'mcp'),
      ),
    ),
    row('AGENTS.md block', 'agents-md', (rows) =>
      changed(rows['agents-md'].wouldChange, rows['agents-md'].state, 'agents-md'),
    ),
  ]
}
