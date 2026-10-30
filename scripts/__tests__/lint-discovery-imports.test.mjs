import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  DISCOVERY_ENTRIES,
  PINNED_ACQUISITION_ROOTS,
  PINNED_FORBIDDEN_RUNTIME,
  REQUIRED_GRAPH_MEMBER,
  WORKSPACE_ROOT,
  acquisitionCallNames,
  deriveForbiddenRuntime,
  lintDiscoveryImports,
  moduleEdges,
} from '../lint-discovery-imports.mjs'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'lint-discovery-imports.mjs')
const FORBIDDEN = ['forbidden-runtime']
const ACQUIRE = ['acquireEmbedder']

function workspace(t, files) {
  const root = mkdtempSync(join(tmpdir(), 'agent-qa-431-06-lint-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const packages = {
    'packages/app/package.json': { name: '@vostride/agent-qa-app', exports: { '.': { import: './dist/index.js' } } },
    'packages/lib/package.json': {
      name: '@vostride/agent-qa-lib',
      exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' }, './reader': { import: './dist/reader.js' } },
    },
  }
  for (const [path, manifest] of Object.entries(packages)) files[path] = JSON.stringify(manifest)
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  return root
}

function lintSubject(t, files) {
  const root = workspace(t, files)
  return lintDiscoveryImports({ root, entries: ['packages/app/src/entry.ts'], forbidden: FORBIDDEN, acquisitionCalls: ACQUIRE })
}

const rules = (result) => result.violations.map(violation => `${violation.rule} ${violation.file} ${violation.specifier}`)

test('moduleEdges keeps executable edges and drops type-only imports, type queries and comments', () => {
  const edges = moduleEdges([
    "import type { A } from 'type-only'",
    "export type { B } from 'type-reexport'",
    "import { type C } from 'kept-by-verbatim'",
    "import d from 'default-import'",
    "import 'side-effect'",
    "export * from 'star-reexport'",
    "import e = require('import-equals')",
    "type F = typeof import('type-query')",
    "// import 'commented'",
    "/* require('block-commented') */",
    "const text = \"import('in-a-string')\"",
    "const g = require('top-level-require')",
    "function later() { return require('nested-require') }",
    "async function lazy() { return await import('dynamic-literal') }",
    "const computed = (name: string) => import(name)",
  ].join('\n'), 'subject.ts')
  assert.deepEqual(edges.map(edge => [edge.specifier, edge.kind, edge.eager]), [
    ['kept-by-verbatim', 'import', true],
    ['default-import', 'import', true],
    ['side-effect', 'side-effect', true],
    ['star-reexport', 're-export', true],
    ['import-equals', 'import-equals', true],
    ['top-level-require', 'require', true],
    ['nested-require', 'require', false],
    ['dynamic-literal', 'dynamic-import', false],
  ])
})

test('a clean subject resolves the workspace alias and passes with type-only and lazy runtime edges', (t) => {
  const result = lintSubject(t, {
    'packages/app/src/entry.ts': "import { read } from '@vostride/agent-qa-lib'\nimport { reader } from '@vostride/agent-qa-lib/reader'\n// import 'forbidden-runtime'\nexport const run = () => [read(), reader]\n",
    'packages/lib/src/index.ts': "import type { Runtime } from 'forbidden-runtime'\nexport { read } from './read.js'\nexport type { Runtime }\n",
    'packages/lib/src/read.ts': "export async function read() { return (await import('forbidden-runtime')).default }\n",
    'packages/lib/src/reader.ts': "export const reader = 1\n",
  })
  assert.deepEqual(rules(result), [])
  assert.deepEqual(result.graph, [
    'packages/app/src/entry.ts', 'packages/lib/src/index.ts', 'packages/lib/src/read.ts', 'packages/lib/src/reader.ts',
  ])
})

test('a planted eager import behind a workspace re-export is flagged where it lives', (t) => {
  const result = lintSubject(t, {
    'packages/app/src/entry.ts': "import { read } from '@vostride/agent-qa-lib'\nexport const run = read\n",
    'packages/lib/src/index.ts': "export { read } from './read.js'\n",
    'packages/lib/src/read.ts': "import { Tokenizer } from 'forbidden-runtime'\nexport const read = () => Tokenizer\n",
  })
  assert.deepEqual(rules(result), ['eager-runtime-import packages/lib/src/read.ts forbidden-runtime'])
})

test('a planted top-level require and a deep subpath import are flagged', (t) => {
  const result = lintSubject(t, {
    'packages/app/src/entry.ts': "import './load.js'\n",
    'packages/app/src/load.ts': "const runtime = require('forbidden-runtime/dist/native.cjs')\nexport default runtime\n",
  })
  assert.deepEqual(rules(result), ['eager-runtime-import packages/app/src/load.ts forbidden-runtime/dist/native.cjs'])
})

test('a request handler that imports at call time or calls an acquisition export is flagged', (t) => {
  const result = lintSubject(t, {
    'packages/app/src/entry.ts': [
      "import { acquireEmbedder } from './acquire.js'",
      "export async function handle() { await import('forbidden-runtime'); return acquireEmbedder({}) }",
    ].join('\n'),
    'packages/app/src/acquire.ts': "export async function acquireEmbedder(options: unknown) { return options }\n",
  })
  assert.deepEqual(rules(result), [
    'request-path-runtime-import packages/app/src/entry.ts forbidden-runtime',
    'request-path-acquisition-call packages/app/src/entry.ts acquireEmbedder',
  ])
})

test('an edge that resolves to no source file fails closed', (t) => {
  const result = lintSubject(t, {
    'packages/app/src/entry.ts': "import { gone } from './missing.js'\nimport { absent } from '@vostride/agent-qa-lib/absent'\nexport const run = [gone, absent]\n",
  })
  assert.deepEqual(rules(result), [
    'unresolved-workspace-edge packages/app/src/entry.ts ./missing.js',
    'unresolved-workspace-edge packages/app/src/entry.ts @vostride/agent-qa-lib/absent',
  ])
})

test('the forbidden runtime is derived from the acquisition imports and equals its pins', () => {
  const derived = deriveForbiddenRuntime(WORKSPACE_ROOT)
  assert.deepEqual(derived.roots, [...PINNED_ACQUISITION_ROOTS])
  assert.deepEqual(derived.names, [...PINNED_FORBIDDEN_RUNTIME])
  assert.ok(!derived.names.includes('sharp'), 'sharp is a shared runner-local dependency, not an acquisition-only one')
  assert.deepEqual(acquisitionCallNames(WORKSPACE_ROOT), [
    'acquireEmbedder', 'createFloorEmbedder', 'createNativeEmbedder', 'discoverEmbedderWorker',
    'loadFloorAssets', 'resetEmbedderCapability', 'resolveEmbedderCapability',
  ])
})

test('the floor wrapper holds its tokenizer runtime behind a lazy import, where it used to be eager', () => {
  const floor = join(WORKSPACE_ROOT, 'packages/knowledge-local/src/embedder-floor.ts')
  const now = moduleEdges(readFileSync(floor, 'utf8'), floor).filter(edge => edge.specifier === '@huggingface/tokenizers')
  assert.deepEqual(now.map(edge => [edge.kind, edge.eager]), [['dynamic-import', false]])
  const eager = moduleEdges("import { Tokenizer } from '@huggingface/tokenizers'\n", floor)
  assert.deepEqual(eager.map(edge => [edge.kind, edge.eager]), [['import', true]])
})

test('the live discovery graph reaches the acquisition modules and carries no runtime edge', () => {
  const result = lintDiscoveryImports()
  assert.deepEqual(result.violations, [])
  assert.ok(result.graph.includes(REQUIRED_GRAPH_MEMBER), `the graph never reached ${REQUIRED_GRAPH_MEMBER}`)
  for (const entry of DISCOVERY_ENTRIES) assert.ok(result.graph.includes(entry), `entry ${entry} was not linted`)
})

test('the lint script exits clean on the live tree', () => {
  const run = spawnSync(process.execPath, [SCRIPT], { cwd: WORKSPACE_ROOT, encoding: 'utf8' })
  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stdout, /discovery-imports OK/u)
})
