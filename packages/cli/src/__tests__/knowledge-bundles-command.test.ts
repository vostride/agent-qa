// Import statements are parsed from the file bytes, so prose cannot count as a dependency.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripVTControlCharacters } from 'node:util'

// The unfenced compatibility composition is test-only and intentionally absent from the
// knowledge-local package barrel. This listing fixture imports its internal test seam directly.
import {
  publishBundleForTest as publishBundle,
  type BundleStoreConfig,
  type PublishBundleInput,
} from '@vostride/agent-qa-knowledge-local'
import { KnowledgeBundleSummarySchema } from '@vostride/agent-qa-schema'
import type {
  BundleDiscriminant,
  BundleDraft,
  KnowledgeBundleSummary,
} from '@vostride/agent-qa-schema'
import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createKnowledgeCommand } from '../commands/knowledge.js'

const PRODUCT = 'shop'

const KNOWLEDGE_READ_SOURCE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'commands',
  'knowledge-read.ts',
)

/**
 * Packages whose presence anywhere in this file would mean a verb reads data for itself
 * instead of asking the function layer for it. The assertion covers the whole file and is
 * checked against a planted control so it cannot go vacuous. Core's run-text output subpath is
 * the one exception, because it reads no data; the core root stays refused.
 */
const DATA_LAYER_PACKAGES = [
  '@vostride/agent-qa-core',
  '@vostride/agent-qa-knowledge-local',
  '@vostride/agent-qa-runner-local',
] as const

const CORE_OUTPUT = '@vostride/agent-qa-core/run-text-output'

interface InvocationResult {
  stdout: string
  stderr: string
  exitCode: typeof process.exitCode
}

interface FixtureWorkspace {
  root: string
  configPath: string
  knowledgeRoot: string
  runtimeRoot: string
}

function fixtureWorkspace(roots: string[]): FixtureWorkspace {
  const root = mkdtempSync(join(tmpdir(), 'agent-qa-knowledge-bundles-'))
  roots.push(root)
  const configPath = join(root, 'agent-qa.config.yaml')
  mkdirSync(join(root, '.agent-qa'), { recursive: true })
  writeFileSync(
    configPath,
    `${JSON.stringify({
      workspace: {
        testMatch: ['tests/**/*.yaml'],
        suiteMatch: ['suites/**/*.suite.yaml'],
        hooksFile: 'hooks.yaml',
        envFile: '.env',
        secretsFile: '.env.secrets.local',
      },
      knowledge: {
        dir: 'agent-qa-knowledge',
      },
      use: {
        mobile: { appState: 'preserve' },
      },
    }, null, 2)}\n`,
    'utf8',
  )
  writeFileSync(join(root, '.env.secrets.local'), '', 'utf8')
  return {
    root,
    configPath,
    knowledgeRoot: join(root, 'agent-qa-knowledge'),
    runtimeRoot: join(root, '.agent-qa'),
  }
}

function bundleInput(input: {
  name: string
  kind: 'fact' | 'caution'
  createdAtOrdinal: number
}): PublishBundleInput {
  const draft: BundleDraft = {
    kind: input.kind,
    ...(input.kind === 'fact' ? { subtype: 'selector' as const } : {}),
    anchors: input.kind === 'fact'
      ? [{ t: 'el', role: 'button', name: input.name }]
      : [{ t: 'error', message: input.name }],
    scope: { tier: 'product', key: PRODUCT },
    summary: `${input.name} summary`,
    body: `${input.name} body`,
    distilledEvidenceRef: {
      id: `${input.kind}-${input.createdAtOrdinal}-evidence`,
      sha: (input.kind === 'fact' ? 'a' : 'b').repeat(64),
    },
    originStage: 'run-curation',
  }
  const discriminant: BundleDiscriminant = input.kind === 'fact'
    ? { kind: 'fact', subtype: 'selector', elementRef: { role: 'button', name: input.name } }
    : { kind: 'caution', errorKey: input.name }

  return {
    draft,
    discriminant,
    originClass: 'agent-verified',
    createdAtOrdinal: input.createdAtOrdinal,
    screenStates: [],
    initialEvents: [],
    relations: [],
    provenance: {
      mode: 'run-linked',
      runId: `knowledge-bundles-${input.kind}`,
      testId: 'knowledge-bundles-command',
      stepIndex: 0,
      sourceBuildOrdinal: input.createdAtOrdinal,
    },
    artifacts: [],
  }
}

/** Commit two real bundles so the listing has rows that came off disk. */
function seedTwoBundles(workspace: FixtureWorkspace): { factId: string; cautionId: string } {
  const config: BundleStoreConfig = {
    knowledgeRoot: workspace.knowledgeRoot,
    productKey: PRODUCT,
  }
  const fact = publishBundle(config, bundleInput({
    name: 'Checkout',
    kind: 'fact',
    createdAtOrdinal: 5,
  }))
  const caution = publishBundle(config, bundleInput({
    name: 'Payment timeout',
    kind: 'caution',
    createdAtOrdinal: 12,
  }))

  expect(fact.kind).toBe('published')
  expect(caution.kind).toBe('published')
  if (fact.kind !== 'published' || caution.kind !== 'published') {
    throw new Error('knowledge bundles fixture publication failed')
  }
  return { factId: fact.id, cautionId: caution.id }
}

async function invoke(
  workspace: FixtureWorkspace,
  args: readonly string[],
): Promise<InvocationResult> {
  const stdout: string[] = []
  const stderr: string[] = []
  const log = vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => {
    stdout.push(values.map(String).join(' '))
  })
  const error = vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => {
    stderr.push(values.map(String).join(' '))
  })
  process.exitCode = undefined

  try {
    const program = new Command()
      .option('--config <path>', 'config file path')
      .addCommand(createKnowledgeCommand())
    program.exitOverride()
    await program.parseAsync([
      'node',
      'agent-qa',
      '--config',
      workspace.configPath,
      'knowledge',
      ...args,
    ])
    return { stdout: stdout.join('\n'), stderr: stderr.join('\n'), exitCode: process.exitCode }
  } finally {
    log.mockRestore()
    error.mockRestore()
  }
}

// ---------------------------------------------------------------------------------------
// Import-statement extraction over file bytes.
// ---------------------------------------------------------------------------------------

// Strips comments, because the arch extractor reads a quoted word after `from` even in prose.
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/(^|[^:])\/\/[^\n]*/gu, '$1')
}

/** Every module specifier this source imports or re-exports, statement-scoped. */
function importSpecifiers(source: string): string[] {
  const body = stripComments(source)
  const specifiers: string[] = []
  // `[^'"]` spans newlines, so a multi-line clause is covered, and it cannot run past the
  // end of its own statement because the next thing it would have to cross is a quote.
  for (const match of body.matchAll(/^(?:import|export)\s[^'"]*?\bfrom\s*'([^']+)'/gmu)) {
    specifiers.push(match[1]!)
  }
  for (const match of body.matchAll(/^import\s*'([^']+)'/gmu)) {
    specifiers.push(match[1]!)
  }
  return specifiers
}

const CLAUSE_KEYWORDS = new Set(['import', 'export', 'type', 'as', 'default', 'from'])

/** The local names an import clause binds, per statement, for the matching specifiers. */
function importedBindings(source: string, matches: (specifier: string) => boolean): string[] {
  const body = stripComments(source)
  const bindings: string[] = []
  for (const match of body.matchAll(/^(?:import|export)\s([^'"]*?)\bfrom\s*'([^']+)'/gmu)) {
    if (!matches(match[2]!)) continue
    for (const identifier of match[1]!.match(/[A-Za-z_$][\w$]*/gu) ?? []) {
      if (!CLAUSE_KEYWORDS.has(identifier)) bindings.push(identifier)
    }
  }
  return [...new Set(bindings)]
}

/**
 * The bundles verb's registration block: everything from its `.command(...)` call to the
 * end of the file. The verb is registered LAST on purpose so this slice is exact; the
 * guard below fails loudly if a later verb is appended after it and silently shrinks the
 * region this assertion covers.
 */
function bundlesRegistrationBlock(source: string): string {
  const marker = ".command('bundles')"
  const start = source.indexOf(marker)
  expect(start).toBeGreaterThan(-1)
  const block = source.slice(start + marker.length)
  expect(block).not.toContain('.command(')
  return block
}

describe('agent-qa knowledge bundles (the exemplar thin client)', () => {
  const roots: string[] = []
  let originalExitCode: typeof process.exitCode

  beforeEach(() => {
    originalExitCode = process.exitCode
  })

  afterEach(() => {
    process.exitCode = originalExitCode
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('renders both committed bundles as schema-valid summaries under --json', async () => {
    const workspace = fixtureWorkspace(roots)
    const { factId, cautionId } = seedTwoBundles(workspace)

    const result = await invoke(workspace, ['bundles', '--json'])

    expect(result.stderr).toBe('')
    expect(result.exitCode).toBeUndefined()
    const rows = JSON.parse(result.stdout) as KnowledgeBundleSummary[]
    expect(rows).toHaveLength(2)
    // Every row honours the published DTO contract — the op's declared output, unchanged
    // by the surface that printed it.
    expect(rows.map((row) => KnowledgeBundleSummarySchema.parse(row))).toEqual(rows)
    expect([...rows].map((row) => row.bundleId).sort()).toEqual([factId, cautionId].sort())
    // The op owns the total order (product, then bundleId); the surface renders it as given.
    expect(rows.map((row) => row.bundleId)).toEqual(
      [...rows].map((row) => row.bundleId).sort(),
    )
    expect(rows.every((row) => row.product === PRODUCT)).toBe(true)
    expect(rows.map((row) => row.summary).sort()).toEqual(
      ['Checkout summary', 'Payment timeout summary'].sort(),
    )
  })

  it('renders human output through the display boundary with no placeholder residue', async () => {
    const workspace = fixtureWorkspace(roots)
    const { factId, cautionId } = seedTwoBundles(workspace)

    const result = await invoke(workspace, ['bundles'])

    expect(result.stderr).toBe('')
    expect(result.exitCode).toBeUndefined()
    const human = stripVTControlCharacters(result.stdout)
    expect(human).toContain(factId)
    expect(human).toContain(cautionId)
    expect(human).toContain('Checkout summary')
    expect(human).toContain('Payment timeout summary')
    expect(human).not.toMatch(/SECRET_\d+/u)
  })

  it('treats a workspace with no committed bundles as an empty success', async () => {
    const workspace = fixtureWorkspace(roots)

    const json = await invoke(workspace, ['bundles', '--json'])
    const human = await invoke(workspace, ['bundles'])

    expect(json.stderr).toBe('')
    expect(json.exitCode).toBeUndefined()
    expect(JSON.parse(json.stdout)).toEqual([])
    expect(human.stderr).toBe('')
    expect(human.exitCode).toBeUndefined()
    expect(stripVTControlCharacters(human.stdout)).toContain('No committed knowledge bundles')
  })

  it('renders byte-identically for repeated invocations', async () => {
    const workspace = fixtureWorkspace(roots)
    seedTwoBundles(workspace)

    const first = await invoke(workspace, ['bundles', '--json'])
    const second = await invoke(workspace, ['bundles', '--json'])

    expect(first).toEqual(second)
  })
})

describe('knowledge-read.ts source shape', () => {
  const source = readFileSync(KNOWLEDGE_READ_SOURCE_PATH, 'utf8')

  it('extracts statement-scoped specifiers and ignores prose that looks like one', () => {
    // The positive control. Without it, every assertion below would also pass against an
    // extractor that silently returned nothing.
    const synthetic = [
      "// a doc comment mentioning an import from '@vostride/agent-qa-safety' in prose",
      '/* and a block comment quoting the same specifier:',
      "   from '@vostride/agent-qa-safety' */",
      "import { evaluate } from '@vostride/agent-qa-safety'",
      "import {",
      '  a,',
      '  b,',
      "} from '@vostride/agent-qa-core'",
      "import type { C } from '@vostride/agent-qa-schema'",
      "import 'side-effect-only'",
    ].join('\n')

    expect(importSpecifiers(synthetic)).toEqual([
      '@vostride/agent-qa-safety',
      '@vostride/agent-qa-core',
      '@vostride/agent-qa-schema',
      'side-effect-only',
    ])
    expect(importedBindings(synthetic, (s) => s === '@vostride/agent-qa-core'))
      .toEqual(['a', 'b'])
  })

  it('no longer imports the safety package anywhere in the file', () => {
    const specifiers = importSpecifiers(source)

    // The extractor is live against THIS file, not just the synthetic control.
    expect(specifiers.length).toBeGreaterThan(4)
    expect(specifiers).toContain('@vostride/agent-qa-agent')
    // The file has no direct safety dependency; the declared mask is the CLI's own.
    expect(specifiers.filter((specifier) => specifier.includes('agent-qa-safety'))).toEqual([])
    expect(importedBindings(source, (s) => s === '@vostride/agent-qa-agent'))
      .toEqual(['invokeFunction'])
  })

  it('takes every verb in the file from invokeFunction and from no data package', () => {
    const isDataPackage = (specifier: string): boolean =>
      DATA_LAYER_PACKAGES.some((pkg) => specifier.startsWith(pkg))
    const specifiers = importSpecifiers(source)

    // The extractor is live against THIS file, not just a synthetic control.
    expect(specifiers.length).toBeGreaterThan(4)
    expect(specifiers).toContain(CORE_OUTPUT)
    expect(specifiers.filter(isDataPackage).filter((specifier) => specifier !== CORE_OUTPUT))
      .toEqual([])

    // Planting a forbidden import proves the check catches one, so an empty result is not vacuous.
    const planted = [
      "import { inspectRecords } from '@vostride/agent-qa-knowledge-local/reader'",
      "import { printRunText } from '@vostride/agent-qa-core'",
      "import { guardRunText } from '@vostride/agent-qa-core/logging'",
      source,
    ].join('\n')
    expect(importSpecifiers(planted).filter(isDataPackage)
      .filter((specifier) => specifier !== CORE_OUTPUT))
      .toEqual([
        '@vostride/agent-qa-knowledge-local/reader',
        '@vostride/agent-qa-core',
        '@vostride/agent-qa-core/logging',
      ])

    // And the data every verb renders still arrives the sanctioned way.
    expect(bundlesRegistrationBlock(source)).toContain('invokeFunction')
    expect(importedBindings(source, (s) => s === '@vostride/agent-qa-agent'))
      .toContain('invokeFunction')
  })
})
