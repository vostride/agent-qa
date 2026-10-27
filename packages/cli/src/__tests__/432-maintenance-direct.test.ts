// Phase 432 plan 15 (D-01, D-09, D-14): running a maintenance command is the intent.
//
// `knowledge rollback` and `knowledge purge <record-id>` execute from one invocation. There is no
// y/N, no repeated record id, no `--yes` and no `--confirm`; the retired options are unknown to the
// parser. What survives is the explicit target, the preview, the writer lease and the under-lease
// changed-set recheck, so a target that drifts after its preview is refused before any deletion.
//
// Every fixture below uses a throwaway temp workspace, knowledge root and runtime root.

import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

import { guardPurgeReceipt, loadBundle } from '@vostride/agent-qa-knowledge-local'
import { publishBundleForTest as publishBundle } from '@vostride/agent-qa-knowledge-local'
import type {
  BundleStoreConfig,
  PublishBundleInput,
} from '@vostride/agent-qa-knowledge-local'
import { asEvidenceToken, BundleOutcomeEventSchema } from '@vostride/agent-qa-schema'
import type { BundleDiscriminant, BundleDraft } from '@vostride/agent-qa-schema'
import { Command, CommanderError } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({
  readlineCalls: [] as string[],
  leaseAcquireHook: undefined as ((knowledgeRoot: string) => void) | undefined,
  authorityRefreshHook: undefined as ((call: number) => void) | undefined,
  authorityRefreshCalls: 0,
  purgeRecordCalls: 0,
  rollbackCurationJobCalls: 0,
  rollbackCampaignCalls: 0,
}))

// A prompt that is still wired answers "no": a surviving confirmation then fails on the outcome
// assertions below instead of hanging the worker or crashing the fixture.
vi.mock('node:readline', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:readline')>()
  return {
    ...actual,
    createInterface: vi.fn(() => ({
      close: vi.fn(),
      question: (question: string, answer: (value: string) => void) => {
        harness.readlineCalls.push(question)
        answer('n')
      },
    })),
  }
})

vi.mock('@vostride/agent-qa-knowledge-local', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@vostride/agent-qa-knowledge-local')>()
  return {
    ...actual,
    acquireWriterLease: vi.fn((...args: Parameters<typeof actual.acquireWriterLease>) => {
      harness.leaseAcquireHook?.(args[0])
      return actual.acquireWriterLease(...args)
    }),
    refreshWriterLeaseAuthority: vi.fn(
      (...args: Parameters<typeof actual.refreshWriterLeaseAuthority>) => {
        harness.authorityRefreshCalls += 1
        harness.authorityRefreshHook?.(harness.authorityRefreshCalls)
        return actual.refreshWriterLeaseAuthority(...args)
      },
    ),
    purgeRecord: vi.fn((...args: Parameters<typeof actual.purgeRecord>) => {
      harness.purgeRecordCalls += 1
      return actual.purgeRecord(...args)
    }),
    rollbackCurationJob: vi.fn((...args: Parameters<typeof actual.rollbackCurationJob>) => {
      harness.rollbackCurationJobCalls += 1
      return actual.rollbackCurationJob(...args)
    }),
    rollbackCampaign: vi.fn((...args: Parameters<typeof actual.rollbackCampaign>) => {
      harness.rollbackCampaignCalls += 1
      return actual.rollbackCampaign(...args)
    }),
  }
})

import { createKnowledgeCommand } from '../commands/knowledge.js'

const PRODUCT = 'maintenance-direct-storefront'
const CURATION_JOB_ID = 'maintenance-direct-curation-job'
const BUILD_ORDINAL = 12

interface Workspace {
  root: string
  configPath: string
  knowledgeRoot: string
  runtimeRoot: string
}

interface Invocation {
  stdout: string
  stderr: string
  exitCode: typeof process.exitCode
  commanderError?: CommanderError
  stdinTouches: string[]
}

function workspaceFixture(
  roots: string[],
  ordinals: Readonly<Record<string, number>> = { [PRODUCT]: BUILD_ORDINAL },
): Workspace {
  const root = mkdtempSync(join(tmpdir(), `agent-qa-432-maintenance-${randomUUID()}-`))
  roots.push(root)
  const configPath = join(root, 'agent-qa.config.yaml')
  const runtimeRoot = join(root, '.agent-qa')
  mkdirSync(runtimeRoot, { recursive: true })
  writeFileSync(configPath, `${JSON.stringify({
    workspace: {
      testMatch: ['tests/**/*.yaml'],
      suiteMatch: ['suites/**/*.suite.yaml'],
      hooksFile: 'hooks.yaml',
      envFile: '.env',
      secretsFile: '.env.secrets.local',
    },
    knowledge: { dir: 'agent-qa-knowledge' },
    use: { mobile: { appState: 'preserve' } },
  }, null, 2)}\n`, 'utf8')
  writeFileSync(join(runtimeRoot, 'build-ordinals.json'), `${JSON.stringify(ordinals)}\n`, 'utf8')
  writeFileSync(join(root, '.env.secrets.local'), '', 'utf8')
  return { root, configPath, knowledgeRoot: join(root, 'agent-qa-knowledge'), runtimeRoot }
}

function bundleInput(product: string, scopeProduct: string, createdAtOrdinal: number): PublishBundleInput {
  const draft: BundleDraft = {
    kind: 'fact',
    subtype: 'selector',
    anchors: [{ t: 'el', role: 'button', name: 'Checkout' }],
    scope: { tier: 'product', key: scopeProduct },
    summary: 'Use the Checkout button to continue.',
    body: 'The checkout selector was observed by a completed run.',
    distilledEvidenceRef: { id: 'maintenance-direct-evidence', sha: 'a'.repeat(64) },
    originStage: 'run-curation',
  }
  const discriminant: BundleDiscriminant = {
    kind: 'fact',
    subtype: 'selector',
    elementRef: { role: 'button', name: 'Checkout' },
  }
  return {
    draft,
    discriminant,
    originClass: 'agent-verified',
    createdAtOrdinal,
    screenStates: [],
    initialEvents: [BundleOutcomeEventSchema.parse({
      type: 'confirmed',
      evidenceToken: asEvidenceToken(`maintenance-direct-${product}-${createdAtOrdinal}`),
      curationJobId: CURATION_JOB_ID,
      buildOrdinal: createdAtOrdinal,
      origin: 'agent-verified',
    })],
    relations: [],
    provenance: {
      mode: 'run-linked',
      runId: `run-maintenance-direct-${product}`,
      testId: 'test-maintenance-direct',
      stepIndex: 0,
      curationJobId: CURATION_JOB_ID,
      sourceBuildOrdinal: createdAtOrdinal,
    },
    artifacts: [],
    evidenceMarkdown: 'Checkout was observed deterministically.\n',
  }
}

function seedBundle(
  workspace: Workspace,
  options: { product?: string; scopeProduct?: string; createdAtOrdinal?: number } = {},
): { id: string; dir: string } {
  const product = options.product ?? PRODUCT
  const config: BundleStoreConfig = {
    knowledgeRoot: workspace.knowledgeRoot,
    productKey: product,
  }
  const published = publishBundle(config, bundleInput(
    product,
    options.scopeProduct ?? product,
    options.createdAtOrdinal ?? 5,
  ))
  if (published.kind !== 'published') throw new Error(`expected a published fixture, got ${published.kind}`)
  return { id: published.id, dir: published.dir }
}

function snapshot(root: string): Record<string, string> {
  if (!existsSync(root)) return {}
  const files: Record<string, string> = {}
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile()) files[relative(root, path)] = readFileSync(path).toString('base64')
    }
  }
  visit(root)
  return files
}

function purgeReceiptPaths(workspace: Workspace, recordId: string): string[] {
  return [
    join(workspace.knowledgeRoot, 'memory', 'receipts', `purge-${recordId}.intent.json`),
    join(workspace.knowledgeRoot, 'memory', 'receipts', `purge-${recordId}.json`),
  ]
}

function deprecatedBy(bundleDir: string): number {
  const loaded = loadBundle(bundleDir)
  if (loaded.kind !== 'loaded') throw new Error(`expected a loaded bundle, got ${loaded.kind}`)
  return loaded.bundle.events.filter(({ curationJobId }) => curationJobId.startsWith('rollback:'))
    .length
}

function setTerminal(tty: boolean): void {
  for (const stream of [process.stdin, process.stdout, process.stderr]) {
    Object.defineProperty(stream, 'isTTY', { configurable: true, value: tty })
  }
}

const STDIN_METHODS = [
  'read', 'on', 'once', 'addListener', 'prependListener', 'resume', 'pipe', 'setRawMode',
] as const

async function invoke(workspace: Workspace, args: readonly string[]): Promise<Invocation> {
  const stdout: string[] = []
  const stderr: string[] = []
  const stdinTouches: string[] = []
  const spies = [
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout.push(String(chunk))
      return true
    }),
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr.push(String(chunk))
      return true
    }),
    vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => {
      stdout.push(`${values.map(String).join(' ')}\n`)
    }),
  ]
  const stdin = process.stdin as unknown as Record<string, unknown>
  const originals = new Map<string, { own: boolean; value: unknown }>()
  for (const method of STDIN_METHODS) {
    originals.set(method, { own: Object.hasOwn(stdin, method), value: stdin[method] })
    stdin[method] = () => {
      stdinTouches.push(method)
      throw new Error(`stdin.${method} is forbidden in a maintenance invocation`)
    }
  }
  process.exitCode = undefined
  let commanderError: CommanderError | undefined
  try {
    const knowledge = createKnowledgeCommand()
    const program = new Command().option('--config <path>', 'config file path').addCommand(knowledge)
    for (const command of [program, knowledge, ...knowledge.commands]) command.exitOverride()
    try {
      await program.parseAsync(['node', 'agent-qa', '--config', workspace.configPath, 'knowledge', ...args])
    } catch (error) {
      if (!(error instanceof CommanderError)) throw error
      commanderError = error
    }
  } finally {
    for (const [method, original] of originals) {
      if (original.own) stdin[method] = original.value
      else delete stdin[method]
    }
    for (const spy of spies) spy.mockRestore()
  }
  return {
    stdout: stdout.join(''),
    stderr: stderr.join(''),
    exitCode: process.exitCode,
    ...(commanderError === undefined ? {} : { commanderError }),
    stdinTouches,
  }
}

describe('432 maintenance commands execute declared intent', () => {
  const roots: string[] = []
  let exitCode: typeof process.exitCode
  const ttys = new Map<NodeJS.ReadStream | NodeJS.WriteStream, boolean | undefined>()

  beforeEach(() => {
    exitCode = process.exitCode
    for (const stream of [process.stdin, process.stdout, process.stderr]) ttys.set(stream, stream.isTTY)
    setTerminal(false)
    harness.readlineCalls.splice(0)
    harness.leaseAcquireHook = undefined
    harness.authorityRefreshHook = undefined
    harness.authorityRefreshCalls = 0
    harness.purgeRecordCalls = 0
    harness.rollbackCurationJobCalls = 0
    harness.rollbackCampaignCalls = 0
  })

  afterEach(() => {
    process.exitCode = exitCode
    for (const [stream, value] of ttys) {
      Object.defineProperty(stream, 'isTTY', { configurable: true, value })
    }
    vi.restoreAllMocks()
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  describe('C432-MAINTENANCE-NO-PROMPTS', () => {
    it('C432-MAINTENANCE-NO-PROMPTS: rollback applies from a non-TTY with stdin forbidden and no flag', async () => {
      const workspace = workspaceFixture(roots)
      const bundle = seedBundle(workspace, { createdAtOrdinal: BUILD_ORDINAL })

      const result = await invoke(workspace, ['rollback', '--job', CURATION_JOB_ID, '--json'])

      expect(result.commanderError).toBeUndefined()
      expect(result.exitCode).toBeUndefined()
      expect(JSON.parse(result.stdout)).toMatchObject({
        receiptId: expect.stringMatching(/^rollback:/u),
        inverseCount: 1,
        deprecatedBundles: [bundle.id],
      })
      expect(result.stderr).toContain('Rollback preview')
      expect(harness.rollbackCurationJobCalls).toBe(1)
      expect(deprecatedBy(bundle.dir)).toBe(1)
      expect(harness.readlineCalls).toEqual([])
      expect(result.stdinTouches).toEqual([])
    })

    it('C432-MAINTENANCE-NO-PROMPTS: knowledge purge removes the explicit record from a non-TTY with stdin forbidden', async () => {
      const workspace = workspaceFixture(roots)
      const bundle = seedBundle(workspace)

      const result = await invoke(workspace, ['purge', bundle.id, '--json'])

      expect(result.commanderError).toBeUndefined()
      expect(result.exitCode).toBeUndefined()
      const receipt = guardPurgeReceipt(JSON.parse(result.stdout))
      expect(receipt.purgedRecordId).toBe(bundle.id)
      expect(receipt.initiator).toMatch(/^cli:.+/u)
      expect(result.stderr).toContain(`Purge preview for ${bundle.id}`)
      expect(existsSync(bundle.dir)).toBe(false)
      expect(harness.purgeRecordCalls).toBe(1)
      expect(harness.readlineCalls).toEqual([])
      expect(result.stdinTouches).toEqual([])
    })

    it('C432-MAINTENANCE-NO-PROMPTS: an interactive terminal is not asked either', async () => {
      setTerminal(true)
      const rollbackWorkspace = workspaceFixture(roots)
      const rolledBack = seedBundle(rollbackWorkspace, { createdAtOrdinal: BUILD_ORDINAL })
      const rollback = await invoke(rollbackWorkspace, ['rollback', '--job', CURATION_JOB_ID])
      expect(rollback.exitCode).toBeUndefined()
      expect(rollback.stdout).toContain('Rollback preview')
      expect(rollback.stdout).toContain('Rollback complete')
      expect(deprecatedBy(rolledBack.dir)).toBe(1)

      const purgeWorkspace = workspaceFixture(roots)
      const purged = seedBundle(purgeWorkspace)
      const purge = await invoke(purgeWorkspace, ['purge', purged.id])
      expect(purge.exitCode).toBeUndefined()
      expect(purge.stdout).toContain(`Purge preview for ${purged.id}`)
      expect(purge.stdout).toContain('Purge complete')
      expect(existsSync(purged.dir)).toBe(false)

      expect(harness.readlineCalls).toEqual([])
      expect([...rollback.stdinTouches, ...purge.stdinTouches]).toEqual([])
    })

    it('C432-MAINTENANCE-NO-PROMPTS: the retired --yes and --confirm options are unknown before any effect', async () => {
      const workspace = workspaceFixture(roots)
      const bundle = seedBundle(workspace, { createdAtOrdinal: BUILD_ORDINAL })
      const before = snapshot(workspace.root)

      const invocations: Array<{ args: readonly string[]; option: string }> = [
        { args: ['rollback', '--job', CURATION_JOB_ID, '--yes', '--json'], option: '--yes' },
        { args: ['purge', bundle.id, '--confirm', bundle.id, '--json'], option: '--confirm' },
        { args: ['purge', bundle.id, '--yes'], option: '--yes' },
      ]
      for (const { args, option } of invocations) {
        const result = await invoke(workspace, args)
        expect(result.commanderError?.code, args.join(' ')).toBe('commander.unknownOption')
        expect(result.stderr, args.join(' ')).toContain(`unknown option '${option}'`)
        expect(result.stdout, args.join(' ')).toBe('')
      }
      expect(snapshot(workspace.root)).toEqual(before)
      expect(harness.rollbackCurationJobCalls).toBe(0)
      expect(harness.purgeRecordCalls).toBe(0)
      expect(harness.readlineCalls).toEqual([])
    })

    it('C432-MAINTENANCE-NO-PROMPTS: help names no confirmation option', () => {
      const knowledge = createKnowledgeCommand()
      for (const name of ['rollback', 'purge']) {
        const command = knowledge.commands.find((candidate) => candidate.name() === name)
        expect(command, name).toBeDefined()
        const options = command!.options.map((option) => option.long)
        expect(options, name).not.toContain('--yes')
        expect(options, name).not.toContain('--confirm')
        expect(command!.helpInformation(), name).not.toMatch(/confirm|approv|prompt/iu)
      }
    })

    it('C432-MAINTENANCE-NO-PROMPTS: a campaign rollback applies across products with no flag', async () => {
      const alpha = 'maintenance-direct-campaign-alpha'
      const beta = 'maintenance-direct-campaign-beta'
      const workspace = workspaceFixture(roots, { [alpha]: 7, [beta]: 11 })
      const first = seedBundle(workspace, { product: alpha, createdAtOrdinal: 7 })
      const second = seedBundle(workspace, { product: beta, createdAtOrdinal: 11 })

      const result = await invoke(workspace, [
        'rollback', '--from-build', '7', '--to-build', '11', '--json',
      ])

      expect(result.exitCode).toBeUndefined()
      expect(JSON.parse(result.stdout)).toMatchObject({ inverseCount: 2 })
      expect(harness.rollbackCampaignCalls).toBe(1)
      expect(deprecatedBy(first.dir)).toBe(1)
      expect(deprecatedBy(second.dir)).toBe(1)
      expect(harness.readlineCalls).toEqual([])
      expect(result.stdinTouches).toEqual([])
    })

    it('a live writer lease still refuses rollback and purge before any effect, with no prompt', async () => {
      const workspace = workspaceFixture(roots)
      const bundle = seedBundle(workspace)
      const holder = '66666666-6666-4666-8666-666666666666'
      writeFileSync(join(workspace.knowledgeRoot, '.epoch'), '7\n', 'utf8')
      writeFileSync(join(workspace.knowledgeRoot, '.lease'), `${JSON.stringify({
        leaseId: holder,
        pid: 4343,
        epoch: 7,
        heartbeatAtMs: Date.now() + 60_000,
      })}\n`, 'utf8')
      const before = snapshot(workspace.knowledgeRoot)

      for (const args of [
        ['rollback', '--job', CURATION_JOB_ID, '--json'],
        ['purge', bundle.id, '--json'],
      ]) {
        const result = await invoke(workspace, args)
        expect(result.exitCode, args[0]).toBe(1)
        expect(result.stdout, args[0]).toBe('')
        expect(result.stderr, args[0]).toContain('refusal [writer-lease-held]')
        expect(result.stderr, args[0]).toContain(holder)
      }
      expect(snapshot(workspace.knowledgeRoot)).toEqual(before)
      expect(harness.rollbackCurationJobCalls).toBe(0)
      expect(harness.purgeRecordCalls).toBe(0)
      expect(harness.readlineCalls).toEqual([])
    })

    it('keeps typed refusals for an invalid, empty or unknown purge target and a missing rollback selector', async () => {
      const workspace = workspaceFixture(roots)
      const bundle = seedBundle(workspace)
      const before = snapshot(bundle.dir)

      const escaping = await invoke(workspace, ['purge', '../escape', '--json'])
      expect(escaping.exitCode).toBe(1)
      expect(escaping.stdout).toBe('')
      expect(escaping.stderr).toContain('knowledge purge: error: recordId must be a safe path segment')

      const empty = await invoke(workspace, ['purge', '', '--json'])
      expect(empty.exitCode).toBe(1)
      expect(empty.stdout).toBe('')
      expect(empty.stderr).toContain('knowledge purge: error: recordId must be a safe path segment')

      const unknown = await invoke(workspace, ['purge', 'f'.repeat(64), '--json'])
      expect(unknown.exitCode).toBe(1)
      expect(unknown.stdout).toBe('')
      expect(unknown.stderr).toContain(`knowledge purge: error [not-found]: record ${'f'.repeat(64)}`)

      const unselected = await invoke(workspace, ['rollback', '--json'])
      expect(unselected.exitCode).toBe(1)
      expect(unselected.stderr).toContain('knowledge rollback: error [invalid-selector]')

      const blankJob = await invoke(workspace, ['rollback', '--job', ' ', '--json'])
      expect(blankJob.exitCode).toBe(1)
      expect(blankJob.stderr).toContain('knowledge rollback: error [invalid-selector]: --job must be non-empty')

      expect(snapshot(bundle.dir)).toEqual(before)
      expect(harness.purgeRecordCalls).toBe(1)
      expect(harness.rollbackCurationJobCalls).toBe(0)
      expect(harness.readlineCalls).toEqual([])
    })
  })

  describe('C432-PURGE-DRIFT', () => {
    it('C432-PURGE-DRIFT: purge refuses a target that drifts after its preview, with no partial deletion', async () => {
      const workspace = workspaceFixture(roots)
      const primary = seedBundle(workspace)
      let drifted: { id: string; dir: string } | undefined
      let knowledgeBefore: Record<string, string> = {}
      harness.leaseAcquireHook = () => {
        if (drifted !== undefined) return
        drifted = seedBundle(workspace, { product: 'maintenance-direct-z-drift', scopeProduct: PRODUCT })
        knowledgeBefore = snapshot(workspace.knowledgeRoot)
      }

      const result = await invoke(workspace, ['purge', primary.id, '--json'])

      expect(drifted?.id).toBe(primary.id)
      expect(result.exitCode).toBe(1)
      expect(result.stdout).toBe('')
      expect(result.stderr).toContain(
        'knowledge purge: error [preview-changed]: purge target changed after the preview',
      )
      expect(harness.purgeRecordCalls).toBe(0)
      expect(existsSync(primary.dir)).toBe(true)
      expect(existsSync(drifted!.dir)).toBe(true)
      // Only the writer lease's own top-level bookkeeping (.epoch, .lease, .writer-authority.*) may
      // move; no store byte changes.
      const withoutLease = (files: Record<string, string>) => Object.fromEntries(
        Object.entries(files).filter(([path]) => !/^\.[^/]+$/u.test(path)),
      )
      expect(withoutLease(snapshot(workspace.knowledgeRoot))).toEqual(withoutLease(knowledgeBefore))
      for (const path of purgeReceiptPaths(workspace, primary.id)) expect(existsSync(path)).toBe(false)
      expect(harness.readlineCalls).toEqual([])
    })

    it('C432-PURGE-DRIFT: drift after the under-lease recheck is refused by the mutator before deletion', async () => {
      const workspace = workspaceFixture(roots)
      const primary = seedBundle(workspace)
      let drifted: { id: string; dir: string } | undefined
      harness.authorityRefreshHook = (call) => {
        if (call !== 1) return
        drifted = seedBundle(workspace, { product: 'maintenance-direct-z-late', scopeProduct: PRODUCT })
      }

      const result = await invoke(workspace, ['purge', primary.id, '--json'])

      expect(drifted?.id).toBe(primary.id)
      expect(result.exitCode).toBe(1)
      expect(result.stdout).toBe('')
      expect(result.stderr).toContain('knowledge purge: error: purge target set changed after the preview')
      expect(result.stderr).not.toMatch(/confirm/iu)
      expect(harness.purgeRecordCalls).toBe(1)
      expect(existsSync(primary.dir)).toBe(true)
      expect(existsSync(drifted!.dir)).toBe(true)
      for (const path of purgeReceiptPaths(workspace, primary.id)) expect(existsSync(path)).toBe(false)
    })

    it('C432-PURGE-DRIFT: a rerun after the refusal previews the new set and removes every copy', async () => {
      const workspace = workspaceFixture(roots, { [PRODUCT]: BUILD_ORDINAL, 'maintenance-direct-z-retry': 3 })
      const primary = seedBundle(workspace)
      let drifted: { id: string; dir: string } | undefined
      harness.leaseAcquireHook = () => {
        if (drifted !== undefined) return
        drifted = seedBundle(workspace, { product: 'maintenance-direct-z-retry', scopeProduct: PRODUCT })
      }
      const refused = await invoke(workspace, ['purge', primary.id, '--json'])
      expect(refused.exitCode).toBe(1)
      expect(refused.stderr).toContain('preview-changed')

      const retried = await invoke(workspace, ['purge', primary.id, '--json'])
      expect(retried.exitCode).toBeUndefined()
      expect(retried.stderr).toContain(relative(workspace.knowledgeRoot, drifted!.dir))
      expect(guardPurgeReceipt(JSON.parse(retried.stdout)).purgedRecordId).toBe(primary.id)
      expect(existsSync(primary.dir)).toBe(false)
      expect(existsSync(drifted!.dir)).toBe(false)
      expect(harness.purgeRecordCalls).toBe(1)
    })

    it('C432-PURGE-DRIFT: rollback refuses the same under-lease drift before any inverse event', async () => {
      const driftProduct = 'maintenance-direct-rollback-drift'
      const workspace = workspaceFixture(roots, { [PRODUCT]: BUILD_ORDINAL, [driftProduct]: 6 })
      const bundle = seedBundle(workspace)
      const counters = readFileSync(join(workspace.runtimeRoot, 'build-ordinals.json'))
      harness.leaseAcquireHook = () => {
        if (harness.leaseAcquireHook === undefined) return
        harness.leaseAcquireHook = undefined
        seedBundle(workspace, { product: driftProduct, createdAtOrdinal: 6 })
      }

      const result = await invoke(workspace, ['rollback', '--job', CURATION_JOB_ID, '--json'])

      expect(result.exitCode).toBe(1)
      expect(result.stdout).toBe('')
      expect(result.stderr).toContain(
        'knowledge rollback: error [preview-changed]: rollback target changed after the preview',
      )
      expect(harness.rollbackCurationJobCalls).toBe(0)
      expect(deprecatedBy(bundle.dir)).toBe(0)
      expect(readFileSync(join(workspace.runtimeRoot, 'build-ordinals.json'))).toEqual(counters)
      expect(harness.readlineCalls).toEqual([])
    })
  })
})
