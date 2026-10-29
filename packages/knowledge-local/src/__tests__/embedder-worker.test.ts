import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { STATIC_FLOOR_EMBEDDING_PROFILE } from '@vostride/agent-qa-schema'
import { build } from 'tsup'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import {
  discoverEmbedderWorker,
  resetEmbedderCapability,
  resolveEmbedderCapability,
} from '../embedder-acquire.js'
import { createFloorEmbedder } from '../embedder-floor.js'
import {
  resolveProcessIncarnation,
  verifyEmbedderWorkerIncarnation,
} from '../embedder-worker/worker-incarnation.js'
import { incarnationFormat } from '../lease/writer-lease.js'
import {
  EMBEDDER_WORKER_PROTOCOL_SCHEMA_VERSION,
  EMBEDDER_WORKER_REQUEST_TIMEOUT_MS,
  EMBEDDER_WORKER_SOCKET_PATH_BUDGET_BYTES,
  EMBEDDER_WORKER_START_TIMEOUT_MS,
  EMBEDDER_WORKER_TERM_GRACE_MS,
  EMBEDDER_WORKER_REGISTRATION_SCHEMA_VERSION,
  EMBEDDER_WORKER_UNVERIFIABLE_INCARNATION,
  EmbedderWorkerTimeoutError,
  createEmbedderWorkerPort,
  embedderWorkerAgentQaRoot,
  embedderWorkerRegistrationPath,
  embedderWorkerSocketPath,
  readEmbedderWorkerRegistration,
  removeEmbedderWorkerRegistration,
  writeEmbedderWorkerRegistration,
  type EmbedderWorkerRegistration,
} from '../embedder-worker/worker-registration.js'
import {
  runEmbedderWorker,
  type EmbedderWorkerHandle,
} from '../embedder-worker/worker-entry.js'

const packageRoot = fileURLToPath(new URL('../..', import.meta.url))
const roots: string[] = []
const children: ChildProcess[] = []
const originalCwd = process.cwd()
let workerEntryPath = ''
let workerBuildRoot = ''

function temporaryProject(label: string): string {
  const base = process.platform === 'win32' ? tmpdir() : '/tmp'
  const root = mkdtempSync(join(base, `agent-qa-embedder-worker-${label}-`))
  roots.push(root)
  return root
}

async function eventually(
  predicate: () => boolean,
  message: string | (() => string),
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(typeof message === 'function' ? message() : message)
}

function registration(
  projectRoot: string,
  overrides: Partial<{
    instanceId: string
    pid: number
    socketPath: string
  }> = {},
): void {
  const agentQaRoot = join(projectRoot, '.agent-qa')
  const instanceId = overrides.instanceId ?? '00000000-0000-4000-8000-000000000100'
  const pid = overrides.pid ?? process.pid
  writeEmbedderWorkerRegistration(agentQaRoot, {
    schemaVersion: EMBEDDER_WORKER_REGISTRATION_SCHEMA_VERSION,
    instanceId,
    pid,
    socketPath:
      overrides.socketPath ?? embedderWorkerSocketPath(agentQaRoot, projectRoot, instanceId),
    profile: STATIC_FLOOR_EMBEDDING_PROFILE,
    startedAtMs: Date.now(),
    incarnation: resolveProcessIncarnation(pid) ?? EMBEDDER_WORKER_UNVERIFIABLE_INCARNATION,
  })
}

/**
 * The pid's start time read straight from the kernel, never through the module under test.
 *
 * Prior-round law: an identity assertion phrased in the code's own vocabulary only proves the code
 * agrees with itself. The recorded token stays free to carry whatever opaque prefix it likes; it is
 * not free to carry a start time the OS never reported.
 */
function kernelStartTimeFact(pid: number): string {
  if (process.platform === 'linux') {
    const raw = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const afterComm = raw.slice(raw.lastIndexOf(')') + 1).trim().split(/\s+/)
    const startTime = afterComm[19]
    if (startTime === undefined) throw new Error(`Could not read starttime for pid ${pid}`)
    return startTime
  }
  return execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], {
    encoding: 'utf8',
    env: { LC_ALL: 'C', LANG: 'C', TZ: 'UTC0' },
  }).trim()
}

function rawWorkerRequest(socketPath: string, body: unknown): Promise<unknown> {
  const payload = JSON.stringify(body)
  return new Promise((resolveRequest, rejectRequest) => {
    const workerRequest = request(
      {
        socketPath,
        path: '/embed',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        },
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer | string) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        })
        response.on('end', () => {
          try {
            resolveRequest(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown)
          } catch (error) {
            rejectRequest(error)
          }
        })
      },
    )
    workerRequest.once('error', rejectRequest)
    workerRequest.end(payload)
  })
}

beforeAll(async () => {
  workerBuildRoot = mkdtempSync(join(packageRoot, '.embedder-worker-test-build-'))
  await build({
    entry: {
      'embedder-worker/worker-entry': join(
        packageRoot,
        'src/embedder-worker/worker-entry.ts',
      ),
    },
    outDir: workerBuildRoot,
    format: ['esm'],
    dts: false,
    clean: true,
    sourcemap: false,
    target: 'node24',
    platform: 'node',
    splitting: false,
    silent: true,
  })
  workerEntryPath = join(workerBuildRoot, 'embedder-worker', 'worker-entry.js')
})

afterEach(async () => {
  process.chdir(originalCwd)
  resetEmbedderCapability()

  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    if (child.exitCode === null && child.signalCode === null) await once(child, 'exit')
  }
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true })
})

afterAll(() => {
  if (workerBuildRoot !== '') rmSync(workerBuildRoot, { force: true, recursive: true })
})

describe.sequential('embedder worker discovery', () => {
  it('pins every worker wait deadline in code rather than configuration', () => {
    expect({
      request: EMBEDDER_WORKER_REQUEST_TIMEOUT_MS,
      start: EMBEDDER_WORKER_START_TIMEOUT_MS,
      terminate: EMBEDDER_WORKER_TERM_GRACE_MS,
    }).toEqual({ request: 30_000, start: 15_000, terminate: 5_000 })
  })

  it('returns no-worker when registration is absent', async () => {
    const projectRoot = temporaryProject('absent')
    const agentQaRoot = join(projectRoot, '.agent-qa')
    process.chdir(projectRoot)

    await expect(discoverEmbedderWorker(agentQaRoot)).resolves.toEqual({ kind: 'no-worker' })
  })

  it('round-trips the current identity and reads every older registration shape as malformed', () => {
    const projectRoot = temporaryProject('registration-current')
    const agentQaRoot = embedderWorkerAgentQaRoot(projectRoot)
    const registrationPath = embedderWorkerRegistrationPath(agentQaRoot)
    const instanceId = '00000000-0000-4000-8000-000000000101'
    const socketPath = (embedderWorkerSocketPath as (
      root: string,
      project: string,
      instance: string,
    ) => string)(agentQaRoot, projectRoot, instanceId)
    const expected: EmbedderWorkerRegistration = {
      schemaVersion: EMBEDDER_WORKER_REGISTRATION_SCHEMA_VERSION,
      instanceId,
      pid: process.pid,
      socketPath,
      profile: STATIC_FLOOR_EMBEDDING_PROFILE,
      startedAtMs: Date.now(),
      incarnation: resolveProcessIncarnation(process.pid)
        ?? EMBEDDER_WORKER_UNVERIFIABLE_INCARNATION,
    }

    expect(EMBEDDER_WORKER_REGISTRATION_SCHEMA_VERSION).toBe(2)
    writeEmbedderWorkerRegistration(agentQaRoot, expected)
    expect(readEmbedderWorkerRegistration(agentQaRoot)).toEqual({
      kind: 'parsed',
      registration: expected,
    })

    // The incarnation is what every signal decision depends on, so a file without it is not a
    // registration at all.
    const { incarnation: _omitted, ...withoutIncarnation } = expected
    writeFileSync(registrationPath, `${JSON.stringify(withoutIncarnation)}\n`)
    expect(readEmbedderWorkerRegistration(agentQaRoot)).toEqual({ kind: 'malformed' })
  })

  it.each([
    {
      shape: 'no instanceId and no incarnation, stamped 1',
      planted: {
        schemaVersion: 1,
        pid: process.pid,
        socketPath: '/tmp/agent-qa-embedder-older.sock',
        profile: STATIC_FLOOR_EMBEDDING_PROFILE,
        startedAtMs: 101,
      },
    },
    {
      shape: 'an instanceId and no incarnation, stamped 2',
      planted: {
        schemaVersion: 2,
        instanceId: '00000000-0000-4000-8000-000000000102',
        pid: process.pid,
        socketPath: '/tmp/agent-qa-embedder-older.sock',
        profile: STATIC_FLOOR_EMBEDDING_PROFILE,
        startedAtMs: 102,
      },
    },
    {
      shape: 'every current field, stamped 3',
      planted: {
        schemaVersion: 3,
        instanceId: '00000000-0000-4000-8000-000000000103',
        pid: process.pid,
        socketPath: '/tmp/agent-qa-embedder-older.sock',
        profile: STATIC_FLOOR_EMBEDDING_PROFILE,
        startedAtMs: 103,
        incarnation: 'proc-starttime:103',
      },
    },
  ])('reads a registration with $shape as malformed', ({ planted }) => {
    const projectRoot = temporaryProject('registration-older')
    const agentQaRoot = embedderWorkerAgentQaRoot(projectRoot)
    const registrationPath = embedderWorkerRegistrationPath(agentQaRoot)
    mkdirSync(agentQaRoot, { recursive: true })
    const bytes = Buffer.from(`${JSON.stringify(planted)}\n`)
    writeFileSync(registrationPath, bytes)

    expect(readEmbedderWorkerRegistration(agentQaRoot)).toEqual({ kind: 'malformed' })
    expect(readFileSync(registrationPath)).toEqual(bytes)
  })

  it('answers match, mismatch, and unverifiable for a registered pid current occupant', async () => {
    const projectRoot = temporaryProject('incarnation-verdict')
    const agentQaRoot = embedderWorkerAgentQaRoot(projectRoot)
    const instanceId = '00000000-0000-4000-8000-000000000108'
    const live = {
      schemaVersion: EMBEDDER_WORKER_REGISTRATION_SCHEMA_VERSION,
      instanceId,
      pid: process.pid,
      socketPath: join(agentQaRoot, 'embedder-worker-verdict.sock'),
      profile: STATIC_FLOOR_EMBEDDING_PROFILE,
      startedAtMs: Date.now(),
      incarnation: resolveProcessIncarnation(process.pid)
        ?? EMBEDDER_WORKER_UNVERIFIABLE_INCARNATION,
    } as const

    const exitedChild = spawn(process.execPath, ['-e', 'process.exit(0)'])
    const deadPid = exitedChild.pid
    if (deadPid === undefined) throw new Error('Expected the fixture child to have a pid')
    await once(exitedChild, 'exit')

    expect(verifyEmbedderWorkerIncarnation(live as never)).toBe(
      process.platform === 'win32' ? 'unverifiable' : 'match',
    )
    expect(verifyEmbedderWorkerIncarnation({
      ...live,
      incarnation: `${incarnationFormat(live.incarnation)}:1`,
    } as never)).toBe(process.platform === 'win32' ? 'unverifiable' : 'mismatch')
    // The sentinel is what a worker records when it cannot attribute itself. It is never a signal
    // target, even though the pid it names is unquestionably alive.
    expect(verifyEmbedderWorkerIncarnation({
      ...live,
      incarnation: EMBEDDER_WORKER_UNVERIFIABLE_INCARNATION,
    } as never)).toBe('unverifiable')
    expect(verifyEmbedderWorkerIncarnation({ ...live, pid: deadPid } as never)).toBe(
      'unverifiable',
    )
  })

  it('derives distinct bounded socket paths for concurrent worker instances', () => {
    const projectRoot = temporaryProject('generation-sockets')
    const agentQaRoot = embedderWorkerAgentQaRoot(projectRoot)
    const derive = embedderWorkerSocketPath as (
      root: string,
      project: string,
      instance: string,
    ) => string
    const first = derive(
      agentQaRoot,
      projectRoot,
      '00000000-0000-4000-8000-000000000102',
    )
    const second = derive(
      agentQaRoot,
      projectRoot,
      '00000000-0000-4000-8000-000000000103',
    )

    expect(first).not.toBe(second)
    expect(Buffer.byteLength(first)).toBeLessThanOrEqual(
      EMBEDDER_WORKER_SOCKET_PATH_BUDGET_BYTES,
    )
    expect(Buffer.byteLength(second)).toBeLessThanOrEqual(
      EMBEDDER_WORKER_SOCKET_PATH_BUDGET_BYTES,
    )
  })

  it('atomically preserves a successor published after predecessor quarantine and double-removes as a no-op', () => {
    const projectRoot = temporaryProject('atomic-remove')
    const agentQaRoot = embedderWorkerAgentQaRoot(projectRoot)
    const registrationPath = embedderWorkerRegistrationPath(agentQaRoot)
    const derive = embedderWorkerSocketPath as (
      root: string,
      project: string,
      instance: string,
    ) => string
    const predecessor = {
      schemaVersion: EMBEDDER_WORKER_REGISTRATION_SCHEMA_VERSION,
      instanceId: '00000000-0000-4000-8000-000000000104',
      pid: process.pid,
      socketPath: derive(
        agentQaRoot,
        projectRoot,
        '00000000-0000-4000-8000-000000000104',
      ),
      profile: STATIC_FLOOR_EMBEDDING_PROFILE,
      startedAtMs: 104,
      incarnation: 'proc-starttime:104',
    }
    const successor = {
      ...predecessor,
      instanceId: '00000000-0000-4000-8000-000000000105',
      socketPath: derive(
        agentQaRoot,
        projectRoot,
        '00000000-0000-4000-8000-000000000105',
      ),
      startedAtMs: 105,
    }
    const predecessorBytes = Buffer.from(`${JSON.stringify(predecessor)}\n`)
    const successorBytes = Buffer.from(`${JSON.stringify(successor)}\n`)
    mkdirSync(agentQaRoot, { recursive: true })
    writeFileSync(registrationPath, predecessorBytes)

    const removeWithBarrier = removeEmbedderWorkerRegistration as unknown as (
      root: string,
      expected: typeof predecessor,
      options: { afterQuarantine: () => void },
    ) => boolean
    expect(removeWithBarrier(agentQaRoot, predecessor, {
      afterQuarantine: () => writeFileSync(registrationPath, successorBytes),
    })).toBe(true)
    expect(readFileSync(registrationPath)).toEqual(successorBytes)

    expect(removeEmbedderWorkerRegistration(agentQaRoot, successor as never)).toBe(true)
    expect(removeEmbedderWorkerRegistration(agentQaRoot, successor as never)).toBe(false)
  })

  it('keeps successor registration bytes and socket serving after delayed predecessor close', async () => {
    const projectRoot = temporaryProject('delayed-close')
    const agentQaRoot = embedderWorkerAgentQaRoot(projectRoot)
    const registrationPath = embedderWorkerRegistrationPath(agentQaRoot)
    let first: EmbedderWorkerHandle | undefined
    let successor: EmbedderWorkerHandle | undefined

    try {
      first = await runEmbedderWorker({
        projectRoot,
        profile: STATIC_FLOOR_EMBEDDING_PROFILE,
      })
      successor = await runEmbedderWorker({
        projectRoot,
        profile: STATIC_FLOOR_EMBEDDING_PROFILE,
      })
      const successorBytes = readFileSync(registrationPath)

      await first.close()

      expect(readFileSync(registrationPath)).toEqual(successorBytes)
      const port = createEmbedderWorkerPort(
        successor.registration.socketPath,
        successor.registration.profile.dim,
      )
      await expect(port.embedQuery('successor remains live')).resolves.toBeInstanceOf(
        Float32Array,
      )
    } finally {
      await successor?.close().catch(() => undefined)
      await first?.close().catch(() => undefined)
    }
  })

  it('removes a dead-pid registration and returns no-worker', async () => {
    const projectRoot = temporaryProject('dead-pid')
    const agentQaRoot = join(projectRoot, '.agent-qa')
    process.chdir(projectRoot)
    const exitedChild = spawn(process.execPath, ['-e', 'process.exit(0)'])
    const deadPid = exitedChild.pid
    if (deadPid === undefined) throw new Error('Expected the fixture child to have a pid')
    await once(exitedChild, 'exit')
    registration(projectRoot, { pid: deadPid })
    expect(readEmbedderWorkerRegistration(agentQaRoot)).toMatchObject({ kind: 'parsed' })

    await expect(discoverEmbedderWorker(agentQaRoot)).resolves.toEqual({ kind: 'no-worker' })
    expect(existsSync(embedderWorkerRegistrationPath(agentQaRoot))).toBe(false)
  })

  it('removes a dead-socket registration and returns no-worker', async () => {
    const projectRoot = temporaryProject('dead-socket')
    const agentQaRoot = join(projectRoot, '.agent-qa')
    process.chdir(projectRoot)
    registration(projectRoot, {
      socketPath: embedderWorkerSocketPath(
        agentQaRoot,
        projectRoot,
        '00000000-0000-4000-8000-000000000100',
      ),
    })
    expect(readEmbedderWorkerRegistration(agentQaRoot)).toMatchObject({ kind: 'parsed' })

    await expect(discoverEmbedderWorker(agentQaRoot)).resolves.toEqual({ kind: 'no-worker' })
    expect(existsSync(embedderWorkerRegistrationPath(agentQaRoot))).toBe(false)
  })

  it('round-trips floor embeddings through a real child and cleans up on SIGTERM', async () => {
    const projectRoot = temporaryProject('live')
    const agentQaRoot = embedderWorkerAgentQaRoot(projectRoot)
    const registrationPath = embedderWorkerRegistrationPath(agentQaRoot)
    process.chdir(projectRoot)

    const child = spawn(
      process.execPath,
      [workerEntryPath, projectRoot, JSON.stringify(STATIC_FLOOR_EMBEDDING_PROFILE)],
      { cwd: projectRoot, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    children.push(child)
    let stderr = ''
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk
    })

    await eventually(
      () => existsSync(registrationPath),
      () => `worker did not register (exit=${child.exitCode}); stderr: ${stderr}`,
    )
    const registeredWorker = JSON.parse(readFileSync(registrationPath, 'utf8')) as {
      socketPath: string
      incarnation: string
    }
    expect(registeredWorker).toMatchObject({
      schemaVersion: EMBEDDER_WORKER_REGISTRATION_SCHEMA_VERSION,
      pid: child.pid,
      profile: STATIC_FLOOR_EMBEDDING_PROFILE,
    })
    // The worker attributes ITSELF, and the recorded token has to carry a fact this test read from
    // the kernel rather than from the module that wrote it.
    if (process.platform !== 'win32' && child.pid !== undefined) {
      expect(registeredWorker.incarnation).toContain(kernelStartTimeFact(child.pid))
      expect(verifyEmbedderWorkerIncarnation(registeredWorker as never)).toBe('match')
    }
    const foreignProjectRoot = temporaryProject('foreign-cwd')
    process.chdir(foreignProjectRoot)
    await expect(discoverEmbedderWorker(agentQaRoot)).resolves.toMatchObject({ kind: 'worker' })

    process.chdir(projectRoot)

    const outcome = await resolveEmbedderCapability({
      preferredProfile: STATIC_FLOOR_EMBEDDING_PROFILE,
      allowDownload: false,
    })
    expect(outcome.kind).toBe('ready')
    if (outcome.kind !== 'ready') throw new Error(`Expected ready, received ${outcome.kind}`)

    const rendering = 'worker and in-process floor embeddings must remain byte-identical'
    const inProcessFloor = createFloorEmbedder()
    const expected = await inProcessFloor.embedDocument(rendering)
    const actual = await outcome.embedder.embedDocument(rendering)
    expect(Buffer.from(actual.buffer, actual.byteOffset, actual.byteLength)).toEqual(
      Buffer.from(expected.buffer, expected.byteOffset, expected.byteLength),
    )

    const query = 'Which embeddings must remain identical?'
    const expectedQuery = await inProcessFloor.embedQuery(query)
    const actualQuery = await outcome.embedder.embedQuery(query)
    expect(Buffer.from(actualQuery.buffer, actualQuery.byteOffset, actualQuery.byteLength)).toEqual(
      Buffer.from(expectedQuery.buffer, expectedQuery.byteOffset, expectedQuery.byteLength),
    )

    const batchResponse = await rawWorkerRequest(registeredWorker.socketPath, {
      schemaVersion: EMBEDDER_WORKER_PROTOCOL_SCHEMA_VERSION,
      method: 'embedBatch',
      requests: [
        { schemaVersion: EMBEDDER_WORKER_PROTOCOL_SCHEMA_VERSION, method: 'embedDocument', rendering },
        {
          schemaVersion: EMBEDDER_WORKER_PROTOCOL_SCHEMA_VERSION,
          method: 'embedQuery',
          rendering: query,
        },
      ],
    })
    expect(batchResponse).toEqual({
      schemaVersion: EMBEDDER_WORKER_PROTOCOL_SCHEMA_VERSION,
      vectors: [Array.from(expected), Array.from(expectedQuery)],
    })

    child.kill('SIGTERM')
    await once(child, 'exit')
    await eventually(
      () => !existsSync(registrationPath),
      () => `worker registration remained after SIGTERM; stderr: ${stderr}`,
    )
  })

  it.skipIf(process.platform === 'win32')(
    'refuses a SIGSTOPped worker request by deadline and invalidates it to typed deferral',
    async () => {
      const projectRoot = temporaryProject('request-timeout')
      const agentQaRoot = embedderWorkerAgentQaRoot(projectRoot)
      const registrationPath = embedderWorkerRegistrationPath(agentQaRoot)
      process.chdir(projectRoot)

      const child = spawn(
        process.execPath,
        [workerEntryPath, projectRoot, JSON.stringify(STATIC_FLOOR_EMBEDDING_PROFILE)],
        { cwd: projectRoot, stdio: ['ignore', 'pipe', 'pipe'] },
      )
      children.push(child)
      let stderr = ''
      child.stderr?.setEncoding('utf8')
      child.stderr?.on('data', (chunk: string) => {
        stderr += chunk
      })
      await eventually(
        () => existsSync(registrationPath),
        () => `worker did not register (exit=${child.exitCode}); stderr: ${stderr}`,
      )

      const requestTimeoutMs = 100
      const discovered = await discoverEmbedderWorker(agentQaRoot, { requestTimeoutMs })
      expect(discovered.kind).toBe('worker')
      if (discovered.kind !== 'worker' || !('embedder' in discovered)) {
        throw new Error('Expected a worker-backed embedder')
      }

      child.kill('SIGSTOP')
      try {
        const startedAtMs = Date.now()
        let refusal: unknown
        try {
          const embedder = discovered.embedder as { embedQuery(text: string): Promise<Float32Array> }
          await embedder.embedQuery('a stopped worker must not wedge curation')
        } catch (error) {
          refusal = error
        }

        expect(refusal).toBeInstanceOf(EmbedderWorkerTimeoutError)
        expect((refusal as EmbedderWorkerTimeoutError).phase).toBe('request')
        expect(Date.now() - startedAtMs).toBeLessThan(requestTimeoutMs + 2_000)
        expect(existsSync(registrationPath)).toBe(false)
        await expect(resolveEmbedderCapability({
          preferredProfile: STATIC_FLOOR_EMBEDDING_PROFILE,
          allowDownload: false,
          workerPolicy: 'required',
          agentQaRoot,
        })).resolves.toEqual({ kind: 'deferred', reason: 'worker-unavailable' })
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          const exited = once(child, 'exit')
          child.kill('SIGCONT')
          child.kill('SIGTERM')
          await exited
        }
      }
    },
  )
})

describe('embedder registration start-time format', () => {
  it('an embedder registration stamped in another start-time format is unverifiable, and an equal-format different one is a mismatch', () => {
    const projectRoot = temporaryProject('incarnation-format')
    const agentQaRoot = embedderWorkerAgentQaRoot(projectRoot)
    const own = resolveProcessIncarnation(process.pid)
    const live = {
      schemaVersion: EMBEDDER_WORKER_REGISTRATION_SCHEMA_VERSION,
      instanceId: '00000000-0000-4000-8000-000000000442',
      pid: process.pid,
      socketPath: join(agentQaRoot, 'embedder-worker-format.sock'),
      profile: STATIC_FLOOR_EMBEDDING_PROFILE,
      startedAtMs: Date.now(),
      incarnation: own ?? EMBEDDER_WORKER_UNVERIFIABLE_INCARNATION,
    } as const

    if (process.platform === 'win32') {
      expect(own).toBeUndefined()
    } else {
      expect(own).toBeTypeOf('string')
      expect(String(own)).toContain(':')
      expect(verifyEmbedderWorkerIncarnation(live as never)).toBe('match')
    }
    const format = String(own).split(':')[0]
    const verdicts = {
      foreignFormat: verifyEmbedderWorkerIncarnation({
        ...live,
        incarnation: 'foreign-format:1',
      } as never),
      equalFormat: verifyEmbedderWorkerIncarnation({
        ...live,
        incarnation: `${format}:1`,
      } as never),
    }

    expect(verdicts, `own token ${String(own)}`).toEqual({
      foreignFormat: 'unverifiable',
      equalFormat: process.platform === 'win32' ? 'unverifiable' : 'mismatch',
    })
  })
})
