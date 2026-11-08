import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { isPathInsideDir, resolvePluginEntry, type AgentQaConfig } from '@vostride/agent-qa-core'
import { parse, parseDocument, Scalar } from 'yaml'

import { InitRefusal } from './init-refusal.js'
import { withoutBom } from './package-json-plan.js'
import { findProjectAgentQa } from './project-agent-qa.js'
import type { ProjectHost } from './project-host.js'
import { projectRange } from './project-range.js'
import { listAgentQaSkills, resolveAgentQaSkillsDirectory } from './skills.js'

const EXACT_SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u
const SKIPPED_FOLDERS = new Set(['node_modules', '.turbo', '.git', 'dist'])
const SKIPPED_FILES = new Set(['pnpm-lock.yaml', 'package-lock.json', '.DS_Store'])
const FRONTMATTER = /^---\n([\s\S]*?\n)?---(?:\n|$)/u

export const PLUGIN_SKILL_FOLDER_PREFIX = 'agent-qa-plugin-'
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u
const SKILL_NAME_MAX_LENGTH = 64

export interface AgentQaSkillSource {
  dir: string
  version: string
  source: 'project' | 'running'
}

export interface PluginSkillSource {
  folder: string
  dir: string
  version: string
}

export interface PluginSkillSources {
  sources: PluginSkillSource[]
  held: string[]
  notes: string[]
  configLoaded: boolean
}

export interface SkillFile {
  path: string
  bytes: Buffer
}

function runningVersion(host: Pick<ProjectHost, 'io' | 'runningPackageDir'>): string {
  const manifest = join(host.runningPackageDir, 'package.json')
  let version: unknown
  try {
    version = (JSON.parse(withoutBom(host.io.readText(manifest) ?? '')) as { version?: unknown })
      .version
  } catch {
    version = undefined
  }
  if (typeof version !== 'string' || !EXACT_SEMVER.test(version)) {
    throw new InitRefusal(`Unable to read the running agent-qa's version from ${manifest}.`)
  }
  return version
}

export async function resolveAgentQaSkillSource(
  projectDir: string,
  host: Pick<ProjectHost, 'homedir' | 'io' | 'runningPackageDir'>,
): Promise<AgentQaSkillSource> {
  const range = await projectRange(projectDir, host)
  const found = await findProjectAgentQa(range, range.start, host.io)
  const source: AgentQaSkillSource =
    found !== undefined
      ? { dir: join(found.realDir, 'skills'), version: found.version, source: 'project' }
      : {
          dir: resolveAgentQaSkillsDirectory(host.runningPackageDir).path,
          version: runningVersion(host),
          source: 'running',
        }
  if (listAgentQaSkills(source.dir).length === 0) {
    throw new InitRefusal(`No agent-qa skills were found in ${source.dir}.`)
  }
  return source
}

// Listing a plugin is the trust decision, so each listed plugin's own skill installs beside ours.
// A listed entry whose skill cannot be read now is held: its installed files stay as they are.
export async function pluginSkillSources(
  projectDir: string,
  version: string,
): Promise<PluginSkillSources> {
  const configPath = join(projectDir, 'agent-qa.config.yaml')
  const { ConfigFileNotFoundError, resolveConfig } = await import('../config.js')
  let plugins: NonNullable<AgentQaConfig['plugins']>
  try {
    plugins = (await resolveConfig({ configPath, loadAuthPlugins: false })).plugins ?? []
  } catch (error) {
    if (error instanceof ConfigFileNotFoundError) {
      return { sources: [], held: [], notes: [], configLoaded: true }
    }
    return {
      sources: [],
      held: [],
      notes: [`Plugin skills were not updated: ${firstProblem(error)}. Run npx agent-qa validate.`],
      configLoaded: false,
    }
  }
  const result: PluginSkillSources = { sources: [], held: [], notes: [], configLoaded: true }
  const taken = new Set<string>()
  for (const entry of plugins) {
    const folder = `${PLUGIN_SKILL_FOLDER_PREFIX}${entry.name}`
    if (taken.has(folder)) continue
    taken.add(folder)
    if (!SKILL_NAME.test(folder) || folder.length > SKILL_NAME_MAX_LENGTH) {
      result.notes.push(
        `Plugin ${entry.name}: ${folder} is not a valid skill name (lowercase letters, digits ` +
          `and single hyphens, at most ${SKILL_NAME_MAX_LENGTH} characters), so its skill is not ` +
          'installed.',
      )
      continue
    }
    const skipped = (note: string): void => {
      result.held.push(folder)
      result.notes.push(note)
    }
    const resolved = resolvePluginEntry(entry, {
      configDir: projectDir,
      configPath,
      agentQaVersion: version,
    })
    if (resolved.state !== 'ok') {
      skipped(
        `${resolved.reason ?? `Plugin entry ${entry.name} is ${resolved.state}.`} Its skill is not installed.`,
      )
      continue
    }
    const manifest = resolved.manifest
    if (manifest?.kind !== 'remote' || manifest.skill === undefined) continue
    if (resolved.packageDir === undefined || !resolved.version) {
      skipped(
        `Plugin ${entry.name}: its package.json has no version, so its skill is not installed.`,
      )
      continue
    }
    const dir = containedSkillDir(resolved.packageDir, manifest.skill)
    if (dir === 'outside') {
      skipped(
        `Plugin ${entry.name}: its skill path ${manifest.skill} leaves its package, so its skill ` +
          'is not installed.',
      )
    } else if (dir === 'missing') {
      skipped(
        `Plugin ${entry.name}: its skill path ${manifest.skill} holds no SKILL.md, so its skill ` +
          'is not installed.',
      )
    } else {
      result.sources.push({ folder, dir, version: resolved.version })
    }
  }
  return result
}

// Both sides are real paths, so a symlinked skill folder is judged by where it points.
function containedSkillDir(packageDir: string, skill: string): string | 'outside' | 'missing' {
  let realPackage: string
  let realSkill: string
  try {
    realPackage = realpathSync(packageDir)
    realSkill = realpathSync(resolve(realPackage, skill))
  } catch {
    return 'missing'
  }
  if (!isPathInsideDir(realSkill, realPackage)) return 'outside'
  try {
    return lstatSync(join(realSkill, 'SKILL.md')).isFile() ? realSkill : 'missing'
  } catch {
    return 'missing'
  }
}

function firstProblem(error: unknown): string {
  const lines = (error instanceof Error ? error.message : String(error))
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
  const first = lines[0] ?? 'the config did not load'
  const problem = first.endsWith(':') && lines[1] !== undefined ? `${first} ${lines[1]}` : first
  return problem.replace(/\.+$/u, '')
}

// Symlinks are skipped, never followed, so nothing outside the skill folder is read.
export function readSkillFiles(skillDir: string): SkillFile[] {
  const files: SkillFile[] = []
  const walk = (folder: string, prefix: string): void => {
    for (const name of readdirSync(folder).sort()) {
      const path = join(folder, name)
      const stat = lstatSync(path)
      const relativePath = prefix === '' ? name : `${prefix}/${name}`
      if (stat.isDirectory()) {
        if (!SKIPPED_FOLDERS.has(name)) walk(path, relativePath)
      } else if (stat.isFile() && !SKIPPED_FILES.has(name)) {
        files.push({ path: relativePath, bytes: readFileSync(path) })
      }
    }
  }
  walk(skillDir, '')
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

export function stampSkillFrontmatter(
  text: string,
  stamp: { version: string; name?: string },
): string {
  const match = FRONTMATTER.exec(text)
  if (match === null) throw new InitRefusal('Refusing to stamp a SKILL.md with no frontmatter.')
  const doc = parseDocument(match[1] ?? '')
  if (doc.errors.length > 0) {
    throw new InitRefusal(`Refusing to stamp a SKILL.md: ${doc.errors[0]?.message ?? 'bad YAML'}`)
  }
  const version = new Scalar(stamp.version)
  version.type = Scalar.QUOTE_DOUBLE
  try {
    doc.setIn(['metadata', 'version'], version)
    if (stamp.name !== undefined) doc.set('name', stamp.name)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new InitRefusal(`Refusing to stamp a SKILL.md: ${message}`)
  }
  const stamped = `---\n${doc.toString({ lineWidth: 0 })}---\n${text.slice(match[0].length)}`
  const check = parse(doc.toString({ lineWidth: 0 })) as { metadata?: { version?: unknown } }
  if (check.metadata?.version !== stamp.version) {
    throw new InitRefusal('Refusing to stamp a SKILL.md: the version did not survive a re-parse.')
  }
  return stamped
}

export function sha256Of(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}
