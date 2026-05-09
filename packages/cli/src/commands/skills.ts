import { Command } from 'commander'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface AgentQaSkillInfo {
  name: string
  path: string
  description?: string
}

export interface ResolvedSkillsDirectory {
  path: string
  source: 'package' | 'source' | 'missing'
}

interface SkillsCommandOptions {
  startDir?: string
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


export function createSkillsCommand(options: SkillsCommandOptions = {}): Command {
  const stdout = options.stdout ?? process.stdout
  const stderr = options.stderr ?? process.stderr

  return new Command('skills')
    .description('List packaged agent-qa skills')
    .option('--json', 'print machine-readable output')
    .action((opts: { json?: boolean }) => {
      const resolved = resolveAgentQaSkillsDirectory(options.startDir)
      const skills = listAgentQaSkills(resolved.path)

      if (resolved.source === 'missing' || skills.length === 0) {
        const payload = { path: resolved.path, source: resolved.source, skills: [] }
        if (opts.json) {
          stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
        } else {
          stderr.write(`agent-qa skills not found at ${resolved.path}\n`)
        }
        process.exitCode = 1
        return
      }

      if (opts.json) {
        stdout.write(`${JSON.stringify({ path: resolved.path, source: resolved.source, skills }, null, 2)}\n`)
        return
      }

      stdout.write(`agent-qa skills\n`)
      stdout.write(`Path: ${resolved.path}\n`)
      stdout.write(`Source: ${resolved.source}\n`)
      for (const skill of skills) {
        stdout.write(`- ${skill.name}${skill.description ? `: ${skill.description}` : ''}\n`)
      }
    })
}
