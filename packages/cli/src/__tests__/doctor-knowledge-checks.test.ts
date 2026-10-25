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
  EMBEDDER_WORKER_NOT_REGISTERED_TEXT,
  NO_KNOWLEDGE_ROOT_MESSAGE,
  RUNG_CAUSE_LABELS,
  createKnowledgeChecks,
  type KnowledgeCheckProbes,
} from '../commands/doctor-knowledge-checks.js'

const STATIC_PROFILE: EmbeddingProfile = { ...DEFAULT_EMBEDDING_PROFILE, backend: 'static' }

/** `ready` carries a live `EmbedderPort`; no row reads it, so the cells hand over a stub. */
function ready(rung: 'native' | 'floor', profile: EmbeddingProfile = DEFAULT_EMBEDDING_PROFILE) {
  return { kind: 'ready', rung, profile, embedder: {} } as never
}

function deferred(reason: string) {
  return { kind: 'deferred', reason } as never
}

const LEXICAL_ONLY = { kind: 'lexical-only' } as never

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
      expect(checks[0].fixInstructions).toContain('agent-qa knowledge rebuild-index')
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

  it('fails the embedder row with the 399 wording when a live daemon lease has no worker registration', async () => {
    const project = makeProject()
    const { checks, embedder, rung } = await runChecks(project, baseProbes({
      readWriterLease: () => ({ kind: 'parsed', lease: {} as never }),
      readEmbedderWorkerRegistration: () => ({ kind: 'absent' }),
      daemonLive: () => true,
      readDaemonEventLedger: () => ({
        events: [
          { kind: 'embedder-worker-start' },
          {
            kind: 'embedder-worker-exit',
            reason: 'crash',
            stderr: 'Error: Embedder worker could not resolve profile: deferred\n    at /home/u/.agent-qa/worker.js',
          },
        ],
      }),
    }))
    expect(embedder).toEqual({ status: 'fail', message: EMBEDDER_WORKER_NOT_REGISTERED_TEXT })
    expect(embedder.message).not.toContain('/home/u/.agent-qa/worker.js')
    expect(checks[1].fixInstructions).toContain('v2 does not download the embedding model')
    expect(rung.status).not.toBe('fail')
  })

  it('fails the embedder row with the ledger reason word when the exit was not a profile failure', async () => {
    const project = makeProject()
    const { embedder } = await runChecks(project, baseProbes({
      readWriterLease: () => ({ kind: 'parsed', lease: {} as never }),
      readEmbedderWorkerRegistration: () => ({ kind: 'absent' }),
      readDaemonEventLedger: () => ({
        events: [{ kind: 'embedder-worker-exit', reason: 'terminated', stderr: 'SIGKILL' }],
      }),
    }))
    expect(embedder).toEqual({
      status: 'fail',
      message: 'embedder worker failed to start: terminated',
    })
  })

  it('fails with `no registration published` when a live lease has no exit row at all', async () => {
    const project = makeProject()
    const { embedder } = await runChecks(project, baseProbes({
      readWriterLease: () => ({ kind: 'parsed', lease: {} as never }),
      readEmbedderWorkerRegistration: () => ({ kind: 'absent' }),
      readDaemonEventLedger: () => ({ events: [] }),
    }))
    expect(embedder).toEqual({
      status: 'fail',
      message: 'embedder worker failed to start: no registration published',
    })
  })

  it('does not consult the daemon half at all when no writer lease is live', async () => {
    const project = makeProject()
    const readEmbedderWorkerRegistration = vi.fn(() => ({ kind: 'absent' as const }))
    const readDaemonEventLedger = vi.fn(() => ({ events: [] }))
    const { embedder } = await runChecks(project, baseProbes({
      readWriterLease: () => ({ kind: 'absent' }),
      readEmbedderWorkerRegistration,
      readDaemonEventLedger,
    }))
    expect(readEmbedderWorkerRegistration).not.toHaveBeenCalled()
    expect(readDaemonEventLedger).not.toHaveBeenCalled()
    expect(embedder.status).toBe('pass')
  })

  it('leaves the embedder row PASSING when a live lease did publish a parsed registration', async () => {
    const project = makeProject()
    const { embedder } = await runChecks(project, baseProbes({
      readWriterLease: () => ({ kind: 'parsed', lease: {} as never }),
      readEmbedderWorkerRegistration: () => ({ kind: 'parsed', registration: {} as never }),
      readDaemonEventLedger: () => ({ events: [] }),
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

  it('hard-codes allowDownload false on the capability probe (D-20: asking must not change the answer)', async () => {
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

describe('C446-EMBEDDER-FIX', () => {
  const liveLease = { readWriterLease: () => ({ kind: 'parsed', lease: {} as never }) as const }
  const profileExit = {
    kind: 'embedder-worker-exit',
    reason: 'crash',
    stderr: 'Error: Embedder worker could not resolve profile: deferred\n    at /home/u/.agent-qa/worker.js',
  }

  async function daemonState(events: Record<string, unknown>[], live = true) {
    const { checks, embedder } = await runChecks(makeProject(), baseProbes({
      ...liveLease,
      readEmbedderWorkerRegistration: () => ({ kind: 'absent' }),
      daemonLive: () => live,
      readDaemonEventLedger: () => ({ events: events as never }),
    }))
    return { embedder, fix: checks[1]!.fixInstructions }
  }

  it('a daemon worker that could not resolve its profile says v2 downloads no embedding model and daemon stop clears the row', async () => {
    const { embedder, fix } = await daemonState([{ kind: 'embedder-worker-start' }, profileExit])
    expect(embedder).toEqual({ status: 'fail', message: EMBEDDER_WORKER_NOT_REGISTERED_TEXT })
    expect(fix).toContain('v2 does not download the embedding model')
    expect(fix).toContain('npx agent-qa daemon stop')
    expect(fix).toBe('v2 does not download the embedding model, and knowledge search works without it. Stop the daemon with `npx agent-qa daemon stop` to clear this row.')
    expect(fix).not.toContain('/home/u/.agent-qa/worker.js')
  })

  it('an idle daemon with no worker registration says the worker starts when a run needs it and daemon stop clears the row', async () => {
    const worker = 'The daemon starts its embedder worker when a run needs it, so an idle daemon shows this row. Stop the daemon with `npx agent-qa daemon stop` to clear it.'
    for (const [events, reason] of [
      [[], 'no registration published'],
      [[{ kind: 'embedder-worker-exit', reason: 'terminated', stderr: 'SIGKILL' }], 'terminated'],
    ] as const) {
      const { embedder, fix } = await daemonState([...events])
      expect(embedder).toEqual({ status: 'fail', message: `embedder worker failed to start: ${reason}` })
      expect(fix).toContain('starts its embedder worker when a run needs it')
      expect(fix).toContain('npx agent-qa daemon stop')
      expect(fix).toBe(worker)
    }
  })

  it('both daemon states keep the fail status and name no config key', async () => {
    const states = [await daemonState([profileExit]), await daemonState([])]
    for (const { embedder, fix } of states) {
      expect(embedder.status).toBe('fail')
      expect(fix).not.toContain('agent-qa.config.yaml')
      expect(fix).not.toContain('profile in')
      expect(fix).not.toContain('embedder.')
    }
    expect(states[0]!.fix).not.toBe(states[1]!.fix)

    const pass = await runChecks(makeProject(), baseProbes())
    const warn = await runChecks(makeProject(), baseProbes({
      resolveEmbedderCapability: () => Promise.resolve(ready('floor')),
    }))
    const project = makeProject()
    const skip = await runChecks({ ...project, config: null as never }, baseProbes())
    expect([pass.embedder.status, warn.embedder.status, skip.embedder.status]).toEqual(['pass', 'warn', 'skip'])
  })

  it('a worker that exited with crash or start-error says it exited with an error, not that the daemon is idle', async () => {
    const worker = 'The daemon starts its embedder worker when a run needs it, so an idle daemon shows this row. Stop the daemon with `npx agent-qa daemon stop` to clear it.'
    for (const reason of ['crash', 'start-error']) {
      const { embedder, fix } = await daemonState([
        { kind: 'embedder-worker-start' },
        { kind: 'embedder-worker-exit', reason, stderr: 'Error: worker exited with code 1' },
      ])
      expect(embedder).toEqual({ status: 'fail', message: `embedder worker failed to start: ${reason}` })
      expect(fix, reason).not.toBe(worker)
      expect(fix, reason).toContain('exited with an error')
      expect(fix, reason).toContain('npx agent-qa daemon stop')
      expect(fix, reason).not.toContain('idle daemon')
    }
  })

  it('idle, daemon-stop and replace exits and no recorded exit keep the idle worker text', async () => {
    const worker = 'The daemon starts its embedder worker when a run needs it, so an idle daemon shows this row. Stop the daemon with `npx agent-qa daemon stop` to clear it.'
    for (const reason of ['idle', 'daemon-stop', 'replace']) {
      const { embedder, fix } = await daemonState([{ kind: 'embedder-worker-exit', reason, stderr: '' }])
      expect(embedder).toEqual({ status: 'fail', message: `embedder worker failed to start: ${reason}` })
      expect(fix, reason).toBe(worker)
    }
    const { embedder, fix } = await daemonState([])
    expect(embedder).toEqual({ status: 'fail', message: 'embedder worker failed to start: no registration published' })
    expect(fix).toBe(worker)
  })

  it('with no live daemon the fix says daemon stop cannot clear the row and names the daemon start that takes the lease over', async () => {
    const states = [
      { events: [profileExit], message: EMBEDDER_WORKER_NOT_REGISTERED_TEXT },
      {
        events: [{ kind: 'embedder-worker-exit', reason: 'crash', stderr: 'Error: worker exited with code 1' }],
        message: 'embedder worker failed to start: crash',
      },
      { events: [], message: 'embedder worker failed to start: no registration published' },
    ]
    const fixes = new Set<string>()
    for (const { events, message } of states) {
      const { embedder, fix } = await daemonState(events, false)
      expect(embedder).toEqual({ status: 'fail', message })
      expect(fix, message).toContain('No agent-qa daemon is running')
      expect(fix, message).toContain('cannot clear')
      expect(fix, message).toContain('`npx agent-qa daemon`')
      expect(fix, message).not.toContain('/home/u/.agent-qa/worker.js')
      fixes.add(fix)
    }
    expect(fixes.size).toBe(1)
  })
})
