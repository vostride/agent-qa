// SC4's closed-socket half, and the 386 D-16 two-receipt rule (Phase 388 plan 06).
//
// Two claims, measured against the same real daemon generation:
//
//   1. A USER WHO EXITS AND RE-QUERIES SEES THE TRUTH. Chip status is read through the one op
//      (`runs.postprocessing`) from a SECOND composition over the same project root — mid-chain
//      while the daemon is still working, and again after the daemon has been stopped and its
//      socket is gone. Nothing is asked of another process in either read; nothing could be.
//   2. THE DAEMON NEVER WRITES A FINISHED RUN'S LOG. `events.jsonl` is snapshotted the moment the
//      CLI tail returns and compared whole after the daemon's ENTIRE drain — claim, analysis,
//      chain, curation, chain terminal, shutdown — has completed.
//
// The second claim's honesty rests on where `createChipEmitter(` sits: it is constructed once in
// the product, inside `post-run-tail.ts`'s acquired-lease branch, which is the one branch a
// handed-off run never reaches and a daemon never runs at all. That is asserted here too, because
// a byte comparison over a file nothing was ever going to touch is a comparison over nothing —
// see the differential recorded in the plan summary, which puts an emitter on the daemon's own
// curation binding and turns this file red.

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
        // 391 D-17: the handed-off tail completed no analyze-run in-process, so the exit line
        // carries the pending-proposal count and the exact fetch command for the digest the
        // daemon's chain will fill in. Nothing is waiting on a human in this fixture, and the
        // line says `0 pending` rather than omitting the clause — the count is READ, so its
        // absence would mean the digest could not be composed.
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
      // The attached record is the view of the SAME record the terminal transaction wrote,
      // compared whole: a projection that assembled a plausible notification of its own would
      // fail here. The stored row keeps its own words (444 D-36).
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

      // ---- 386 D-16: no second process wrote this run's log -------------------------------------
      // Whole-file equality, across the daemon's entire life: claim, analysis, chain, curation,
      // chain terminal and shutdown all happened between the two reads.
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
    // Scoped to `openProjectHost`'s own body rather than to the module. The module ALSO holds
    // `runRealTail`, which uses the real `nudgeDaemon` on purpose — a scan over the whole file
    // would be reading the tail's powers as the reader's. (And the scan is over CODE: this file
    // explains in prose what it does not do, and prose is what the 388-02/388-03 extractor
    // hazard reads as a specifier.)
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
