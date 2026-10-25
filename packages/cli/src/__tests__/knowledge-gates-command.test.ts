// 2026-09-06, 416 D-17/D-18: real persisted history through the read-only function layer.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import { invokeFunction } from '@vostride/agent-qa-agent'
import {
  appendGateReceipt,
  appendPromotionReceipt,
  publishBundleForTest,
  readGateReceipts,
  verifyBundleIntegrity,
  type BundleStoreConfig,
} from '@vostride/agent-qa-knowledge-local'
import { SecretRedactor, SecretStore } from '@vostride/agent-qa-runner'
import { GATE_RECEIPT_SCHEMA_VERSION, canonicalJson, KnowledgeGatesListResultSchema, stampReceiptDigest } from '@vostride/agent-qa-schema'
import { Command } from 'commander'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createKnowledgeCommand } from '../commands/knowledge.js'
import { CLI_FUNCTION_CALLER, composeCliLocalAgent } from '../composition/local-agent-host.js'

const DATA_LAYER_PACKAGES = [
  '@vostride/agent-qa-core',
  '@vostride/agent-qa-knowledge-local',
  '@vostride/agent-qa-runner-local',
] as const

describe('agent-qa knowledge gates', () => {
  const roots: string[] = []
  const originalExitCode = process.exitCode
  afterEach(() => {
    process.exitCode = originalExitCode
    vi.restoreAllMocks()
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'agent-qa-knowledge-gates-'))
    roots.push(root)
    const configPath = join(root, 'agent-qa.config.yaml')
    mkdirSync(join(root, '.agent-qa'), { recursive: true })
    writeFileSync(configPath, JSON.stringify({
      workspace: { testMatch: ['tests/**/*.yaml'], suiteMatch: ['suites/**/*.suite.yaml'],
        hooksFile: 'hooks.yaml', envFile: '.env', secretsFile: '.env.secrets.local' },
      knowledge: { dir: 'agent-qa-knowledge', commitArtifacts: 'none' },
      use: { mobile: { appState: 'preserve' } },
    }) + '\n')
    writeFileSync(join(root, '.env.secrets.local'), '')
    const agentQaRoot = join(root, '.agent-qa')
    const config: BundleStoreConfig = {
      knowledgeRoot: join(root, 'agent-qa-knowledge'), productKey: 'shop',
      commitArtifacts: 'none',
    }
    const result = publishBundleForTest(config, {
      draft: { kind: 'fact', subtype: 'selector', anchors: [{ t: 'el', role: 'button', name: 'Checkout' }],
        scope: { tier: 'product', key: 'shop' }, summary: 'Checkout', body: 'Checkout button',
        distilledEvidenceRef: { id: 'checkout-evidence', sha: 'a'.repeat(64) }, originStage: 'run-curation' },
      discriminant: { kind: 'fact', subtype: 'selector', elementRef: { role: 'button', name: 'Checkout' } },
      originClass: 'agent-verified', createdAtOrdinal: 5, screenStates: [], initialEvents: [], relations: [],
      provenance: { mode: 'run-linked', runId: 'knowledge-gates', testId: 'knowledge-gates-command',
        stepIndex: 0, sourceBuildOrdinal: 5 }, artifacts: [],
    })
    expect(result.kind).toBe('published')
    if (result.kind !== 'published') throw new Error('gate fixture publication failed')
    return { configPath, config, agentQaRoot, id: result.id, dir: result.dir }
  }

  async function invoke(configPath: string, args: string[], expectedError?: string) {
    const stdout: string[] = []
    const stderr: string[] = []
    const log = vi.spyOn(console, 'log').mockImplementation((...values) => { stdout.push(values.join(' ')) })
    const error = vi.spyOn(console, 'error').mockImplementation((...values) => { stderr.push(values.join(' ')) })
    process.exitCode = undefined
    try {
      const program = new Command().option('--config <path>').addCommand(createKnowledgeCommand()).exitOverride()
      await program.parseAsync(['node', 'agent-qa', '--config', configPath, 'knowledge', 'gates', ...args])
      if (expectedError === undefined) {
        expect(stderr).toEqual([])
        expect(process.exitCode).toBeUndefined()
      } else {
        expect(stdout).toEqual([])
        expect(stderr.map(stripVTControlCharacters)).toEqual([`Knowledge gates error: ${expectedError}`])
        expect(process.exitCode).toBe(1)
      }
      return stdout.join('\n')
    } finally { log.mockRestore(); error.mockRestore() }
  }

  it.each([
    { raw: 'AKIAIOSFODNN7EXAMPLE', defect: 'schema' },
    { raw: 'receipt-auditor@example.invalid', defect: 'schema' },
    { raw: 'Bearer synthetic-receipt-token', defect: 'JSON' },
  ])('does not expose $defect parser input through function or CLI errors', async ({ raw, defect }) => {
    const { agentQaRoot, configPath, id, dir } = fixture()
    const receipt = stampReceiptDigest({
      schemaVersion: GATE_RECEIPT_SCHEMA_VERSION, kind: 'promotion', candidateId: id,
      promotionPath: 'deterministic-verdict-floor', citedReceiptDigests: [],
      producedAtOrdinal: 6, producedBy: { opId: 'test' },
    })
    const bytes = defect === 'schema'
      ? `${canonicalJson({ ...receipt, [raw]: 'unexpected' })}\n` : `${raw}\n`
    writeFileSync(join(dir, 'evidence/gates.jsonl'), bytes)
    const host = composeCliLocalAgent({ configPath, agentQaRoot })
    const failure = await invokeFunction(host.registry, 'knowledge.gates.list', { recordId: id }, CLI_FUNCTION_CALLER)
      .then(() => { throw new Error('expected read refusal') }, error => error as Error)
    expect(failure.message).toContain(`evidence/gates.jsonl line 1: invalid ${defect === 'schema' ? 'receipt schema' : 'JSON'}`)
    expect(JSON.stringify({ ...failure, message: failure.message, stack: failure.stack })).not.toContain(raw)
    expect(failure.cause).toBeUndefined()
    for (const args of [[id, '--json'], [id]]) await invoke(configPath, args, failure.message)
    expect(readFileSync(join(dir, 'evidence/gates.jsonl'), 'utf8')).toBe(bytes)
  })

  it('preserves producer-masked sensitive fields and their digests through write, read and JSON output', async () => {
    const { config, configPath, id, dir } = fixture()
    const rawSecret = 'AKIAIOSFODNN7EXAMPLE'
    const rawEmail = 'receipt-auditor@example.invalid'
    // 2026-10-14 (441-14, D-07): the producer masks both values as declared secrets.
    const redactor = new SecretRedactor(new SecretStore({ AWS_441: rawSecret, EMAIL_441: rawEmail }))
    const mask = (text: string): string => redactor.redactString(text)
    const maskedProducer = mask(`review ${rawSecret} by ${rawEmail}`)
    expect(maskedProducer).toBe('review [secret:AWS_441] by [secret:EMAIL_441]')
    const promotion = stampReceiptDigest({
      schemaVersion: GATE_RECEIPT_SCHEMA_VERSION, kind: 'promotion', candidateId: id,
      promotionPath: 'deterministic-verdict-floor', citedReceiptDigests: [],
      producedAtOrdinal: 6, producedBy: { opId: maskedProducer },
    })
    const gate = stampReceiptDigest({
      schemaVersion: GATE_RECEIPT_SCHEMA_VERSION, gate: 3, verdict: 'pass', candidateId: id,
      producedAtOrdinal: 7, producedBy: { jobId: maskedProducer },
      runId: mask(rawSecret), stepId: mask(rawEmail), mark: 'confirmed-bug',
    })
    const { receiptDigest: _digest, ...promotionInput } = promotion
    expect(appendPromotionReceipt(config, id, promotionInput)).toEqual({ kind: 'appended' })
    expect(appendGateReceipt(config, id, gate)).toEqual({ kind: 'appended' })
    expect(readGateReceipts(dir, id)).toEqual([promotion, gate])
    const output = await invoke(configPath, [id, '--json'])
    const dto = KnowledgeGatesListResultSchema.parse(JSON.parse(output))
    expect(dto).toMatchObject({ kind: 'found', lines: [promotion, gate], standing: [gate] })
    expect(output).toContain('[secret:AWS_441]')
    expect(output).toContain('[secret:EMAIL_441]')
    for (const raw of [rawSecret, rawEmail]) {
      expect(output).not.toContain(raw)
      expect(readFileSync(join(dir, 'evidence/gates.jsonl'), 'utf8')).not.toContain(raw)
    }
    expect(verifyBundleIntegrity(dir).ok).toBe(true)
  })

  it('renders schema-valid history, standing and the live verdict over real bundles', async () => {
    const { config, configPath, id } = fixture()
    expect(appendPromotionReceipt(config, id, {
      schemaVersion: GATE_RECEIPT_SCHEMA_VERSION, kind: 'promotion', candidateId: id, promotionPath: 'deterministic-verdict-floor',
      citedReceiptDigests: [], producedAtOrdinal: 6, producedBy: { opId: 'promote' },
    })).toEqual({ kind: 'appended' })
    const score = { baseline: 0.5, candidate: 0.8, delta: 0.3, floor: 0.1, n: 10 }
    const receipt = stampReceiptDigest({ schemaVersion: GATE_RECEIPT_SCHEMA_VERSION, gate: 1, verdict: 'pass',
      candidateId: id, producedAtOrdinal: 7, producedBy: { jobId: 'replay-check' },
      perAxisScore: { headline: score, elementIdentity: score, value: score, opClass: score,
        sideEffect: score, loop: score },
      corpusVersion: { corpusDigest: 'c'.repeat(64), partitionVersion: 2, gateSetSize: 10,
        excludedCount: 0, minimumGateSet: 1 },
      samples: { k: 1, seeds: [1], seedHonored: true, modelCalls: 0 }, crossCheck: 'held',
    })
    expect(appendGateReceipt(config, id, receipt)).toEqual({ kind: 'appended' })
    const dto = KnowledgeGatesListResultSchema.parse(JSON.parse(await invoke(configPath, [id, '--json'])))
    expect(dto.kind).toBe('found')
    if (dto.kind !== 'found') throw new Error('published record not found')
    expect(dto.lines).toHaveLength(2)
    expect(dto.standing).toEqual([receipt])
    expect(dto.strongestPromotionPath).toBe('deterministic-verdict-floor')
    const human = await invoke(configPath, [id])
    expect(human).toContain(`record ${id} · fact · candidate · strongest path: deterministic-verdict-floor`)
    expect(human).toContain('promotion deterministic-verdict-floor @6 by promote cites 0')
    expect(human).toContain(`gate 1 pass @7 by replay-check digest ${receipt.receiptDigest.slice(0, 12)}`)
    expect(human.indexOf('promotion deterministic-verdict-floor')).toBeLessThan(human.indexOf('gate 1 pass'))
    expect(human).toContain('standing:\ngate 1: pass @7\ngate 2: none\ngate 3: none')
    expect(human).toContain(dto.live.verdict === 'promote'
      ? `promote via ${dto.live.promotionPath}` : `held: ${dto.live.reason}`)
  })

  it('shows Gate-2 corpus freshness and promotion receipt identity in human history', async () => {
    const { config, configPath, id } = fixture()
    const gate = stampReceiptDigest({
      schemaVersion: GATE_RECEIPT_SCHEMA_VERSION, gate: 2, verdict: 'pass', candidateId: id,
      producedAtOrdinal: 6, producedBy: { jobId: 'canary-review' },
      attributedObservationId: 'synthetic-observation', corpusVersion: { corpusDigest: 'd'.repeat(64) },
      benefit: 'exercised-benefited', stateValidity: 'valid',
    })
    expect(appendGateReceipt(config, id, gate)).toEqual({ kind: 'appended' })
    expect(appendPromotionReceipt(config, id, {
      schemaVersion: GATE_RECEIPT_SCHEMA_VERSION, kind: 'promotion', candidateId: id,
      promotionPath: 'gate1+gate2', citedReceiptDigests: [gate.receiptDigest],
      producedAtOrdinal: 7, producedBy: { opId: 'promote' },
    })).toEqual({ kind: 'appended' })
    const dto = KnowledgeGatesListResultSchema.parse(JSON.parse(await invoke(configPath, [id, '--json'])))
    if (dto.kind !== 'found') throw new Error('published record not found')
    const human = await invoke(configPath, [id])
    const lines = human.split('\n')
    expect(lines.find(line => line.startsWith('gate 2 pass'))).toContain(`corpus ${gate.corpusVersion.corpusDigest.slice(0, 12)}`)
    expect(lines.find(line => line.startsWith('promotion gate1+gate2'))).toContain(`digest ${dto.lines[1].receiptDigest.slice(0, 12)}`)
  })

  it('reports no gate receipts with the actual live answer and reports not found', async () => {
    const { configPath, id } = fixture()
    const dto = KnowledgeGatesListResultSchema.parse(JSON.parse(await invoke(configPath, [id, '--json'])))
    if (dto.kind !== 'found') throw new Error('published record not found')
    expect(dto.lines).toEqual([])
    expect(await invoke(configPath, [id])).toBe(dto.live.verdict === 'promote'
      ? `no gate receipts; would promote via ${dto.live.promotionPath}`
      : `no gate receipts; held: ${dto.live.reason}`)
    expect(await invoke(configPath, ['missing'])).toBe('record missing: not found')
  })

  it('keeps every verb free of data-layer imports', () => {
    const source = readFileSync(new URL('../commands/knowledge-read.ts', import.meta.url), 'utf8')
    expect(source).toContain('invokeFunction')
    for (const name of DATA_LAYER_PACKAGES) expect(source).not.toContain(name)
  })
})
