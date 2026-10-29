// 423 Gap 1: runs.evidence over the production composition. No test installs a masking resolver;
// 2026-10-14 (441-16, D-06): every read below masks with the host's declared mask.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { invokeFunction } from '@vostride/agent-qa-agent'
import type { LocalAgentHost } from '@vostride/agent-qa-agent-local'
import {
  DashboardDatabase, createDashboardRunDetailReader, createRunServiceRoutes, startServer, type RunServicePorts,
} from '@vostride/agent-qa-dashboard'
import { generateRunId } from '@vostride/agent-qa-ids'
import { FsEvidenceArtifactStore } from '@vostride/agent-qa-runner-local'
import { RUN_EVIDENCE_DOCUMENT_SCHEMA_VERSION } from '@vostride/agent-qa-schema'
import type { EvidenceDocument } from '@vostride/agent-qa-schema'

import { composeDashboardAgentHost } from '../commands/dashboard.js'
import { CLI_FUNCTION_CALLER, composeCliLocalAgent } from '../composition/local-agent-host.js'

const SECRET = 'synthetic-production-secret-423'
const MARKER = '[secret:SESSION]'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

// Every dispatch appends the gate's audit row, and SQLite rewrites its shared-memory read index on
// any read; neither is a byte the read itself produced, so both stay outside the tree proof.
const DISPATCH_BOOKKEEPING = new Set(['execution_audit.jsonl', 'dashboard.db-shm'])

function fixtureBytes(root: string): unknown {
  return readdirSync(root, { withFileTypes: true }).filter(entry => !DISPATCH_BOOKKEEPING.has(entry.name))
    .map(entry => [entry.name,
      entry.isDirectory() ? fixtureBytes(join(root, entry.name)) : readFileSync(join(root, entry.name), 'hex')])
}

const networkDocument: Extract<EvidenceDocument, { kind: 'network' }> = {
  schemaVersion: RUN_EVIDENCE_DOCUMENT_SCHEMA_VERSION, kind: 'network', records: [
    {
      url: 'https://app.test/api/orders', method: 'POST', status: 200,
      requestHeaders: { 'content-type': 'application/json', 'x-request-id': 'req-423' },
      responseHeaders: { 'content-type': 'application/json', 'x-trace': SECRET },
      body: 'recorded body', startTime: 1, endTime: 2,
    },
    {
      url: 'https://app.test/api/health', method: 'GET', status: 204,
      requestHeaders: {}, responseHeaders: {}, startTime: 3, endTime: 4,
    },
  ],
}

function productionFixture() {
  const root = mkdtempSync(join(tmpdir(), 'agent-qa-423-production-read-'))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const configPath = join(root, 'agent-qa.config.yaml')
  const agentQaRoot = join(root, '.agent-qa')
  const secretsFile = join(root, '.env.secrets.local')
  writeFileSync(configPath, JSON.stringify({
    workspace: { testMatch: ['tests/**/*.yaml'], suiteMatch: ['suites/**/*.yaml'],
      hooksFile: 'hooks.yaml', envFile: '.env', secretsFile: '.env.secrets.local' },
    knowledge: { dir: 'agent-qa-knowledge' },
    registry: { llms: [{ name: 'unused', provider: 'openai-compatible', model: 'unused',
      baseURL: 'http://127.0.0.1:1/v1' }],
      targets: { local: { platform: 'web', url: 'http://127.0.0.1:1' } } },
    use: { llm: 'unused', mobile: { appState: 'preserve' } },
  }))
  writeFileSync(secretsFile, `SESSION=${SECRET}\n`)
  mkdirSync(agentQaRoot, { recursive: true })

  const runId = generateRunId()
  const db = new DashboardDatabase({ dbPath: join(agentQaRoot, 'dashboard.db') })
  cleanups.push(() => db.close())
  const networkRef = new FsEvidenceArtifactStore({ root: agentQaRoot, runId }).persistEvidenceDocument(networkDocument)
  db.insertRun({
    id: runId, name: 'Production read posture', status: 'passed', duration: 1,
    startedAt: new Date(0).toISOString(), endedAt: new Date(1).toISOString(),
  })
  db.upsertRunMember({ runId, testIndex: 0, name: 'Production member', totalSteps: 1, outcome: 'passed' })
  db.insertRunStep({
    runId, testIndex: 0, stepIndex: 0, stepText: 'Submit the order',
    cacheStatus: 'miss', verifierVerdict: null, selfHealOccurred: false, briefDigest: '', status: 'passed',
    evidence: {
      console: { kind: 'console', state: 'absent', reason: 'empty' },
      network: { kind: 'network', state: 'present', ref: networkRef as never, counts: { total: 2, failed: 0, errored: 0 } },
      a11y: { kind: 'a11y', state: 'absent', reason: 'unsupported' },
      variables: { kind: 'variables', state: 'present', counts: { count: 2 } },
    },
    variableSnapshot: {
      first: { value: 'plain-first', source: 'inline' },
      second: { value: SECRET, source: 'env' },
    },
  })

  const host: LocalAgentHost = composeCliLocalAgent({
    configPath, agentQaRoot, runDetail: createDashboardRunDetailReader(db),
  })
  cleanups.push(() => host.close())
  const read = async (kind: 'network' | 'variables') => {
    const result = await invokeFunction(host.registry, 'runs.evidence',
      { runId, testIndex: 0, stepIndex: 0, kind }, CLI_FUNCTION_CALLER)
    return result as { outcome: string; code?: string }
  }
  return { root, configPath, agentQaRoot, secretsFile, runId, db, host, networkRef, read }
}

async function listen(server: ReturnType<typeof createServer>): Promise<string> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('HTTP fixture did not bind')
  return `http://127.0.0.1:${address.port}`
}

// The local human door and the bearer machine door over the SAME composed host, as dashboard.ts
// wires them. Neither restores anything a read masked (441 D-07).
async function startDoors(f: ReturnType<typeof productionFixture>) {
  const agentHost = composeDashboardAgentHost(f.host)
  const started = await startServer({ declaredSecretMask: (text) => text, db: f.db, port: 0, agentHost })
  cleanups.push(() => started.close())
  const address = started.server.address()
  if (address === null || typeof address === 'string') throw new Error('Dashboard fixture did not bind')
  const origin = `http://127.0.0.1:${address.port}`
  const remote = await listen(createServer(createRunServiceRoutes({ agentHost } as unknown as RunServicePorts)))
  const query = 'kind=network&testIndex=0&stepIndex=0'
  return {
    human: `${origin}/api/runs/${f.runId}/evidence?${query}`,
    machine: `${remote}/run/${f.runId}/evidence?${query}`,
    artifact: `${origin}/api/runs/${f.runId}/artifacts/${f.networkRef.sha}`,
  }
}

describe('423 production read posture', () => {
  it('COLD-EVIDENCE-HOST reads multi-key network and variables evidence readable with the declared secret masked', async () => {
    const f = productionFixture()
    const before = fixtureBytes(f.root)

    const network = await f.read('network') as unknown as {
      outcome: string
      code?: string
      document: { records: { url: string; requestHeaders: Record<string, string>; responseHeaders: Record<string, string> }[] }
    }
    expect({ outcome: network.outcome, code: network.code }).toEqual({ outcome: 'ready', code: undefined })
    const records = network.document.records
    expect(records.map(record => record.url)).toEqual(networkDocument.records.map(record => record.url))
    expect(records[0]!.requestHeaders).toEqual({ 'content-type': 'application/json', 'x-request-id': 'req-423' })
    expect(Object.keys(records[0]!.requestHeaders)).toEqual(['content-type', 'x-request-id'])
    expect(Object.keys(records[0]!.responseHeaders)).toEqual(['content-type', 'x-trace'])
    expect(records[0]!.responseHeaders['content-type']).toBe('application/json')
    expect(records[0]!.responseHeaders['x-trace']).toBe(MARKER)
    expect(records[1]!.requestHeaders).toEqual({})
    expect(records[1]!.responseHeaders).toEqual({})
    expect(JSON.stringify(network)).not.toContain(SECRET)

    const variables = await f.read('variables') as unknown as {
      outcome: string
      code?: string
      document: { records: Record<string, { value: string; source: string }> }
    }
    expect({ outcome: variables.outcome, code: variables.code }).toEqual({ outcome: 'ready', code: undefined })
    expect(Object.keys(variables.document.records)).toEqual(['first', 'second'])
    expect(variables.document.records.first).toEqual({ value: 'plain-first', source: 'inline' })
    expect(variables.document.records.second).toEqual({ value: MARKER, source: 'env' })
    expect(JSON.stringify(variables)).not.toContain(SECRET)

    expect(await f.read('network')).toEqual(network)
    expect(await f.read('variables')).toEqual(variables)
    expect(fixtureBytes(f.root)).toEqual(before)
    // 432-13: no op gate writes this file any more; if anything else does, it still holds no secret.
    const auditPath = join(f.agentQaRoot, 'execution_audit.jsonl')
    expect(existsSync(auditPath) ? readFileSync(auditPath, 'utf8') : '').not.toContain(SECRET)
  })

  it('COLD-EVIDENCE-HTTP serves readable masked evidence on the human and bearer doors and immutable bytes on the sha route', async () => {
    const f = productionFixture()
    const doors = await startDoors(f)

    const human = await fetch(doors.human)
    expect(human.status).toBe(200)
    const humanRaw = await human.text()
    const humanBody = JSON.parse(humanRaw)
    expect(humanBody).toMatchObject({ outcome: 'ready', document: { records: [
      { requestHeaders: { 'content-type': 'application/json', 'x-request-id': 'req-423' },
        responseHeaders: { 'content-type': 'application/json', 'x-trace': MARKER } },
      { requestHeaders: {}, responseHeaders: {} },
    ] } })
    expect(humanRaw).not.toContain(SECRET)

    // 432-21 (D-12/D-13): the machine door is tokenless; what it refuses is a cross-site read.
    expect((await fetch(doors.machine, { headers: { Origin: 'https://evil.example' } })).status).toBe(403)
    const machine = await fetch(doors.machine)
    expect(machine.status).toBe(200)
    const machineRaw = await machine.text()
    expect(JSON.parse(machineRaw)).toMatchObject({ outcome: 'ready', document: { records: [
      { requestHeaders: { 'x-request-id': 'req-423' }, responseHeaders: { 'x-trace': MARKER } },
      { requestHeaders: {}, responseHeaders: {} },
    ] } })
    expect(machineRaw).not.toContain(SECRET)

    const artifact = await fetch(doors.artifact)
    expect(artifact.status).toBe(200)
    expect(artifact.headers.get('etag')).toBe(`"${f.networkRef.sha}"`)
    const served = Buffer.from(await artifact.arrayBuffer())
    expect(served).toEqual(Buffer.from(JSON.stringify(networkDocument)))
    expect(served).toEqual(Buffer.from(new FsEvidenceArtifactStore({ root: f.agentQaRoot, runId: f.runId }).getBlob(f.networkRef.sha)!))
  })

  it('COLD-EVIDENCE-UNAVAILABLE answers masking-unavailable with the capture kept when cold sources are missing', async () => {
    const f = productionFixture()
    const doors = await startDoors(f)
    rmSync(f.secretsFile)

    const result = await f.read('network')
    expect(result).toEqual({
      address: { runId: f.runId, testIndex: 0, stepIndex: 0, kind: 'network' },
      outcome: 'read-error', code: 'masking-unavailable',
      capture: { kind: 'network', state: 'present', ref: f.networkRef, counts: { total: 2, failed: 0, errored: 0 } },
    })
    expect(result).not.toHaveProperty('document')

    const human = await fetch(doors.human)
    expect(human.status).toBe(200)
    expect(await human.json()).toEqual(result)
  })
})
