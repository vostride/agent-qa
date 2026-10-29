import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { LEASE_HEARTBEAT_TTL_MS } from '@vostride/agent-qa-knowledge-local'
import { afterAll, describe, expect, test } from 'vitest'

import { DAEMON_EVENTS_FILE } from '../daemon/events.js'
import { DAEMON_REGISTRATION_FILE } from '../daemon/registration.js'
import { fetchDaemonIdentity } from '../daemon/server.js'
import { readJson } from './fencing/spawn-helpers.js'
import {
  LEG_TIMEOUT_MS,
  awaitChildExit,
  cleanupTakeoverRoots,
  killIfRunning,
  makeRoot,
  processStateFromOs,
  startDaemonChild,
  waitForMarker,
} from './socket-takeover/spawn-helpers.js'

const describePosix = process.platform === 'win32' ? describe.skip : describe

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return true
    throw error
  }
}

describePosix('daemon socket takeover past a stopped predecessor', () => {
  afterAll(cleanupTakeoverRoots)

  test(
    'a successor becomes ready while a SIGSTOPped predecessor still owns its own socket',
    async () => {
      const paths = makeRoot('sigstop-successor')
      const predecessor = startDaemonChild('predecessor', paths)
      let successor: ReturnType<typeof startDaemonChild> | undefined

      try {
        await waitForMarker(predecessor, paths.readyMarker.predecessor, 'predecessor readiness')
        const predecessorReady = readJson(paths.readyMarker.predecessor)
        expect(predecessorReady).toMatchObject({
          ready: true,
          generation: 'predecessor',
          pid: predecessor.child.pid,
        })
        const predecessorSocket = predecessorReady.socketPath as string
        expect(existsSync(predecessorSocket)).toBe(true)
        await expect(fetchDaemonIdentity(predecessorSocket)).resolves.toMatchObject({
          instanceId: predecessorReady.instanceId,
          pid: predecessor.child.pid,
        })

        // Stops the whole daemon: only a stopped listener reproduces the stalled-socket schedule.
        expect(predecessor.child.kill('SIGSTOP')).toBe(true)
        await new Promise((resolve) => setTimeout(resolve, 250))
        expect(processStateFromOs(predecessor.child.pid!)).toContain('T')

        await new Promise((resolve) => setTimeout(resolve, LEASE_HEARTBEAT_TTL_MS + 1_500))
        expect(processStateFromOs(predecessor.child.pid!)).toContain('T')

        successor = startDaemonChild('successor', paths)
        await waitForMarker(successor, paths.readyMarker.successor, 'successor readiness')
        const successorReady = readJson(paths.readyMarker.successor)
        expect(successorReady).toMatchObject({
          ready: true,
          generation: 'successor',
          pid: successor.child.pid,
        })
        const successorSocket = successorReady.socketPath as string

        // The whole point: a generation binds an address no other generation ever binds.
        expect(successorSocket).not.toBe(predecessorSocket)
        expect(existsSync(successorSocket)).toBe(true)
        await expect(fetchDaemonIdentity(successorSocket)).resolves.toMatchObject({
          instanceId: successorReady.instanceId,
          pid: successor.child.pid,
        })

        // Readiness was reached WITHOUT the predecessor's cooperation, and without evicting it:
        // no signal was sent, and the process is still stopped exactly where it was left.
        expect(processStateFromOs(predecessor.child.pid!)).toContain('T')
        expect(isAlive(predecessor.child.pid!)).toBe(true)
        expect(predecessor.child.exitCode).toBeNull()
        expect(predecessor.child.signalCode).toBeNull()

        // The predecessor's own address was reclaimed as part of exactly removing its
        // registration — never as a precondition for the successor to listen.
        expect(existsSync(predecessorSocket)).toBe(false)
        const successorEvents = readFileSync(
          join(paths.agentQaRoot, DAEMON_EVENTS_FILE),
          'utf8',
        ).trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
        expect(successorEvents).toContainEqual(expect.objectContaining({
          kind: 'registration-recovered',
          classification: 'unreachable-lease-stale',
          instanceId: predecessorReady.instanceId,
          socketPath: predecessorSocket,
          socketRemoved: true,
        }))

        const successorRegistrationBytes = readFileSync(
          join(paths.agentQaRoot, DAEMON_REGISTRATION_FILE),
        )

        expect(predecessor.child.kill('SIGCONT')).toBe(true)
        const predecessorExit = await awaitChildExit(predecessor)
        expect(predecessorExit.signal).toBeNull()
        const predecessorReport = readJson(paths.report.predecessor)
        expect(predecessorReport).toMatchObject({
          failed: false,
          generation: 'predecessor',
          exitCode: 1,
        })
        const predecessorEvents = predecessorReport.events as Record<string, unknown>[]
        expect(predecessorEvents).toContainEqual(
          expect.objectContaining({ kind: 'lease-lost' }),
        )
        expect(predecessorEvents.at(-1)).toMatchObject({
          kind: 'daemon-stopped',
          exitCode: 1,
        })

        // The resumed predecessor tore down only what it owned.
        expect(readFileSync(join(paths.agentQaRoot, DAEMON_REGISTRATION_FILE)))
          .toEqual(successorRegistrationBytes)
        expect(existsSync(predecessorSocket)).toBe(false)
        expect(existsSync(successorSocket)).toBe(true)
        await expect(fetchDaemonIdentity(successorSocket)).resolves.toMatchObject({
          instanceId: successorReady.instanceId,
          pid: successor.child.pid,
        })

        expect(successor.child.kill('SIGTERM')).toBe(true)
        const successorExit = await awaitChildExit(successor)
        expect(successorExit.signal).toBeNull()
        expect(readJson(paths.report.successor)).toMatchObject({
          failed: false,
          generation: 'successor',
          exitCode: 0,
          errors: [],
        })
        expect(existsSync(join(paths.agentQaRoot, DAEMON_REGISTRATION_FILE))).toBe(false)
        expect(existsSync(successorSocket)).toBe(false)
      } finally {
        await killIfRunning(predecessor.child)
        if (successor !== undefined) await killIfRunning(successor.child)
      }
    },
    LEG_TIMEOUT_MS,
  )
})
