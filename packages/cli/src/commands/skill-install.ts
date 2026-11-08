import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { resolvePluginEntry, type AgentQaConfig } from '@vostride/agent-qa-core'
import { parse, parseDocument, Scalar } from 'yaml'

import { InitRefusal } from './init-refusal.js'
import { withoutBom } from './package-json-plan.js'
import { findProjectAgentQa } from './project-agent-qa.js'
import type { ProjectHost } from './project-host.js'
import { projectRange } from './project-range.js'
import { listAgentQaSkills, resolveAgentQaSkillsDirectory } from './skills.js'

const EXACT_SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u
const SKIPPED_FOLDERS = new Set(['node_modules', '.turbo', '.git', 'dist', 'scripts'])
const SKIPPED_FILES = new Set(['pnpm-lock.yaml', 'package-lock.json', '.DS_Store'])
const FRONTMATTER = /^---\n([\s\S]*?\n)?---(?:\n|$)/u

export const PLUGIN_SKILL_FOLDER_PREFIX = 'agent-qa-plugin-'

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
      return { sources: [], notes: [], configLoaded: true }
    }
    throw error
  }
  const sources: PluginSkillSource[] = []
  const taken = new Set<string>()
  for (const entry of plugins) {
    const folder = `${PLUGIN_SKILL_FOLDER_PREFIX}${entry.name}`
    if (taken.has(folder)) continue
    const resolved = resolvePluginEntry(entry, {
      configDir: projectDir,
      configPath,
      agentQaVersion: version,
    })
    const manifest = resolved.manifest
    if (
      resolved.state !== 'ok' ||
      manifest?.kind !== 'remote' ||
      manifest.skill === undefined ||
      resolved.packageDir === undefined ||
      resolved.version === undefined
    ) {
      continue
    }
    taken.add(folder)
    sources.push({
      folder,
      dir: resolve(resolved.packageDir, manifest.skill),
      version: resolved.version,
    })
  }
  return { sources, notes: [], configLoaded: true }
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
