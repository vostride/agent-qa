// `agent-qa entities` — the verb that replaced `ids` (Phase 387 plan 09, D-20).
//
// This file replaces `ids.test.ts`, and the substitution is deliberate rather than
// bookkeeping. What that suite actually covered was a CLI surface over id minting: parse a
// type, call the generator, print, set an exit code. The generator itself is covered where it
// lives (`packages/ids/src/__tests__/persistent-id.test.ts`) and did NOT move — the addressing
// ledger maps FROM those ids — so nothing was lost by deleting the command's own suite. What
// is covered here is the property that replaced it: this surface owns no capability at all,
// and the card it prints came out of the function layer.
//
// Every case runs the real command against a real temp project: a bundle is genuinely
// published to disk, the composition root is genuinely built, and the addressing ledger is a
// real sqlite file. A stubbed registry would let a renderer that fabricated a plausible card
// pass every assertion below.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stripVTControlCharacters } from 'node:util'

// The unfenced compatibility composition is test-only and intentionally absent from the
// knowledge-local package barrel; this fixture imports its internal test seam directly.
import {
  publishBundleForTest,
  type BundleStoreConfig,
  type PublishBundleInput,
} from '@vostride/agent-qa-knowledge-local'
import { EntityCardSchema } from '@vostride/agent-qa-schema'
import type {
  BundleDiscriminant,
  BundleDraft,
  EntityCard,
  EntityCardResolution,
} from '@vostride/agent-qa-schema'
import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createEntitiesCommand } from '../commands/entities.js'

const PRODUCT = 'shop'

interface InvocationResult {
  stdout: string
  stderr: string
  writes: string[]
  exitCode: typeof process.exitCode
}

const PAIR = /^::stop-commands::([0-9a-f]{32})\n[\s\S]*\n::\1::\n$/u

interface FixtureWorkspace {
  root: string
  configPath: string
  knowledgeRoot: string
  runtimeRoot: string
}

function fixtureWorkspace(roots: string[]): FixtureWorkspace {
  const root = mkdtempSync(join(tmpdir(), 'agent-qa-entities-'))
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

function bundleInput(name: string, createdAtOrdinal: number): PublishBundleInput {
  const draft: BundleDraft = {
    kind: 'fact',
    subtype: 'selector',
    anchors: [{ t: 'el', role: 'button', name }],
    scope: { tier: 'product', key: PRODUCT },
    summary: `${name} summary`,
    body: `${name} body`,
    distilledEvidenceRef: { id: `${name}-evidence`, sha: 'a'.repeat(64) },
    originStage: 'run-curation',
  }
  const discriminant: BundleDiscriminant = {
    kind: 'fact',
    subtype: 'selector',
    elementRef: { role: 'button', name },
  }
  return {
    draft,
    discriminant,
    originClass: 'agent-verified',
    createdAtOrdinal,
    screenStates: [],
    initialEvents: [],
    relations: [],
    provenance: {
      mode: 'run-linked',
      runId: `entities-command-${name}`,
      testId: 'entities-command',
      stepIndex: 0,
      sourceBuildOrdinal: createdAtOrdinal,
    },
    artifacts: [],
  }
}

function seedBundle(workspace: FixtureWorkspace, name: string): string {
  const config: BundleStoreConfig = {
    knowledgeRoot: workspace.knowledgeRoot,
    productKey: PRODUCT,
  }
  const outcome = publishBundleForTest(config, bundleInput(name, 5))
  expect(outcome.kind).toBe('published')
  if (outcome.kind !== 'published') throw new Error('entities fixture bundle did not publish')
  return outcome.id
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
  const writes: string[] = []
  const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    writes.push(String(chunk))
    return true
  })
  process.exitCode = undefined

  try {
    const program = new Command()
      .option('--config <path>', 'config file path')
      .addCommand(createEntitiesCommand())
    program.exitOverride()
    await program.parseAsync([
      'node',
      'agent-qa',
      '--config',
      workspace.configPath,
      'entities',
      ...args,
    ])
    return {
      stdout: stdout.join('\n'),
      stderr: stderr.join('\n'),
      writes,
      exitCode: process.exitCode,
    }
  } finally {
    log.mockRestore()
    error.mockRestore()
    write.mockRestore()
  }
}

describe('agent-qa entities (the addressing debug verb)', () => {
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

  it('resolves a committed bundle ref to a minted MEM card through the function layer', async () => {
    const workspace = fixtureWorkspace(roots)
    const bundleId = seedBundle(workspace, 'Checkout')

    const result = await invoke(workspace, ['resolve', bundleId, '--json'])

    expect(result.stderr).toBe('')
    expect(result.exitCode).toBeUndefined()
    const resolution = JSON.parse(result.stdout) as EntityCardResolution
    expect(resolution).toMatchObject({
      kind: 'resolved',
      score: 1,
      card: { kind: 'MEM', id: 'MEM-001', uri: 'agentqa://memory/MEM-001', status: 'active' },
    })
    // Validated against the schema boundary, not just shape-matched: a card the renderer
    // fabricated could satisfy the object above and still not be a card.
    if (resolution.kind !== 'resolved') throw new Error('expected the resolved arm')
    expect(EntityCardSchema.safeParse(resolution.card).success).toBe(true)
    // D-10: no dashboard base URL is configured, so no link is offered.
    expect(Object.hasOwn(resolution.card, 'url')).toBe(false)
  })

  it('round-trips the minted short-ID back through `entities get`', async () => {
    const workspace = fixtureWorkspace(roots)
    const bundleId = seedBundle(workspace, 'Checkout')

    // The mint happens on the FIRST sighting; `get` is handed the address it produced. This is
    // the round trip the CLI exists to make available, and it crosses the durable ledger: the
    // second invocation is a separate composition reading what the first wrote to disk.
    await invoke(workspace, ['resolve', bundleId, '--json'])
    const got = await invoke(workspace, ['get', 'MEM-001', '--json'])

    expect(got.stderr).toBe('')
    expect(got.exitCode).toBeUndefined()
    const card = JSON.parse(got.stdout) as EntityCard
    expect(card).toMatchObject({ kind: 'MEM', id: 'MEM-001' })
    expect(EntityCardSchema.safeParse(card).success).toBe(true)
  })

  it('renders the human view with the address, the status and the action list', async () => {
    const workspace = fixtureWorkspace(roots)
    const bundleId = seedBundle(workspace, 'Checkout')

    const result = await invoke(workspace, ['resolve', bundleId])
    const text = stripVTControlCharacters(result.stdout)

    expect(result.exitCode).toBeUndefined()
    expect(text).toContain('Resolved')
    expect(text).toContain('MEM-001')
    expect(text).toContain('agentqa://memory/MEM-001')
    expect(text).toContain('status: active')
    expect(text).toContain('actions (')
  })

  it('reports an unmatched reference as the typed none arm, never as a guess', async () => {
    const workspace = fixtureWorkspace(roots)
    seedBundle(workspace, 'Checkout')

    // Free text that no address parses and no source recognises. The never-guess contract is
    // exactly that this does NOT come back as the one bundle the store happens to hold.
    const result = await invoke(workspace, ['resolve', 'something nobody ever stored', '--json'])

    expect(result.exitCode).toBeUndefined()
    const resolution = JSON.parse(result.stdout) as EntityCardResolution
    expect(resolution.kind).toBe('none')
    expect(result.stdout).not.toContain('MEM-001')
  })

  it('reports an unminted address as a failed invocation rather than an empty card', async () => {
    const workspace = fixtureWorkspace(roots)
    seedBundle(workspace, 'Checkout')

    const result = await invoke(workspace, ['get', 'MEM-404', '--json'])

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe('')
    expect(stripVTControlCharacters(result.stderr)).toContain('Entities get error')
  })

  it('refuses an empty reference at the flag boundary', async () => {
    const workspace = fixtureWorkspace(roots)

    const result = await invoke(workspace, ['resolve', '   '])

    expect(result.exitCode).toBe(1)
    expect(stripVTControlCharacters(result.stderr)).toContain('[missing-ref]')
  })
})

describe('agent-qa entities under GitHub Actions', () => {
  const roots: string[] = []
  const CRAFTED = '##[error]x ::set-output name=x::y'
  let originalExitCode: typeof process.exitCode

  beforeEach(() => {
    originalExitCode = process.exitCode
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    process.exitCode = originalExitCode
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('prints a card carrying a workflow command inside one stop-commands pair', async () => {
    const workspace = fixtureWorkspace(roots)
    const bundleId = seedBundle(workspace, CRAFTED)
    const plain = await invoke(workspace, ['resolve', bundleId])
    expect(plain.stdout).toContain('::set-output name=x::y')
    vi.stubEnv('GITHUB_ACTIONS', 'true')

    const result = await invoke(workspace, ['resolve', bundleId])

    expect(result.stdout).toBe('')
    expect(result.writes).toHaveLength(1)
    expect(result.writes[0]).toMatch(PAIR)
    expect(result.writes[0]).toContain(`\n${plain.stdout}\n`)
  })

  it('prints --json with no # and the same value', async () => {
    const workspace = fixtureWorkspace(roots)
    const bundleId = seedBundle(workspace, CRAFTED)
    const plain = await invoke(workspace, ['resolve', bundleId, '--json'])
    expect(plain.stdout).toContain('##[error]x')
    vi.stubEnv('GITHUB_ACTIONS', 'true')

    const result = await invoke(workspace, ['resolve', bundleId, '--json'])

    expect(result.writes).toEqual([])
    expect(result.stdout).not.toContain('#')
    expect(JSON.parse(result.stdout)).toEqual(JSON.parse(plain.stdout))
  })

  it('prints an error inside a pair, on stderr while --json holds stdout', async () => {
    const workspace = fixtureWorkspace(roots)
    seedBundle(workspace, 'Checkout')
    vi.stubEnv('GITHUB_ACTIONS', 'true')

    const human = await invoke(workspace, ['get', 'MEM-404'])
    const json = await invoke(workspace, ['get', 'MEM-404', '--json'])

    expect(human.exitCode).toBe(1)
    expect(human.stderr).toBe('')
    expect(human.writes).toHaveLength(1)
    expect(human.writes[0]).toMatch(PAIR)
    expect(human.writes[0]).toContain('Entities get error')
    expect(json.exitCode).toBe(1)
    expect(json.writes).toEqual([])
    expect(json.stdout).toBe('')
    expect(`${json.stderr}\n`).toMatch(PAIR)
  })

  it('prints the same card and JSON as before without the variable', async () => {
    const workspace = fixtureWorkspace(roots)
    const bundleId = seedBundle(workspace, CRAFTED)

    const human = await invoke(workspace, ['resolve', bundleId])
    const json = await invoke(workspace, ['resolve', bundleId, '--json'])

    expect(human.writes).toEqual([])
    expect(human.stdout).toContain(CRAFTED)
    expect(human.stdout).not.toContain('::stop-commands::')
    expect(json.writes).toEqual([])
    expect(json.stdout).toBe(JSON.stringify(JSON.parse(json.stdout), null, 2))
    expect(json.stdout).toContain(CRAFTED)
  })
})
