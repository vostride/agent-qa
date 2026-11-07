import { dirname, join, relative } from 'node:path'
import { isMap, isScalar, parseDocument } from 'yaml'
import { writeScaffoldFileAtomic } from './init-filesystem.js'
import type { DetectedManager } from './package-manager.js'
import type { ProjectHost } from './project-host.js'
import type { ProjectRange } from './project-range.js'

// pnpm 11+ fails an install while any of these build scripts is unreviewed, and agent-qa needs none.
export const PNPM_DENIED_BUILDS = [
  'edgedriver',
  'geckodriver',
  'onnxruntime-node',
  'protobufjs',
] as const

const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/iu
const PLAIN_KEY = /^[a-z0-9][a-z0-9._-]*$/iu

function newline(src: string): string {
  return src.includes('\r\n') ? '\r\n' : '\n'
}

function yamlKey(name: string): string {
  return PLAIN_KEY.test(name) ? name : JSON.stringify(name)
}

function keyName(key: unknown): string {
  return String(isScalar(key) ? key.value : key)
}

function listed(items: readonly string[]): string {
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`
}

function blockRoot(src: string) {
  const doc = parseDocument(src)
  if (doc.errors.length > 0) return undefined
  if (doc.contents === null) return doc
  return isMap(doc.contents) && doc.contents.flow !== true ? doc : undefined
}

function appended(src: string, lines: readonly string[]): string {
  const nl = newline(src)
  const sep = src.length === 0 || src.endsWith('\n') ? '' : nl
  return `${src}${sep}${lines.map((line) => `${line}${nl}`).join('')}`
}

export function withDeniedBuilds(
  src: string,
  names: readonly string[],
): { text: string; added: string[] } | { refused: string; missing: string[] } {
  const wanted = [...new Set(names)]
  const doc = blockRoot(src)
  if (doc === undefined) return { refused: 'the file is not a block map', missing: wanted }
  const node = doc.get('allowBuilds', true)
  if (node === undefined) {
    if (wanted.length === 0) return { text: src, added: [] }
    const lines = ['allowBuilds:', ...wanted.map((name) => `  ${yamlKey(name)}: false`)]
    return { text: appended(src, lines), added: wanted }
  }
  if (!isMap(node) || node.flow === true || node.items.length === 0) {
    const present = isMap(node) ? new Set(node.items.map((pair) => keyName(pair.key))) : new Set()
    return {
      refused: 'allowBuilds is not a block map',
      missing: wanted.filter((name) => !present.has(name)),
    }
  }
  const present = new Set(node.items.map((pair) => keyName(pair.key)))
  const added = wanted.filter((name) => !present.has(name))
  if (added.length === 0) return { text: src, added }

  const first = node.items[0]!.key
  const last = node.items.at(-1)!
  const firstStart = isScalar(first) && first.range ? first.range[0] : 0
  const indent = src.slice(src.lastIndexOf('\n', firstStart - 1) + 1, firstStart)
  const lastNode = (last.value ?? last.key) as { range?: [number, number, number] } | null
  const lastEnd = lastNode?.range?.[1] ?? src.length
  const nl = newline(src)
  const eol = src.indexOf('\n', lastEnd)
  const at = eol === -1 ? src.length : eol + 1
  const lines = added.map((name) => `${indent}${yamlKey(name)}: false${nl}`).join('')
  const lead = eol === -1 ? nl : ''
  return { text: `${src.slice(0, at)}${lead}${lines}${src.slice(at)}`, added }
}

// Yarn 4 defaults to Plug'n'Play, which leaves no node_modules for agent-qa and its plugins.
export function withNodeModulesLinker(src: string): string | undefined {
  const doc = blockRoot(src)
  if (doc === undefined) return undefined
  const node = doc.get('nodeLinker', true)
  if (node === undefined) return appended(src, ['nodeLinker: node-modules'])
  if (!isScalar(node) || node.value !== 'pnp' || !node.range) return undefined
  const quote = node.type === 'QUOTE_DOUBLE' ? '"' : node.type === 'QUOTE_SINGLE' ? "'" : ''
  return `${src.slice(0, node.range[0])}${quote}node-modules${quote}${src.slice(node.range[1])}`
}

export function ignoredBuildNames(output: string): string[] {
  const names: string[] = []
  for (const match of output.matchAll(/Ignored build scripts:([^\r\n]*)/gu)) {
    for (const item of match[1]!.split(',')) {
      const spec = item.trim().replace(/\.$/u, '')
      const at = spec.lastIndexOf('@')
      const name = at > 0 ? spec.slice(0, at) : spec
      if (PACKAGE_NAME.test(name) && !names.includes(name)) names.push(name)
    }
  }
  return names
}

function foldersFrom(range: ProjectRange, packageDir: string): string[] {
  const at = range.folders.indexOf(packageDir)
  return at === -1 ? [packageDir] : range.folders.slice(at)
}

function nearestAtOrAbove(
  range: ProjectRange,
  packageDir: string,
  names: readonly string[],
  host: ProjectHost,
): string | undefined {
  for (const folder of foldersFrom(range, packageDir)) {
    if (names.some((name) => host.io.exists(join(folder, name)))) return folder
  }
  return undefined
}

function write(file: string, content: string): void {
  writeScaffoldFileAtomic({ root: dirname(file), path: file, content, force: true })
}

function preparePnpm(
  input: { range: ProjectRange; packageDir: string; host: ProjectHost },
  deny: readonly string[],
): string[] {
  const { range, packageDir, host } = input
  const folder = nearestAtOrAbove(range, packageDir, ['pnpm-workspace.yaml'], host) ?? packageDir
  const file = join(folder, 'pnpm-workspace.yaml')
  const shown = relative(range.start, file) || file
  const result = withDeniedBuilds(host.io.readText(file) ?? '', deny)
  if ('refused' in result) {
    if (result.missing.length === 0) return []
    const entries = listed(result.missing.map((name) => `${yamlKey(name)}: false`))
    return [`add ${entries} under allowBuilds in ${shown}`]
  }
  if (result.added.length === 0) return []
  write(file, result.text)
  return [`denied the build scripts of ${listed(result.added)} in ${shown}`]
}

function prepareYarn(input: { range: ProjectRange; packageDir: string; host: ProjectHost }) {
  const { range, packageDir, host } = input
  const root = nearestAtOrAbove(range, packageDir, ['yarn.lock', '.yarnrc.yml'], host) ?? packageDir
  const file = join(root, '.yarnrc.yml')
  const text = withNodeModulesLinker(host.io.readText(file) ?? '')
  if (text === undefined) return []
  write(file, text)
  return [`set nodeLinker: node-modules in ${relative(range.start, file) || file}`]
}

export async function prepareManagerSettings(input: {
  manager: DetectedManager
  range: ProjectRange
  packageDir: string
  host: ProjectHost
  deny?: readonly string[]
}): Promise<string[]> {
  const packageDir = await input.host.io.realpath(input.packageDir)
  const located = { ...input, packageDir }
  if (input.manager.name === 'pnpm') {
    return preparePnpm(located, [...PNPM_DENIED_BUILDS, ...(input.deny ?? [])])
  }
  if (input.manager.name === 'yarn' && input.manager.yarnLine === 'berry')
    return prepareYarn(located)
  return []
}
