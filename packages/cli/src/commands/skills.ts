import {
  guardJsonText,
  printRunText,
  reserveStdoutForData,
} from '@vostride/agent-qa-core/run-text-output'
import { Command, type CommanderError } from 'commander'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import pc from 'picocolors'
import { parse as parseYaml } from 'yaml'

import { CliRefusal } from '../composition/cli-refusal.js'
import {
  AgentRemovalFailure,
  CODING_AGENTS,
  removeAgentSetup,
  type AgentRemovalAgent,
  type AgentRemovalResult,
  type CodingAgent,
} from './agent-setup.js'
import { AGENT_SETUP_MANIFEST_PATH } from './agent-setup-manifest.js'
import { isInitRefusal } from './init-refusal.js'

export interface AgentQaSkillInfo {
  name: string
  path: string
  description?: string
}

export interface AgentQaSkillSummary {
  name: string
  shortDescription: string
}

export interface ResolvedSkillsDirectory {
  path: string
  source: 'package' | 'source' | 'missing'
}

interface SkillsCommandOptions {
  startDir?: string
  cwd?: string
  stdout?: Pick<NodeJS.WriteStream, 'write'>
  stderr?: Pick<NodeJS.WriteStream, 'write'>
}

function findPackageRoot(startDir: string): string {
  let current = resolve(startDir)

  while (true) {
    const packagePath = join(current, 'package.json')
    if (existsSync(packagePath)) {
      try {
        const pkg = JSON.parse(readFileSync(packagePath, 'utf-8')) as { name?: string }
        if (pkg.name === 'agent-qa') {
          return current
        }
      } catch {
        // Keep walking; malformed package files are reported by publish validation.
      }
    }

    const parent = dirname(current)
    if (parent === current) {
      return resolve(startDir)
    }
    current = parent
  }
}

function hasSkillDirectories(dir: string): boolean {
  if (!existsSync(dir)) return false

  try {
    return readdirSync(dir).some((entry) => {
      const skillDir = join(dir, entry)
      return statSync(skillDir).isDirectory() && existsSync(join(skillDir, 'SKILL.md'))
    })
  } catch {
    return false
  }
}

export function resolveAgentQaSkillsDirectory(startDir = dirname(fileURLToPath(import.meta.url))): ResolvedSkillsDirectory {
  const packageRoot = findPackageRoot(startDir)
  const packagedSkills = join(packageRoot, 'skills')
  if (hasSkillDirectories(packagedSkills)) {
    return { path: packagedSkills, source: 'package' }
  }

  const sourceSkills = resolve(packageRoot, '../..', 'skills')
  if (hasSkillDirectories(sourceSkills)) {
    return { path: sourceSkills, source: 'source' }
  }

  return { path: packagedSkills, source: 'missing' }
}


function parseSkillDescription(skillPath: string): string | undefined {
  const body = readFileSync(skillPath, 'utf-8')
  const description = body.match(/^description:\s*(.+)$/m)?.[1]?.trim()
  return description?.replace(/^["']|["']$/g, '')
}

export function listAgentQaSkills(skillsDir: string): AgentQaSkillInfo[] {
  if (!hasSkillDirectories(skillsDir)) return []

  return readdirSync(skillsDir)
    .filter((entry) => {
      const skillDir = join(skillsDir, entry)
      return statSync(skillDir).isDirectory() && existsSync(join(skillDir, 'SKILL.md'))
    })
    .sort()
    .map((entry) => {
      const skillDir = join(skillsDir, entry)
      return {
        name: entry,
        path: skillDir,
        description: parseSkillDescription(join(skillDir, 'SKILL.md')),
      }
    })
}

const SKILL_FRONTMATTER = /^\uFEFF?---\r?\n([\s\S]*?\r?\n)?---(?:\r?\n|$)/u

function fieldsOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : ''
}

function firstSentence(text: string): string {
  return text.match(/^.*?[.!?](?=\s|$)/u)?.[0] ?? text
}

export function skillSummary(skillMarkdown: string): AgentQaSkillSummary {
  const match = SKILL_FRONTMATTER.exec(skillMarkdown)
  const fields = fieldsOf(match === null ? undefined : parseYaml(match[1] ?? ''))
  const name = textOf(fields['name'])
  if (name === '') throw new Error('A SKILL.md frontmatter names no skill.')
  const shortDescription = textOf(fieldsOf(fields['metadata'])['short-description'])
  return {
    name,
    shortDescription: shortDescription || firstSentence(textOf(fields['description'])),
  }
}

export function runningAgentQaSkillSummaries(startDir?: string): AgentQaSkillSummary[] {
  return listAgentQaSkills(resolveAgentQaSkillsDirectory(startDir).path)
    .map((skill) => skillSummary(readFileSync(join(skill.path, 'SKILL.md'), 'utf-8')))
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
}

export function createSkillsCommand(options: SkillsCommandOptions = {}): Command {
  const stdout = options.stdout ?? process.stdout
  const stderr = options.stderr ?? process.stderr

  const cmd = new Command('skills')
    .description('List packaged agent-qa skills')
    .option('--json', 'print machine-readable output')
    .action((opts: { json?: boolean }) => {
      const releaseStdout = opts.json === true ? reserveStdoutForData() : undefined
      try {
        const resolved = resolveAgentQaSkillsDirectory(options.startDir)
        const skills = listAgentQaSkills(resolved.path)

        if (resolved.source === 'missing' || skills.length === 0) {
          const payload = { path: resolved.path, source: resolved.source, skills: [] }
          if (opts.json) {
            stdout.write(`${guardJsonText(JSON.stringify(payload, null, 2))}\n`)
          } else {
            stderr.write(`agent-qa skills not found at ${resolved.path}\n`)
          }
          process.exitCode = 1
          return
        }

        if (opts.json) {
          const payload = { path: resolved.path, source: resolved.source, skills }
          stdout.write(`${guardJsonText(JSON.stringify(payload, null, 2))}\n`)
          return
        }

        stdout.write(`agent-qa skills\n`)
        stdout.write(`Path: ${resolved.path}\n`)
        stdout.write(`Source: ${resolved.source}\n`)
        for (const skill of skills) {
          stdout.write(`- ${skill.name}${skill.description ? `: ${skill.description}` : ''}\n`)
        }
      } finally {
        releaseStdout?.()
      }
    })
    .addCommand(createSkillsUninstallCommand(options))

  cmd.exitOverride(commanderExit)
  return cmd
}

// Commander has printed its own line; its usage errors keep Commander's exit code.
function commanderExit(error: CommanderError): void {
  if (error.exitCode !== 0) throw new CliRefusal([], error.exitCode, { cause: error })
}

// Commander has printed its own line; a usage error exits 2, and help returns to exit 0.
function usageErrorExit(error: { exitCode: number }): void {
  if (error.exitCode !== 0) throw new CliRefusal([], 2, { cause: error })
}

const AGENT_LABELS: Readonly<Record<CodingAgent, string>> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
}

export function parseCodingAgentList(value: string): CodingAgent[] | undefined {
  const names = value.split(',').map((name) => name.trim())
  if (names.includes('all')) return undefined
  for (const name of names) {
    if (!(CODING_AGENTS as readonly string[]).includes(name)) {
      throw new CliRefusal(
        [pc.red(`Unknown coding agent "${name}". Use claude-code, codex or all.`)],
        2,
      )
    }
  }
  return CODING_AGENTS.filter((agent) => names.includes(agent))
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

function agentLines(report: AgentRemovalAgent, dryRun: boolean): string[] {
  const label = AGENT_LABELS[report.agent]
  const clauses: string[] = []
  if (report.skills > 0) clauses.push(`${plural(report.skills, 'skill')} from ${report.skillRoot}`)
  for (const entry of report.entries) {
    if (entry.outcome === 'removed') clauses.push(`the agent-qa entry from ${entry.file}`)
  }
  const what = clauses.length === 0 ? "nothing of agent-qa's" : clauses.join(' and ')
  const lines = [
    dryRun ? `- ${label}: would remove ${what}` : pc.green(`✓ ${label}: removed ${what}`),
  ]
  const edit = dryRun ? '  Would remove your edit:' : '  Removed your edit:'
  for (const file of report.files) if (file.edited) lines.push(`${edit} ${file.path}`)
  for (const entry of report.entries) {
    if (entry.edited) lines.push(`${edit} the agent-qa entry in ${entry.file}`)
  }
  return lines
}

function removalLines(result: AgentRemovalResult): string[] {
  if (!result.installed) {
    return [`agent-qa's skills and MCP entries are not installed in ${result.projectDir}.`]
  }
  const lines = result.removed.flatMap((report) => agentLines(report, result.dryRun))
  for (const agent of result.notInstalled) {
    lines.push(`- ${AGENT_LABELS[agent]}: not installed here`)
  }
  if (result.block.outcome === 'removed') {
    lines.push(
      result.dryRun
        ? '- AGENTS.md: would remove the agent-qa block'
        : pc.green('✓ AGENTS.md: removed the agent-qa block'),
    )
    if (result.block.edited) {
      const edit = result.dryRun ? '  Would remove your edit:' : '  Removed your edit:'
      lines.push(`${edit} the agent-qa block in AGENTS.md`)
    }
  }
  if (result.removed.length === 0 && result.manifest === 'removed') {
    lines.push(
      result.dryRun
        ? `- ${AGENT_SETUP_MANIFEST_PATH}: would remove it; it lists no coding agent`
        : pc.green(`✓ ${AGENT_SETUP_MANIFEST_PATH}: removed it; it listed no coding agent`),
    )
  }
  if (lines.length === 0) lines.push("Nothing of agent-qa's is installed for those coding agents.")
  lines.push(...result.notes)
  return lines
}

interface UninstallOptions {
  agents?: string
  dryRun?: boolean
}

export function createSkillsUninstallCommand(options: SkillsCommandOptions = {}): Command {
  const stdout = options.stdout ?? process.stdout

  const cmd = new Command('uninstall')
    .description(
      "Remove agent-qa's skills, MCP entries and AGENTS.md block from the project folder",
    )
    .option('--agents <list>', 'claude-code, codex or all, comma separated (default: all)')
    .option('--dry-run', 'print what would be removed and change nothing')
    .option('--json', 'print machine-readable output')
    .action(async (opts: UninstallOptions, command: Command) => {
      // `skills` has its own --json, which Commander gives the parent wherever it appears.
      const globals = command.optsWithGlobals<{ config?: string; json?: boolean }>()
      const json = globals.json === true
      const releaseStdout = json ? reserveStdoutForData() : undefined
      try {
        const agents = opts.agents === undefined ? undefined : parseCodingAgentList(opts.agents)
        const cwd = options.cwd ?? process.cwd()
        const config = resolve(cwd, globals.config ?? 'agent-qa.config.yaml')
        const result = await removeAgentSetup({
          projectDir: dirname(config),
          agents,
          dryRun: opts.dryRun === true,
        })
        if (json) {
          stdout.write(`${guardJsonText(JSON.stringify(result, null, 2))}\n`)
          return
        }
        for (const line of removalLines(result)) {
          printRunText(line, (text) => stdout.write(`${text}\n`))
        }
      } catch (error) {
        if (isInitRefusal(error)) {
          throw new CliRefusal([pc.red((error as Error).message)], 2, { cause: error })
        }
        if (error instanceof AgentRemovalFailure) {
          throw new CliRefusal([pc.red(error.message)], 3, { cause: error })
        }
        throw error
      } finally {
        releaseStdout?.()
      }
    })

  cmd.exitOverride(usageErrorExit)
  return cmd
}
