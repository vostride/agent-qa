// A real runner feed over the real `startServer` transport; `handle-filter.test.ts` picks seqs.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveWorkspacePaths } from '@vostride/agent-qa-core'
import { startRun } from '@vostride/agent-qa-runner'
import type {
  MemberTestRunContext,
  RunMemberDescriptor,
} from '@vostride/agent-qa-runner'
import {
  RUN_EVENT_SCOPE,
  RUN_SERVICE_CONTRACT_VERSION,
  handleRosterOf,
  memberIndexOf,
  type RunEventEnvelope,
  type RunSession,
  type RunStartAcknowledgement,
} from '@vostride/agent-qa-schema'
import { parse as parseYaml } from 'yaml'
import { afterEach, describe, expect, it } from 'vitest'

import { DashboardDatabase } from '../../db/database.js'
import { startServer } from '../../server/server.js'
import type { RunServicePorts } from '../run-service-routes.js'

const RUN_ID = 'run-attribution'

/** Planted, non-contiguous, not 0-based — see the header. */
const HANDLES = [3, 7, 11] as const

const MEMBERS: readonly RunMemberDescriptor[] = [
  { testId: 'alpha', name: 'alpha test', filePath: 'alpha.test.ts', testIndex: 3 },
  { testId: 'bravo', name: 'bravo test', filePath: 'bravo.test.ts', testIndex: 7 },
  { testId: 'charlie', name: 'charlie test', filePath: 'charlie.test.ts', testIndex: 11 },
]

const OWNER_INDEX: Readonly<Record<string, number>> = { alpha: 3, bravo: 7, charlie: 11 }

async function drainUntil(predicate: () => boolean, turns = 200): Promise<boolean> {
  for (let i = 0; i < turns; i += 1) {
    if (predicate()) return true
    await Promise.resolve()
  }
  return predicate()
}

/**
 * Run three members CONCURRENTLY on the real shell and return the session plus its whole stream.
 *
 * No member returns until all three have started, so the published stream is interleaved — a
 * sequential execution produces a different one and every set assertion below would move.
 */
async function produceConcurrentRun(): Promise<{
  readonly session: RunSession
  readonly events: readonly RunEventEnvelope[]
}> {
  const log: RunEventEnvelope[] = []
  const started: string[] = []
  const session = startRun({
    runId: RUN_ID as never,
    scope: { tier: 'suite', key: 'attribution' },
    executionContext: 'local-headless',
    buildOrdinal: 1,
    configDigests: { suiteConfigDigest: 'suite-d', testConfigDigest: 'test-d' },
    members: [...MEMBERS],
    workers: 3,
    executor: async (member: RunMemberDescriptor, ctx: MemberTestRunContext) => {
      started.push(member.testId)
      ctx.events.stepStarted({ stepIndex: 0, stepText: `${member.testId} first` })
      ctx.events.hookStarted({
        hookName: 'before-each',
        phase: 'setup',
        hookExecutionId: `h-${member.testId}`,
        scope: 'test',
        testIndex: ctx.testIndex,
      })
      await drainUntil(() => started.length === MEMBERS.length)
      ctx.events.stepStarted({ stepIndex: 1, stepText: `${member.testId} second` })
      return {
        name: member.testId,
        filePath: member.filePath,
        status: 'passed' as const,
        steps: [{ name: 'a step', status: 'passed' as const, duration: 1 }],
        duration: 1,
      }
    },
    ports: {
      handoffStore: { save: () => undefined },
      eventLog: {
        append(envelope) { log.push(envelope) },
        read(fromSeq) { return log.filter((event) => event.seq >= fromSeq) },
      },
    },
  })
  const seen: RunEventEnvelope[] = []
  session.subscribe(1, (event) => seen.push(event))
  await session.done

  // The overlap is real, not assumed: a sequential run emits alpha's second step before bravo's
  // first, so this ordering is unreachable without genuine concurrency.
  const steps = seen
    .filter((event) => event.type === 'stepStarted')
    .map((event) => (event.payload as { stepText: string }).stepText)
  expect(steps.slice(0, 3)).toEqual(['alpha first', 'bravo first', 'charlie first'])

  return { session, events: seen }
}

const CONFIG = `
workspace:
  testMatch:
    - tests/**/*.yaml
  suiteMatch:
    - suites/**/*.suite.yaml
  hooksFile: hooks.yaml
  envFile: .env
  secretsFile: .secrets.local
concurrency: 2
`

let tempDir: string | undefined
let started: { server: Server; port: number; close: () => void } | undefined
let db: DashboardDatabase | undefined

function servicePorts(session: RunSession): RunServicePorts {
  return {
    invokeRunStart: async () => ({
      runId: RUN_ID as RunStartAcknowledgement['runId'],
      scope: 'main' as unknown as RunStartAcknowledgement['scope'],
      executionContext: 'local-headless' as RunStartAcknowledgement['executionContext'],
      buildOrdinal: 1,
      startedAt: 0,
      testCount: MEMBERS.length,
    }),
    attach: (runId) => runId === RUN_ID ? session : undefined,
    readiness: () => ({
      service: 'up',
      hostComposed: true,
      contractVersion: RUN_SERVICE_CONTRACT_VERSION,
    }),
    // A fixture with no live view answers a mint with 503 by name, never a fabricated token.
    mintLiveUrl: () => Promise.reject(
      Object.assign(new Error('no live-view port is bound on this fixture'), {
        name: 'LiveViewUnavailableError',
      }),
    ),
  }
}

/** Bring up the SHIPPED dashboard host with the run service mounted over the real run. */
async function mountShippedHost(session: RunSession): Promise<number> {
  tempDir = mkdtempSync(join(tmpdir(), 'agent-qa-handle-attribution-'))
  const configPath = join(tempDir, 'agent-qa.config.yaml')
  writeFileSync(join(tempDir, 'hooks.yaml'), 'hooks: []\n')
  writeFileSync(join(tempDir, '.env'), '')
  writeFileSync(join(tempDir, '.secrets.local'), '')
  writeFileSync(configPath, CONFIG)

  db = new DashboardDatabase({ dbPath: ':memory:' })
  started = await startServer({
    declaredSecretMask: (text) => text,
    db,
    port: 0,
    configPath,
    workspacePaths: resolveWorkspacePaths({ config: parseYaml(CONFIG), configPath }),
    runService: servicePorts(session),
  })
  const address = started.server.address() as AddressInfo | null
  if (address === null) throw new Error('server did not expose an address')
  return address.port
}

afterEach(async () => {
  started?.close()
  started = undefined
  await new Promise((resolve) => setTimeout(resolve, 0))
  db = undefined
  if (tempDir !== undefined) {
    rmSync(tempDir, { recursive: true, force: true })
    tempDir = undefined
  }
})

interface Attached {
  readonly handle: number | 'firehose'
  readonly seqs: readonly number[]
  readonly status: number
}

/** Attach one SSE reader. The run is over, so the replay ends at `runFinished` and this returns. */
async function attach(port: number, handle: number | 'firehose'): Promise<Attached> {
  const query = handle === 'firehose' ? '' : `?handle=${String(handle)}`
  const response = await fetch(`http://127.0.0.1:${String(port)}/run/${RUN_ID}/events${query}`)
  const body = await response.text()
  return {
    handle,
    status: response.status,
    seqs: [...body.matchAll(/^id: (\d+)$/gmu)].map((match) => Number(match[1])),
  }
}

describe('three SIMULTANEOUS per-handle readers on the shipped server, one concurrent run', () => {
  it('gives each reader its own member plus every run-scoped envelope, and nothing else', async () => {
    const { session, events } = await produceConcurrentRun()
    const port = await mountShippedHost(session)

    // SIMULTANEOUS, not sequential: all three attach before any of them has finished reading, so
    // the stream core is serving three filtered views of the same session at once.
    const [three, seven, eleven, firehose] = await Promise.all([
      attach(port, 3), attach(port, 7), attach(port, 11), attach(port, 'firehose'),
    ])

    const runScoped = events.filter((e) => RUN_EVENT_SCOPE[e.type] === 'run').map((e) => e.seq)
    const memberSeqs = (handle: number): number[] => events
      .filter((e) => RUN_EVENT_SCOPE[e.type] !== 'run' && memberIndexOf(e) === handle)
      .map((e) => e.seq)

    for (const [reader, handle] of [[three, 3], [seven, 7], [eleven, 11]] as const) {
      expect(reader.status).toBe(200)
      expect(reader.seqs).toEqual(
        [...runScoped, ...memberSeqs(handle)].sort((a, b) => a - b),
      )
    }
    // The firehose is the control: it carries every envelope the run published.
    expect(firehose.seqs).toEqual(events.map((event) => event.seq))
    // Non-vacuity — three empty streams would satisfy the disjointness cell below.
    expect(memberSeqs(3).length).toBeGreaterThan(0)
  })

  it('the three readers\' member sets are DISJOINT and their run-scoped sets IDENTICAL', async () => {
    const { session, events } = await produceConcurrentRun()
    const port = await mountShippedHost(session)
    const readers = await Promise.all(HANDLES.map(async (handle) => attach(port, handle)))

    const runScoped = new Set(
      events.filter((event) => RUN_EVENT_SCOPE[event.type] === 'run').map((event) => event.seq),
    )
    const memberSets = readers.map((reader) =>
      new Set(reader.seqs.filter((seq) => !runScoped.has(seq))))

    // Identical run-scoped sets: every handle subscriber learns the run ended.
    for (const reader of readers) {
      expect(reader.seqs.filter((seq) => runScoped.has(seq))).toEqual([...runScoped])
    }
    // Disjoint member sets: no reader sees another member's data.
    for (let i = 0; i < memberSets.length; i += 1) {
      expect(memberSets[i]!.size).toBeGreaterThan(0)
      for (let j = i + 1; j < memberSets.length; j += 1) {
        expect([...memberSets[i]!].filter((seq) => memberSets[j]!.has(seq))).toEqual([])
      }
    }
    // …and the three member sets together are the whole of the run's member-scoped traffic: no
    // envelope was dropped from every reader (the failure mode disjointness alone cannot see).
    const union = new Set(memberSets.flatMap((set) => [...set]))
    const allMemberScoped = events
      .filter((event) => RUN_EVENT_SCOPE[event.type] !== 'run')
      .map((event) => event.seq)
    expect([...union].sort((a, b) => a - b)).toEqual(allMemberScoped.sort((a, b) => a - b))
  })

  it('serves the run\'s OWN roster, and a handle outside it is refused with a typed 400', async () => {
    const { session, events } = await produceConcurrentRun()
    const port = await mountShippedHost(session)

    expect(handleRosterOf(events[0] as RunEventEnvelope)).toEqual([...HANDLES])

    // 0, 1 and 2 are the array positions of the three members. On the shipped door they are not
    // handles at all — which is what makes "the handle IS the testIndex" a wire fact rather than
    // a naming convention.
    for (const outside of [0, 1, 2, 4, 12]) {
      const response = await fetch(
        `http://127.0.0.1:${String(port)}/run/${RUN_ID}/events?handle=${String(outside)}`,
      )
      expect(response.status).toBe(400)
      expect(response.headers.get('content-type')).toContain('application/json')
      expect(await response.json()).toEqual({ error: 'unknown_handle' })
    }
  })

  it('still refuses a cross-site per-handle attach — the filter is below the same-site guard', async () => {
    const { session } = await produceConcurrentRun()
    const port = await mountShippedHost(session)
    const response = await fetch(
      `http://127.0.0.1:${String(port)}/run/${RUN_ID}/events?handle=7`,
      { headers: { Origin: 'https://evil.example' } },
    )
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: 'cross_site_refused' })
  })

  it('attributes every member-scoped envelope the run published to the right owner', async () => {
    // The write side's totality fold, re-asserted on the bytes that actually crossed the socket:
    // whatever a reader received for handle H names member H and no other.
    const { session, events } = await produceConcurrentRun()
    const port = await mountShippedHost(session)
    const bySeq = new Map(events.map((event) => [event.seq, event]))

    let checked = 0
    for (const handle of HANDLES) {
      const reader = await attach(port, handle)
      for (const seq of reader.seqs) {
        const event = bySeq.get(seq)
        expect(event, `seq ${String(seq)} was not published by the run`).toBeDefined()
        if (RUN_EVENT_SCOPE[event!.type] === 'run') continue
        const payload = event!.payload as {
          testId?: unknown
          stepText?: unknown
          hookExecutionId?: unknown
        }
        const owner = typeof payload.testId === 'string'
          ? payload.testId
          : typeof payload.stepText === 'string'
            ? payload.stepText.split(' ')[0]
            : typeof payload.hookExecutionId === 'string'
              ? payload.hookExecutionId.split('-')[1]
              : undefined
        expect(owner, `no owner derivable for seq ${String(seq)}`).toBeDefined()
        expect(OWNER_INDEX[owner as string], `seq ${String(seq)} reached handle ${String(handle)}`)
          .toBe(handle)
        checked += 1
      }
    }
    // Non-vacuity: a filter serving nothing but run-scoped events would check zero envelopes.
    expect(checked).toBe(
      events.filter((event) => RUN_EVENT_SCOPE[event.type] !== 'run').length,
    )
  })
})
