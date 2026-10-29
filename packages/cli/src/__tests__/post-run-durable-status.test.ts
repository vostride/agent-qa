// Chip status is re-read from a second composition; the daemon's drain leaves `events.jsonl`.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { LocalAgentHost } from '@vostride/agent-qa-agent-local'
import { toRunNotificationView } from '@vostride/agent-qa-schema'
import type { RunNotification, RunNotificationView } from '@vostride/agent-qa-schema'
import { afterAll, afterEach, describe, expect, test } from 'vitest'

import { daemonRegistrationPath } from '../daemon/registration.js'
import { FIXTURE_CURATION_COUNTS } from './post-run-daemon/daemon.fixture.js'
import {
  readEventsBytes,
  readNotifications,
  readStatusThroughTheOp,
  runRealTail,
  writeProjectFixture,
} from './post-run-daemon/project.js'
import {
  cleanupPostRunDaemonRoots,
  LEG_TIMEOUT_MS,
  makePostRunDaemonRoot,
  startPostRunDaemon,
  stopAllPostRunDaemons,
  stopDaemonGracefully,
  waitForMarker,
  waitUntil,
} from './post-run-daemon/spawn-helpers.js'

const describePosix = process.platform === 'win32' ? describe.skip : describe
const RUN_ID = 'run-388-06-durable'

const hosts: LocalAgentHost[] = []

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close().catch(() => undefined)
  await stopAllPostRunDaemons()
})

afterAll(cleanupPostRunDaemonRoots)

describePosix('post-processing status survives a closed socket', () => {
  test(
    'answers mid-chain and after the daemon is gone, from durable rows alone, while the run log '
    + 'stays byte-identical across the whole drain',
    async () => {
      const paths = makePostRunDaemonRoot('durable')
      const project = writeProjectFixture(paths.agentQaRoot, RUN_ID)

      const daemon = startPostRunDaemon('first', paths)
      const ready = await waitForMarker(daemon, paths.readyMarker.first, 'the daemon')
      const socketPath = String(ready.socketPath)
      expect(existsSync(socketPath)).toBe(true)

      // Before anything is queued, the honest answer is the all-pending projection — the control
      // that keeps every later reading a fact about a row rather than about an absence.
      expect((await readStatusThroughTheOp(paths.agentQaRoot, paths.knowledgeRoot, RUN_ID)).chips)
        .toEqual({ analysis: 'pending', curation: 'pending' })

      const tail = await runRealTail({
        agentQaRoot: paths.agentQaRoot,
        knowledgeRoot: paths.knowledgeRoot,
        runId: RUN_ID,
        hosts,
      })
      expect(tail.report).toMatchObject({ enqueue: 'enqueued', drain: 'handed-off' })

      // The comparison basis: the finished run's log as the CLI tail left it. The handed-off leg
      // constructs no emitter, so this is still the runner's own three lines.
      const eventsWhenTailReturned = readEventsBytes(project.eventsPath)
      expect(eventsWhenTailReturned).toBe(project.eventsBytes)

      // The close-out line the tail printed says work stays queued, in the chip vocabulary.
      // The curation stage names a later LOCAL run, not this daemon: the production daemon
      // declares the unmasked posture and cannot claim `curate-memory` at all. THIS test's
      // daemon fixture deliberately declares `masker-active` so the daemon-side fold below is
      // reachable, so it does drain curation moments later — but the line the CLI prints
      // states the shipped contract, which the production-posture pin in
      // `post-run-daemon-chain.test.ts` is what holds in place.
      expect(tail.info).toEqual([
        'post-processing — analysis: pending (daemon will drain) · curation: pending'
        + ' (deferred to a later local run)'
        // The handed-off tail completed no analyze-run, so the exit line carries the fetch command.
        + ` · digest: agent-qa digest "${RUN_ID}"`,
      ])
      expect(tail.warn).toEqual([])

      // ---- mid-chain, over the daemon's shoulder ----------------------------------------------
      await waitForMarker(
        daemon,
        paths.enteredMarker.first,
        'the daemon-side curation fold to be entered',
      )
      const midChain = await readStatusThroughTheOp(
        paths.agentQaRoot,
        paths.knowledgeRoot,
        RUN_ID,
      )
      // Analysis is durably terminal; curation is durably claimed by a live host. Two different
      // words, from two different rows, in one read.
      expect(midChain.chips).toEqual({
        analysis: 'complete',
        curation: 'running',
      })
      expect('notification' in midChain).toBe(false)

      // ---- the daemon finishes, and then stops existing ----------------------------------------
      const { writeFileSync } = await import('node:fs')
      writeFileSync(paths.gate, 'open\n', 'utf8')
      await waitUntil(
        async () => (await readNotifications(paths.agentQaRoot, paths.knowledgeRoot)).length > 0,
        `the daemon never finished the chain:\n${daemon.output()}`,
      )
      const exitCode = await stopDaemonGracefully(daemon)
      expect(exitCode).toBe(0)
      // There is now no socket to ask and no registration to find it by. Any answer from here on
      // came out of durable state or out of nowhere.
      expect(existsSync(socketPath)).toBe(false)
      expect(existsSync(daemonRegistrationPath(paths.agentQaRoot))).toBe(false)

      const afterExit = await readStatusThroughTheOp(
        paths.agentQaRoot,
        paths.knowledgeRoot,
        RUN_ID,
      )
      expect(afterExit.chips).toEqual({
        analysis: 'complete',
        curation: 'complete',
      })
      // Compared whole with the record the terminal transaction wrote; a made-up one fails.
      const rows = await readNotifications(paths.agentQaRoot, paths.knowledgeRoot)
      expect(rows).toHaveLength(1)
      expect(afterExit.notification).toEqual(toRunNotificationView(rows[0]!.payload as RunNotification))
      expect((rows[0]!.payload as RunNotification).outcome).toBe('done')
      expect(afterExit.notification as RunNotificationView).toMatchObject({
        runId: RUN_ID,
        outcome: 'complete',
        stages: {
          curation: {
            status: 'complete',
            curated: FIXTURE_CURATION_COUNTS.curated,
            deprecated: FIXTURE_CURATION_COUNTS.deprecated,
          },
        },
      })

      // Whole-file equality across the daemon's entire life between the reads.
      expect(readEventsBytes(project.eventsPath)).toBe(eventsWhenTailReturned)
    },
    LEG_TIMEOUT_MS,
  )
})

describe('the one construction site that makes the daemon silent', () => {
  test('the chip emitter is built once, inside the acquired-lease branch, and nowhere else', () => {
    const tail = readFileSync(new URL('../curation/post-run-tail.ts', import.meta.url), 'utf8')
    // One construction site in the whole product, and it is downstream of both early returns —
    // the handed-off nudge and the refusal — so a daemon-served chain cannot reach it.
    expect(tail.match(/createChipEmitter\(/gu) ?? []).toHaveLength(1)
    const handedOff = tail.indexOf("drainOutcome = 'handed-off'")
    const refused = tail.indexOf("drainOutcome = 'refused'")
    const construction = tail.indexOf('createChipEmitter({')
    expect(handedOff).toBeGreaterThan(0)
    expect(refused).toBeGreaterThan(0)
    expect(construction).toBeGreaterThan(refused)
    expect(construction).toBeGreaterThan(handedOff)

    // …and the daemon host names no emitter at all: its silence is an absence, not a guard.
    const daemonHost = readFileSync(new URL('../daemon/host.ts', import.meta.url), 'utf8')
    expect(daemonHost).not.toMatch(/ChipEmitter|post-run-chip-emitter/u)
  })

  test('the reading composition is powerless to ask another process anything', () => {
    const source = readFileSync(
      new URL('./post-run-daemon/project.ts', import.meta.url),
      'utf8',
    )
    // Scoped to `openProjectHost`, because `runRealTail` in the module uses the real nudge.
    const start = source.indexOf('export function openProjectHost(')
    expect(start).toBeGreaterThan(0)
    const body = source.slice(start, source.indexOf('\n}\n', start))
    for (const forbidden of [
      'applyDelegate',
      'nudgeDaemon',
      'socketPath',
      'daemon/client',
      'runExecution',
    ]) {
      expect(body, `the reading host must not name ${forbidden}`).not.toContain(forbidden)
    }
    // And the read itself goes through the op constant, never a literal and never a store.
    const reader = source.slice(
      source.indexOf('export async function readStatusThroughTheOp('),
      source.indexOf('export interface JobRowView'),
    )
    expect(reader).toContain('RUNS_POST_PROCESSING_FUNCTION_ID')
    expect(reader).not.toMatch(/sqlite|agent-jobs\.db|runs\.postprocessing/u)
  })
})
