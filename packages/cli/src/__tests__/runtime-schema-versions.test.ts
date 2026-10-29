import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, request } from 'node:http'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ConfigReaderPort, JobModelCapability } from '@vostride/agent-qa-agent'
import { composeLocalAgent } from '@vostride/agent-qa-agent-local'
import type { LocalAgentHost } from '@vostride/agent-qa-agent-local'
import { MASKED_RESOLVED_CONFIG_SCHEMA_VERSION, canonicalJson } from '@vostride/agent-qa-schema'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ZodTypeAny } from 'zod'

import {
  MARK_EDIT_RECORD_FILE,
  MarkEditRecordUnreadableError,
  answerRecordedMarkEdit,
  recordMarkEditAhead,
  withMarkEditScope,
} from '../gates/mark-edit-record.js'

import { invokeViaDaemon } from '../daemon/client.js'
import { runDaemonHost } from '../daemon/host.js'
import {
  DAEMON_REGISTRATION_FILE,
  DAEMON_REGISTRATION_SCHEMA_VERSION,
  readDaemonRegistration,
  writeDaemonRegistration,
} from '../daemon/registration.js'
import {
  DAEMON_IDENTITY_SCHEMA_VERSION,
  INVOKE_ENVELOPE_SCHEMA_VERSION,
  daemonIdentitySchema,
  fetchDaemonIdentity,
  invokeEnvelopeSchema,
  startInvokeServer,
  type InvokeServerHandle,
} from '../daemon/server.js'
import { removeTempRoots } from './temp-roots.js'

const workerProtocol = (await import(
  new URL('../../../knowledge-local/src/embedder-worker/worker-registration.js', import.meta.url)
    .href
)) as {
  EMBEDDER_WORKER_PROTOCOL_SCHEMA_VERSION: number
  embedderWorkerRequestSchema: ZodTypeAny
  embedderWorkerResponseSchema: ZodTypeAny
}

const INSTANCE_ID = '44444444-4444-4444-8444-444444444444'
const MASKED_CONFIG = {
  schemaVersion: MASKED_RESOLVED_CONFIG_SCHEMA_VERSION as typeof MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
  configPath: '/fixture/agent-qa.config.yaml',
  entries: [],
}
const TEST_CONFIG: ConfigReaderPort = { getMasked: () => Promise.resolve(MASKED_CONFIG) }
const TEST_MODEL: JobModelCapability = {
  modelId: 'test:runtime-stamps',
  generate: () => Promise.resolve({ text: 'unused' }),
}

const roots: string[] = []
const hosts: LocalAgentHost[] = []
const servers: InvokeServerHandle[] = []
const peers: Server[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  for (const server of servers.splice(0)) await server.close()
  for (const peer of peers.splice(0)) {
    await new Promise<void>((resolveClose) => peer.close(() => resolveClose()))
  }
  for (const host of hosts.splice(0)) host.close()
  removeTempRoots(roots.splice(0))
})

function temporaryProject(label: string): { agentQaRoot: string; knowledgeRoot: string } {
  const base = process.platform === 'win32' ? tmpdir() : '/tmp'
  const root = mkdtempSync(join(base, `agent-qa-stamps-${label}-`))
  roots.push(root)
  const agentQaRoot = join(root, '.agent-qa')
  mkdirSync(agentQaRoot, { recursive: true })
  return { agentQaRoot, knowledgeRoot: join(root, 'agent-qa-knowledge') }
}

function restamp(file: string, stamp: number): void {
  const document = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  writeFileSync(file, `${canonicalJson({ ...document, schemaVersion: stamp })}\n`, 'utf8')
}

function runDir(label: string): string {
  const { agentQaRoot } = temporaryProject(label)
  const dir = join(agentQaRoot, 'runs', 'run-stamps')
  mkdirSync(dir, { recursive: true })
  return dir
}

async function startRegisteredDaemon(label: string): Promise<{
  agentQaRoot: string
  socketPath: string
}> {
  const { agentQaRoot, knowledgeRoot } = temporaryProject(label)
  const socketPath = join(agentQaRoot, 'daemon.sock')
  const host = composeLocalAgent({
    mask: (text) => text,
    mintQuarantineIdentityPath: (filePath) => filePath,
    agentQaRoot,
    config: TEST_CONFIG,
    knowledgeRoot: () => knowledgeRoot,
    model: () => TEST_MODEL,
  })
  hosts.push(host)
  writeDaemonRegistration(agentQaRoot, {
    schemaVersion: DAEMON_REGISTRATION_SCHEMA_VERSION,
    instanceId: INSTANCE_ID,
    pid: process.pid,
    socketPath,
    startedAtMs: Date.now(),
  })
  servers.push(await startInvokeServer({
    socketPath,
    registry: host.registry,
    identity: {
      schemaVersion: DAEMON_IDENTITY_SCHEMA_VERSION,
      instanceId: INSTANCE_ID,
      pid: process.pid,
    },
  }))
  return { agentQaRoot, socketPath }
}

function postInvoke(socketPath: string, envelope: unknown): Promise<number> {
  const body = JSON.stringify(envelope)
  return new Promise((resolvePost, rejectPost) => {
    const outgoing = request({
      socketPath,
      path: '/invoke',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        connection: 'close',
      },
    }, (response) => {
      response.resume()
      response.once('error', rejectPost)
      response.once('end', () => resolvePost(response.statusCode ?? 500))
    })
    outgoing.once('error', rejectPost)
    outgoing.end(body)
  })
}

describe('cli runtime stamps', () => {
  it('serves an invoke round trip with the envelope and the identity at 2', async () => {
    const { agentQaRoot, socketPath } = await startRegisteredDaemon('round-trip')

    expect(INVOKE_ENVELOPE_SCHEMA_VERSION).toBe(2)
    expect(DAEMON_IDENTITY_SCHEMA_VERSION).toBe(2)
    await expect(fetchDaemonIdentity(socketPath)).resolves.toEqual({
      schemaVersion: 2,
      instanceId: INSTANCE_ID,
      pid: process.pid,
    })
    await expect(invokeViaDaemon({ agentQaRoot, functionId: 'config.get', input: {} }))
      .resolves.toEqual(MASKED_CONFIG)
    await expect(postInvoke(socketPath, {
      schemaVersion: 2,
      functionId: 'config.get',
      input: {},
    })).resolves.toBe(200)
  })

  it('refuses an invoke envelope stamped 1 at the schema and on the wire', async () => {
    const { socketPath } = await startRegisteredDaemon('envelope-1')
    const envelope = { schemaVersion: 1, functionId: 'config.get', input: {} }

    expect(invokeEnvelopeSchema.safeParse(envelope).success).toBe(false)
    await expect(postInvoke(socketPath, envelope)).resolves.toBe(400)
  })

  it('refuses a daemon identity stamped 1 at the schema and from a peer that serves it', async () => {
    const identity = { schemaVersion: 1, instanceId: INSTANCE_ID, pid: process.pid }
    expect(daemonIdentitySchema.safeParse(identity).success).toBe(false)

    const { agentQaRoot } = temporaryProject('identity-1')
    const socketPath = join(agentQaRoot, 'peer.sock')
    const peer = createServer((incoming, outgoing) => {
      incoming.resume()
      outgoing.writeHead(200, { 'content-type': 'application/json' })
      outgoing.end(JSON.stringify(identity))
    })
    peers.push(peer)
    await new Promise<void>((resolveListen) => peer.listen(socketPath, () => resolveListen()))

    await expect(fetchDaemonIdentity(socketPath)).rejects.toThrow()
  })

  it.each([
    ['an embedDocument request', 'request', { method: 'embedDocument', rendering: 'x' }],
    ['an embedQuery request', 'request', { method: 'embedQuery', rendering: 'x' }],
    ['a response', 'response', { vectors: [[0.5]] }],
  ] as const)('refuses %s stamped 1 at the embedder worker protocol schema', (_label, kind, body) => {
    const schema = kind === 'request'
      ? workerProtocol.embedderWorkerRequestSchema
      : workerProtocol.embedderWorkerResponseSchema
    expect(workerProtocol.EMBEDDER_WORKER_PROTOCOL_SCHEMA_VERSION).toBe(2)
    expect(schema.safeParse({ ...body, schemaVersion: 2 }).success).toBe(true)
    expect(schema.safeParse({ ...body, schemaVersion: 1 }).success).toBe(false)
  })

  it('refuses a daemon registration stamped 1, leaves it byte-identical, and unlinks no socket', async () => {
    const { agentQaRoot, knowledgeRoot } = temporaryProject('registration-1')
    const socketPath = join(agentQaRoot, 'daemon.sock')
    const registrationFile = join(agentQaRoot, DAEMON_REGISTRATION_FILE)
    writeFileSync(socketPath, 'left by an earlier build', 'utf8')
    writeFileSync(registrationFile, `${JSON.stringify({
      schemaVersion: 1,
      pid: 2_147_483_647,
      socketPath,
      startedAtMs: 1_700_000_000_000,
    })}\n`, 'utf8')
    const bytesBefore = readFileSync(registrationFile)
    const unlinkDaemonSocket = vi.fn(() => true)
    const removeRegistrationIfOwned = vi.fn()
    const acquireWriterLease = vi.fn()
    const errors: string[] = []

    expect(readDaemonRegistration(agentQaRoot)).toEqual({ kind: 'malformed' })
    await expect(runDaemonHost({
      agentQaRoot,
      knowledgeRoot,
      config: TEST_CONFIG,
      model: () => TEST_MODEL,
      operations: {
        unlinkDaemonSocket,
        removeRegistrationIfOwned: removeRegistrationIfOwned as never,
        acquireWriterLease: acquireWriterLease as never,
      },
      logger: { info: vi.fn(), error: (message) => errors.push(message) },
    })).resolves.toBe(1)

    expect(errors).toEqual([
      'agent-qa daemon registration is malformed; refusing to overwrite it',
    ])
    expect(unlinkDaemonSocket).not.toHaveBeenCalled()
    expect(removeRegistrationIfOwned).not.toHaveBeenCalled()
    expect(acquireWriterLease).not.toHaveBeenCalled()
    expect(readFileSync(registrationFile)).toEqual(bytesBefore)
    expect(existsSync(socketPath)).toBe(true)
  })

  it('records a mark edit at 2 and refuses one stamped 1 as unreadable', async () => {
    const dir = runDir('mark-edit-1')
    const recordPath = join(dir, MARK_EDIT_RECORD_FILE)
    const scope = { recordPath, operationId: 'operation-stamps' }
    const content = 'name: stamps\n'
    const contentDigest = createHash('sha256').update(content).digest('hex')
    await withMarkEditScope(scope, async () => {
      recordMarkEditAhead({ filePath: 'stamps.yaml', contentDigest })
    })
    writeFileSync(join(dir, 'stamps.yaml'), content, 'utf8')
    expect(JSON.parse(readFileSync(recordPath, 'utf8'))).toMatchObject({ schemaVersion: 2 })
    expect(answerRecordedMarkEdit({ ...scope, configDir: dir })).toEqual({
      kind: 'written',
      filePath: 'stamps.yaml',
      contentDigest,
    })

    restamp(recordPath, 1)
    expect(() => answerRecordedMarkEdit({ ...scope, configDir: dir }))
      .toThrow(MarkEditRecordUnreadableError)
  })
})
