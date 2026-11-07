import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import type { PluginManifest } from '@vostride/agent-qa-plugin-kit/protocol'
import { parse as parseYaml } from 'yaml'

import { findPackageJson } from '../plugin-loader-util.js'
import { schemaFieldsOf } from './describe.js'
import { readPluginManifest } from './manifest.js'
import { MAX_PLUGIN_SCHEMA_BYTES, loadPluginSchema } from './options-check.js'
import { pluginInstallLine, supportedPluginProtocols } from './resolve-entries.js'

export interface PluginPackageCheck {
  name: string
  ok: boolean
  detail?: string
  warning?: boolean
}

export interface PluginPackageReport {
  packageDir?: string
  remote: boolean
  checks: PluginPackageCheck[]
}

export interface ValidatePluginPackageOptions {
  configDir: string
  agentQaVersion: string
  cwd?: string
}

type JsonObject = Record<string, unknown>
type Scope = 'options' | 'settings'

interface SchemaFile {
  scope: Scope
  file: string
}

const DRAFT_2020_12 = /^https:\/\/json-schema\.org\/draft\/2020-12\/schema#?$/
const CODE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.sh', '.py'])
const CREDENTIAL_TERM =
  /token|secret|password|passwd|passphrase|api[-_]?key|access[-_]?key|private[-_]?key|credential/i
const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall']
const AGENT_QA_PACKAGE = /^(agent-qa|@vostride\/agent-qa(-.+)?)$/
const PLUGIN_KEYWORD = 'agent-qa-plugin'
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function passed(name: string): PluginPackageCheck {
  return { name, ok: true }
}

function failed(name: string, problems: readonly string[]): PluginPackageCheck {
  return problems.length === 0 ? passed(name) : { name, ok: false, detail: problems.join('; ') }
}

function warned(name: string, problems: readonly string[]): PluginPackageCheck {
  return problems.length === 0
    ? passed(name)
    : { name, ok: true, warning: true, detail: problems.join('; ') }
}

function shown(path: string): string {
  return path.split(sep).join('/')
}

function isPathTarget(target: string): boolean {
  if (target.startsWith('.') || isAbsolute(target)) return true
  return !target.startsWith('@') && (target.includes('/') || target.includes('\\'))
}

function locate(
  target: string,
  options: ValidatePluginPackageOptions,
): { packageJsonPath: string } | { check: PluginPackageCheck } {
  if (isPathTarget(target)) {
    const packageJsonPath = join(resolve(options.cwd ?? process.cwd(), target), 'package.json')
    if (existsSync(packageJsonPath)) return { packageJsonPath }
    return { check: failed('package', [`${target} has no package.json`]) }
  }
  const packageJsonPath = findPackageJson(target, options.configDir)
  if (packageJsonPath !== null) return { packageJsonPath }
  const install = pluginInstallLine({ name: target, package: target })
  if (install === undefined) {
    return { check: failed('package', [`${target} is not an npm package name or a folder`]) }
  }
  return {
    check: failed('package', [`${target} is not installed in this project. Run ${install}.`]),
  }
}

function manifestCheck(manifest: PluginManifest): PluginPackageCheck {
  if (manifest.kind !== 'remote') return passed('manifest')
  const window = supportedPluginProtocols()
  if (window.includes(manifest.protocol)) return passed('manifest')
  return failed('manifest', [
    `the manifest speaks plugin protocol ${manifest.protocol}; this agent-qa speaks `
      + `${window.join(' and ')}`,
  ])
}

function declaredSchemaOf(packageDir: string, file: string): unknown {
  const path = resolve(packageDir, file)
  try {
    if (statSync(path).size > MAX_PLUGIN_SCHEMA_BYTES) return undefined
    return JSON.parse(readFileSync(path, 'utf-8'))
  } catch {
    return undefined
  }
}

function draftProblem(file: string, schema: unknown): string | undefined {
  if (!isObject(schema)) return undefined
  if (typeof schema.$schema !== 'string') return `${file} names no $schema`
  if (DRAFT_2020_12.test(schema.$schema)) return undefined
  return `${file} names ${schema.$schema}, not JSON Schema draft 2020-12`
}

function checkSchemas(
  packageDir: string,
  files: readonly SchemaFile[],
): { check: PluginPackageCheck; loaded: { scope: Scope; schema: JsonObject }[] } {
  const problems: string[] = []
  const loaded: { scope: Scope; schema: JsonObject }[] = []
  for (const { scope, file } of files) {
    const declared = declaredSchemaOf(packageDir, file)
    const draft = draftProblem(file, declared)
    if (draft !== undefined) {
      problems.push(draft)
      continue
    }
    const schema = loadPluginSchema(packageDir, file)
    if (schema.ok) loaded.push({ scope, schema: schema.schema })
    else problems.push(schema.message)
  }
  return { check: failed('schemas', problems), loaded }
}

function checkCredentialMarks(loaded: readonly { scope: Scope; schema: JsonObject }[]) {
  const problems = loaded.flatMap(({ scope, schema }) =>
    schemaFieldsOf(schema)
      .filter((field) => !field.credential && field.type.includes('string'))
      .filter((field) => CREDENTIAL_TERM.test(field.path.split('.').at(-1) ?? ''))
      .map(
        (field) =>
          `${scope}.${field.path} looks like a credential and has no credential mark; mark it `
          + 'with credential() so config must hold a {{secret:NAME}} reference',
      ),
  )
  return warned('credential-marks', problems)
}

function codeFiles(root: string, dir: string = root): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    const stats = lstatSync(path)
    if (stats.isDirectory()) return codeFiles(root, path)
    const code =
      stats.isSymbolicLink()
      || CODE_EXTENSIONS.has(extname(name).toLowerCase())
      || (stats.mode & 0o111) !== 0
    return code ? [shown(relative(root, path))] : []
  })
}

function frontmatterProblems(skillFile: string, text: string): string[] {
  const match = FRONTMATTER.exec(text)
  let fields: unknown
  try {
    fields = match === null ? undefined : parseYaml(match[1] ?? '')
  } catch {
    return [`${skillFile} frontmatter is not YAML`]
  }
  if (!isObject(fields)) return [`${skillFile} has no frontmatter with name and description`]
  return (['name', 'description'] as const)
    .filter((key) => typeof fields[key] !== 'string' || fields[key].trim() === '')
    .map((key) => `${skillFile} has no ${key} in its frontmatter`)
}

function checkSkill(packageDir: string, manifest: PluginManifest): PluginPackageCheck {
  if (manifest.kind !== 'remote') return passed('skill')
  if (manifest.skill === undefined) {
    return warned('skill', [
      'the manifest names no skill; a skill tells coding agents how to configure the plugin',
    ])
  }
  const dir = resolve(packageDir, manifest.skill)
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    return failed('skill', [`${manifest.skill} is not a folder in the package`])
  }
  const problems: string[] = []
  const code = codeFiles(dir)
  if (code.length > 0) {
    problems.push(`the skill folder holds code (${code.join(', ')}); a skill is plain files`)
  }
  const skillPath = join(dir, 'SKILL.md')
  const skillFile = shown(relative(packageDir, skillPath))
  if (!existsSync(skillPath)) problems.push(`${skillFile} is missing`)
  else problems.push(...frontmatterProblems(skillFile, readFileSync(skillPath, 'utf-8')))
  return failed('skill', problems)
}

function checkPackage(packageJsonPath: string): PluginPackageCheck {
  let pkg: unknown
  try {
    pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8'))
  } catch {
    return failed('package', ['package.json is not readable JSON'])
  }
  if (!isObject(pkg)) return failed('package', ['package.json is not an object'])
  const problems: string[] = []
  const scripts = isObject(pkg.scripts) ? Object.keys(pkg.scripts) : []
  const installs = INSTALL_SCRIPTS.filter((name) => scripts.includes(name))
  if (installs.length > 0) {
    const names = installs.join(', ')
    problems.push(`package.json runs ${names} on install; a plugin installs with no scripts`)
  }
  const peers = isObject(pkg.peerDependencies) ? Object.keys(pkg.peerDependencies) : []
  for (const peer of peers.filter((name) => AGENT_QA_PACKAGE.test(name))) {
    problems.push(
      `package.json lists ${peer} in peerDependencies; agent-qa checks a plugin by its protocol, `
        + 'not peerDependencies',
    )
  }
  const keywords = Array.isArray(pkg.keywords) ? pkg.keywords : []
  if (!keywords.includes(PLUGIN_KEYWORD)) {
    problems.push(`package.json keywords lack ${PLUGIN_KEYWORD}, which npm search finds plugins by`)
  }
  return warned('package', problems)
}

export function validatePluginPackage(
  target: string,
  options: ValidatePluginPackageOptions,
): PluginPackageReport {
  const located = locate(target, options)
  if ('check' in located) return { remote: false, checks: [located.check] }

  const { packageJsonPath } = located
  const packageDir = dirname(packageJsonPath)
  const read = readPluginManifest(packageJsonPath)
  if (!read.ok) {
    return {
      packageDir,
      remote: false,
      checks: [failed('manifest', [read.issue]), checkPackage(packageJsonPath)],
    }
  }

  const { manifest } = read
  const files: SchemaFile[] = []
  if (manifest.options !== undefined) files.push({ scope: 'options', file: manifest.options })
  if (manifest.kind === 'remote') files.push({ scope: 'settings', file: manifest.settings })
  const schemas = checkSchemas(packageDir, files)
  return {
    packageDir,
    remote: manifest.kind === 'remote',
    checks: [
      manifestCheck(manifest),
      schemas.check,
      checkCredentialMarks(schemas.loaded),
      checkSkill(packageDir, manifest),
      checkPackage(packageJsonPath),
    ],
  }
}
