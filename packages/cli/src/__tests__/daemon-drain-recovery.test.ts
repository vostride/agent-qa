import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  LEASE_FILE,
  LEASE_HEARTBEAT_TTL_MS,
} from '@vostride/agent-qa-knowledge-local'
import { afterAll, afterEach, describe, expect, test, vi } from 'vitest'

import { appendDrainSessionReceipt, readDrainSessionReceipts } from '../daemon/drain-receipts.js'
import {
  DAEMON_REGISTRATION_SCHEMA_VERSION,
  daemonRegistrationPath,
  writeDaemonRegistration,
  type RemoveRegistrationOutcome,
} from '../daemon/registration.js'
import { DAEMON_IDENTITY_SCHEMA_VERSION, startInvokeServer } from '../daemon/server.js'
import {
  enqueueRealCandidate,
  invokeDrain,
  writeWorkspaceConfig,
} from './drain-recovery/fixtures.js'
import { readJson } from './fencing/spawn-helpers.js'
import {
  cleanupTakeoverRoots,
  killIfRunning,
  makeRoot,
  processStateFromOs,
  startDaemonChild,
  waitForMarker,
} from './socket-takeover/spawn-helpers.js'

// The contended removal is microseconds wide, so the removal is doubled and the rest stays real.
let nextRemovalOverride: (() => RemoveRegistrationOutcome) | undefined

vi.mock('../daemon/registration.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../daemon/registration.js')>()
  const takeOverride = (): RemoveRegistrationOutcome | undefined => {
    const override = nextRemovalOverride
    nextRemovalOverride = undefined
    return override?.()
  }
  return {
    ...actual,
    removeRegistrationIfOwned: (
      ...args: Parameters<typeof actual.removeRegistrationIfOwned>
    ): RemoveRegistrationOutcome => takeOverride() ?? actual.removeRegistrationIfOwned(...args),
  }
})

const describePosix = process.platform === 'win32' ? describe.skip : describe

// Room for a real TTL plus a two-minute daemon wait, so a slow recovery fails by assertion.
const RECOVERY_LEG_TIMEOUT_MS = 300_000

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

/**
 * Bind a listener that accepts and never answers, at an address short enough to bind.
 *
 * A per-project socket under a `mkdtemp` root plus this suite's own label overruns darwin's
 * 104-byte `sun_path` budget, so the wedged-daemon address gets its own shallow directory.
 */
function bindUnansweringSocket(
  accepted: Socket[],
): { socketPath: string; server: Server; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'aq-wedge-'))
  // Accept and never answer. The accepted connections are held so cleanup can destroy them;
  // net.Server has no closeAllConnections, so close() alone would wait on them forever.
  const server = createServer((socket) => { accepted.push(socket) })
  return { dir, socketPath: join(dir, 'd.sock'), server }
}

function readEpoch(knowledgeRoot: string): number {
  return Number(readFileSync(join(knowledgeRoot, '.epoch'), 'utf8').trim())
}

function plantLease(
  knowledgeRoot: string,
  lease: { leaseId: string; pid: number; epoch: number; heartbeatAtMs: number },
): void {
  mkdirSync(knowledgeRoot, { recursive: true })
  writeFileSync(join(knowledgeRoot, '.epoch'), `${lease.epoch}\n`, 'utf8')
  writeFileSync(join(knowledgeRoot, LEASE_FILE), `${JSON.stringify(lease)}\n`, 'utf8')
}

describePosix('knowledge drain recovery across unreachable daemon hosts', () => {
  const surrogates: ChildProcess[] = []
  const servers: Server[] = []
  const socketDirs: string[] = []
  const acceptedSockets: Socket[] = []

  afterEach(async () => {
    for (const surrogate of surrogates.splice(0)) {
      if (surrogate.exitCode === null && surrogate.signalCode === null) {
        const exited = once(surrogate, 'exit')
        surrogate.kill('SIGKILL')
        await exited
      }
    }
    for (const socket of acceptedSockets.splice(0)) socket.destroy()
    for (const server of servers.splice(0)) {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
    for (const dir of socketDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  afterAll(cleanupTakeoverRoots)

  test(
    'drains through the inline successor when the registered daemon is SIGSTOPped past the lease TTL',
    async () => {
      const paths = makeRoot('sigstop')
      const configPath = writeWorkspaceConfig(paths.root)
      const daemon = startDaemonChild('predecessor', paths)

      try {
        await waitForMarker(daemon, paths.readyMarker.predecessor, 'daemon readiness')
        const ready = readJson(paths.readyMarker.predecessor)
        expect(ready).toMatchObject({ ready: true, pid: daemon.child.pid })
        const daemonPid = daemon.child.pid!
        const daemonInstanceId = ready.instanceId as string
        const epochUnderDaemon = readEpoch(paths.knowledgeRoot)

        // Stop the whole host before any work arrives, so the queued candidate is only ever
        // drainable by whoever recovers the registration.
        expect(daemon.child.kill('SIGSTOP')).toBe(true)
        await new Promise((resolve) => setTimeout(resolve, 250))
        expect(processStateFromOs(daemonPid)).toContain('T')

        const candidateId = enqueueRealCandidate(paths.knowledgeRoot, 'sigstop-remainder')
        await new Promise((resolve) => setTimeout(resolve, LEASE_HEARTBEAT_TTL_MS + 1_500))
        expect(processStateFromOs(daemonPid)).toContain('T')

        const result = await invokeDrain(configPath)

        // The command completed the work itself rather than reporting an unreachable daemon.
        expect(result.stderr).toBe('')
        expect(result.exitCode).toBeUndefined()
        expect(result.stdout).toContain('Knowledge curation queue drained inline')
        expect(result.stdout).toContain('remaining 0')

        // Exactly the classified generation was removed, and the lease was arbitrated inline.
        expect(existsSync(daemonRegistrationPath(paths.agentQaRoot))).toBe(false)
        expect(daemonInstanceId).toMatch(/^[0-9a-f-]{36}$/)
        expect(readEpoch(paths.knowledgeRoot)).toBeGreaterThan(epochUnderDaemon)

        // The receipt chain names the inline session that actually did the work.
        expect(readDrainSessionReceipts(paths.agentQaRoot)).toEqual([
          expect.objectContaining({
            holderPid: process.pid,
            candidateIds: [candidateId],
            remainingAfter: 0,
            outcome: 'completed',
            failures: 0,
            quarantined: 0,
          }),
        ])

        // Recovery cost the stopped host nothing: it is still exactly where it was left.
        expect(processStateFromOs(daemonPid)).toContain('T')
        expect(isAlive(daemonPid)).toBe(true)
        expect(daemon.child.exitCode).toBeNull()
        expect(daemon.child.signalCode).toBeNull()
      } finally {
        await killIfRunning(daemon.child)
      }
    },
    RECOVERY_LEG_TIMEOUT_MS,
  )

  test(
    'drains inline through a reused-pid registration and never signals the unrelated occupant',
    async () => {
      const paths = makeRoot('reused')
      const configPath = writeWorkspaceConfig(paths.root)
      mkdirSync(paths.agentQaRoot, { recursive: true })

      // An unrelated process that inherited the dead daemon's pid. It never touches the queue,
      // the lease, or the socket — it merely occupies the number the registration records.
      const surrogate = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], {
        stdio: ['ignore', 'ignore', 'ignore'],
      })
      surrogates.push(surrogate)
      await new Promise((resolve) => setTimeout(resolve, 150))
      const surrogatePid = surrogate.pid!
      expect(isAlive(surrogatePid)).toBe(true)

      const instanceId = randomUUID()
      writeDaemonRegistration(paths.agentQaRoot, {
        schemaVersion: DAEMON_REGISTRATION_SCHEMA_VERSION,
        instanceId,
        pid: surrogatePid,
        // The dead generation's address; nothing listens there any more.
        socketPath: join(paths.agentQaRoot, `daemon-${instanceId.slice(0, 12)}.sock`),
        startedAtMs: Date.now() - 600_000,
      })
      plantLease(paths.knowledgeRoot, {
        leaseId: randomUUID(),
        pid: surrogatePid,
        epoch: 4,
        heartbeatAtMs: Date.now() - (LEASE_HEARTBEAT_TTL_MS * 4),
      })
      const candidateId = enqueueRealCandidate(paths.knowledgeRoot, 'reused-pid-remainder')

      const result = await invokeDrain(configPath)

      expect(result.stderr).toBe('')
      expect(result.exitCode).toBeUndefined()
      expect(result.stdout).toContain('Knowledge curation queue drained inline')
      expect(result.stdout).toContain('remaining 0')
      expect(existsSync(daemonRegistrationPath(paths.agentQaRoot))).toBe(false)
      expect(readEpoch(paths.knowledgeRoot)).toBe(5)
      expect(readDrainSessionReceipts(paths.agentQaRoot)).toEqual([
        expect.objectContaining({
          holderPid: process.pid,
          epoch: 5,
          candidateIds: [candidateId],
          remainingAfter: 0,
          outcome: 'completed',
        }),
      ])

      // The occupant of the recorded pid was never a target.
      expect(isAlive(surrogatePid)).toBe(true)
      expect(surrogate.exitCode).toBeNull()
      expect(surrogate.signalCode).toBeNull()
    },
    RECOVERY_LEG_TIMEOUT_MS,
  )

  test(
    'refuses to recover a daemon whose writer lease is fresh and names the holder instead',
    async () => {
      const paths = makeRoot('fresh')
      const configPath = writeWorkspaceConfig(paths.root)
      mkdirSync(paths.agentQaRoot, { recursive: true })

      // A daemon inside a long governed mutation: its socket accepts the connection but its
      // blocked loop never answers the identity handshake. Its beat is independent of that work,
      // so the lease it publishes stays current and the registration is not recoverable.
      const { dir, socketPath, server } = bindUnansweringSocket(acceptedSockets)
      socketDirs.push(dir)
      servers.push(server)
      await new Promise<void>((resolve) => server.listen(socketPath, resolve))

      const leaseId = randomUUID()
      const holderPid = process.pid
      plantLease(paths.knowledgeRoot, {
        leaseId,
        pid: holderPid,
        epoch: 9,
        heartbeatAtMs: Date.now(),
      })
      writeDaemonRegistration(paths.agentQaRoot, {
        schemaVersion: DAEMON_REGISTRATION_SCHEMA_VERSION,
        instanceId: randomUUID(),
        pid: holderPid,
        socketPath,
        startedAtMs: Date.now() - 60_000,
      })
      enqueueRealCandidate(paths.knowledgeRoot, 'fresh-holder-remainder')
      const registrationBefore = readFileSync(daemonRegistrationPath(paths.agentQaRoot))
      const leaseBefore = readFileSync(join(paths.knowledgeRoot, LEASE_FILE))

      const result = await invokeDrain(configPath)

      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('writer-lease-held')
      expect(result.stderr).toContain(`pid ${holderPid}`)
      expect(result.stderr).toContain(leaseId)

      // Nothing was stolen, removed, or drained.
      expect(readFileSync(daemonRegistrationPath(paths.agentQaRoot))).toEqual(registrationBefore)
      expect(readFileSync(join(paths.knowledgeRoot, LEASE_FILE))).toEqual(leaseBefore)
      expect(readEpoch(paths.knowledgeRoot)).toBe(9)
      expect(readDrainSessionReceipts(paths.agentQaRoot)).toEqual([])
    },
    RECOVERY_LEG_TIMEOUT_MS,
  )

  test(
    'still recovers when the writer lease has aged past the heartbeat TTL',
    async () => {
      const paths = makeRoot('aged-lease')
      const configPath = writeWorkspaceConfig(paths.root)
      mkdirSync(paths.agentQaRoot, { recursive: true })

      const { dir, socketPath, server } = bindUnansweringSocket(acceptedSockets)
      socketDirs.push(dir)
      servers.push(server)
      await new Promise<void>((resolve) => server.listen(socketPath, resolve))

      plantLease(paths.knowledgeRoot, {
        leaseId: randomUUID(),
        pid: process.pid,
        epoch: 2,
        heartbeatAtMs: Date.now() - (LEASE_HEARTBEAT_TTL_MS * 2),
      })
      // Drawn from OUTSIDE the freshness precondition: the accepting control for the leg above,
      // differing only in the one fact that makes the holder recoverable.
      writeDaemonRegistration(paths.agentQaRoot, {
        schemaVersion: DAEMON_REGISTRATION_SCHEMA_VERSION,
        instanceId: randomUUID(),
        pid: process.pid,
        socketPath,
        startedAtMs: Date.now() - 60_000,
      })
      enqueueRealCandidate(paths.knowledgeRoot, 'aged-lease-remainder')

      const result = await invokeDrain(configPath)

      expect(result.stderr).toBe('')
      expect(result.exitCode).toBeUndefined()
      expect(result.stdout).toContain('Knowledge curation queue drained inline')
      expect(result.stdout).toContain('remaining 0')
      expect(existsSync(daemonRegistrationPath(paths.agentQaRoot))).toBe(false)
      expect(readEpoch(paths.knowledgeRoot)).toBe(3)
    },
    RECOVERY_LEG_TIMEOUT_MS,
  )
})

// Parked registration bytes are read by nothing, so every drain exit must name them.
describePosix('stranded quarantine evidence on every drain exit', () => {
  const servers: Server[] = []
  const socketDirs: string[] = []
  const acceptedSockets: Socket[] = []

  afterEach(async () => {
    nextRemovalOverride = undefined
    // net.Server has no closeAllConnections, so an unanswered accept would hang close() forever.
    for (const socket of acceptedSockets.splice(0)) socket.destroy()
    for (const server of servers.splice(0)) {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
    for (const dir of socketDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  afterAll(cleanupTakeoverRoots)

  /** A quarantine file with the exact name and bytes a real contended removal would leave. */
  function plantQuarantine(agentQaRoot: string, tag: string): string {
    const quarantinePath = `${daemonRegistrationPath(agentQaRoot)}.remove-${tag}-${randomUUID()}`
    writeFileSync(quarantinePath, '{"schemaVersion":2}\n', 'utf8')
    return quarantinePath
  }

  function plantStaleRegistration(paths: { agentQaRoot: string }, socketPath: string): string {
    const instanceId = randomUUID()
    mkdirSync(paths.agentQaRoot, { recursive: true })
    writeDaemonRegistration(paths.agentQaRoot, {
      schemaVersion: DAEMON_REGISTRATION_SCHEMA_VERSION,
      instanceId,
      pid: process.pid,
      socketPath,
      startedAtMs: Date.now() - 600_000,
    })
    return instanceId
  }

  test(
    'names the quarantine path on the inline-drain exit',
    async () => {
      const paths = makeRoot('wr03-inline')
      const configPath = writeWorkspaceConfig(paths.root)
      plantStaleRegistration(paths, join(paths.agentQaRoot, 'daemon.sock'))
      plantLease(paths.knowledgeRoot, {
        leaseId: randomUUID(),
        pid: process.pid,
        epoch: 2,
        heartbeatAtMs: Date.now() - (LEASE_HEARTBEAT_TTL_MS * 4),
      })
      enqueueRealCandidate(paths.knowledgeRoot, 'wr03-inline-remainder')
      const quarantinePath = plantQuarantine(paths.agentQaRoot, 'inline')
      nextRemovalOverride = () => ({
        kind: 'changed-under-removal',
        registrationPath: daemonRegistrationPath(paths.agentQaRoot),
        quarantinePath,
      })

      const result = await invokeDrain(configPath, ['--json'])

      // The exit itself is unchanged — the drain still ran inline and still finished the work.
      const summary = JSON.parse(result.stdout) as {
        quarantinedRegistrations?: string[]
        quarantined: number
        remaining: number
      }
      expect(summary.remaining).toBe(0)
      // The report's own candidate count keeps its key; the registration evidence has its own.
      expect(summary.quarantined).toBe(0)
      expect(summary.quarantinedRegistrations).toEqual([quarantinePath])
      expect(result.stderr).toContain(quarantinePath)
      expect(existsSync(quarantinePath)).toBe(true)
    },
    RECOVERY_LEG_TIMEOUT_MS,
  )

  test(
    'names the quarantine path on the writer-lease-held refusal exit',
    async () => {
      const paths = makeRoot('wr03-refuse')
      const configPath = writeWorkspaceConfig(paths.root)
      const { dir, socketPath, server } = bindUnansweringSocket(acceptedSockets)
      socketDirs.push(dir)
      servers.push(server)
      await new Promise<void>((resolve) => server.listen(socketPath, resolve))

      plantStaleRegistration(paths, socketPath)
      const leaseId = randomUUID()
      plantLease(paths.knowledgeRoot, {
        leaseId,
        pid: process.pid,
        epoch: 3,
        heartbeatAtMs: Date.now() - (LEASE_HEARTBEAT_TTL_MS * 4),
      })
      enqueueRealCandidate(paths.knowledgeRoot, 'wr03-refuse-remainder')
      const quarantinePath = plantQuarantine(paths.agentQaRoot, 'refuse')
      // The holder came back between the two classifications — the shape that makes the second
      // look refuse rather than recover, with the first attempt's bytes already parked.
      nextRemovalOverride = () => {
        plantLease(paths.knowledgeRoot, {
          leaseId,
          pid: process.pid,
          epoch: 3,
          heartbeatAtMs: Date.now(),
        })
        return {
          kind: 'changed-under-removal',
          registrationPath: daemonRegistrationPath(paths.agentQaRoot),
          quarantinePath,
        }
      }

      const result = await invokeDrain(configPath, ['--json'])

      expect(result.exitCode).toBe(1)
      const summary = JSON.parse(result.stdout) as {
        reason: string
        quarantinedRegistrations?: string[]
      }
      expect(summary.reason).toBe('writer-lease-held')
      expect(summary.quarantinedRegistrations).toEqual([quarantinePath])
      expect(result.stderr).toContain('writer-lease-held')
      expect(result.stderr).toContain(quarantinePath)
    },
    RECOVERY_LEG_TIMEOUT_MS,
  )

  test(
    'names the quarantine path on the live-confirmed delegate exit',
    async () => {
      const paths = makeRoot('wr03-delegate')
      const configPath = writeWorkspaceConfig(paths.root)
      const dir = mkdtempSync(join(tmpdir(), 'aq-w3d-'))
      socketDirs.push(dir)
      const successorSocket = join(dir, 'd.sock')
      const successorInstanceId = randomUUID()
      let nudged = 0
      // A successor daemon that really answers the identity handshake and really receipts a drain
      // session. `drainViaDaemon` is the shipped delegate path; nothing about it is stubbed.
      const successor = await startInvokeServer({
        socketPath: successorSocket,
        registry: {} as never,
        identity: {
          schemaVersion: DAEMON_IDENTITY_SCHEMA_VERSION,
          instanceId: successorInstanceId,
          pid: process.pid,
        },
        onNudge: () => {
          nudged += 1
          const sessionId = randomUUID()
          appendDrainSessionReceipt(paths.agentQaRoot, {
            ts: new Date().toISOString(),
            sessionId,
            holderPid: process.pid,
            epoch: 2,
            candidateIds: [],
            remainingAfter: 0,
            outcome: 'completed',
            failures: 0,
            quarantined: 0,
          })
          return { sessionId }
        },
      })

      try {
        plantStaleRegistration(paths, join(paths.agentQaRoot, 'daemon.sock'))
        plantLease(paths.knowledgeRoot, {
          leaseId: randomUUID(),
          pid: process.pid,
          epoch: 2,
          heartbeatAtMs: Date.now() - (LEASE_HEARTBEAT_TTL_MS * 4),
        })
        const quarantinePath = plantQuarantine(paths.agentQaRoot, 'delegate')
        // The removal is contended because a successor published in the window — so it publishes
        // one, and the second classification finds a daemon that answers for itself.
        nextRemovalOverride = () => {
          writeDaemonRegistration(paths.agentQaRoot, {
            schemaVersion: DAEMON_REGISTRATION_SCHEMA_VERSION,
            instanceId: successorInstanceId,
            pid: process.pid,
            socketPath: successorSocket,
            startedAtMs: Date.now(),
          })
          return {
            kind: 'changed-under-removal',
            registrationPath: daemonRegistrationPath(paths.agentQaRoot),
            quarantinePath,
          }
        }

        const result = await invokeDrain(configPath, ['--json'])

        expect(nudged).toBe(1)
        const summary = JSON.parse(result.stdout) as {
          mode: string
          quarantinedRegistrations?: string[]
        }
        expect(summary.mode).toBe('daemon')
        expect(summary.quarantinedRegistrations).toEqual([quarantinePath])
        expect(result.stderr).toContain(quarantinePath)
        expect(existsSync(quarantinePath)).toBe(true)
      } finally {
        await successor.close()
      }
    },
    RECOVERY_LEG_TIMEOUT_MS,
  )
})
