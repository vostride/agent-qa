import { dirname, resolve } from 'node:path'

import { validSemverVersion, type LatestAgentQaAnswer } from '@vostride/agent-qa-core'

import { AGENT_MCP_FILES, CODING_AGENTS, type CodingAgent } from './agent-setup.js'
import { AGENT_SETUP_MANIFEST_PATH, readAgentSetupManifest } from './agent-setup-manifest.js'
import { guideLines, versionMove } from './agent-qa-upgrade.js'
import type { CheckResult, DoctorCheck } from './doctor.js'
import { readProjectPackageJson } from './package-json-plan.js'
import type { LatestVersionAsk } from './latest-version-ask.js'
import { installedPackageVersion } from './package-install.js'
import { declaredAgentQaVersion } from './project-agent-qa.js'
import { projectHost, type ProjectHost } from './project-host.js'
import { projectRange, type ProjectRange } from './project-range.js'
import {
  agentLabel,
  checkAgentRows,
  checkDepsRow,
  configuredPackages,
  packageLabel,
  skillsState,
  type AgentRowsCheck,
  type DepsRowState,
  type SetupRowName,
} from './setup-rows.js'

export interface SetupChecksInput {
  configPath: string
  host: Partial<ProjectHost>
  // The agent-qa running doctor, which may be another copy than the project's.
  runningVersion: string
}

function setupFix(row: SetupRowName | 'deps,skills'): string {
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
  return wouldChange ? { status: 'warn', message, fix: setupFix(row) } : { status: 'pass', message }
}

function mcpMessage(agent: CodingAgent, rows: AgentRowsCheck): string {
  const file = AGENT_MCP_FILES[agent]
  const outcome = rows.perAgent[agent]?.mcp.files[0]?.outcome
  if (outcome === 'created') return `no agent-qa entry in ${file}`
  if (rows.perAgent[agent]?.mcp.wouldChange === true) return `the agent-qa entry in ${file} differs`
  return 'current'
}

interface ProjectInstall {
  range: ProjectRange
  packageJson: { path: string; text: string | undefined }
  agentQa: string | undefined
}

async function projectInstall(configPath: string, host: ProjectHost): Promise<ProjectInstall> {
  const range = await projectRange(dirname(configPath), host)
  const packageJson = readProjectPackageJson(range, host.io)
  const fromDir = packageJson.text === undefined ? range.start : dirname(packageJson.path)
  const installed = installedPackageVersion(range, fromDir, 'agent-qa', host.io)
  return { range, packageJson, agentQa: typeof installed === 'string' ? installed : undefined }
}

// The project's installed agent-qa, else the running one; the plugin rows compare against it.
export async function projectAgentQaVersion(input: SetupChecksInput): Promise<string> {
  try {
    const install = await projectInstall(resolve(input.configPath), projectHost(input.host))
    return install.agentQa ?? input.runningVersion
  } catch {
    return input.runningVersion
  }
}

// The deps row's own report of what the project declares and has installed, at its version.
async function projectPackages(
  input: SetupChecksInput,
  configPath: string,
  host: ProjectHost,
): Promise<DepsRowState> {
  const { range, packageJson, agentQa } = await projectInstall(configPath, host)
  const version = agentQa ?? declaredAgentQaVersion(packageJson.text) ?? input.runningVersion
  return checkDepsRow({
    range,
    packageJson,
    config: configuredPackages(host.io.readText(configPath)),
    version,
    from: version,
    io: host.io,
  })
}

function versionsResult(
  deps: DepsRowState,
  skills: string | undefined,
  running: string,
): CheckResult {
  const agentQa = deps.packages.find((pkg) => pkg.name === 'agent-qa')
  if (agentQa?.declared === true && agentQa.installed === undefined) {
    return { status: 'fail', message: 'agent-qa declared, not installed', fix: setupFix('deps') }
  }
  const project = agentQa?.installed ?? running
  const installedPlugins = deps.packages.flatMap((pkg) =>
    pkg.name === 'agent-qa' || pkg.installed === undefined
      ? []
      : [{ label: packageLabel(pkg.name), version: pkg.installed }],
  )
  const message = [
    ['agent-qa', project],
    ...(skills === undefined ? [] : [['skills', skills]]),
    ...installedPlugins.map((plugin) => [plugin.label, plugin.version]),
    ...(running === project ? [] : [['this agent-qa', running]]),
  ]
    .map((part) => part.join(' '))
    .join(', ')
  const packageDiffers = installedPlugins.some((plugin) => plugin.version !== project)
  const skillsDiffer = skills !== undefined && skills !== project
  if (packageDiffers) {
    return { status: 'warn', message, fix: setupFix(skillsDiffer ? 'deps,skills' : 'deps') }
  }
  if (skillsDiffer) return { status: 'warn', message, fix: setupFix('skills') }
  return { status: 'pass', message }
}

function versionsCheck(
  input: SetupChecksInput,
  configPath: string,
  host: ProjectHost,
  skills: string | undefined,
): DoctorCheck {
  return {
    name: 'agent-qa versions',
    fixInstructions: setupFix('deps'),
    check: async () => {
      let deps: DepsRowState
      try {
        deps = await projectPackages(input, configPath, host)
      } catch (error) {
        return { status: 'warn', message: oneLine(error), fix: refusedFix('deps') }
      }
      return versionsResult(deps, skills, input.runningVersion)
    },
  }
}

// The project folder is the config's, where init sets up the coding agents. Every agent row reads
// one dry run of the installer, the same one the re-run's menu pre-checks with.
export function createSetupChecks(input: SetupChecksInput): DoctorCheck[] {
  const host = projectHost(input.host)
  const configPath = resolve(input.configPath)
  const projectDir = dirname(configPath)
  let manifest: ReturnType<typeof readAgentSetupManifest>
  try {
    manifest = readAgentSetupManifest(projectDir)
  } catch (error) {
    return [
      versionsCheck(input, configPath, host, undefined),
      {
        name: 'Coding agents',
        fixInstructions: MANIFEST_FIX,
        check: async () => ({ status: 'warn', message: oneLine(error) }),
      },
    ]
  }
  const versions = versionsCheck(input, configPath, host, manifest?.version)
  const agents = CODING_AGENTS.filter((agent) => manifest?.agents.includes(agent) === true)
  if (agents.length === 0) {
    return [
      versions,
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
    versions,
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

export interface NewerVersionInput {
  // The project's installed agent-qa, else the running one.
  projectVersion: string
  latestVersion: LatestVersionAsk
  homeDir: string
  now?: () => Date
}

const PRODUCT = 'agent-qa'
const COULD_NOT_CHECK: CheckResult = { status: 'skip', message: 'could not check' }

// Only versions that pass semver reach the message or a link, so registry text never does.
export function createNewerVersionCheck(input: NewerVersionInput): DoctorCheck {
  return {
    name: 'Newer agent-qa',
    fixInstructions: setupFix('upgrade'),
    check: async () => {
      let answer: LatestAgentQaAnswer
      try {
        answer = await input.latestVersion(input.homeDir, input.now)
      } catch {
        return COULD_NOT_CHECK
      }
      const latest =
        answer.source === 'none' || answer.latestVersion === undefined
          ? undefined
          : validSemverVersion(answer.latestVersion)
      const project = validSemverVersion(input.projectVersion)
      if (latest === undefined || project === undefined) return COULD_NOT_CHECK
      const move = versionMove(project, latest)
      if (move === undefined) return { status: 'pass', message: `you're on the latest, ${project}` }
      return {
        status: 'warn',
        message: `${PRODUCT} ${move.to} is out; you're on ${move.from}`,
        fix: move.breaking ? guideLines(move).join('\n') : setupFix('upgrade'),
      }
    },
  }
}
