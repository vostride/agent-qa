import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as agent from '@vostride/agent-qa-agent'
import type { FunctionDeps } from '@vostride/agent-qa-agent'
import { generateRunId } from '../../../ids/dist/index.js'
import { FsEvidenceArtifactStore } from '@vostride/agent-qa-runner-local'
import {
  asRunId,
  EvidenceArtifactRefSchema,
  RunsEvidenceResultSchema,
  RUN_EVIDENCE_DOCUMENT_SCHEMA_VERSION,
} from '@vostride/agent-qa-schema'
import type { FunctionCaller, RunDetailRows } from '@vostride/agent-qa-schema'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { composeLocalAgent } from '../composition/compose-local-agent.js'

// 2026-10-01 (432-30, D-12): the retired `grantedScopes` and `safeMode` caller fields and the
// retired `resolveExecutionContext` registry option are dropped; nothing read them. The composed
// host's own `resolveExecutionContext` input is not the registry option and stays.
const caller: FunctionCaller = { surface: 'test', origin: 'agent' }
const op = 'runs.evidence'
let temporary: string
beforeEach(() => {
  temporary = mkdtempSync(join(tmpdir(), 'agent-qa-evidence-op-'))
})
afterEach(() => {
  rmSync(temporary, { recursive: true, force: true })
})

function fixture(populated = true) {
  const root = join(temporary, '.agent-qa')
  const runId = asRunId(generateRunId())
  const document = {
    schemaVersion: RUN_EVIDENCE_DOCUMENT_SCHEMA_VERSION as typeof RUN_EVIDENCE_DOCUMENT_SCHEMA_VERSION,
    kind: 'console' as const,
    records: [{ level: 'error', text: 'recorded console', timestamp: 2 }] }
  const store = new FsEvidenceArtifactStore({ root, runId })
  const ref = populated ? EvidenceArtifactRefSchema.parse(store.persistEvidenceDocument(document)) : undefined
  const rows: RunDetailRows = { runId, members: [{ testIndex: 2, attempts: 1 }],
    steps: [{ testIndex: 2, stepIndex: 3, cacheStatus: 'miss',
      verifierVerdict: { pass: true, reasoning: 'done' }, selfHealOccurred: false, briefDigest: 'brief',
      ...(ref === undefined ? {} : { evidence: {
        console: { kind: 'console', state: 'present', ref, counts: { total: 1, errors: 1, warnings: 0 } },
        network: { kind: 'network', state: 'absent', reason: 'empty' },
        a11y: { kind: 'a11y', state: 'absent', reason: 'unsupported' },
        variables: { kind: 'variables', state: 'absent', reason: 'not-captured' },
      } }),
    }], subActions: [] }
  const read = vi.fn(async (id: string) => populated && id === runId ? rows : undefined)
  const forbidden = vi.fn(() => { throw new Error('Evidence reads cannot author or load configuration') })
  const input = { mask: (text: string) => text, agentQaRoot: root,
    knowledgeRoot: () => join(temporary, 'knowledge'),
    config: { getMasked: forbidden }, model: forbidden, mintQuarantineIdentityPath: (path: string) => path,
    resolveExecutionContext: () => 'local-headless' as const }
  const host = composeLocalAgent({ ...input, runDetail: { read } })
  return { root, runId, document, rows, ref, read, forbidden, host, input,
    address: { runId, testIndex: 2, stepIndex: 3, kind: 'console' } }
}

function tree(root: string): Record<string, string> {
  if (!existsSync(root)) return {}
  return Object.fromEntries(readdirSync(root, { recursive: true, withFileTypes: true })
    .map(entry => [join(entry.parentPath, entry.name), entry.isDirectory() ? 'directory'
      : readFileSync(join(entry.parentPath, entry.name)).toString('base64')]))
}

it('EVIDENCE-REGISTRY-BOUND invokes the composed reader over exact stored evidence', async () => {
  const f = fixture()
  try {
    expect(f.host.registry.list(caller).find(item => item.id === op)).toMatchObject({
      bindingStatus: 'bound', resultKind: 'unary', risk: { readOnly: true },
    })
    expect(Reflect.get(agent, 'RUNS_EVIDENCE_FUNCTION_ID')).toBe(op)
    expect(Reflect.get(agent, 'runsEvidenceSpec')).toBeUndefined()
    const answer = RunsEvidenceResultSchema.parse(await agent.invokeFunction(f.host.registry, op, f.address, caller))
    expect(answer).toMatchObject({ outcome: 'ready', document: f.document, evidence: { ref: f.ref } })
    expect(f.read).toHaveBeenCalledWith(f.runId)
    expect(f.forbidden).not.toHaveBeenCalled()
  } finally { await f.host.close() }
})

it('EVIDENCE-UNBOUND composed host without detail advertises and refuses the missing reader', async () => {
  const f = fixture(false)
  const host = composeLocalAgent(f.input)
  try {
    expect(host.registry.list(caller).find(item => item.id === op)?.bindingStatus).toBe('unbound')
    await expect(agent.invokeFunction(host.registry, op, f.address, caller)).rejects.toBeInstanceOf(agent.FunctionNotBoundError)
    expect(existsSync(join(f.root, 'runs'))).toBe(false)
  } finally { await host.close(); await f.host.close() }
})

it.each(['both', 'runDetail', 'evidenceBlobs'] as const)(
  'EVIDENCE-UNBOUND missing %s never advertises a usable partial binding', async missing => {
    const f = fixture(false)
    const deps = {
      ...(missing === 'both' || missing === 'runDetail' ? {} : { runDetail: { read: f.read } }),
      ...(missing === 'both' || missing === 'evidenceBlobs' ? {} : { evidenceBlobs: { read: f.forbidden } }),
    } as unknown as FunctionDeps
    const registry = agent.createFunctionRegistry({ deps })
    try {
      expect(registry.list(caller).find(item => item.id === op)?.bindingStatus).toBe('unbound')
      expect(registry.list(caller).find(item => item.id === 'runs.detail')?.bindingStatus)
        .toBe(missing === 'evidenceBlobs' ? 'bound' : 'unbound')
      await expect(agent.invokeFunction(registry, op, f.address, caller)).rejects.toBeInstanceOf(agent.FunctionNotBoundError)
      expect(f.read).not.toHaveBeenCalled()
      expect(f.forbidden).not.toHaveBeenCalled()
    } finally { await f.host.close() }
  },
)

it('EVIDENCE-READ-ONLY preserves stored bytes and rows without opening jobs or knowledge', async () => {
  const f = fixture()
  const before = tree(join(f.root, 'runs'))
  const rows = JSON.stringify(f.rows)
  try {
    for (let count = 0; count < 2; count++) {
      await expect(agent.invokeFunction(f.host.registry, op, f.address, caller)).resolves.toMatchObject({ outcome: 'ready' })
    }
    expect(tree(join(f.root, 'runs'))).toEqual(before)
    expect(JSON.stringify(f.rows)).toBe(rows)
    expect(existsSync(join(f.root, 'agent-jobs.db'))).toBe(false)
    expect(existsSync(join(temporary, 'knowledge'))).toBe(false)
    expect(f.forbidden).not.toHaveBeenCalled()
  } finally { await f.host.close() }
})

it('EVIDENCE-READ-ONLY missing run creates no run directory', async () => {
  const f = fixture(false)
  try {
    await expect(agent.invokeFunction(f.host.registry, op, f.address, caller)).rejects.toBeInstanceOf(agent.RunNotFoundError)
    expect(existsSync(join(f.root, 'runs'))).toBe(false)
    expect(existsSync(join(temporary, 'knowledge'))).toBe(false)
    expect(existsSync(join(f.root, 'agent-jobs.db'))).toBe(false)
  } finally { await f.host.close() }
})
