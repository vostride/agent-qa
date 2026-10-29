import { afterEach, describe, it, expect } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { RUN_EVIDENCE_BLOBS_SUBDIR, RUNS_SUBDIR, slugBranch } from '@vostride/agent-qa-runner-local'
import { SecretRedactor, SecretStore } from '@vostride/agent-qa-runner'
import {
  computeRunConfigDigests,
  buildRunPorts,
  buildMemberRunConfig,
  createSuiteLifecycle,
  resolveRunExecutionContext,
} from '@vostride/agent-qa-agent-local'
import { assembleCliRun } from '../composition/run-assembly.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

// One digest mint feeds the cache path and the handoff header, so run and handoff identity agree.
describe('computeRunConfigDigests (one mint)', () => {
  const input = {
    configContent: 'config-yaml',
    members: [
      { testFileContent: 'test-a', suiteFileContent: 'suite-1' },
      { testFileContent: 'test-b', suiteFileContent: 'suite-1' },
    ],
  }

  it('is deterministic: same inputs => same run-level pair and per-member pairs', () => {
    const a = computeRunConfigDigests(input)
    const b = computeRunConfigDigests(input)
    expect(a).toEqual(b)
    expect(a.perMember).toHaveLength(2)
    // both members share the same suite content => equal per-member suite digest.
    expect(a.perMember[0].suiteConfigDigest).toBe(a.perMember[1].suiteConfigDigest)
    // distinct test content => distinct per-member test digest.
    expect(a.perMember[0].testConfigDigest).not.toBe(a.perMember[1].testConfigDigest)
    // run-level pair is a stable 16-hex digest.
    expect(a.runLevel.suiteConfigDigest).toMatch(/^[0-9a-f]{16}$/)
    expect(a.runLevel.testConfigDigest).toMatch(/^[0-9a-f]{16}$/)
  })

  it('collapses a single-member run to the member values', () => {
    const d = computeRunConfigDigests({
      configContent: 'cfg',
      members: [{ testFileContent: 't', suiteFileContent: 's' }],
    })
    expect(d.runLevel).toEqual(d.perMember[0])
  })

  it('folds config + suite content into the per-member suite digest (config change forks it)', () => {
    const base = computeRunConfigDigests({
      configContent: 'c',
      members: [{ testFileContent: 't', suiteFileContent: 's' }],
    })
    const changed = computeRunConfigDigests({
      configContent: 'c2',
      members: [{ testFileContent: 't', suiteFileContent: 's' }],
    })
    expect(changed.perMember[0].suiteConfigDigest).not.toBe(base.perMember[0].suiteConfigDigest)
    expect(changed.perMember[0].testConfigDigest).toBe(base.perMember[0].testConfigDigest)
  })

  it('treats an absent suiteFileContent as empty (single-test path shape)', () => {
    const d = computeRunConfigDigests({
      configContent: 'c',
      members: [{ testFileContent: 't' }],
    })
    expect(d.perMember[0].suiteConfigDigest).toMatch(/^[0-9a-f]{16}$/)
    expect(d.runLevel).toEqual(d.perMember[0])
  })
})

// buildRunPorts constructs the runner-local persistence ports rooted at the run's `.agent-qa`
// runtime dir (the FsActionCache rooting idiom).
describe('buildRunPorts (roots under .agent-qa)', () => {
  it('roots the event log + handoff store under <configDir>/.agent-qa', () => {
    const configDir = tempDir('run-ports-')
    const runId = 'r_ports-root-check'
    const ports = buildRunPorts({ configDir, runId })
    expect(typeof ports.eventLog.append).toBe('function')
    expect(typeof ports.handoffStore.save).toBe('function')

    // Append one envelope; the write must land under <configDir>/.agent-qa/runs.
    ports.eventLog.append({
      seq: 1,
      ts: 0,
      runId,
      type: 'runWarning',
      payload: { code: 'root-check', message: 'root-check' },
    } as never)
    expect(existsSync(join(configDir, '.agent-qa', 'runs'))).toBe(true)
  })
})

// One run-scoped evidence store, copied into each member config unwrapped.
describe('buildRunPorts — run-scoped evidence artifact store', () => {
  it('persists sentinel bytes through the neutral port and reads them back by returned sha under the run/blob namespace', () => {
    const configDir = tempDir('run-evidence-')
    const runId = 'r_evidence-roundtrip'
    const store = buildRunPorts({ configDir, runId }).evidenceArtifacts

    const bytes = new Uint8Array([1, 2, 3, 4, 5, 250])
    const ref = store.persistDecisionScreenshot(bytes)
    expect(ref.sha).toMatch(/^[0-9a-f]{64}$/)
    expect(ref.id).toBe(`decision-screenshot:${ref.sha}`)

    // Round-trips through the returned neutral port.
    expect(store.getBlob(ref.sha)).toEqual(bytes)

    // Durable placement beneath the current run namespace — consume the runner-local layout
    // constants rather than re-deriving the slug/directory algorithm in the CLI.
    const blobPath = join(
      resolve(configDir, '.agent-qa'),
      RUNS_SUBDIR,
      slugBranch(runId),
      RUN_EVIDENCE_BLOBS_SUBDIR,
      ref.sha,
    )
    expect(existsSync(blobPath)).toBe(true)
    expect(new Uint8Array(readFileSync(blobPath))).toEqual(bytes)
  })

  it('scopes blobs per run — a second runId cannot resolve the first run blob (cross-run isolation)', () => {
    const configDir = tempDir('run-evidence-iso-')
    const first = buildRunPorts({ configDir, runId: 'r_first' }).evidenceArtifacts
    const second = buildRunPorts({ configDir, runId: 'r_second' }).evidenceArtifacts

    const ref = first.persistDecisionScreenshot(new Uint8Array([9, 8, 7, 6]))
    expect(first.getBlob(ref.sha)).toBeDefined()
    expect(second.getBlob(ref.sha)).toBeUndefined()
  })
})

// buildMemberRunConfig maps the resolved host impls into a MemberRunConfig; the run-scoped evidence
// store must cross into member execution by strict identity (no wrapping) so Plan 12's loop producer
// sees the exact run store.
describe('buildMemberRunConfig — evidence store identity', () => {
  it('copies the exact supplied evidenceArtifacts store into MemberRunConfig', () => {
    const configDir = tempDir('run-evidence-mc-')
    const store = buildRunPorts({ configDir, runId: 'r_member-config' }).evidenceArtifacts

    const config = buildMemberRunConfig({
      adapter: { platform: 'web' } as never,
      planner: {} as never,
      verifier: {} as never,
      plannerModel: {} as never,
      verifierModel: {} as never,
      sink: {} as never,
      testIndex: 0,
      abortSignal: new AbortController().signal,
      filePath: 'checkout.test.ts',
      evidenceArtifacts: store,
    })

    expect(config.evidenceArtifacts).toBe(store)
  })

  it('leaves evidenceArtifacts undefined when no store is supplied', () => {
    const config = buildMemberRunConfig({
      adapter: { platform: 'web' } as never,
      planner: {} as never,
      verifier: {} as never,
      plannerModel: {} as never,
      verifierModel: {} as never,
      sink: {} as never,
      testIndex: 0,
      abortSignal: new AbortController().signal,
      filePath: 'checkout.test.ts',
    })

    expect(config.evidenceArtifacts).toBeUndefined()
  })
})

// createSuiteLifecycle lazily sets up a suite on its first member, tears down the previous suite
// on a cross-suite member, and finalize() tears down the last active suite — a wholly-skipped
// suite never sets up (ensureReady is only called by the executor for non-skipped members).
describe('createSuiteLifecycle (lazy per-suite setup/teardown)', () => {
  it('sets up lazily on first member, tears down previous on cross-suite, finalize tears down last', async () => {
    const events: string[] = []
    const hooksFor = (key: string) => ({
      setup: async () => { events.push(`setup:${key}`) },
      teardown: async () => { events.push(`teardown:${key}`) },
    })
    const lc = createSuiteLifecycle()

    // `ensureReady` returns a per-member lease; a suite is not torn down while a member is live.
    ;(await lc.ensureReady('A', hooksFor('A'))).release()
    ;(await lc.ensureReady('A', hooksFor('A'))).release() // same suite => no re-setup
    ;(await lc.ensureReady('B', hooksFor('B'))).release() // cross-suite => tears down A, sets up B
    await lc.finalize() // tears down the last active suite (B)

    // Suite C is never ensured => it never appears (a wholly-skipped suite never sets up).
    expect(events).toEqual(['setup:A', 'teardown:A', 'setup:B', 'teardown:B'])
  })

  it('finalize is a no-op when no suite was ever set up (all members skipped)', async () => {
    const events: string[] = []
    const lc = createSuiteLifecycle()
    await lc.finalize()
    expect(events).toEqual([])
  })
})

describe('resolveRunExecutionContext (delegates to safety-local)', () => {
  it('resolves a valid execution context', () => {
    const ctx = resolveRunExecutionContext()
    expect(['local-interactive', 'local-headless', 'ci', 'cloud']).toContain(ctx)
  })

  it('honors an explicit override', () => {
    const ctx = resolveRunExecutionContext('cloud')
    expect(ctx).toBe('cloud')
  })
})

// Read off the assembled `RunConfig`, so the fault port is shown to cross the ports hop.
describe('buildRunPorts — onSubscriberFault destination', () => {
  it('supplies a callable onSubscriberFault whose invocation is an observable process warning carrying the code', async () => {
    const configDir = tempDir('run-ports-fault-')
    const ports = buildRunPorts({ configDir, runId: 'r_fault-destination' })
    expect(typeof ports.onSubscriberFault, 'buildRunPorts supplies the port').toBe('function')

    const observed = new Promise<{ code?: string; message: string }>((resolve) => {
      process.once('warning', (warning: Error & { code?: string }) => {
        resolve({ code: warning.code, message: warning.message })
      })
    })
    ports.onSubscriberFault?.('live-stream-subscriber-detached', 'live-frame subscriber threw during delivery and was detached')
    const warning = await observed
    expect(warning.code).toBe('live-stream-subscriber-detached')
    expect(warning.message).toBe('live-frame subscriber threw during delivery and was detached')
  })

  it('THE CROSSING CELL: assembleCliRun carries the port onto the RunConfig the shell reads', async () => {
    const configDir = realpathSync(tempDir('run-assembly-fault-'))
    const runId = 'r_assembly-fault'
    const assembly = await assembleCliRun({
      runId,
      executionContext: 'local-headless' as never,
      configDir,
      knowledgeRoot: join(configDir, 'knowledge'),
      ports: buildRunPorts({ configDir, runId }),
      secretRedactor: new SecretRedactor(new SecretStore()),
      members: [],
      executor: (() => { throw new Error('unreachable in this cell') }) as never,
      configDigests: { config: 'c', source: 's' } as never,
      product: 'fault-product',
      warn: () => { /* no fold in this cell */ },
    })
    expect(typeof assembly.config.ports?.onSubscriberFault, 'carried across run-assembly.ts:175').toBe('function')
  })
})
