import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  acquireWriterLease,
  appendOutcomeEvent,
  guardPurgeReceipt,
  loadBundle,
  purgeRecord,
  queuedCandidateDir,
} from '@vostride/agent-qa-knowledge-local'
import { publishBundleForTest as publishBundle } from '@vostride/agent-qa-knowledge-local'
import type {
  BundleStoreConfig,
  PublishBundleInput,
} from '@vostride/agent-qa-knowledge-local'
import {
  asEvidenceToken,
  asRecordId,
  BundleOutcomeEventSchema,
} from '@vostride/agent-qa-schema'
import type {
  BundleDiscriminant,
  BundleDraft,
} from '@vostride/agent-qa-schema'
import { Command, CommanderError } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const commandHarness = vi.hoisted(() => ({
  promptCalls: [] as Array<{
    input: 'stdin' | 'other'
    output: 'stdout' | 'stderr' | 'other'
    question: string
  }>,
  // Runs as the writer lease is acquired: after the preview, before the under-lease recheck.
  leaseAcquireHook: undefined as (() => void) | undefined,
  rebuildIndexHook: undefined as ((input: Record<string, unknown>) => Promise<unknown>) | undefined,
  authorityRefreshHook: undefined as (
    (authority: Record<string, unknown>, call: number) => void
  ) | undefined,
  authorityRefreshCalls: 0,
  drainQueueCalls: 0,
  drainInputs: [] as Record<string, unknown>[],
  drainPromotions: undefined as Array<{ candidateId: string; promotionPath?: 'deterministic-verdict-floor'; promotionHoldReason?: 'gate1-receipt-required' }> | undefined,
  releaseLeaseCalls: 0,
  rebuildIndexInputs: [] as Record<string, unknown>[],
  purgeRecordInputs: [] as Record<string, unknown>[],
  rollbackCampaignInputs: [] as Record<string, unknown>[],
  rollbackCurationJobInputs: [] as Record<string, unknown>[],
  purgeRecordCalls: 0,
  rollbackCampaignCalls: 0,
  rollbackCurationJobCalls: 0,
}))

const daemonHarness = vi.hoisted(() => ({
  nudgeCalls: [] as string[],
  nudgeCallTimes: [] as number[],
  nudgeOptions: [] as Array<{
    knowledgeRoot?: string
    deadlineMs?: number
    requireReceipt?: boolean
    signal?: AbortSignal
  } | undefined>,
  nudgeHook: undefined as (
    | ((
      agentQaRoot: string,
      options?: {
        knowledgeRoot?: string
        deadlineMs?: number
        requireReceipt?: boolean
        signal?: AbortSignal
      },
    ) =>
      | Promise<{ sessionId: string } | undefined>
      | { sessionId: string }
      | undefined)
    | undefined
  ),
  // The classification seam: only the identity handshake is injected, so every routing case
  // below is decided by the real five-way classifier reading real lease and registration bytes.
  identityHook: undefined as (
    | ((registration: { instanceId: string; pid: number; socketPath: string }) =>
      Promise<DaemonIdentity>)
    | undefined
  ),
  classifyCalls: 0,
  ownedRemovals: [] as string[],
  ownedRemovalHook: undefined as (((instanceId: string) => boolean | undefined) | undefined),
}))

vi.mock('node:readline', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:readline')>()
  return {
    ...actual,
    createInterface: vi.fn((options: {
      input: NodeJS.ReadableStream
      output?: NodeJS.WritableStream
    }) => ({
      close: vi.fn(),
      question: (question: string, resolveAnswer: (answer: string) => void) => {
        const output = options.output
        if (output === undefined) throw new Error('maintenance prompt requires an output stream')
        commandHarness.promptCalls.push({
          input: options.input === process.stdin ? 'stdin' : 'other',
          output: output === process.stdout
            ? 'stdout'
            : output === process.stderr ? 'stderr' : 'other',
          question,
        })
        output.write(question)
        // Phase 432 D-14: maintenance never asks. A prompt that is still wired is declined, so it
        // fails on outcome assertions rather than hanging the worker.
        resolveAnswer('n')
      },
    })),
  }
})

vi.mock('@vostride/agent-qa-knowledge-local', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('@vostride/agent-qa-knowledge-local')
  >()
  return {
    ...actual,
    acquireWriterLease: vi.fn((...args: Parameters<typeof actual.acquireWriterLease>) => {
      commandHarness.leaseAcquireHook?.()
      return actual.acquireWriterLease(...args)
    }),
    drainQueue: vi.fn((...args: Parameters<typeof actual.drainQueue>) => {
      commandHarness.drainQueueCalls += 1
      commandHarness.drainInputs.push(args[0] as unknown as Record<string, unknown>)
      return actual.drainQueue(...args).then(report => commandHarness.drainPromotions === undefined
        ? report : { ...report, promotions: commandHarness.drainPromotions })
    }),
    rebuildIndex: vi.fn((...args: Parameters<typeof actual.rebuildIndex>) => {
      const input = args[0] as unknown as Record<string, unknown>
      commandHarness.rebuildIndexInputs.push(input)
      return commandHarness.rebuildIndexHook === undefined
        ? actual.rebuildIndex(...args)
        : commandHarness.rebuildIndexHook(input)
    }),
    refreshWriterLeaseAuthority: vi.fn((...args: Parameters<typeof actual.refreshWriterLeaseAuthority>) => {
      commandHarness.authorityRefreshCalls += 1
      commandHarness.authorityRefreshHook?.(
        args[0] as unknown as Record<string, unknown>,
        commandHarness.authorityRefreshCalls,
      )
      return actual.refreshWriterLeaseAuthority(...args)
    }),
    releaseLease: vi.fn((...args: Parameters<typeof actual.releaseLease>) => {
      commandHarness.releaseLeaseCalls += 1
      return actual.releaseLease(...args)
    }),
    purgeRecord: vi.fn((...args: Parameters<typeof actual.purgeRecord>) => {
      commandHarness.purgeRecordCalls += 1
      commandHarness.purgeRecordInputs.push(args[0] as unknown as Record<string, unknown>)
      return actual.purgeRecord(...args)
    }),
    rollbackCampaign: vi.fn((...args: Parameters<typeof actual.rollbackCampaign>) => {
      commandHarness.rollbackCampaignCalls += 1
      commandHarness.rollbackCampaignInputs.push(args[0] as unknown as Record<string, unknown>)
      return actual.rollbackCampaign(...args)
    }),
    rollbackCurationJob: vi.fn((...args: Parameters<typeof actual.rollbackCurationJob>) => {
      commandHarness.rollbackCurationJobCalls += 1
      commandHarness.rollbackCurationJobInputs.push(args[0] as unknown as Record<string, unknown>)
      return actual.rollbackCurationJob(...args)
    }),
  }
})

vi.mock('../daemon/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../daemon/client.js')>()
  return {
    ...actual,
    nudgeDaemon: vi.fn(async (
      agentQaRoot: string,
      options?: {
        knowledgeRoot?: string
        deadlineMs?: number
        requireReceipt?: boolean
        signal?: AbortSignal
      },
    ) => {
      daemonHarness.nudgeCalls.push(agentQaRoot)
      daemonHarness.nudgeCallTimes.push(Date.now())
      daemonHarness.nudgeOptions.push(options)
      return await daemonHarness.nudgeHook?.(agentQaRoot, options)
    }),
  }
})

vi.mock('../daemon/registration.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../daemon/registration.js')>()
  return {
    ...actual,
    classifyDaemonRegistration: vi.fn(async (
      input: Parameters<typeof actual.classifyDaemonRegistration>[0],
    ) => {
      daemonHarness.classifyCalls += 1
      return await actual.classifyDaemonRegistration({
        ...input,
        ...(daemonHarness.identityHook === undefined
          ? {}
          : { operations: { fetchIdentity: daemonHarness.identityHook } }),
      })
    }),
    removeRegistrationIfOwned: vi.fn((
      agentQaRoot: string,
      instanceId: string,
      options?: Parameters<typeof actual.removeRegistrationIfOwned>[2],
    ) => {
      daemonHarness.ownedRemovals.push(instanceId)
      const forced = daemonHarness.ownedRemovalHook?.(instanceId)
      if (forced !== undefined) return forced
      return actual.removeRegistrationIfOwned(agentQaRoot, instanceId, options)
    }),
  }
})

import { createKnowledgeCommand } from '../commands/knowledge.js'
import {
  CURATION_TAIL_RECEIPT_FILE,
  CURATION_TAIL_RECEIPT_SCHEMA_VERSION,
  type CurationTailReceipt,
} from '../curation/curation-tail.js'
import {
  appendDrainSessionReceipt,
} from '../daemon/drain-receipts.js'
import * as drainReceipts from '../daemon/drain-receipts.js'
import { readDaemonEventLedger } from '../daemon/events.js'
import {
  DAEMON_REGISTRATION_SCHEMA_VERSION,
  daemonRegistrationPath,
  writeDaemonRegistration,
} from '../daemon/registration.js'
import { DAEMON_IDENTITY_SCHEMA_VERSION, daemonSocketPath } from '../daemon/server.js'
import type { DaemonIdentity } from '../daemon/server.js'

const PRODUCT = 'maintenance-storefront'
const CURATION_JOB_ID = 'maintenance-curation-job'
const BUILD_ORDINAL = 12
const LIVE_LEASE_ID = '11111111-1111-4111-8111-111111111111'
const DAEMON_INSTANCE_ID = '44444444-4444-4444-8444-444444444444'
const SIBLING_INSTANCE_ID = '55555555-5555-4555-8555-555555555555'
const FIRST_CANDIDATE_ID = 'a'.repeat(64)
const SECOND_CANDIDATE_ID = 'b'.repeat(64)
const FIRST_SESSION_ID = '22222222-2222-4222-8222-222222222222'
const SECOND_SESSION_ID = '33333333-3333-4333-8333-333333333333'

interface FixtureWorkspace {
  root: string
  configPath: string
  knowledgeRoot: string
  runtimeRoot: string
}

interface InvocationResult {
  stdout: string
  stderr: string
  exitCode: typeof process.exitCode
  commanderError?: CommanderError
}

function fixtureWorkspace(
  roots: string[],
  ordinals: Readonly<Record<string, number>> = { [PRODUCT]: BUILD_ORDINAL },
  knowledgeDir = 'agent-qa-knowledge',
): FixtureWorkspace {
  const root = mkdtempSync(join(tmpdir(), `agent-qa-knowledge-maintain-${randomUUID()}-`))
  roots.push(root)
  const configPath = join(root, 'agent-qa.config.yaml')
  const runtimeRoot = join(root, '.agent-qa')
  mkdirSync(runtimeRoot, { recursive: true })
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
        dir: knowledgeDir,
        commitArtifacts: 'none',
      },
      use: {
        mobile: { appState: 'preserve' },
      },
    }, null, 2)}\n`,
    'utf8',
  )
  writeFileSync(
    join(runtimeRoot, 'build-ordinals.json'),
    `${JSON.stringify(ordinals)}\n`,
    'utf8',
  )
  writeFileSync(join(root, '.env.secrets.local'), '', 'utf8')
  return {
    root,
    configPath,
    knowledgeRoot: join(root, knowledgeDir),
    runtimeRoot,
  }
}

interface SeedBundleOptions {
  product?: string
  scopeProduct?: string
  createdAtOrdinal?: number
  curationJobId?: string
}

function bundleInput(options: SeedBundleOptions = {}): PublishBundleInput {
  const product = options.product ?? PRODUCT
  const scopeProduct = options.scopeProduct ?? product
  const createdAtOrdinal = options.createdAtOrdinal ?? 5
  const curationJobId = options.curationJobId ?? CURATION_JOB_ID
  const draft: BundleDraft = {
    kind: 'fact',
    subtype: 'selector',
    anchors: [{ t: 'el', role: 'button', name: 'Checkout' }],
    scope: { tier: 'product', key: scopeProduct },
    summary: 'Use the Checkout button to continue.',
    body: 'The checkout selector was confirmed by a completed run.',
    distilledEvidenceRef: {
      id: 'maintenance-evidence',
      sha: 'a'.repeat(64),
    },
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
      evidenceToken: asEvidenceToken(`maintenance-confirmation-${product}-${createdAtOrdinal}`),
      curationJobId,
      buildOrdinal: createdAtOrdinal,
      origin: 'agent-verified',
    })],
    relations: [],
    provenance: {
      mode: 'run-linked',
      runId: `run-knowledge-maintenance-${product}`,
      testId: 'test-knowledge-maintenance',
      stepIndex: 0,
      curationJobId,
      sourceBuildOrdinal: createdAtOrdinal,
    },
    artifacts: [],
    evidenceMarkdown: 'Checkout was observed deterministically.\n',
  }
}

function seedBundle(
  workspace: FixtureWorkspace,
  options: SeedBundleOptions = {},
): { id: string; dir: string } {
  const product = options.product ?? PRODUCT
  const config: BundleStoreConfig = {
    knowledgeRoot: workspace.knowledgeRoot,
    productKey: product,
    commitArtifacts: 'none',
  }
  const published = publishBundle(config, bundleInput(options))
  if (published.kind !== 'published') {
    throw new Error(`expected published maintenance fixture, got ${published.kind}`)
  }
  return { id: published.id, dir: published.dir }
}

function expectedBundlePaths(workspace: FixtureWorkspace, bundleDir: string): string[] {
  const loaded = loadBundle(bundleDir)
  if (loaded.kind !== 'loaded') {
    throw new Error(`expected loaded purge fixture, got ${loaded.kind}`)
  }
  const relativeDir = relative(workspace.knowledgeRoot, bundleDir)
  return [
    relativeDir,
    ...Object.keys(loaded.bundle.manifest.contentHashes).map((path) => `${relativeDir}/${path}`),
    `${relativeDir}/manifest.json`,
  ].sort()
}

function rollbackInverseOrdinals(bundleDir: string): number[] {
  const loaded = loadBundle(bundleDir)
  if (loaded.kind !== 'loaded') {
    throw new Error(`expected loaded rollback fixture, got ${loaded.kind}`)
  }
  return loaded.bundle.events
    .filter(({ curationJobId }) => curationJobId.startsWith('rollback:'))
    .map(({ buildOrdinal }) => buildOrdinal)
}

function snapshotFiles(root: string): Record<string, string> {
  if (!existsSync(root)) return {}
  const files: Record<string, string> = {}

  function visit(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile()) {
        files[relative(root, path)] = readFileSync(path).toString('base64')
      }
    }
  }

  visit(root)
  return files
}

async function invoke(
  workspace: FixtureWorkspace,
  args: readonly string[],
): Promise<InvocationResult> {
  const stdout: string[] = []
  const stderr: string[] = []
  const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout.push(String(chunk))
    return true
  })
  const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr.push(String(chunk))
    return true
  })
  const consoleLog = vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => {
    stdout.push(`${values.map(String).join(' ')}\n`)
  })
  process.exitCode = undefined

  let commanderError: CommanderError | undefined
  try {
    const knowledge = createKnowledgeCommand()
    const program = new Command()
      .option('--config <path>', 'config file path')
      .addCommand(knowledge)
    for (const command of [program, knowledge, ...knowledge.commands]) {
      command.exitOverride()
    }
    try {
      await program.parseAsync([
        'node',
        'agent-qa',
        '--config',
        workspace.configPath,
        'knowledge',
        ...args,
      ])
    } catch (error) {
      if (!(error instanceof CommanderError)) throw error
      commanderError = error
    }
    return {
      stdout: stdout.join(''),
      stderr: stderr.join(''),
      exitCode: process.exitCode,
      ...(commanderError === undefined ? {} : { commanderError }),
    }
  } finally {
    stdoutWrite.mockRestore()
    stderrWrite.mockRestore()
    consoleLog.mockRestore()
  }
}

function plantLiveWriterLease(workspace: FixtureWorkspace): void {
  mkdirSync(join(workspace.knowledgeRoot, 'memory', 'index'), { recursive: true })
  writeFileSync(join(workspace.knowledgeRoot, '.epoch'), '7\n', 'utf8')
  writeFileSync(
    join(workspace.knowledgeRoot, '.lease'),
    `${JSON.stringify({
      leaseId: LIVE_LEASE_ID,
      pid: 4242,
      epoch: 7,
      heartbeatAtMs: Date.now() + 60_000,
    })}\n`,
    'utf8',
  )
}

function plantDaemonRegistration(
  workspace: FixtureWorkspace,
  pid = process.pid,
  socketPath = join(workspace.runtimeRoot, 'daemon.sock'),
): void {
  writeDaemonRegistration(workspace.runtimeRoot, {
    schemaVersion: DAEMON_REGISTRATION_SCHEMA_VERSION,
    instanceId: DAEMON_INSTANCE_ID,
    pid,
    socketPath,
    startedAtMs: Date.now(),
  })
}

/**
 * Leave a real socket inode behind with no listener, exactly as a SIGKILLed daemon does.
 *
 * An in-process `net.Server` unlinks its own path on close, which would make "the socket is
 * gone" true for reasons that have nothing to do with the code under test. Only a listener that
 * never got to clean up leaves the artifact drain recovery actually meets.
 */
async function abandonSocketFile(socketPath: string): Promise<void> {
  mkdirSync(dirname(socketPath), { recursive: true })
  const child = spawn(
    process.execPath,
    ['-e', "require('node:net').createServer().listen(process.argv[1])", socketPath],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  )
  try {
    const deadline = Date.now() + 10_000
    while (!existsSync(socketPath)) {
      if (Date.now() > deadline) throw new Error(`abandoned socket ${socketPath} was never bound`)
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    if (!lstatSync(socketPath).isSocket()) throw new Error(`${socketPath} is not a socket`)
  } finally {
    const exited = once(child, 'exit')
    child.kill('SIGKILL')
    await exited
  }
}

/**
 * Answer the identity handshake as the registered generation itself would.
 *
 * Delegation is only legal for a nonce-authenticated host, so a delegating fixture has to
 * produce that proof. Nothing else about classification is stubbed.
 */
function armLiveDaemonIdentity(): void {
  daemonHarness.identityHook = (registration) => Promise.resolve({
    schemaVersion: DAEMON_IDENTITY_SCHEMA_VERSION,
    instanceId: registration.instanceId,
    pid: registration.pid,
  })
}

/** A live pid whose socket answers with somebody else's identity: alive is not authority. */
function armForeignDaemonIdentity(): void {
  daemonHarness.identityHook = () => Promise.resolve({
    schemaVersion: DAEMON_IDENTITY_SCHEMA_VERSION,
    instanceId: '99999999-9999-4999-8999-999999999999',
    pid: 1,
  })
}

function seedPendingCandidate(workspace: FixtureWorkspace, candidateId: string): string {
  const dir = queuedCandidateDir(workspace.knowledgeRoot, candidateId)
  mkdirSync(dir, { recursive: true })
  return dir
}

function writeRunReceipt(
  workspace: FixtureWorkspace,
  directory: string,
  receipt: Omit<CurationTailReceipt, 'schemaVersion' | 'handoffDigest' | 'projectionVersion'>,
): void {
  const runDir = join(workspace.runtimeRoot, 'runs', directory)
  mkdirSync(runDir, { recursive: true })
  writeFileSync(
    join(runDir, CURATION_TAIL_RECEIPT_FILE),
    `${JSON.stringify({
      schemaVersion: CURATION_TAIL_RECEIPT_SCHEMA_VERSION,
      handoffDigest: 'c'.repeat(64),
      projectionVersion: 1,
      ...receipt,
    })}\n`,
    'utf8',
  )
}

describe('knowledge maintenance commands', () => {
  const roots: string[] = []
  let originalExitCode: typeof process.exitCode
  let originalStderrIsTty: boolean | undefined
  let originalStdinIsTty: boolean | undefined
  let originalStdoutIsTty: boolean | undefined

  function setTerminalTopology(input: {
    stderr: boolean
    stdin: boolean
    stdout: boolean
  }): void {
    Object.defineProperty(process.stdin, 'isTTY', {
      configurable: true,
      value: input.stdin,
    })
    Object.defineProperty(process.stdout, 'isTTY', {
      configurable: true,
      value: input.stdout,
    })
    Object.defineProperty(process.stderr, 'isTTY', {
      configurable: true,
      value: input.stderr,
    })
  }

  beforeEach(() => {
    originalExitCode = process.exitCode
    originalStdinIsTty = process.stdin.isTTY
    originalStdoutIsTty = process.stdout.isTTY
    originalStderrIsTty = process.stderr.isTTY
    setTerminalTopology({ stdin: false, stdout: false, stderr: false })
    commandHarness.promptCalls.splice(0)
    commandHarness.leaseAcquireHook = undefined
    commandHarness.rebuildIndexHook = undefined
    commandHarness.authorityRefreshHook = undefined
    commandHarness.authorityRefreshCalls = 0
    commandHarness.drainQueueCalls = 0
    commandHarness.drainInputs = []
    commandHarness.drainPromotions = undefined
    commandHarness.releaseLeaseCalls = 0
    commandHarness.rebuildIndexInputs.splice(0)
    commandHarness.purgeRecordInputs.splice(0)
    commandHarness.rollbackCampaignInputs.splice(0)
    commandHarness.rollbackCurationJobInputs.splice(0)
    commandHarness.purgeRecordCalls = 0
    commandHarness.rollbackCampaignCalls = 0
    commandHarness.rollbackCurationJobCalls = 0
    daemonHarness.nudgeCalls.splice(0)
    daemonHarness.nudgeCallTimes.splice(0)
    daemonHarness.nudgeOptions.splice(0)
    daemonHarness.nudgeHook = undefined
    daemonHarness.identityHook = undefined
    daemonHarness.classifyCalls = 0
    daemonHarness.ownedRemovals.splice(0)
    daemonHarness.ownedRemovalHook = undefined
  })

  afterEach(() => {
    process.exitCode = originalExitCode
    Object.defineProperty(process.stdin, 'isTTY', {
      configurable: true,
      value: originalStdinIsTty,
    })
    Object.defineProperty(process.stdout, 'isTTY', {
      configurable: true,
      value: originalStdoutIsTty,
    })
    Object.defineProperty(process.stderr, 'isTTY', {
      configurable: true,
      value: originalStderrIsTty,
    })
    vi.restoreAllMocks()
    vi.useRealTimers()
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('drains the curation queue inline when daemon registration is absent', async () => {
    const workspace = fixtureWorkspace(roots)

    const result = await invoke(workspace, ['drain'])

    expect(result.exitCode).toBeUndefined()
    expect(result.stderr).toBe('')
    expect(result.stdout).toContain('Knowledge curation queue drained inline')
    expect(result.stdout).toContain('remaining 0')
    expect(commandHarness.drainQueueCalls).toBe(1)
    expect(daemonHarness.nudgeCalls).toEqual([])
  })

  it('prints promotion paths and holds in report order on stdout', async () => {
    const workspace = fixtureWorkspace(roots)
    commandHarness.drainPromotions = [
      { candidateId: 'c1', promotionPath: 'deterministic-verdict-floor' },
      { candidateId: 'c2', promotionHoldReason: 'gate1-receipt-required' },
    ]
    const result = await invoke(workspace, ['drain'])
    expect(result.stdout).toContain('curation: c1 promoted via deterministic-verdict-floor\ncuration: c2 held: gate1-receipt-required')
  })

  it('cleans a stale daemon registration and falls back to the same inline drain', async () => {
    const workspace = fixtureWorkspace(roots)
    plantDaemonRegistration(workspace, 2_000_000_000)

    const result = await invoke(workspace, ['drain'])

    expect(result.exitCode).toBeUndefined()
    expect(result.stdout).toContain('Knowledge curation queue drained inline')
    expect(commandHarness.drainQueueCalls).toBe(1)
    expect(daemonHarness.nudgeCalls).toEqual([])
    expect(existsSync(daemonRegistrationPath(workspace.runtimeRoot))).toBe(false)
  })

  it('routes drain on classified daemon identity and never on signal-zero liveness', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../commands/knowledge-maintain.ts', import.meta.url)),
      'utf8',
    )
    expect(source).toContain('classifyDaemonRegistration')
    // Plan 22's prohibition, and I-01's closure. This replaced a `unconditionalRemovals === 0`
    // counter on a module mock: the counter could only ever say "not called on these schedules",
    // while the surface itself no longer exists to be called on any schedule at all.
    expect(source).not.toContain('removeDaemonRegistration')
    // Pinned non-vacuous: the compare-delete this command DOES use must still be here, so a
    // renamed or emptied file cannot satisfy the assertion above.
    expect(source).toContain('removeRegistrationIfOwned')
  })

  it('refuses to guess a drain mode from a malformed daemon registration', async () => {
    const workspace = fixtureWorkspace(roots)
    writeFileSync(daemonRegistrationPath(workspace.runtimeRoot), '{ not json', 'utf8')
    const registrationBefore = readFileSync(daemonRegistrationPath(workspace.runtimeRoot))

    const result = await invoke(workspace, ['drain'])

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('registration-malformed')
    expect(commandHarness.drainQueueCalls).toBe(0)
    expect(daemonHarness.nudgeCalls).toEqual([])
    expect(readFileSync(daemonRegistrationPath(workspace.runtimeRoot)))
      .toEqual(registrationBefore)
  })

  it('removes exactly the classified stale generation before draining inline', async () => {
    const workspace = fixtureWorkspace(roots)
    plantDaemonRegistration(workspace, 2_000_000_000)

    const result = await invoke(workspace, ['drain'])

    expect(result.exitCode).toBeUndefined()
    expect(result.stdout).toContain('Knowledge curation queue drained inline')
    expect(daemonHarness.ownedRemovals).toEqual([DAEMON_INSTANCE_ID])
    expect(existsSync(daemonRegistrationPath(workspace.runtimeRoot))).toBe(false)
    expect(commandHarness.drainQueueCalls).toBe(1)
  })

  it('unlinks the drain-recovered generation\'s own socket (W-07)', async () => {
    const workspace = fixtureWorkspace(roots)
    // The address the recorded instance is REQUIRED to bind. 386-38's nonce arm demands exactly
    // this, so a fixture that records some other in-root path measures the refusal, not the
    // reclaim — which is how 386-33's exactness fixture came to lock a hazard in.
    const owned = daemonSocketPath(
      workspace.runtimeRoot,
      workspace.root,
      DAEMON_INSTANCE_ID,
    )
    await abandonSocketFile(owned)
    // The sharpest available bystander: a SIBLING generation's address, in the same directory,
    // for the same project — refused because it is not the instance the registration names.
    // Containment would delete it; exactness does not.
    const bystander = daemonSocketPath(
      workspace.runtimeRoot,
      workspace.root,
      SIBLING_INSTANCE_ID,
    )
    await abandonSocketFile(bystander)
    roots.push(dirname(owned), dirname(bystander))
    plantDaemonRegistration(workspace, 2_000_000_000, owned)

    const result = await invoke(workspace, ['drain'])

    expect(result.exitCode).toBeUndefined()
    expect(result.stdout).toContain('Knowledge curation queue drained inline')
    expect(existsSync(daemonRegistrationPath(workspace.runtimeRoot))).toBe(false)
    expect(
      { recovered: existsSync(owned), bystander: existsSync(bystander) },
      'the drain must reclaim the removed generation\'s address and nothing else',
    ).toEqual({ recovered: false, bystander: true })
    expect(readDaemonEventLedger(workspace.runtimeRoot).events).toContainEqual(
      expect.objectContaining({
        kind: 'registration-recovered',
        instanceId: DAEMON_INSTANCE_ID,
        socketPath: owned,
        socketRemoved: true,
      }),
    )
  }, 20_000)

  it('leaves a recorded socket path the drain cannot prove it owns (W-07)', async () => {
    const workspace = fixtureWorkspace(roots)
    // Drawn from OUTSIDE the ownership precondition: a real socket in its own directory, named
    // by registration bytes that are `z.string().min(1)` and therefore attacker-shaped. Obeying
    // them would make the drain a local arbitrary-socket-deletion primitive.
    const foreignDir = mkdtempSync(join(tmpdir(), 'agent-qa-foreign-'))
    roots.push(foreignDir)
    const foreign = join(foreignDir, 'victim.sock')
    await abandonSocketFile(foreign)
    plantDaemonRegistration(workspace, 2_000_000_000, foreign)

    const result = await invoke(workspace, ['drain'])

    // The refusal must not cost the drain its work: the registration is compare-deleted and the
    // queue is still drained inline. Only the deletion the guard cannot justify is skipped.
    expect(result.exitCode).toBeUndefined()
    expect(result.stdout).toContain('Knowledge curation queue drained inline')
    expect(existsSync(daemonRegistrationPath(workspace.runtimeRoot))).toBe(false)
    expect(existsSync(foreign), 'a socket the drain cannot prove it owns must survive').toBe(true)
    expect(readDaemonEventLedger(workspace.runtimeRoot).events).toContainEqual(
      expect.objectContaining({
        kind: 'registration-recovered',
        socketPath: foreign,
        socketRemoved: false,
      }),
    )
  }, 20_000)

  it('refuses an in-container address that is not the recorded instance\'s own (W-07)', async () => {
    const workspace = fixtureWorkspace(roots)
    // The input that separates the drain's gate from a weaker one: a real socket in the very
    // directory this project's addresses live in, which containment would happily delete and
    // exactness must refuse. Without this case, degrading the nonce arm to containment passes
    // the whole corpus — the bystander in the reclaim case is not this proof, because only the
    // ONE recorded path is ever a deletion candidate.
    const sibling = daemonSocketPath(
      workspace.runtimeRoot,
      workspace.root,
      SIBLING_INSTANCE_ID,
    )
    await abandonSocketFile(sibling)
    roots.push(dirname(sibling))
    plantDaemonRegistration(workspace, 2_000_000_000, sibling)

    const result = await invoke(workspace, ['drain'])

    expect(result.exitCode).toBeUndefined()
    expect(result.stdout).toContain('Knowledge curation queue drained inline')
    expect(existsSync(daemonRegistrationPath(workspace.runtimeRoot))).toBe(false)
    expect(
      existsSync(sibling),
      'a live sibling generation\'s address is not this registration\'s to delete',
    ).toBe(true)
    expect(readDaemonEventLedger(workspace.runtimeRoot).events).toContainEqual(
      expect.objectContaining({
        kind: 'registration-recovered',
        socketPath: sibling,
        socketRemoved: false,
      }),
    )
  }, 20_000)

  it('reclassifies once when the registration changed under an exact removal', async () => {
    const workspace = fixtureWorkspace(roots)
    plantDaemonRegistration(workspace, 2_000_000_000)
    daemonHarness.ownedRemovalHook = () => {
      // A successor cleaned up in the window between classification and removal.
      rmSync(daemonRegistrationPath(workspace.runtimeRoot), { force: true })
      return false
    }

    const result = await invoke(workspace, ['drain'])

    expect(result.exitCode).toBeUndefined()
    expect(daemonHarness.classifyCalls).toBe(2)
    expect(daemonHarness.ownedRemovals).toEqual([DAEMON_INSTANCE_ID])
    expect(result.stdout).toContain('Knowledge curation queue drained inline')
    expect(commandHarness.drainQueueCalls).toBe(1)
  })

  it('fails closed naming the holder when an unreachable daemon is still beating', async () => {
    // Real timers: the holder's freshness IS the subject, so a clock this test advances would age
    // out the very fact the case exists to honour.
    const nowMs = Date.now()
    const workspace = fixtureWorkspace(roots)
    seedPendingCandidate(workspace, FIRST_CANDIDATE_ID)
    // The holder is inside a long governed mutation, and its beat is independent of that work, so
    // the lease FILE it publishes is what proves it is still alive.
    mkdirSync(join(workspace.knowledgeRoot, 'memory', 'index'), { recursive: true })
    writeFileSync(join(workspace.knowledgeRoot, '.epoch'), '7\n', 'utf8')
    writeFileSync(
      join(workspace.knowledgeRoot, '.lease'),
      `${JSON.stringify({
        leaseId: LIVE_LEASE_ID,
        pid: 4242,
        epoch: 7,
        heartbeatAtMs: nowMs,
      })}\n`,
      'utf8',
    )
    plantDaemonRegistration(workspace)
    armForeignDaemonIdentity()
    const registrationBefore = readFileSync(daemonRegistrationPath(workspace.runtimeRoot))
    const leaseBefore = readFileSync(join(workspace.knowledgeRoot, '.lease'))

    const result = await invoke(workspace, ['drain'])

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('writer-lease-held')
    expect(result.stderr).toContain('pid 4242')
    expect(result.stderr).toContain(LIVE_LEASE_ID)
    expect(commandHarness.drainQueueCalls).toBe(0)
    expect(daemonHarness.ownedRemovals).toEqual([])
    expect(readFileSync(daemonRegistrationPath(workspace.runtimeRoot)))
      .toEqual(registrationBefore)
    expect(readFileSync(join(workspace.knowledgeRoot, '.lease'))).toEqual(leaseBefore)
  }, 180_000)

  it('delegates to a live daemon, polls progress, and never enters the inline lease path', async () => {
    const workspace = fixtureWorkspace(roots)
    const pending = seedPendingCandidate(workspace, FIRST_CANDIDATE_ID)
    plantLiveWriterLease(workspace)
    plantDaemonRegistration(workspace)
    armLiveDaemonIdentity()
    const leasePath = join(workspace.knowledgeRoot, '.lease')
    const leaseBefore = readFileSync(leasePath, 'utf8')
    let receiptWritten = false
    daemonHarness.nudgeHook = () => {
      setTimeout(() => rmSync(pending, { recursive: true, force: true }), 10)
      setTimeout(() => {
        appendDrainSessionReceipt(workspace.runtimeRoot, {
          ts: '2026-07-30T00:00:00.000Z',
          sessionId: FIRST_SESSION_ID,
          holderPid: process.pid,
          epoch: 1,
          candidateIds: [FIRST_CANDIDATE_ID],
          remainingAfter: 0,
          outcome: 'completed',
          failures: 0,
          quarantined: 0,
        })
        receiptWritten = true
      }, 150)
      return { sessionId: FIRST_SESSION_ID }
    }

    const result = await invoke(workspace, ['drain'])

    expect(result.exitCode).toBeUndefined()
    expect(result.stderr).toBe('')
    expect(result.stdout).toContain('remaining 1')
    expect(result.stdout).toContain('remaining 0')
    expect(daemonHarness.nudgeCalls).toEqual([workspace.runtimeRoot])
    expect(receiptWritten).toBe(true)
    expect(commandHarness.drainQueueCalls).toBe(0)
    expect(commandHarness.releaseLeaseCalls).toBe(0)
    expect(readFileSync(leasePath, 'utf8')).toBe(leaseBefore)
  })

  it('never treats queued-zero as success while the terminal receipt reports a claim', async () => {
    const workspace = fixtureWorkspace(roots)
    const pending = seedPendingCandidate(workspace, FIRST_CANDIDATE_ID)
    plantLiveWriterLease(workspace)
    plantDaemonRegistration(workspace)
    armLiveDaemonIdentity()
    daemonHarness.nudgeHook = () => {
      const claimDir = join(
        workspace.knowledgeRoot,
        'memory/queue/claimed',
        LIVE_LEASE_ID,
        FIRST_CANDIDATE_ID,
      )
      mkdirSync(join(claimDir, '..'), { recursive: true })
      renameSync(pending, claimDir)
      appendDrainSessionReceipt(workspace.runtimeRoot, {
        ts: '2026-07-30T00:00:00.000Z',
        sessionId: FIRST_SESSION_ID,
        holderPid: process.pid,
        epoch: 1,
        candidateIds: [FIRST_CANDIDATE_ID],
        remainingAfter: 1,
        outcome: 'failed',
        failures: 1,
        quarantined: 0,
      })
      return { sessionId: FIRST_SESSION_ID }
    }

    const result = await invoke(workspace, ['drain'])

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('unresolved')
    expect(result.stderr).toContain('claimed 1')
    expect(commandHarness.drainQueueCalls).toBe(0)
  })

  it('fsyncs the receipt directory exactly once, when the ledger is created', () => {
    const workspace = fixtureWorkspace(roots)
    const fsyncDirectory = vi.fn()
    const receipt = {
      ts: '2026-07-30T00:00:00.000Z',
      sessionId: FIRST_SESSION_ID,
      holderPid: process.pid,
      epoch: 1,
      candidateIds: [FIRST_CANDIDATE_ID],
      remainingAfter: 0,
      outcome: 'completed' as const,
      failures: 0,
      quarantined: 0,
    }

    appendDrainSessionReceipt(workspace.runtimeRoot, receipt, { fsyncDirectory })
    // WR-03: the directory entry that first publishes the ledger must survive the crash window.
    expect(fsyncDirectory.mock.calls).toEqual([[workspace.runtimeRoot]])

    appendDrainSessionReceipt(
      workspace.runtimeRoot,
      { ...receipt, sessionId: SECOND_SESSION_ID },
      { fsyncDirectory },
    )
    expect(fsyncDirectory.mock.calls).toEqual([[workspace.runtimeRoot]])
    expect(drainReceipts.readDrainSessionReceipts(workspace.runtimeRoot)).toHaveLength(2)
  })

  it('retains valid receipt history across one torn tail and rejects completed malformation', () => {
    const workspace = fixtureWorkspace(roots)
    appendDrainSessionReceipt(workspace.runtimeRoot, {
      ts: '2026-07-30T00:00:00.000Z',
      sessionId: FIRST_SESSION_ID,
      holderPid: process.pid,
      epoch: 1,
      candidateIds: [FIRST_CANDIDATE_ID],
      remainingAfter: 0,
      outcome: 'completed',
      failures: 0,
      quarantined: 0,
    })
    appendFileSync(
      join(workspace.runtimeRoot, drainReceipts.DRAIN_SESSION_RECEIPTS_FILE),
      '{"ts":"torn-final-line"',
      'utf8',
    )
    const readDrainSessionReceiptLedger = (
      drainReceipts as unknown as {
        readDrainSessionReceiptLedger?: (agentQaRoot: string) => {
          receipts: unknown[]
          warnings: Array<{ kind: string; line: number }>
        }
      }
    ).readDrainSessionReceiptLedger
    expect(readDrainSessionReceiptLedger).toBeTypeOf('function')
    expect(readDrainSessionReceiptLedger?.(workspace.runtimeRoot)).toMatchObject({
      receipts: [{ sessionId: FIRST_SESSION_ID, remainingAfter: 0 }],
      warnings: [{ kind: 'torn-final-line', line: 2 }],
    })

    writeFileSync(
      join(workspace.runtimeRoot, drainReceipts.DRAIN_SESSION_RECEIPTS_FILE),
      `${JSON.stringify({
        ts: '2026-07-30T00:00:00.000Z',
        sessionId: FIRST_SESSION_ID,
        holderPid: process.pid,
        epoch: 1,
        candidateIds: [FIRST_CANDIDATE_ID],
        remainingAfter: 0,
      })}\n{"malformed":true}\n`,
      'utf8',
    )
    expect(() => readDrainSessionReceiptLedger?.(workspace.runtimeRoot)).toThrow()
  })

  it('times out a live-daemon wait non-zero while reporting the durable remainder', async () => {
    vi.useFakeTimers({ now: 1_700_000_000_000 })
    const workspace = fixtureWorkspace(roots)
    seedPendingCandidate(workspace, FIRST_CANDIDATE_ID)
    plantDaemonRegistration(workspace)
    armLiveDaemonIdentity()

    const invocation = invoke(workspace, ['drain'])
    await vi.waitFor(() => expect(daemonHarness.nudgeCalls).toEqual([workspace.runtimeRoot]))
    await vi.advanceTimersByTimeAsync(120_001)
    const result = await invocation

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain('remaining 1')
    expect(result.stderr).toContain('timed out')
    expect(commandHarness.drainQueueCalls).toBe(0)
  })

  it('starts the overall deadline before a slow nudge and never grants a second wait budget', async () => {
    const startedAtMs = 1_700_000_000_000
    vi.useFakeTimers({ now: startedAtMs })
    const workspace = fixtureWorkspace(roots)
    seedPendingCandidate(workspace, FIRST_CANDIDATE_ID)
    plantDaemonRegistration(workspace)
    armLiveDaemonIdentity()
    daemonHarness.nudgeHook = (_agentQaRoot, options) => {
      if (options?.deadlineMs !== undefined) vi.setSystemTime(options.deadlineMs + 1)
      return undefined
    }

    let completedAtMs: number | undefined
    const invocation = invoke(workspace, ['drain']).then((result) => {
      completedAtMs = Date.now()
      return result
    })
    await vi.waitFor(() => expect(daemonHarness.nudgeCalls).toHaveLength(1))
    await vi.advanceTimersByTimeAsync(120_001)
    const result = await invocation

    const nudgeStartedAtMs = daemonHarness.nudgeCallTimes[0]
    expect(nudgeStartedAtMs).toBeTypeOf('number')
    const expectedDeadlineMs = nudgeStartedAtMs! + 120_000
    expect(daemonHarness.nudgeOptions).toEqual([{
      knowledgeRoot: workspace.knowledgeRoot,
      deadlineMs: expectedDeadlineMs,
      requireReceipt: true,
    }])
    expect(completedAtMs).toBe(expectedDeadlineMs + 1)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('daemon unresponsive')
    expect(result.stderr).toContain('queued 1')
  })

  it('renders deterministic stitched run and daemon-session receipt status', async () => {
    const workspace = fixtureWorkspace(roots)
    seedPendingCandidate(workspace, SECOND_CANDIDATE_ID)
    writeRunReceipt(workspace, 'z-run-dir', {
      canary: { rideAlongUncredited: 0, rerunExcluded: 0,
        nonSignal: { environment: 0, timeout: 0, flake: 0 } },
      runId: 'run-zeta',
      drainKind: 'handed-off',
      handoffHolderPid: 404,
      candidateIds: [SECOND_CANDIDATE_ID],
    })
    writeRunReceipt(workspace, 'a-run-dir', {
      canary: { rideAlongUncredited: 0, rerunExcluded: 0,
        nonSignal: { environment: 0, timeout: 0, flake: 0 } },
      runId: 'run-alpha',
      drainKind: 'drained',
      handoffHolderPid: null,
      candidateIds: [FIRST_CANDIDATE_ID, SECOND_CANDIDATE_ID],
    })
    appendDrainSessionReceipt(workspace.runtimeRoot, {
      ts: '2026-07-30T00:00:02.000Z',
      sessionId: SECOND_SESSION_ID,
      holderPid: 505,
      epoch: 8,
      candidateIds: [SECOND_CANDIDATE_ID],
      remainingAfter: 1,
      outcome: 'failed',
      failures: 1,
      quarantined: 0,
    })
    appendDrainSessionReceipt(workspace.runtimeRoot, {
      ts: '2026-07-30T00:00:01.000Z',
      sessionId: FIRST_SESSION_ID,
      holderPid: 606,
      epoch: 9,
      candidateIds: [FIRST_CANDIDATE_ID],
      remainingAfter: 0,
      outcome: 'completed',
      failures: 0,
      quarantined: 0,
    })

    const first = await invoke(workspace, ['drain', '--status'])
    const second = await invoke(workspace, ['drain', '--status'])
    expect(first.exitCode).toBeUndefined()
    expect(second.stdout).toBe(first.stdout)
    expect(first.stdout.indexOf('run-alpha')).toBeLessThan(first.stdout.indexOf('run-zeta'))
    expect(first.stdout.indexOf(SECOND_SESSION_ID)).toBeLessThan(
      first.stdout.indexOf(FIRST_SESSION_ID),
    )
    expect(first.stdout).toContain('remaining: 1')

    const json = await invoke(workspace, ['drain', '--status', '--json'])
    expect(json.exitCode).toBeUndefined()
    expect(JSON.parse(json.stdout)).toEqual({
      runReceipts: [
        {
          runId: 'run-alpha',
          drainKind: 'drained',
          handoffHolderPid: null,
          candidateCount: 2,
          candidateIds: [FIRST_CANDIDATE_ID, SECOND_CANDIDATE_ID],
        },
        {
          runId: 'run-zeta',
          drainKind: 'handed-off',
          handoffHolderPid: 404,
          candidateCount: 1,
          candidateIds: [SECOND_CANDIDATE_ID],
        },
      ],
      sessionReceipts: [
        {
          sessionId: SECOND_SESSION_ID,
          holderPid: 505,
          candidateCount: 1,
          candidateIds: [SECOND_CANDIDATE_ID],
          outcome: 'failed',
          failures: 1,
          quarantined: 0,
          remainingAfter: 1,
        },
        {
          sessionId: FIRST_SESSION_ID,
          holderPid: 606,
          candidateCount: 1,
          candidateIds: [FIRST_CANDIDATE_ID],
          outcome: 'completed',
          failures: 0,
          quarantined: 0,
          remainingAfter: 0,
        },
      ],
      remaining: 1,
    })
  })

  it('prints a clean empty drain status and exits successfully', async () => {
    const workspace = fixtureWorkspace(roots)

    const result = await invoke(workspace, ['drain', '--status'])

    expect(result.exitCode).toBeUndefined()
    expect(result.stderr).toBe('')
    expect(result.stdout).toBe([
      'Knowledge curation queue status',
      '  remaining: 0',
      '  run receipts: none',
      '  daemon session receipts: none',
      '',
    ].join('\n'))
  })

  // 2026-10-01 (432-15, D-14): re-spelled from "fails closed without non-interactive
  // confirmation". Running the command is the intent; the refusal it pinned no longer exists.
  it('applies rollback and purge non-interactively with no confirmation step', async () => {
    const workspace = fixtureWorkspace(roots)
    const bundle = seedBundle(workspace)
    const before = snapshotFiles(bundle.dir)

    const rollback = await invoke(workspace, ['rollback', '--job', CURATION_JOB_ID])
    expect(rollback.exitCode).toBeUndefined()
    expect(rollback.stderr).not.toContain('refusal')
    expect(rollback.stdout).toContain('Rollback complete')
    expect(snapshotFiles(bundle.dir)).not.toEqual(before)

    const purge = await invoke(workspace, ['purge', bundle.id])
    expect(purge.exitCode).toBeUndefined()
    expect(purge.stderr).not.toContain('refusal')
    expect(purge.stdout).toContain('Purge complete')
    expect(existsSync(bundle.dir)).toBe(false)
    expect(commandHarness.promptCalls).toEqual([])
  })

  // 2026-10-01 (432-15, D-14): re-spelled from "refuses piped stdin even when stdout is a TTY".
  // Piped stdin is never read; each destructive mutator runs exactly once.
  it('never reads piped stdin when stdout is a TTY and invokes each mutator once', async () => {
    const workspace = fixtureWorkspace(roots)
    const bundle = seedBundle(workspace)
    setTerminalTopology({ stdin: false, stdout: true, stderr: true })

    const rollback = await invoke(workspace, ['rollback', '--job', CURATION_JOB_ID])
    expect(rollback.exitCode).toBeUndefined()

    const purge = await invoke(workspace, ['purge', bundle.id])
    expect(purge.exitCode).toBeUndefined()

    expect(commandHarness.promptCalls).toEqual([])
    expect(commandHarness.rollbackCurationJobCalls).toBe(1)
    expect(commandHarness.rollbackCampaignCalls).toBe(0)
    expect(commandHarness.purgeRecordCalls).toBe(1)
    expect(existsSync(bundle.dir)).toBe(false)
  })

  // 2026-10-01 (432-15, D-14): re-spelled from "…while prompting on stderr"; the preview keeps
  // stderr, and no prompt is written anywhere.
  it('keeps interactive rollback JSON stdout parseable while previewing on stderr', async () => {
    const workspace = fixtureWorkspace(roots)
    seedBundle(workspace)
    setTerminalTopology({ stdin: true, stdout: true, stderr: true })

    const result = await invoke(workspace, [
      'rollback',
      '--job',
      CURATION_JOB_ID,
      '--json',
    ])

    expect(result.exitCode).toBeUndefined()
    expect(JSON.parse(result.stdout)).toMatchObject({
      receiptId: expect.stringMatching(/^rollback:/u),
      affected: { mintedBundleIds: expect.any(Array) },
    })
    expect(result.stderr).toContain('Rollback preview')
    expect(result.stdout).not.toContain('Rollback preview')
    expect(commandHarness.promptCalls).toEqual([])
    expect(commandHarness.rollbackCurationJobCalls).toBe(1)
    expect(commandHarness.rollbackCurationJobInputs[0]?.writerAuthority).toMatchObject({
      knowledgeRoot: workspace.knowledgeRoot,
      leaseId: expect.any(String),
      epoch: expect.any(Number),
    })
  })

  it('keeps nested knowledge maintenance audit evidence in the canonical runtime root', async () => {
    const workspace = fixtureWorkspace(
      roots,
      { [PRODUCT]: BUILD_ORDINAL },
      'docs/knowledge',
    )
    seedBundle(workspace)

    const result = await invoke(workspace, [
      'rollback', '--job', CURATION_JOB_ID, '--json',
    ])

    expect(result.exitCode).toBeUndefined()
    expect(commandHarness.rollbackCurationJobInputs).toHaveLength(1)
    expect(existsSync(join(workspace.root, 'docs', '.agent-qa'))).toBe(false)
  })

  it('rolls back a job minted at the current product ordinal using the reserved next ordinal', async () => {
    const workspace = fixtureWorkspace(roots)
    const bundle = seedBundle(workspace, { createdAtOrdinal: BUILD_ORDINAL })

    const result = await invoke(workspace, [
      'rollback',
      '--job',
      CURATION_JOB_ID,
      '--json',
    ])

    expect(result.exitCode).toBeUndefined()
    expect(JSON.parse(result.stdout)).toMatchObject({
      inverseCount: 1,
      deprecatedBundles: [bundle.id],
    })
    expect(commandHarness.rollbackCurationJobCalls).toBe(1)
    expect(JSON.parse(readFileSync(
      join(workspace.runtimeRoot, 'build-ordinals.json'),
      'utf8',
    ))).toEqual({ [PRODUCT]: BUILD_ORDINAL + 1 })
    expect(rollbackInverseOrdinals(bundle.dir)).toEqual([BUILD_ORDINAL + 1])
  })

  it('retries the same completed rollback without changing bundle or counter bytes', async () => {
    const workspace = fixtureWorkspace(roots)
    const bundle = seedBundle(workspace, { createdAtOrdinal: BUILD_ORDINAL })
    const args = ['rollback', '--job', CURATION_JOB_ID, '--json'] as const

    const first = await invoke(workspace, args)
    expect(first.exitCode).toBeUndefined()
    expect(JSON.parse(first.stdout)).toMatchObject({ inverseCount: 1 })
    const bundleAfterFirst = snapshotFiles(bundle.dir)
    const counterPath = join(workspace.runtimeRoot, 'build-ordinals.json')
    const counterAfterFirst = readFileSync(counterPath)

    const second = await invoke(workspace, args)
    expect(second.exitCode).toBeUndefined()
    expect(JSON.parse(second.stdout)).toMatchObject({
      inverseCount: 0,
      affected: { plannedEffects: [] },
    })
    expect(snapshotFiles(bundle.dir)).toEqual(bundleAfterFirst)
    expect(readFileSync(counterPath)).toEqual(counterAfterFirst)
    expect(commandHarness.rollbackCurationJobCalls).toBe(2)
  })

  it('advances every affected campaign product to one reserved ordinal', async () => {
    const firstProduct = 'campaign-alpha'
    const secondProduct = 'campaign-beta'
    const workspace = fixtureWorkspace(roots, {
      [firstProduct]: 7,
      [secondProduct]: 11,
      untouched: 99,
    })
    const first = seedBundle(workspace, {
      product: firstProduct,
      createdAtOrdinal: 7,
      curationJobId: 'campaign-job-alpha',
    })
    const second = seedBundle(workspace, {
      product: secondProduct,
      createdAtOrdinal: 11,
      curationJobId: 'campaign-job-beta',
    })

    const result = await invoke(workspace, [
      'rollback',
      '--from-build',
      '7',
      '--to-build',
      '11',
      '--json',
    ])

    expect(result.exitCode).toBeUndefined()
    expect(JSON.parse(result.stdout)).toMatchObject({
      inverseCount: 2,
      deprecatedBundles: [first.id, second.id].sort(),
    })
    expect(commandHarness.rollbackCampaignCalls).toBe(1)
    expect(JSON.parse(readFileSync(
      join(workspace.runtimeRoot, 'build-ordinals.json'),
      'utf8',
    ))).toEqual({
      [firstProduct]: 12,
      [secondProduct]: 12,
      untouched: 99,
    })
    expect(rollbackInverseOrdinals(first.dir)).toEqual([12])
    expect(rollbackInverseOrdinals(second.dir)).toEqual([12])
  })

  it('refuses missing and exhausted affected counters before invoking rollback mutators', async () => {
    const missingProduct = 'missing-counter-product'
    const missingWorkspace = fixtureWorkspace(roots, { untouched: 4 })
    seedBundle(missingWorkspace, {
      product: missingProduct,
      createdAtOrdinal: 5,
      curationJobId: 'missing-counter-job',
    })
    const missingCounters = readFileSync(
      join(missingWorkspace.runtimeRoot, 'build-ordinals.json'),
      'utf8',
    )

    const missing = await invoke(missingWorkspace, [
      'rollback',
      '--job',
      'missing-counter-job',
      '--json',
    ])
    expect(missing.exitCode).toBe(1)
    expect(missing.stderr).toContain('missing-counter-product')
    expect(commandHarness.rollbackCurationJobCalls).toBe(0)
    expect(readFileSync(
      join(missingWorkspace.runtimeRoot, 'build-ordinals.json'),
      'utf8',
    )).toBe(missingCounters)

    const exhaustedProduct = 'exhausted-counter-product'
    const exhaustedWorkspace = fixtureWorkspace(roots, {
      [exhaustedProduct]: Number.MAX_SAFE_INTEGER,
    })
    seedBundle(exhaustedWorkspace, {
      product: exhaustedProduct,
      createdAtOrdinal: 6,
      curationJobId: 'exhausted-counter-job',
    })
    const exhaustedCounters = readFileSync(
      join(exhaustedWorkspace.runtimeRoot, 'build-ordinals.json'),
      'utf8',
    )

    const exhausted = await invoke(exhaustedWorkspace, [
      'rollback',
      '--job',
      'exhausted-counter-job',
      '--json',
    ])
    expect(exhausted.exitCode).toBe(1)
    expect(exhausted.stderr).toContain('exhausted')
    expect(commandHarness.rollbackCurationJobCalls).toBe(0)
    expect(readFileSync(
      join(exhaustedWorkspace.runtimeRoot, 'build-ordinals.json'),
      'utf8',
    )).toBe(exhaustedCounters)
    expect(readdirSync(exhaustedWorkspace.runtimeRoot).some(file => file.endsWith('.tmp'))).toBe(
      false,
    )
  })

  // 2026-10-01 (432-15, D-14): re-spelled from "…while prompting on stderr"; the preview keeps
  // stderr, and no prompt is written anywhere.
  it('keeps interactive purge JSON stdout parseable while previewing on stderr', async () => {
    const workspace = fixtureWorkspace(roots)
    const bundle = seedBundle(workspace)
    setTerminalTopology({ stdin: true, stdout: true, stderr: true })

    const result = await invoke(workspace, ['purge', bundle.id, '--json'])

    expect(result.exitCode).toBeUndefined()
    expect(guardPurgeReceipt(JSON.parse(result.stdout))).toMatchObject({
      purgedRecordId: bundle.id,
      purgedAtOrdinal: BUILD_ORDINAL + 1,
    })
    expect(result.stderr).toContain(`Purge preview for ${bundle.id}`)
    expect(result.stdout).not.toContain('Purge preview')
    expect(commandHarness.promptCalls).toEqual([])
    expect(commandHarness.purgeRecordCalls).toBe(1)
    expect(commandHarness.purgeRecordInputs[0]?.writerAuthority).toMatchObject({
      knowledgeRoot: workspace.knowledgeRoot,
      leaseId: expect.any(String),
      epoch: expect.any(Number),
    })
    expect(commandHarness.purgeRecordInputs[0]?.expectedAffectedSetFingerprint).toMatch(
      /^[0-9a-f]{64}$/u,
    )
    expect(commandHarness.purgeRecordInputs[0]?.purgedAtOrdinal).toBe(BUILD_ORDINAL + 1)
    expect(JSON.parse(readFileSync(
      join(workspace.runtimeRoot, 'build-ordinals.json'),
      'utf8',
    ))).toEqual({ [PRODUCT]: BUILD_ORDINAL + 1 })
  })

  it.each([
    {
      shape: 'stamped 1',
      plant: (intent: Record<string, unknown>) => ({ ...intent, schemaVersion: 1 }),
      refusal: 'PurgeIntent schemaVersion 1 is not supported',
    },
    {
      shape: 'stamped 2 without an affected set',
      plant: ({ affectedSet: _affectedSet, ...intent }: Record<string, unknown>) => intent,
      refusal: '"affectedSet"',
    },
  ])('refuses to resume a purge intent $shape and leaves it in place', async ({ plant, refusal }) => {
    const workspace = fixtureWorkspace(roots)
    const bundle = seedBundle(workspace)
    expect(() => purgeRecord({
      knowledgeRoot: workspace.knowledgeRoot,
      recordId: asRecordId(bundle.id),
      initiator: 'refused-intent-fixture',
      purgedAtOrdinal: BUILD_ORDINAL + 1,
      hooks: {
        afterIntentWritten: () => {
          throw new Error('leave purge intent')
        },
      },
    })).toThrow('leave purge intent')
    const intentPath = join(
      workspace.knowledgeRoot,
      'memory',
      'receipts',
      `purge-${bundle.id}.intent.json`,
    )
    const intent = JSON.parse(readFileSync(intentPath, 'utf8')) as Record<string, unknown>
    writeFileSync(intentPath, `${JSON.stringify(plant(intent))}\n`, 'utf8')
    const plantedBytes = readFileSync(intentPath)

    const result = await invoke(workspace, [
      'purge',
      bundle.id,
      '--json',
    ])

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain(refusal)
    expect(readFileSync(intentPath)).toEqual(plantedBytes)
    expect(existsSync(bundle.dir)).toBe(true)
    expect(existsSync(join(
      workspace.knowledgeRoot,
      'memory',
      'receipts',
      `purge-${bundle.id}.json`,
    ))).toBe(false)
  })

  it('reserves one purge ordinal across every affected product counter', async () => {
    const secondProduct = 'maintenance-purge-secondary'
    const workspace = fixtureWorkspace(roots, {
      [PRODUCT]: BUILD_ORDINAL,
      [secondProduct]: 20,
      untouched: 99,
    })
    const primary = seedBundle(workspace)
    const secondary = seedBundle(workspace, {
      product: secondProduct,
      scopeProduct: PRODUCT,
    })
    expect(secondary.id).toBe(primary.id)

    const result = await invoke(workspace, [
      'purge',
      primary.id,
      '--json',
    ])

    expect(result.exitCode).toBeUndefined()
    expect(guardPurgeReceipt(JSON.parse(result.stdout))).toMatchObject({
      purgedRecordId: primary.id,
      purgedAtOrdinal: 21,
    })
    expect(commandHarness.purgeRecordInputs[0]?.purgedAtOrdinal).toBe(21)
    expect(JSON.parse(readFileSync(
      join(workspace.runtimeRoot, 'build-ordinals.json'),
      'utf8',
    ))).toEqual({
      [PRODUCT]: 21,
      [secondProduct]: 21,
      untouched: 99,
    })
  })

  it('does not reserve another ordinal for an already-purged retry', async () => {
    const workspace = fixtureWorkspace(roots)
    const bundle = seedBundle(workspace)
    const args = [
      'purge',
      bundle.id,
      '--json',
    ] as const

    const first = await invoke(workspace, args)
    expect(first.exitCode).toBeUndefined()
    const counterPath = join(workspace.runtimeRoot, 'build-ordinals.json')
    const countersAfterFirst = readFileSync(counterPath)
    const second = await invoke(workspace, args)

    expect(second.exitCode).toBeUndefined()
    expect(guardPurgeReceipt(JSON.parse(second.stdout))).toEqual(
      guardPurgeReceipt(JSON.parse(first.stdout)),
    )
    expect(readFileSync(counterPath)).toEqual(countersAfterFirst)
    expect(commandHarness.purgeRecordInputs.at(-1)?.purgedAtOrdinal).toBeUndefined()
  })

  it('refuses missing and exhausted purge counters before invoking the mutator', async () => {
    for (const [name, counters] of [
      ['missing', {}],
      ['exhausted', { [PRODUCT]: Number.MAX_SAFE_INTEGER }],
    ] as const) {
      const workspace = fixtureWorkspace(roots, counters)
      const bundle = seedBundle(workspace)
      const counterPath = join(workspace.runtimeRoot, 'build-ordinals.json')
      const counterBytes = readFileSync(counterPath)
      const bundleBytes = snapshotFiles(bundle.dir)
      const callsBefore = commandHarness.purgeRecordCalls

      const result = await invoke(workspace, [
        'purge',
        bundle.id,
        '--json',
      ])

      expect(result.exitCode, name).toBe(1)
      expect(result.stderr, name).toContain(name)
      expect(result.stdout, name).toBe('')
      expect(commandHarness.purgeRecordCalls, name).toBe(callsBefore)
      expect(readFileSync(counterPath), name).toEqual(counterBytes)
      expect(snapshotFiles(bundle.dir), name).toEqual(bundleBytes)
      expect(existsSync(join(
        workspace.knowledgeRoot,
        'memory',
        'receipts',
        `purge-${bundle.id}.intent.json`,
      )), name).toBe(false)
    }
  })

  it('renders every product bundle tree and receipt-named path in the purge preview', async () => {
    const secondaryProduct = 'maintenance-z-non-servable-copy'
    const workspace = fixtureWorkspace(roots, { [PRODUCT]: BUILD_ORDINAL, [secondaryProduct]: 6 })
    const primary = seedBundle(workspace)
    const secondary = seedBundle(workspace, {
      product: secondaryProduct,
      scopeProduct: PRODUCT,
    })
    expect(secondary.id).toBe(primary.id)
    expect(appendOutcomeEvent(
      {
        knowledgeRoot: workspace.knowledgeRoot,
        productKey: secondaryProduct,
        commitArtifacts: 'none',
      },
      asRecordId(secondary.id),
      BundleOutcomeEventSchema.parse({
        type: 'deprecated',
        evidenceToken: 'maintenance-preview-non-servable',
        curationJobId: 'maintenance-preview-non-servable-job',
        buildOrdinal: 6,
        reason: 'Preview must include loadable non-servable copies',
      }),
    ).kind).toBe('appended')
    setTerminalTopology({ stdin: true, stdout: true, stderr: true })
    const expectedPaths = [
      ...expectedBundlePaths(workspace, primary.dir),
      ...expectedBundlePaths(workspace, secondary.dir),
    ]
    let stderrAtLease = ''
    commandHarness.leaseAcquireHook = () => {
      stderrAtLease = (process.stderr.write as unknown as { mock: { calls: unknown[][] } })
        .mock.calls.map(([chunk]) => String(chunk)).join('')
    }

    const result = await invoke(workspace, ['purge', primary.id, '--json'])

    // 2026-10-01 (432-15, D-14): the preview is rendered before the writer lease is taken, and the
    // purge then completes; there is no answer to abort it with.
    expect(result.exitCode).toBeUndefined()
    for (const path of expectedPaths) {
      expect(stderrAtLease).toContain(path)
    }
    expect(stderrAtLease).toContain(relative(workspace.knowledgeRoot, primary.dir))
    expect(stderrAtLease).toContain(relative(workspace.knowledgeRoot, secondary.dir))
    expect(commandHarness.purgeRecordCalls).toBe(1)
    expect(commandHarness.promptCalls).toEqual([])
    expect(existsSync(primary.dir)).toBe(false)
    expect(existsSync(secondary.dir)).toBe(false)
  })

  // 2026-10-01 (432-15, D-14): re-spelled from "…after exact-id authorization"; the drift lands
  // between the preview and the writer lease.
  it('refuses purge target drift after the preview and before mutation', async () => {
    const workspace = fixtureWorkspace(roots)
    const primary = seedBundle(workspace)
    const driftProduct = 'maintenance-z-purge-drift'
    let drifted: { id: string; dir: string } | undefined
    setTerminalTopology({ stdin: true, stdout: true, stderr: true })
    commandHarness.leaseAcquireHook = () => {
      drifted = seedBundle(workspace, {
        product: driftProduct,
        scopeProduct: PRODUCT,
      })
      expect(drifted.id).toBe(primary.id)
    }

    const result = await invoke(workspace, ['purge', primary.id, '--json'])

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('preview-changed')
    expect(commandHarness.purgeRecordCalls).toBe(0)
    expect(existsSync(primary.dir)).toBe(true)
    expect(drifted).toBeDefined()
    expect(existsSync(drifted!.dir)).toBe(true)
  })

  // 2026-10-01 (432-15, D-14): re-spelled from "…when interactive answers refuse". No answer can
  // refuse any more; the surviving refusals (an invalid selector, an unknown record) keep JSON
  // stdout empty and return non-success.
  it('keeps JSON stdout empty and returns non-success when rollback or purge refuses', async () => {
    const rollbackWorkspace = fixtureWorkspace(roots)
    seedBundle(rollbackWorkspace)
    setTerminalTopology({ stdin: true, stdout: true, stderr: true })

    const rollback = await invoke(rollbackWorkspace, [
      'rollback',
      '--job',
      CURATION_JOB_ID,
      '--origin-class',
      'user',
      '--json',
    ])
    expect(rollback.exitCode).toBe(1)
    expect(rollback.stdout).toBe('')
    expect(rollback.stderr).toContain('knowledge rollback: error [invalid-selector]')
    expect(commandHarness.rollbackCurationJobCalls).toBe(0)

    const purgeWorkspace = fixtureWorkspace(roots)
    const bundle = seedBundle(purgeWorkspace)
    const unknownId = 'f'.repeat(64)

    const purge = await invoke(purgeWorkspace, ['purge', unknownId, '--json'])
    expect(purge.exitCode).toBe(1)
    expect(purge.stdout).toBe('')
    expect(purge.stderr).toContain(`knowledge purge: error [not-found]: record ${unknownId}`)
    expect(existsSync(bundle.dir)).toBe(true)
    expect(commandHarness.promptCalls).toEqual([])
  })

  // 2026-10-01 (432-15, D-14): re-spelled from "requires the exact purge id, rejects --yes…".
  // The repeated-id confirmation is gone: --confirm is now as unknown as --yes.
  it('rejects the retired --confirm and --yes options and emits the persisted receipt verbatim', async () => {
    const workspace = fixtureWorkspace(roots)
    const bundle = seedBundle(workspace)
    const before = snapshotFiles(bundle.dir)

    const retired = await invoke(workspace, [
      'purge',
      bundle.id,
      '--confirm',
      bundle.id,
      '--json',
    ])
    expect(retired.commanderError?.code).toBe('commander.unknownOption')
    expect(retired.stderr).toContain("unknown option '--confirm'")
    expect(snapshotFiles(bundle.dir)).toEqual(before)

    const bypass = await invoke(workspace, ['purge', bundle.id, '--yes'])
    expect(bypass.commanderError?.code).toBe('commander.unknownOption')
    expect(bypass.stderr).toContain("unknown option '--yes'")
    expect(snapshotFiles(bundle.dir)).toEqual(before)

    const exact = await invoke(workspace, [
      'purge',
      bundle.id,
      '--json',
    ])
    expect(exact.exitCode).toBeUndefined()
    const emitted = guardPurgeReceipt(JSON.parse(exact.stdout))
    const persisted = guardPurgeReceipt(JSON.parse(readFileSync(
      join(workspace.knowledgeRoot, 'memory', 'receipts', `purge-${bundle.id}.json`),
      'utf8',
    )))
    expect(emitted).toEqual(persisted)
    expect(emitted.purgedRecordId).toBe(bundle.id)
    expect(emitted.initiator).toMatch(/^cli:.+/u)
    expect(existsSync(bundle.dir)).toBe(false)
  })

  it('refuses every mutating verb while a live writer lease names its holder', async () => {
    const workspace = fixtureWorkspace(roots)
    const bundle = seedBundle(workspace)
    plantLiveWriterLease(workspace)
    const before = snapshotFiles(workspace.knowledgeRoot)

    const invocations = [
      ['rebuild-index', '--json'],
      ['rollback', '--job', CURATION_JOB_ID, '--json'],
      ['purge', bundle.id, '--json'],
    ] as const

    for (const args of invocations) {
      const result = await invoke(workspace, args)
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('refusal [writer-lease-held]')
      expect(result.stderr).toContain('pid 4242')
      expect(result.stderr).toContain(LIVE_LEASE_ID)
      expect(result.stdout).toBe('')
    }
    expect(snapshotFiles(workspace.knowledgeRoot)).toEqual(before)
  })

  it('emits a bare RebuildReport object for --json', async () => {
    const workspace = fixtureWorkspace(roots)
    seedBundle(workspace)

    const result = await invoke(workspace, ['rebuild-index', '--json'])
    expect(result.exitCode).toBeUndefined()
    expect(result.stderr).toBe('')
    const report = JSON.parse(result.stdout) as Record<string, unknown>
    expect(Object.keys(report).sort()).toEqual([
      'backfilled',
      'maintenanceRemaining',
      'pendingEmbeddings',
      'projected',
      'removed',
      'scanIssues',
      'skippedIncomplete',
      'vec',
    ])
    expect(report).toMatchObject({
      projected: 1,
      removed: 0,
      backfilled: 0,
      vec: expect.any(String),
      pendingEmbeddings: expect.any(Number),
      maintenanceRemaining: expect.any(Boolean),
    })
  })

  // 2026-10-01 (432-15, D-14): re-spelled from "…while rollback and purge await human
  // authorization". Nothing awaits; the preview is still resolved before any lease is held.
  it('holds no writer lease while rollback and purge resolve their previews', async () => {
    const rollbackWorkspace = fixtureWorkspace(roots)
    seedBundle(rollbackWorkspace)
    setTerminalTopology({ stdin: true, stdout: true, stderr: true })
    const leaseSeen: boolean[] = []
    commandHarness.leaseAcquireHook = () => {
      leaseSeen.push(existsSync(join(rollbackWorkspace.knowledgeRoot, '.lease')))
    }
    expect((await invoke(rollbackWorkspace, [
      'rollback', '--job', CURATION_JOB_ID, '--json',
    ])).exitCode).toBeUndefined()

    const purgeWorkspace = fixtureWorkspace(roots)
    const bundle = seedBundle(purgeWorkspace)
    commandHarness.leaseAcquireHook = () => {
      leaseSeen.push(existsSync(join(purgeWorkspace.knowledgeRoot, '.lease')))
    }
    expect((await invoke(purgeWorkspace, ['purge', bundle.id, '--json'])).exitCode).toBeUndefined()
    expect(leaseSeen).toEqual([false, false])
    expect(commandHarness.promptCalls).toEqual([])
  })

  // 2026-10-01 (432-15, D-14): re-spelled from "rejects an authorized rollback…"; nothing is
  // authorized any more, and the fingerprint recheck under the lease is what survives.
  it('rejects a rollback when the under-lease target fingerprint changes', async () => {
    const driftProduct = 'preview-drift-product'
    const workspace = fixtureWorkspace(roots, {
      [PRODUCT]: BUILD_ORDINAL,
      [driftProduct]: 6,
    })
    seedBundle(workspace)
    setTerminalTopology({ stdin: true, stdout: true, stderr: true })
    commandHarness.leaseAcquireHook = () => {
      seedBundle(workspace, { product: driftProduct, createdAtOrdinal: 6 })
    }

    const result = await invoke(workspace, ['rollback', '--job', CURATION_JOB_ID, '--json'])

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('preview-changed')
    expect(commandHarness.rollbackCurationJobCalls).toBe(0)
  })

  // 2026-10-01 (432-15, D-14): re-spelled from "…while the rollback preview awaits authorization";
  // the promotion now lands between the preview and the writer lease.
  it('rejects a promotion added between the rollback preview and the writer lease', async () => {
    const workspace = fixtureWorkspace(roots)
    const baseJob = 'promotion-preview-base-job'
    const bundle = seedBundle(workspace, { curationJobId: baseJob, createdAtOrdinal: 5 })
    const config: BundleStoreConfig = {
      knowledgeRoot: workspace.knowledgeRoot,
      productKey: PRODUCT,
      commitArtifacts: 'none',
    }
    expect(appendOutcomeEvent(config, asRecordId(bundle.id), {
      type: 'retracted',
      evidenceToken: asEvidenceToken('promotion-preview-base-retraction'),
      curationJobId: 'promotion-preview-setup',
      buildOrdinal: 6,
      retractsEvidenceToken: asEvidenceToken(`maintenance-confirmation-${PRODUCT}-5`),
      retractsCurationJobId: baseJob,
      rollbackReceiptId: 'promotion-preview-setup',
    })).toEqual({ kind: 'appended' })
    expect(appendOutcomeEvent(config, asRecordId(bundle.id), {
      type: 'confirmed',
      evidenceToken: asEvidenceToken('promotion-preview-selected-confirmation'),
      curationJobId: CURATION_JOB_ID,
      buildOrdinal: 7,
      origin: 'agent-verified',
    })).toEqual({ kind: 'appended' })
    setTerminalTopology({ stdin: true, stdout: true, stderr: true })
    commandHarness.leaseAcquireHook = () => {
      expect(appendOutcomeEvent(config, asRecordId(bundle.id), {
        type: 'promoted',
        evidenceToken: asEvidenceToken('promotion-preview-late-promotion'),
        curationJobId: 'promotion-preview-other-job',
        buildOrdinal: 8,
      })).toEqual({ kind: 'appended' })
    }

    const result = await invoke(workspace, ['rollback', '--job', CURATION_JOB_ID, '--json'])

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('preview-changed')
    expect(commandHarness.rollbackCurationJobCalls).toBe(0)
    const loaded = loadBundle(bundle.dir)
    if (loaded.kind !== 'loaded') throw new Error('expected promotion race bundle')
    expect(loaded.bundle.events.filter(({ type }) => type === 'retracted')).toHaveLength(1)
  })

  it('heartbeats work beyond the lease TTL and passes authority into rebuild', async () => {
    const workspace = fixtureWorkspace(roots)
    seedBundle(workspace)
    vi.useFakeTimers({ now: 1_000_000 })
    let continueOperation!: () => void
    let markStarted!: () => void
    const started = new Promise<void>((resolveStarted) => {
      markStarted = resolveStarted
    })
    const operationGate = new Promise<void>((resolveOperation) => {
      continueOperation = resolveOperation
    })
    commandHarness.rebuildIndexHook = async () => {
      markStarted()
      await operationGate
      return {
        projected: 0,
        skippedIncomplete: 0,
        scanIssues: [],
        removed: 0,
        backfilled: 0,
        vec: 'brute',
        pendingEmbeddings: 0,
        maintenanceRemaining: false,
      }
    }

    const invocation = invoke(workspace, ['rebuild-index', '--json'])
    await started
    expect(commandHarness.rebuildIndexInputs[0]?.writerAuthority).toMatchObject({
      knowledgeRoot: workspace.knowledgeRoot,
      leaseId: expect.any(String),
      epoch: 1,
    })
    await vi.advanceTimersByTimeAsync(30_001)
    const competitor = acquireWriterLease(workspace.knowledgeRoot)
    expect(competitor.kind).toBe('held')
    continueOperation()

    expect((await invocation).exitCode).toBeUndefined()
    expect(commandHarness.releaseLeaseCalls).toBe(1)
  })

  it('leaves ordinal counters byte-identical when reclaim wins before persistence', async () => {
    const workspace = fixtureWorkspace(roots)
    seedBundle(workspace, { createdAtOrdinal: BUILD_ORDINAL })
    const ordinalFile = join(workspace.runtimeRoot, 'build-ordinals.json')
    const before = readFileSync(ordinalFile, 'utf8')
    commandHarness.authorityRefreshHook = (authority, call) => {
      if (call !== 1) return
      const leaseFile = join(String(authority.knowledgeRoot), '.lease')
      const lease = JSON.parse(readFileSync(leaseFile, 'utf8')) as Record<string, unknown>
      writeFileSync(
        leaseFile,
        `${JSON.stringify({ ...lease, heartbeatAtMs: Date.now() - 30_000 })}\n`,
        'utf8',
      )
      expect(acquireWriterLease(String(authority.knowledgeRoot)).kind).toBe('acquired')
    }

    const result = await invoke(workspace, [
      'rollback', '--job', CURATION_JOB_ID, '--json',
    ])

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('writer authority lost')
    expect(readFileSync(ordinalFile, 'utf8')).toBe(before)
    expect(readdirSync(workspace.runtimeRoot).some((file) => file.endsWith('.tmp'))).toBe(false)
    expect(commandHarness.rollbackCurationJobCalls).toBe(0)
    expect(commandHarness.rollbackCampaignCalls).toBe(0)
    expect(commandHarness.releaseLeaseCalls).toBe(1)
  })
})
