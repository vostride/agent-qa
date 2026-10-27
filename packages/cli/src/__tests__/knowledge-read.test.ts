import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stripVTControlCharacters } from 'node:util'

import {
  type BundleStoreConfig,
  type PublishBundleInput,
} from '@vostride/agent-qa-knowledge-local'
import {
  PURGE_RECEIPT_SCHEMA_VERSION,
  publishBundleForTest as publishBundle,
} from '@vostride/agent-qa-knowledge-local'
import { recordBuildTag } from '@vostride/agent-qa-runner-local'
import {
  BundleOutcomeEventSchema,
  guardInspectRecordView,
  guardRecordChange,
} from '@vostride/agent-qa-schema'
import type {
  BundleDiscriminant,
  BundleDraft,
  BundleOutcomeEvent,
} from '@vostride/agent-qa-schema'
import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createKnowledgeCommand } from '../commands/knowledge.js'

const PRODUCT = 'shop'
const TAG = 'release-10'
const TAG_ORDINAL = 10

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
  const root = mkdtempSync(join(tmpdir(), 'agent-qa-knowledge-read-'))
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

function event(value: Parameters<typeof BundleOutcomeEventSchema.parse>[0]): BundleOutcomeEvent {
  return BundleOutcomeEventSchema.parse(value)
}

function bundleInput(input: {
  name: string
  kind: 'fact' | 'caution'
  createdAtOrdinal: number
  initialEvents?: readonly BundleOutcomeEvent[]
  evidenceMarkdown?: string
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
      sha: input.kind === 'fact' ? 'a'.repeat(64) : 'b'.repeat(64),
    },
    originStage: 'run-curation',
  }
  const discriminant: BundleDiscriminant = input.kind === 'fact'
    ? {
        kind: 'fact',
        subtype: 'selector',
        elementRef: { role: 'button', name: input.name },
      }
    : {
        kind: 'caution',
        errorKey: input.name,
      }

  return {
    draft,
    discriminant,
    originClass: 'agent-verified',
    createdAtOrdinal: input.createdAtOrdinal,
    screenStates: [],
    initialEvents: [...(input.initialEvents ?? [])],
    relations: [],
    provenance: {
      mode: 'run-linked',
      runId: `knowledge-read-${input.kind}`,
      testId: 'knowledge-read-command',
      stepIndex: 0,
      sourceBuildOrdinal: input.createdAtOrdinal,
    },
    artifacts: [],
    ...(input.evidenceMarkdown === undefined
      ? {}
      : { evidenceMarkdown: input.evidenceMarkdown }),
  }
}

function seedStore(workspace: FixtureWorkspace): { factId: string; cautionId: string } {
  const config: BundleStoreConfig = {
    knowledgeRoot: workspace.knowledgeRoot,
    productKey: PRODUCT,
  }
  const fact = publishBundle(config, bundleInput({
    name: 'Checkout',
    kind: 'fact',
    createdAtOrdinal: 5,
    initialEvents: [
      event({
        type: 'promoted',
        evidenceToken: 'checkout-promoted',
        curationJobId: 'checkout-promotion',
        buildOrdinal: 9,
      }),
      event({
        type: 'confirmed',
        evidenceToken: 'checkout-confirmed',
        curationJobId: 'checkout-confirmation',
        buildOrdinal: 11,
        origin: 'agent-verified',
      }),
    ],
    evidenceMarkdown: 'Use the verified checkout control.\n',
  }))
  const caution = publishBundle(config, bundleInput({
    name: 'Payment timeout',
    kind: 'caution',
    createdAtOrdinal: 12,
  }))

  expect(fact.kind).toBe('published')
  expect(caution.kind).toBe('published')
  if (fact.kind !== 'published' || caution.kind !== 'published') {
    throw new Error('knowledge read fixture publication failed')
  }
  return { factId: fact.id, cautionId: caution.id }
}

async function invoke(workspace: FixtureWorkspace, args: readonly string[]): Promise<InvocationResult> {
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
    return {
      stdout: stdout.join('\n'),
      stderr: stderr.join('\n'),
      exitCode: process.exitCode,
    }
  } finally {
    log.mockRestore()
    error.mockRestore()
  }
}

describe('knowledge read commands', () => {
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

  it('renders inspect and diff byte-identically for repeated inputs', async () => {
    const workspace = fixtureWorkspace(roots)
    seedStore(workspace)

    const firstInspect = await invoke(workspace, ['inspect'])
    const secondInspect = await invoke(workspace, ['inspect'])
    const firstDiff = await invoke(workspace, ['diff', '10'])
    const secondDiff = await invoke(workspace, ['diff', '10'])

    expect(firstInspect).toEqual(secondInspect)
    expect(firstDiff).toEqual(secondDiff)
    expect(firstInspect.exitCode).toBeUndefined()
    expect(firstDiff.exitCode).toBeUndefined()

    const humanInspect = stripVTControlCharacters(firstInspect.stdout)
    expect(humanInspect.indexOf('counts:')).toBeLessThan(
      humanInspect.indexOf('advisory (LLM narrative)'),
    )
    expect(humanInspect.indexOf('evidence tokens:')).toBeLessThan(
      humanInspect.indexOf('advisory (LLM narrative)'),
    )
  })

  it('emits schema-guarded DTO arrays under --json', async () => {
    const workspace = fixtureWorkspace(roots)
    seedStore(workspace)

    const inspectResult = await invoke(workspace, ['inspect', '--json'])
    const diffResult = await invoke(workspace, ['diff', '10', '--json'])
    const inspectRows: unknown[] = JSON.parse(inspectResult.stdout)
    const diffRows: unknown[] = JSON.parse(diffResult.stdout)

    expect(inspectRows.map(guardInspectRecordView)).toEqual(inspectRows)
    expect(diffRows.map(guardRecordChange)).toEqual(diffRows)
    expect(inspectResult.stderr).toBe('')
    expect(diffResult.stderr).toBe('')
  })

  it('narrows by kind and record and treats an empty store as a successful result', async () => {
    const workspace = fixtureWorkspace(roots)
    const { factId, cautionId } = seedStore(workspace)

    const kindResult = await invoke(workspace, ['inspect', '--kind', 'caution', '--json'])
    const recordResult = await invoke(workspace, ['inspect', '--record', factId, '--json'])
    const invalidResult = await invoke(workspace, ['inspect', '--status', 'invented', '--json'])
    const emptyWorkspace = fixtureWorkspace(roots)
    const emptyJson = await invoke(emptyWorkspace, ['inspect', '--json'])
    const emptyHuman = await invoke(emptyWorkspace, ['inspect'])

    expect(JSON.parse(kindResult.stdout).map((row: { recordId: string }) => row.recordId))
      .toEqual([cautionId])
    expect(JSON.parse(recordResult.stdout).map((row: { recordId: string }) => row.recordId))
      .toEqual([factId])
    expect(invalidResult.exitCode).toBe(1)
    expect(stripVTControlCharacters(invalidResult.stderr)).toContain('[invalid-filter]')
    expect(JSON.parse(emptyJson.stdout)).toEqual([])
    expect(emptyJson.exitCode).toBeUndefined()
    expect(stripVTControlCharacters(emptyHuman.stdout))
      .toContain('No knowledge records matched the filter.')
    expect(emptyHuman.exitCode).toBeUndefined()
  })

  it('resolves build tags and refuses unknown tags with a typed error', async () => {
    const workspace = fixtureWorkspace(roots)
    seedStore(workspace)
    await recordBuildTag({
      root: workspace.runtimeRoot,
      product: PRODUCT,
      tag: TAG,
      ordinal: TAG_ORDINAL,
    })

    const numeric = await invoke(workspace, ['diff', String(TAG_ORDINAL), '--json'])
    const tagged = await invoke(workspace, ['diff', TAG, '--product', PRODUCT, '--json'])
    const unknown = await invoke(workspace, [
      'diff',
      'missing-tag',
      '--product',
      PRODUCT,
      '--json',
    ])

    expect(tagged.stdout).toBe(numeric.stdout)
    expect(tagged.exitCode).toBeUndefined()
    expect(unknown.exitCode).toBe(1)
    expect(stripVTControlCharacters(unknown.stderr)).toContain('[unknown-build-tag]')
    expect(stripVTControlCharacters(unknown.stderr)).toContain('Unknown build tag "missing-tag"')
  })

  it('exits non-zero instead of rendering partial output from damaged maintenance truth', async () => {
    const inspectWorkspace = fixtureWorkspace(roots)
    const { factId } = seedStore(inspectWorkspace)
    writeFileSync(
      join(
        inspectWorkspace.knowledgeRoot,
        'memory',
        PRODUCT,
        'bundles',
        factId,
        'manifest.json',
      ),
      'not-json\n',
      'utf8',
    )

    const inspect = await invoke(inspectWorkspace, ['inspect', '--json'])
    expect(inspect.exitCode).toBe(1)
    expect(inspect.stdout).toBe('')
    expect(stripVTControlCharacters(inspect.stderr)).toContain('scan incomplete')

    const diffWorkspace = fixtureWorkspace(roots)
    const receiptsDir = join(diffWorkspace.knowledgeRoot, 'memory', 'receipts')
    mkdirSync(receiptsDir, { recursive: true })
    writeFileSync(
      join(receiptsDir, 'purge-record-b.json'),
      `${JSON.stringify({
        schemaVersion: PURGE_RECEIPT_SCHEMA_VERSION,
        purgedRecordId: 'record-a',
        purgedAtOrdinal: 14,
        initiator: 'test-operator',
        affectedPaths: ['memory/shop/bundles/record-a'],
        firstCommittedOrdinal: 2,
      })}\n`,
      'utf8',
    )

    const diff = await invoke(diffWorkspace, ['diff', '10', '--json'])
    expect(diff.exitCode).toBe(1)
    expect(diff.stdout).toBe('')
    expect(stripVTControlCharacters(diff.stderr)).toContain('scan incomplete')
  })
})
