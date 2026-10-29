#!/usr/bin/env node
// Executable edges only, read from the TypeScript AST; an entry's lazy edges count as eager.

import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { isBuiltin } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'

export const WORKSPACE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export const ACQUISITION_SOURCES = Object.freeze([
  'packages/knowledge-local/src/embedder-acquire.ts',
  'packages/knowledge-local/src/embedder-floor.ts',
  'packages/knowledge-local/src/embedder-native.ts',
])

export const DISCOVERY_ENTRIES = Object.freeze([
  'packages/cli/src/commands/mcp.ts',
  'packages/mcp/src/index.ts',
  'packages/agent/src/functions/ops/knowledge-bundles-list.ts',
  'packages/agent/src/functions/ops/knowledge-records-inspect.ts',
  'packages/agent/src/functions/ops/knowledge-records-diff.ts',
  'packages/agent/src/functions/ops/knowledge-record-show.ts',
  'packages/agent/src/functions/ops/knowledge-brief-why.ts',
  'packages/agent/src/functions/ops/runs-knowledge.ts',
  'packages/agent/src/functions/ops/runs-overview.ts',
  'packages/agent/src/functions/ops/runs-evidence.ts',
  'packages/agent/src/functions/ops/runs-artifact.ts',
])

// The equality pins for `deriveForbiddenRuntime(WORKSPACE_ROOT)`: its acquisition roots and its
// name-level set. A new dependency of the embedding runtime moves the derivation; these literals
// make that a reviewed change.
export const PINNED_ACQUISITION_ROOTS = Object.freeze(['@huggingface/tokenizers', '@huggingface/transformers'])

export const PINNED_FORBIDDEN_RUNTIME = Object.freeze([
  '@huggingface/jinja',
  '@huggingface/tokenizers',
  '@huggingface/transformers',
  '@protobufjs/aspromise',
  '@protobufjs/base64',
  '@protobufjs/codegen',
  '@protobufjs/eventemitter',
  '@protobufjs/fetch',
  '@protobufjs/float',
  '@protobufjs/path',
  '@protobufjs/pool',
  '@protobufjs/utf8',
  'adm-zip',
  'define-data-property',
  'define-properties',
  'es-define-property',
  'es-errors',
  'escape-string-regexp',
  'flatbuffers',
  'global-agent',
  'globalthis',
  'gopd',
  'guid-typescript',
  'has-property-descriptors',
  'long',
  'matcher',
  'object-keys',
  'onnxruntime-common',
  'onnxruntime-node',
  'onnxruntime-web',
  'platform',
  'protobufjs',
])

// The acquisition module that must be inside the eager graph for a clean verdict to mean anything.
export const REQUIRED_GRAPH_MEMBER = 'packages/knowledge-local/src/embedder-floor.ts'

function scriptKindOf(fileName) {
  if (/\.[cm]?jsx?$/u.test(fileName)) return ts.ScriptKind.JS
  if (fileName.endsWith('.tsx')) return ts.ScriptKind.TSX
  return ts.ScriptKind.TS
}

function parse(sourceText, fileName) {
  return ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, scriptKindOf(fileName))
}

function literalText(node) {
  return node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : undefined
}

export function moduleEdges(sourceText, fileName) {
  const source = parse(sourceText, fileName)
  const edges = []
  const add = (specifier, kind, eager, node) => edges.push({
    specifier, kind, eager, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
  })
  const visit = (node, inFunction) => {
    if (ts.isImportDeclaration(node)) {
      const specifier = literalText(node.moduleSpecifier)
      if (specifier !== undefined && node.importClause?.isTypeOnly !== true) {
        add(specifier, node.importClause === undefined ? 'side-effect' : 'import', true, node)
      }
    } else if (ts.isExportDeclaration(node)) {
      const specifier = literalText(node.moduleSpecifier)
      if (specifier !== undefined && !node.isTypeOnly) add(specifier, 're-export', true, node)
    } else if (ts.isImportEqualsDeclaration(node)) {
      if (!node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference)) {
        const specifier = literalText(node.moduleReference.expression)
        if (specifier !== undefined) add(specifier, 'import-equals', !inFunction, node)
      }
    } else if (ts.isCallExpression(node)) {
      const specifier = literalText(node.arguments[0])
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        if (specifier !== undefined) add(specifier, 'dynamic-import', false, node)
      } else if (ts.isIdentifier(node.expression) && node.expression.text === 'require' && specifier !== undefined) {
        add(specifier, 'require', !inFunction, node)
      }
    }
    const nested = inFunction || ts.isFunctionLike(node)
    ts.forEachChild(node, child => visit(child, nested))
  }
  visit(source, false)
  return edges
}

export function calledNames(sourceText, fileName, names) {
  const wanted = new Set(names)
  const source = parse(sourceText, fileName)
  const calls = []
  const visit = (node) => {
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const callee = node.expression
      const name = ts.isIdentifier(callee) ? callee.text
        : ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined
      if (name !== undefined && wanted.has(name)) {
        calls.push({ name, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1 })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return calls
}

export function exportedFunctionNames(sourceText, fileName) {
  const names = []
  for (const statement of parse(sourceText, fileName).statements) {
    const exported = ts.canHaveModifiers(statement)
      && ts.getModifiers(statement)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)
    if (exported && ts.isFunctionDeclaration(statement) && statement.name !== undefined) {
      names.push(statement.name.text)
    }
  }
  return names
}

export function packageNameOf(specifier) {
  if (specifier.startsWith('.') || specifier.startsWith('/') || isBuiltin(specifier)) return undefined
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

export function workspacePackages(root) {
  const packagesDir = join(root, 'packages')
  const packages = new Map()
  for (const name of readdirSync(packagesDir).sort()) {
    const manifestPath = join(packagesDir, name, 'package.json')
    if (!existsSync(manifestPath)) continue
    const manifest = readJson(manifestPath)
    if (typeof manifest.name === 'string') packages.set(manifest.name, { dir: join(packagesDir, name), manifest })
  }
  return packages
}

function locatePackage(name, fromDir) {
  let current = fromDir
  while (true) {
    const candidate = join(current, 'node_modules', name)
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate)
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

function runtimeDependencyNames(manifest) {
  return [...new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
  ])].sort()
}

function installedClosure(starts, skip) {
  const seen = new Map()
  const queue = [...starts]
  while (queue.length > 0) {
    const { name, dir } = queue.shift()
    if (seen.has(dir)) continue
    seen.set(dir, name)
    for (const dependency of runtimeDependencyNames(readJson(join(dir, 'package.json')))) {
      if (skip(dependency)) continue
      const located = locatePackage(dependency, dir)
      if (located !== undefined && !seen.has(located)) queue.push({ name: dependency, dir: located })
    }
  }
  return seen
}

/**
 * The runtime packages only the embedder acquisition modules reach: the closure of their own
 * executable package imports, minus the closure every other workspace dependency reaches.
 */
export function deriveForbiddenRuntime(root = WORKSPACE_ROOT) {
  const workspace = workspacePackages(root)
  const owner = join(root, 'packages', 'knowledge-local')
  const roots = new Set()
  for (const file of ACQUISITION_SOURCES) {
    for (const edge of moduleEdges(readFileSync(join(root, file), 'utf8'), file)) {
      const name = packageNameOf(edge.specifier)
      if (name !== undefined && !workspace.has(name)) roots.add(name)
    }
  }
  const rootNames = [...roots].sort()
  const acquisition = installedClosure(
    rootNames.map(name => {
      const dir = locatePackage(name, owner)
      if (dir === undefined) throw new Error(`acquisition import ${name} is not installed under ${owner}`)
      return { name, dir }
    }),
    name => workspace.has(name),
  )
  const sharedStarts = []
  for (const { dir } of workspace.values()) {
    for (const name of runtimeDependencyNames(readJson(join(dir, 'package.json')))) {
      if (roots.has(name) || workspace.has(name)) continue
      const located = locatePackage(name, dir)
      if (located !== undefined) sharedStarts.push({ name, dir: located })
    }
  }
  const shared = installedClosure(sharedStarts, name => roots.has(name) || workspace.has(name))
  const packages = [...acquisition].filter(([dir]) => !shared.has(dir))
    .map(([dir, name]) => ({ name, dir }))
    .sort((left, right) => left.name.localeCompare(right.name) || left.dir.localeCompare(right.dir))
  // A name some shared package also installs (another version) cannot be judged by name alone.
  const sharedNames = new Set(shared.values())
  const names = [...new Set(packages.map(entry => entry.name))].filter(name => !sharedNames.has(name)).sort()
  return { roots: rootNames, packages, names }
}

export function acquisitionCallNames(root = WORKSPACE_ROOT) {
  return [...new Set(ACQUISITION_SOURCES.flatMap(file =>
    exportedFunctionNames(readFileSync(join(root, file), 'utf8'), file)))].sort()
}

function sourceFor(base) {
  const candidates = []
  if (/\.m?js$/u.test(base)) {
    const stem = base.replace(/\.m?js$/u, '')
    candidates.push(`${stem}.ts`, `${stem}.tsx`, `${stem}.mts`)
  }
  candidates.push(base, `${base}.ts`, join(base, 'index.ts'))
  return candidates.find(candidate => existsSync(candidate) && statSync(candidate).isFile())
}

function exportTarget(value) {
  if (typeof value === 'string') return value
  if (value !== null && typeof value === 'object') {
    for (const condition of ['import', 'default', 'require']) {
      const target = exportTarget(value[condition])
      if (target !== undefined) return target
    }
  }
  return undefined
}

function resolveWorkspaceEdge(specifier, name, workspace) {
  const { dir, manifest } = workspace.get(name)
  const subpath = specifier === name ? '.' : `.${specifier.slice(name.length)}`
  const target = manifest.exports === undefined
    ? (subpath === '.' ? manifest.main : undefined)
    : exportTarget(typeof manifest.exports === 'string' && subpath === '.' ? manifest.exports : manifest.exports[subpath])
  if (typeof target !== 'string') return undefined
  const mapped = target.replace(/^\.\/dist\//u, './src/')
  return sourceFor(join(dir, mapped))
}

const PARSEABLE = /\.(?:[cm]?[jt]sx?)$/u

/**
 * Grow the eager graph from `entries` and report every rule violation. `forbidden` and
 * `acquisitionCalls` default to the live derivation; tests hand planted subjects their own.
 */
export function lintDiscoveryImports(options = {}) {
  const root = options.root ?? WORKSPACE_ROOT
  const entries = options.entries ?? DISCOVERY_ENTRIES
  const forbidden = new Set(options.forbidden ?? deriveForbiddenRuntime(root).names)
  const acquisitionCalls = options.acquisitionCalls ?? acquisitionCallNames(root)
  const workspace = workspacePackages(root)
  const violations = []
  const graph = new Set()
  const entryFiles = new Set(entries.map(entry => resolve(root, entry)))
  const queue = []
  for (const entry of entryFiles) {
    if (!existsSync(entry)) {
      violations.push({ rule: 'unresolved-workspace-edge', file: relative(root, entry), specifier: '(entry)', line: 0 })
    } else {
      queue.push(entry)
    }
  }
  while (queue.length > 0) {
    const file = queue.shift()
    if (graph.has(file)) continue
    graph.add(file)
    if (!PARSEABLE.test(file)) continue
    const text = readFileSync(file, 'utf8')
    const isEntry = entryFiles.has(file)
    const at = relative(root, file)
    for (const edge of moduleEdges(text, file)) {
      if (!edge.eager && !isEntry) continue
      const name = packageNameOf(edge.specifier)
      if (edge.specifier.startsWith('.')) {
        const target = sourceFor(resolve(dirname(file), edge.specifier))
        if (target === undefined) {
          violations.push({ rule: 'unresolved-workspace-edge', file: at, specifier: edge.specifier, line: edge.line })
        } else {
          queue.push(target)
        }
      } else if (name !== undefined && workspace.has(name)) {
        const target = resolveWorkspaceEdge(edge.specifier, name, workspace)
        if (target === undefined) {
          violations.push({ rule: 'unresolved-workspace-edge', file: at, specifier: edge.specifier, line: edge.line })
        } else {
          queue.push(target)
        }
      } else if (name !== undefined && forbidden.has(name)) {
        violations.push({
          rule: isEntry ? 'request-path-runtime-import' : 'eager-runtime-import',
          file: at, specifier: edge.specifier, kind: edge.kind, line: edge.line,
        })
      }
    }
    if (isEntry) {
      for (const call of calledNames(text, file, acquisitionCalls)) {
        violations.push({ rule: 'request-path-acquisition-call', file: at, specifier: call.name, line: call.line })
      }
    }
  }
  return {
    violations,
    graph: [...graph].map(file => relative(root, file)).sort(),
    forbidden: [...forbidden].sort(),
    acquisitionCalls: [...acquisitionCalls].sort(),
  }
}

function main() {
  const derived = deriveForbiddenRuntime(WORKSPACE_ROOT)
  const names = derived.names
  const failures = []
  if (JSON.stringify(derived.roots) !== JSON.stringify([...PINNED_ACQUISITION_ROOTS])) {
    failures.push(`acquisition roots drifted from their pin: derived ${JSON.stringify(derived.roots)}`)
  }
  if (JSON.stringify(names) !== JSON.stringify([...PINNED_FORBIDDEN_RUNTIME])) {
    failures.push(`forbidden runtime set drifted from its pin: derived ${JSON.stringify(names)}`)
  }
  const result = lintDiscoveryImports({ forbidden: names })
  if (!result.graph.includes(REQUIRED_GRAPH_MEMBER)) {
    failures.push(`the eager graph never reached ${REQUIRED_GRAPH_MEMBER}; a clean verdict would be vacuous`)
  }
  if (result.acquisitionCalls.length === 0) failures.push('no acquisition exports were derived')
  for (const violation of result.violations) {
    failures.push(`${violation.rule}: ${violation.file}:${violation.line} ${violation.specifier}`)
  }
  console.log(`431-discovery-imports: ${result.graph.length} modules from ${DISCOVERY_ENTRIES.length} entries; `
    + `acquisition roots ${derived.roots.join(', ')}; forbidden ${names.length}; `
    + `acquisition calls ${result.acquisitionCalls.join(', ')}`)
  if (failures.length > 0) {
    for (const failure of failures) console.error(`431-discovery-imports FAIL ${failure}`)
    process.exitCode = 1
    return
  }
  console.log('431-discovery-imports OK: no embedding runtime on the discovery request path')
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
