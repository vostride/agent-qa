import { afterAll, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

import {
  DEFAULT_EMBEDDING_PROFILE,
  RETRIEVAL_RUNG_REASONS,
  type EmbeddingProfile,
} from '@vostride/agent-qa-schema'

import {
  EMBEDDER_CRASH_FIX,
  EMBEDDER_FLOOR_FIX,
  EMBEDDER_NONE_FIX,
  EMBEDDER_NO_DAEMON_FIX,
  EMBEDDER_NO_DAEMON_TEXT,
  EMBEDDER_PROFILE_FIX,
  EMBEDDER_WORKER_NOT_REGISTERED_TEXT,
  NO_KNOWLEDGE_ROOT_MESSAGE,
  RUNG_CAUSE_LABELS,
  createKnowledgeChecks,
  type KnowledgeCheckProbes,
} from '../commands/doctor-knowledge-checks.js'
import { rowFix } from '../commands/doctor-row.js'
import {
  DAEMON_REGISTRATION_SCHEMA_VERSION,
  inspectDaemonHandshake,
  type DaemonHandshakeDeps,
  type DaemonRegistration,
  type InspectDaemonRegistrationOutcome,
} from '../daemon/registration.js'
import { DAEMON_IDENTITY_SCHEMA_VERSION } from '../daemon/server.js'

const STATIC_PROFILE: EmbeddingProfile = { ...DEFAULT_EMBEDDING_PROFILE, backend: 'static' }

/** `ready` carries a live `EmbedderPort`; no row reads it, so the cells hand over a stub. */
function ready(rung: 'native' | 'floor', profile: EmbeddingProfile = DEFAULT_EMBEDDING_PROFILE) {
  return { kind: 'ready', rung, profile, embedder: {} } as never
}

function deferred(reason: string) {
  return { kind: 'deferred', reason } as never
}

const LEXICAL_ONLY = { kind: 'lexical-only' } as never

const REGISTRATION: DaemonRegistration = {
  schemaVersion: DAEMON_REGISTRATION_SCHEMA_VERSION,
  instanceId: '5b0c2f7e-8a41-4f3b-9d2e-6c1a7b3e9f04',
  pid: 4242,
  socketPath: '/sockets/agent-qa-daemon.sock',
  startedAtMs: 1_000,
}

const SINCE_START = new Date(REGISTRATION.startedAtMs + 1).toISOString()
const BEFORE_START = new Date(REGISTRATION.startedAtMs - 1).toISOString()
const NOT_STARTED = '; the daemon starts its embedder worker when a run needs it'

function daemonOutcome(live: boolean): InspectDaemonRegistrationOutcome {
  return { kind: live ? 'live' : 'stale', registration: REGISTRATION }
}

// Each Embedder WARN outcome, the words its message opens with, and the fix printed under it.
const EMBEDDER_WARNS = [
  { outcome: ready('floor'), opens: 'static floor — ', fix: EMBEDDER_FLOOR_FIX },
  { outcome: deferred('cold-artifact'), opens: 'none — ', fix: EMBEDDER_NONE_FIX },
  { outcome: deferred('load-failure'), opens: 'none — ', fix: EMBEDDER_NONE_FIX },
  { outcome: deferred('worker-unavailable'), opens: 'none — ', fix: EMBEDDER_NONE_FIX },
  { outcome: LEXICAL_ONLY, opens: 'none — ', fix: EMBEDDER_NONE_FIX },
]

function expectWarnFix(fix: string | undefined, expected: string, label: string): void {
  expect(fix, label).not.toContain('exited with an error')
  expect(fix, label).not.toContain('daemon stop')
  expect(fix, label).toBe(expected)
}

interface Project {
  config: Record<string, unknown>
  configPath: string
  knowledgeRoot: string
  agentQaRoot: string
  projectRoot: string
}

const created: string[] = []

function makeProject(options: { withKnowledgeDir?: boolean } = {}): Project {
  const projectRoot = mkdtempSync(join(tmpdir(), 'doctor-knowledge-'))
  created.push(projectRoot)
  const knowledgeRoot = join(projectRoot, 'agent-qa-knowledge')
  if (options.withKnowledgeDir !== false) mkdirSync(knowledgeRoot, { recursive: true })
  return {
    config: { knowledge: { dir: 'agent-qa-knowledge' } },
    configPath: join(projectRoot, 'agent-qa.config.yaml'),
    knowledgeRoot,
    agentQaRoot: join(projectRoot, '.agent-qa'),
    projectRoot,
  }
}

afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true })
})

function baseProbes(overrides: Partial<KnowledgeCheckProbes> = {}): KnowledgeCheckProbes {
  return {
    classifyIndexFace: () => ({ source: 'index' }),
    resolveEmbedderCapability: () => Promise.resolve(ready('native')),
    readWriterLease: () => ({ kind: 'absent' }),
    readEmbedderWorkerRegistration: () => ({ kind: 'absent' }),
    readDaemonEventLedger: () => ({ events: [] }),
    inspectDaemon: () => Promise.resolve({ kind: 'absent' }),
    ...overrides,
  }
}

async function runChecks(project: Project, probes: KnowledgeCheckProbes) {
  const checks = createKnowledgeChecks({
    config: project.config,
    configPath: project.configPath,
    probes,
  })
  const results = await Promise.all(checks.map(check => check.check()))
  return {
    checks,
    store: results[0]!,
    embedder: results[1]!,
    rung: results[2]!,
  }
}

describe('createKnowledgeChecks', () => {
  it('returns exactly three rows named store, embedder, rung in that order', () => {
    const project = makeProject()
    const checks = createKnowledgeChecks({ config: project.config, configPath: project.configPath })
    expect(checks.map(check => check.name)).toEqual([
      'Knowledge store',
      'Embedder',
      'Retrieval rung',
    ])
  })

  it('skips all three rows when the raw config is null', async () => {
    const project = makeProject()
    const checks = createKnowledgeChecks({ config: null, configPath: project.configPath })
    const results = await Promise.all(checks.map(check => check.check()))
    expect(results).toEqual([
      { status: 'skip', message: NO_KNOWLEDGE_ROOT_MESSAGE },
      { status: 'skip', message: NO_KNOWLEDGE_ROOT_MESSAGE },
      { status: 'skip', message: NO_KNOWLEDGE_ROOT_MESSAGE },
    ])
  })

  it('skips all three rows when the configured knowledge dir does not exist on disk', async () => {
    const project = makeProject({ withKnowledgeDir: false })
    const classifyIndexFace = vi.fn(() => ({ source: 'index' as const }))
    const { store, embedder, rung } = await runChecks(project, baseProbes({ classifyIndexFace }))
    expect(store.status).toBe('skip')
    expect(embedder.status).toBe('skip')
    expect(rung.status).toBe('skip')
    expect(store.message).toBe(NO_KNOWLEDGE_ROOT_MESSAGE)
    expect(classifyIndexFace).not.toHaveBeenCalled()
  })

  it('passes all three rows on an open index with a native embedder', async () => {
    const project = makeProject()
    const { store, embedder, rung } = await runChecks(project, baseProbes())
    const relativeRoot = relative(process.cwd(), project.knowledgeRoot) || '.'
    expect(store).toEqual({ status: 'pass', message: `index open at ${relativeRoot} (memidex)` })
    expect(embedder).toEqual({
      status: 'pass',
      message: `native (${DEFAULT_EMBEDDING_PROFILE.model_id})`,
    })
    expect(rung).toEqual({ status: 'pass', message: 'memidex' })
  })

  it('warns store and rung on an absent index, and still probes the embedder for its own row', async () => {
    const project = makeProject()
    const resolveEmbedderCapability = vi.fn(() => Promise.resolve(ready('native')))
    const { store, embedder, rung } = await runChecks(project, baseProbes({
      classifyIndexFace: () => ({
        source: 'scan',
        reason: 'absent',
        detail: 'derived index file is absent',
        filePresent: false,
      }),
      resolveEmbedderCapability,
    }))
    const relativeRoot = relative(process.cwd(), project.knowledgeRoot) || '.'
    expect(store).toEqual({
      status: 'warn',
      message: `no index at ${relativeRoot} — scanning bundles (${RUNG_CAUSE_LABELS['index-not-built']})`,
    })
    expect(rung).toEqual({
      status: 'warn',
      message: `bundle-scan — ${RUNG_CAUSE_LABELS['index-not-built']}`,
    })
    expect(embedder.status).toBe('pass')
    expect(resolveEmbedderCapability).toHaveBeenCalledTimes(1)
  })

  it.each(['corrupt', 'locked', 'schema-version'] as const)(
    'fails the store row on a present-but-unopenable index (%s), naming the reason word not the driver detail',
    async (reason) => {
      const project = makeProject()
      const { checks, store, rung } = await runChecks(project, baseProbes({
        classifyIndexFace: () => ({
          source: 'scan',
          reason,
          detail: 'SQLITE_NOTADB: file is not a database (deep driver text)',
          filePresent: true,
        }),
      }))
      const indexPath = relative(process.cwd(), join(project.knowledgeRoot, 'memory', 'index', 'knowledge.db'))
      expect(store.status).toBe('fail')
      expect(store.message).toBe(`index at ${indexPath} could not be opened: ${reason}`)
      expect(store.message).not.toContain('SQLITE_NOTADB')
      expect(checks[0].fixInstructions).toContain('`npx agent-qa knowledge rebuild-index`')
      expect(rung.status).toBe('warn')
    },
  )

  it('warns the embedder and rung rows on a static floor reached because native could not load', async () => {
    const project = makeProject()
    const { embedder, rung } = await runChecks(project, baseProbes({
      resolveEmbedderCapability: () => Promise.resolve(ready('floor')),
    }))
    expect(embedder).toEqual({
      status: 'warn',
      message: `static floor — ${RUNG_CAUSE_LABELS['native-runtime-unavailable']}`,
    })
    expect(rung).toEqual({
      status: 'warn',
      message: `static-floor — ${RUNG_CAUSE_LABELS['native-runtime-unavailable']}`,
    })
  })

  it('names a deliberately static PREFERRED profile as configured rather than as a fault', async () => {
    const project = makeProject()
    const checks = createKnowledgeChecks({
      config: project.config,
      configPath: project.configPath,
      preferredProfile: STATIC_PROFILE,
      probes: baseProbes({
        resolveEmbedderCapability: () => Promise.resolve(ready('floor', STATIC_PROFILE)),
      }),
    })
    const [, embedder, rung] = await Promise.all(checks.map(check => check.check()))
    expect(embedder).toEqual({
      status: 'warn',
      message: `static floor — ${RUNG_CAUSE_LABELS['profile-static-configured']}`,
    })
    expect(rung).toEqual({
      status: 'warn',
      message: `static-floor — ${RUNG_CAUSE_LABELS['profile-static-configured']}`,
    })
  })

  it.each([
    ['cold-artifact', 'model-not-downloaded'],
    ['load-failure', 'embedder-load-failed'],
    ['worker-unavailable', 'profile-unresolved'],
  ] as const)('warns embedder and rung for a deferred embedder (%s)', async (reason, expected) => {
    const project = makeProject()
    const { embedder, rung } = await runChecks(project, baseProbes({
      resolveEmbedderCapability: () => Promise.resolve(deferred(reason)),
    }))
    expect(embedder).toEqual({ status: 'warn', message: `none — ${RUNG_CAUSE_LABELS[expected]}` })
    expect(rung).toEqual({ status: 'warn', message: `lexical-only — ${RUNG_CAUSE_LABELS[expected]}` })
  })

  it('warns embedder and rung when the static floor was explicitly disabled', async () => {
    const project = makeProject()
    const { embedder, rung } = await runChecks(project, baseProbes({
      resolveEmbedderCapability: () => Promise.resolve(LEXICAL_ONLY),
    }))
    expect(embedder).toEqual({
      status: 'warn',
      message: `none — ${RUNG_CAUSE_LABELS['floor-disabled']}`,
    })
    expect(rung).toEqual({
      status: 'warn',
      message: `lexical-only — ${RUNG_CAUSE_LABELS['floor-disabled']}`,
    })
  })

  it('folds a rejecting capability probe into a load failure rather than throwing', async () => {
    const project = makeProject()
    const { embedder, rung } = await runChecks(project, baseProbes({
      resolveEmbedderCapability: () => Promise.reject(new Error('probe exploded')),
    }))
    expect(embedder.message).toBe(`none — ${RUNG_CAUSE_LABELS['embedder-load-failed']}`)
    expect(rung.message).toBe(`lexical-only — ${RUNG_CAUSE_LABELS['embedder-load-failed']}`)
    expect(embedder.message).not.toContain('probe exploded')
  })

  it("with no daemon, a static floor Embedder WARN prints the static floor's fix and a none WARN prints the none fix", async () => {
    for (const { outcome, opens, fix } of EMBEDDER_WARNS) {
      const { checks, embedder } = await runChecks(makeProject(), baseProbes({
        resolveEmbedderCapability: () => Promise.resolve(outcome),
      }))
      expect(embedder.status, opens).toBe('warn')
      expect(embedder.message.startsWith(opens), embedder.message).toBe(true)
      expectWarnFix(rowFix({ check: checks[1]!, result: embedder }), fix, embedder.message)
    }

    const native = await runChecks(makeProject(), baseProbes())
    expect(native.embedder.status).toBe('pass')
    expect(rowFix({ check: native.checks[1]!, result: native.embedder })).toBeUndefined()
  })

  it('fails the embedder row with the worker-not-registered wording when a live daemon lease has no worker registration', async () => {
    const project = makeProject()
    const { checks, embedder, rung } = await runChecks(project, baseProbes({
      readWriterLease: () => ({ kind: 'parsed', lease: {} as never }),
      readEmbedderWorkerRegistration: () => ({ kind: 'absent' }),
      inspectDaemon: () => Promise.resolve(daemonOutcome(true)),
      readDaemonEventLedger: () => ({
        events: [
          { ts: SINCE_START, kind: 'embedder-worker-start' },
          {
            ts: SINCE_START,
            kind: 'embedder-worker-exit',
            reason: 'crash',
            stderr: 'Error: Embedder worker could not resolve profile: deferred\n    at /home/u/.agent-qa/worker.js',
          },
        ],
      }),
    }))
    expect(embedder).toEqual({ status: 'fail', message: EMBEDDER_WORKER_NOT_REGISTERED_TEXT })
    expect(embedder.message).not.toContain('/home/u/.agent-qa/worker.js')
    expect(rowFix({ check: checks[1]!, result: embedder })).toContain(
      'v2 does not download the embedding model',
    )
    expect(rung.status).not.toBe('fail')
  })

  it('fails the embedder row with the no-daemon text when a writer lease is held and no daemon is live', async () => {
    const project = makeProject()
    const { checks, embedder } = await runChecks(project, baseProbes({
      readWriterLease: () => ({ kind: 'parsed', lease: {} as never }),
      readEmbedderWorkerRegistration: () => ({ kind: 'absent' }),
      readDaemonEventLedger: () => ({ events: [] }),
    }))
    expect(embedder).toEqual({ status: 'fail', message: EMBEDDER_NO_DAEMON_TEXT })
    expect(rowFix({ check: checks[1]!, result: embedder })).toBe(EMBEDDER_NO_DAEMON_FIX)
  })

  it('does not consult the daemon half at all when no writer lease is live', async () => {
    const project = makeProject()
    const readEmbedderWorkerRegistration = vi.fn(() => ({ kind: 'absent' as const }))
    const readDaemonEventLedger = vi.fn(() => ({ events: [] }))
    const inspectDaemon = vi.fn(() => Promise.resolve(daemonOutcome(true)))
    const { embedder } = await runChecks(project, baseProbes({
      readWriterLease: () => ({ kind: 'absent' }),
      readEmbedderWorkerRegistration,
      readDaemonEventLedger,
      inspectDaemon,
    }))
    expect(readEmbedderWorkerRegistration).not.toHaveBeenCalled()
    expect(readDaemonEventLedger).not.toHaveBeenCalled()
    expect(inspectDaemon).not.toHaveBeenCalled()
    expect(embedder.status).toBe('pass')
  })

  it('leaves the embedder row PASSING when a live lease did publish a parsed registration', async () => {
    const project = makeProject()
    const { embedder } = await runChecks(project, baseProbes({
      readWriterLease: () => ({ kind: 'parsed', lease: {} as never }),
      readEmbedderWorkerRegistration: () => ({ kind: 'parsed', registration: {} as never }),
      inspectDaemon: () => Promise.resolve(daemonOutcome(true)),
      readDaemonEventLedger: () => ({
        events: [{ ts: SINCE_START, kind: 'embedder-worker-exit', reason: 'crash', stderr: '' }],
      }),
    }))
    expect(embedder).toEqual({
      status: 'pass',
      message: `native (${DEFAULT_EMBEDDING_PROFILE.model_id})`,
    })
  })

  it('probes each axis exactly once across all three rows', async () => {
    const project = makeProject()
    const classifyIndexFace = vi.fn(() => ({ source: 'index' as const }))
    const resolveEmbedderCapability = vi.fn(() => Promise.resolve(ready('native')))
    const { checks } = await runChecks(project, baseProbes({ classifyIndexFace, resolveEmbedderCapability }))
    await Promise.all(checks.map(check => check.check()))
    expect(classifyIndexFace).toHaveBeenCalledTimes(1)
    expect(resolveEmbedderCapability).toHaveBeenCalledTimes(1)
  })

  it('hard-codes allowDownload false on the capability probe (asking must not change the answer)', async () => {
    const project = makeProject()
    const resolveEmbedderCapability = vi.fn(() => Promise.resolve(ready('native')))
    await runChecks(project, baseProbes({ resolveEmbedderCapability }))
    expect(resolveEmbedderCapability).toHaveBeenCalledWith(
      expect.objectContaining({ allowDownload: false, agentQaRoot: project.agentQaRoot }),
    )
  })

  it('never returns fail on the Retrieval rung row, over every index face x embedder outcome', async () => {
    const project = makeProject()
    const faces = [
      { source: 'index' as const },
      ...(['absent', 'corrupt', 'locked', 'schema-version'] as const).flatMap(reason => (
        [true, false].map(filePresent => ({
          source: 'scan' as const,
          reason,
          detail: 'detail',
          filePresent,
        }))
      )),
    ]
    const embedders = [
      ready('native'),
      ready('floor'),
      deferred('cold-artifact'),
      deferred('load-failure'),
      deferred('worker-unavailable'),
      LEXICAL_ONLY,
    ]

    for (const face of faces) {
      for (const embedder of embedders) {
        const { rung } = await runChecks(project, baseProbes({
          classifyIndexFace: () => face,
          resolveEmbedderCapability: () => Promise.resolve(embedder),
        }))
        expect(rung.status).not.toBe('fail')
        expect(rung.message.trim()).not.toBe('')
        if (rung.status === 'warn') expect(rung.message).toContain(' — ')
      }
    }
  })

  it('maps every reason word in the closed vocabulary to a non-empty label', () => {
    for (const reason of RETRIEVAL_RUNG_REASONS) {
      expect(RUNG_CAUSE_LABELS[reason]).toBeTruthy()
    }
    expect(Object.keys(RUNG_CAUSE_LABELS).sort()).toEqual([...RETRIEVAL_RUNG_REASONS].sort())
  })

  it('is idempotent against a real knowledge root: same answers, byte-identical listing, nothing written', async () => {
    const project = makeProject()
    mkdirSync(join(project.knowledgeRoot, 'memory'), { recursive: true })
    writeFileSync(join(project.knowledgeRoot, 'memory', '.keep'), '', 'utf8')

    // Everything real EXCEPT the capability probe: a live probe may load a model, and this cell's
    // subject is what the checks WRITE, not which rung this machine happens to be on.
    const probes: KnowledgeCheckProbes = {
      resolveEmbedderCapability: () => Promise.resolve(LEXICAL_ONLY),
    }

    const listing = () => readdirSync(project.projectRoot, { recursive: true }).map(String).sort()
    const before = listing()

    const first = await runChecks(project, probes)
    const afterFirst = listing()
    const second = await runChecks(project, probes)
    const afterSecond = listing()

    expect(second.store).toEqual(first.store)
    expect(second.embedder).toEqual(first.embedder)
    expect(second.rung).toEqual(first.rung)

    expect(afterFirst).toEqual(before)
    expect(afterSecond).toEqual(before)
    expect(afterSecond.some(entry => entry.includes('.rebuild-requested'))).toBe(false)
    expect(afterSecond.some(entry => entry.includes('lease'))).toBe(false)
    expect(afterSecond.some(entry => entry.includes('.agent-qa'))).toBe(false)

    expect(first.rung).toEqual({
      status: 'warn',
      message: `bundle-scan — ${RUNG_CAUSE_LABELS['index-not-built']}`,
    })
  })
})

describe('the Embedder row beside a daemon', () => {
  const liveLease = { readWriterLease: () => ({ kind: 'parsed', lease: {} as never }) as const }
  const profileExit = {
    kind: 'embedder-worker-exit',
    reason: 'crash',
    stderr: 'Error: Embedder worker could not resolve profile: deferred\n    at /home/u/.agent-qa/worker.js',
  }

  async function daemonState(
    events: Record<string, unknown>[],
    live = true,
    overrides: Partial<KnowledgeCheckProbes> = {},
  ) {
    const { checks, embedder } = await runChecks(makeProject(), baseProbes({
      ...liveLease,
      readEmbedderWorkerRegistration: () => ({ kind: 'absent' }),
      inspectDaemon: () => Promise.resolve(daemonOutcome(live)),
      readDaemonEventLedger: () => ({
        events: events.map(event => ({ ts: SINCE_START, ...event })) as never,
      }),
      ...overrides,
    }))
    return { embedder, fix: rowFix({ check: checks[1]!, result: embedder }) }
  }

  it('an idle daemon with no worker registration and no worker exit reports the in-process result and says the worker starts when a run needs it', async () => {
    const native = await daemonState([])
    expect(native.embedder).toEqual({
      status: 'pass',
      message: `native (${DEFAULT_EMBEDDING_PROFILE.model_id})${NOT_STARTED}`,
    })

    const floor = await daemonState([], true, {
      resolveEmbedderCapability: () => Promise.resolve(ready('floor')),
    })
    expect(floor.embedder).toEqual({
      status: 'warn',
      message: `static floor — ${RUNG_CAUSE_LABELS['native-runtime-unavailable']}${NOT_STARTED}`,
    })

    const none = await daemonState([], true, {
      resolveEmbedderCapability: () => Promise.resolve(LEXICAL_ONLY),
    })
    expect(none.embedder).toEqual({
      status: 'warn',
      message: `none — ${RUNG_CAUSE_LABELS['floor-disabled']}${NOT_STARTED}`,
    })
  })

  it('beside an idle daemon, the static floor and none Embedder WARNs print the fix for their rung, never the crash fix or daemon stop', async () => {
    const idleStates: Record<string, unknown>[][] = [
      [],
      [{ kind: 'embedder-worker-start' }, { kind: 'embedder-worker-exit', reason: 'idle', stderr: '' }],
    ]
    for (const events of idleStates) {
      for (const { outcome, opens, fix } of EMBEDDER_WARNS) {
        const state = await daemonState(events, true, {
          resolveEmbedderCapability: () => Promise.resolve(outcome),
        })
        expect(state.embedder.status, opens).toBe('warn')
        expect(state.embedder.message.startsWith(opens), state.embedder.message).toBe(true)
        expect(state.embedder.message.endsWith(NOT_STARTED), state.embedder.message).toBe(true)
        expectWarnFix(state.fix, fix, state.embedder.message)
      }

      const native = await daemonState(events)
      expect(native.embedder).toEqual({
        status: 'pass',
        message: `native (${DEFAULT_EMBEDDING_PROFILE.model_id})${NOT_STARTED}`,
      })
      expect(native.fix).toBeUndefined()
    }
  })

  it('idle, daemon-stop and replace exits since the daemon started read as not started', async () => {
    for (const reason of ['idle', 'daemon-stop', 'replace']) {
      const { embedder } = await daemonState([
        { kind: 'embedder-worker-start' },
        { kind: 'embedder-worker-exit', reason, stderr: '' },
      ])
      expect(embedder, reason).toEqual({
        status: 'pass',
        message: `native (${DEFAULT_EMBEDDING_PROFILE.model_id})${NOT_STARTED}`,
      })
    }
  })

  it('a crash or start-error exit since the daemon started fails with the crash fix', async () => {
    for (const reason of ['crash', 'start-error']) {
      const { embedder, fix } = await daemonState([
        { kind: 'embedder-worker-start' },
        { kind: 'embedder-worker-exit', reason, stderr: 'Error: worker exited with code 1' },
      ])
      expect(embedder, reason).toEqual({ status: 'fail', message: `embedder worker failed to start: ${reason}` })
      expect(fix, reason).toBe(EMBEDDER_CRASH_FIX)
      expect(fix, reason).toContain('exited with an error')
      expect(fix, reason).toContain('npx agent-qa daemon stop')
    }
  })

  it('a worker that could not resolve its profile since the daemon started fails with the not-registered text and the profile fix', async () => {
    const { embedder, fix } = await daemonState([{ kind: 'embedder-worker-start' }, profileExit])
    expect(embedder).toEqual({ status: 'fail', message: EMBEDDER_WORKER_NOT_REGISTERED_TEXT })
    expect(fix).toBe(EMBEDDER_PROFILE_FIX)
    expect(fix).toContain('v2 does not download the embedding model')
    expect(fix).not.toContain('/home/u/.agent-qa/worker.js')
  })

  it('a crash or profile exit recorded before the daemon started is ignored, so the worker reads as not started', async () => {
    for (const exit of [
      { kind: 'embedder-worker-exit', reason: 'crash', stderr: 'Error: worker exited with code 1' },
      profileExit,
    ]) {
      const { embedder } = await daemonState([{ ...exit, ts: BEFORE_START }])
      expect(embedder, exit.stderr).toEqual({
        status: 'pass',
        message: `native (${DEFAULT_EMBEDDING_PROFILE.model_id})${NOT_STARTED}`,
      })
    }
  })

  it('only the last exit since the daemon started counts', async () => {
    const { embedder } = await daemonState([
      { kind: 'embedder-worker-exit', reason: 'crash', stderr: '' },
      { kind: 'embedder-worker-exit', reason: 'idle', stderr: '' },
    ])
    expect(embedder.status).toBe('pass')
    const crashed = await daemonState([
      { kind: 'embedder-worker-exit', reason: 'idle', stderr: '' },
      { kind: 'embedder-worker-exit', reason: 'crash', stderr: '' },
    ])
    expect(crashed.embedder.status).toBe('fail')
  })

  it('the failing daemon states name no config key', async () => {
    const states = [
      await daemonState([profileExit]),
      await daemonState([{ kind: 'embedder-worker-exit', reason: 'crash', stderr: '' }]),
      await daemonState([], false),
    ]
    for (const { embedder, fix } of states) {
      expect(embedder.status).toBe('fail')
      expect(fix).not.toContain('agent-qa.config.yaml')
      expect(fix).not.toContain('profile in')
      expect(fix).not.toContain('embedder.')
    }
    expect(new Set(states.map(state => state.fix)).size).toBe(3)
  })

  it('with no live daemon the row fails, the fix says daemon stop cannot clear it, and names the daemon start that takes the lease over', async () => {
    const fixes = new Set<string | undefined>()
    for (const events of [
      [profileExit],
      [{ kind: 'embedder-worker-exit', reason: 'crash', stderr: 'Error: worker exited with code 1' }],
      [{ kind: 'embedder-worker-exit', reason: 'idle', stderr: '' }],
      [],
    ]) {
      const { embedder, fix } = await daemonState(events, false)
      expect(embedder).toEqual({ status: 'fail', message: EMBEDDER_NO_DAEMON_TEXT })
      expect(fix).toBe(EMBEDDER_NO_DAEMON_FIX)
      expect(fix).toContain('No agent-qa daemon is running')
      expect(fix).toContain('cannot clear')
      expect(fix).toContain('`npx agent-qa daemon`')
      expect(fix).not.toContain('/home/u/.agent-qa/worker.js')
      fixes.add(fix)
    }
    expect(fixes.size).toBe(1)
  })
})

describe('daemon liveness by the handshake', () => {
  const liveLease = { readWriterLease: () => ({ kind: 'parsed', lease: {} as never }) as const }

  function handshake(overrides: Partial<DaemonHandshakeDeps> = {}): DaemonHandshakeDeps {
    return {
      readRegistration: () => ({ kind: 'parsed', registration: REGISTRATION }),
      processIsAlive: () => true,
      readIdentity: (registration) => Promise.resolve({
        schemaVersion: DAEMON_IDENTITY_SCHEMA_VERSION,
        instanceId: registration.instanceId,
        pid: registration.pid,
      }),
      ...overrides,
    }
  }

  async function embedderRow(deps: DaemonHandshakeDeps) {
    const { checks, embedder } = await runChecks(makeProject(), baseProbes({
      ...liveLease,
      readEmbedderWorkerRegistration: () => ({ kind: 'absent' }),
      inspectDaemon: (agentQaRoot) => inspectDaemonHandshake(deps, agentQaRoot),
      readDaemonEventLedger: () => ({
        events: [{
          ts: new Date(REGISTRATION.startedAtMs + 1).toISOString(),
          kind: 'embedder-worker-exit',
          reason: 'crash',
          stderr: 'Error: worker exited with code 1',
        }],
      }),
    }))
    return { embedder, fix: rowFix({ check: checks[1]!, result: embedder }) }
  }

  it('a live pid whose identity request fails is stale, and the Embedder row gets the no-daemon fix', async () => {
    const deps = handshake({ readIdentity: () => Promise.reject(new Error('connect ECONNREFUSED')) })
    expect(await inspectDaemonHandshake(deps, '/project/.agent-qa')).toEqual({
      kind: 'stale',
      registration: REGISTRATION,
    })
    const { embedder, fix } = await embedderRow(deps)
    expect(embedder.status).toBe('fail')
    expect(fix).toBe(EMBEDDER_NO_DAEMON_FIX)
    expect(fix).not.toContain('Stop the daemon with')
  })

  it('a live pid whose identity answers another instanceId or pid is stale, and the Embedder row gets the no-daemon fix', async () => {
    for (const identity of [
      { instanceId: '0f9e8d7c-6b5a-4c3d-8e2f-1a0b9c8d7e6f', pid: REGISTRATION.pid },
      { instanceId: REGISTRATION.instanceId, pid: 4343 },
    ]) {
      const deps = handshake({
        readIdentity: () => Promise.resolve({ schemaVersion: DAEMON_IDENTITY_SCHEMA_VERSION, ...identity }),
      })
      expect(await inspectDaemonHandshake(deps, '/project/.agent-qa'), JSON.stringify(identity)).toEqual({
        kind: 'stale',
        registration: REGISTRATION,
      })
      const { fix } = await embedderRow(deps)
      expect(fix, JSON.stringify(identity)).toBe(EMBEDDER_NO_DAEMON_FIX)
    }
  })

  it('a live pid whose identity matches is live, and the Embedder row sends a person to daemon stop', async () => {
    const deps = handshake()
    expect(await inspectDaemonHandshake(deps, '/project/.agent-qa')).toEqual({
      kind: 'live',
      registration: REGISTRATION,
    })
    const { fix } = await embedderRow(deps)
    expect(fix).toContain('Stop the daemon with `npx agent-qa daemon stop`')
  })

  it('a dead pid is stale without asking for the identity', async () => {
    const readIdentity = vi.fn<DaemonHandshakeDeps['readIdentity']>()
    const deps = handshake({ processIsAlive: () => false, readIdentity })
    expect(await inspectDaemonHandshake(deps, '/project/.agent-qa')).toEqual({
      kind: 'stale',
      registration: REGISTRATION,
    })
    expect(readIdentity).not.toHaveBeenCalled()
  })

  it('an absent or malformed registration answers as read', async () => {
    for (const kind of ['absent', 'malformed'] as const) {
      const deps = handshake({ readRegistration: () => ({ kind }) })
      expect(await inspectDaemonHandshake(deps, '/project/.agent-qa')).toEqual({ kind })
    }
  })
})
