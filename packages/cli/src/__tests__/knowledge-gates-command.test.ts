// real persisted history through the read-only function layer.
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

// Core's run-text output subpath reads no data, so it is the one core specifier a verb may name.
const CORE_OUTPUT_SPECIFIER = "'@vostride/agent-qa-core/run-text-output'"

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
      knowledge: { dir: 'agent-qa-knowledge' },
      use: { mobile: { appState: 'preserve' } },
    }) + '\n')
    writeFileSync(join(root, '.env.secrets.local'), '')
    const agentQaRoot = join(root, '.agent-qa')
    const config: BundleStoreConfig = {
      knowledgeRoot: join(root, 'agent-qa-knowledge'), productKey: 'shop',
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
    // the producer masks both values as declared secrets.
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

  it('renders mark, approval and promotion lines with standing and the live verdict over real bundles', async () => {
    const { config, configPath, id } = fixture()
    expect(appendPromotionReceipt(config, id, {
      schemaVersion: GATE_RECEIPT_SCHEMA_VERSION, kind: 'promotion', candidateId: id, promotionPath: 'deterministic-verdict-floor',
      citedReceiptDigests: [], producedAtOrdinal: 6, producedBy: { opId: 'promote' },
    })).toEqual({ kind: 'appended' })
    const mark = stampReceiptDigest({ schemaVersion: GATE_RECEIPT_SCHEMA_VERSION, gate: 3, verdict: 'pass',
      candidateId: id, producedAtOrdinal: 7, producedBy: { opId: 'runs.mark' },
      runId: 'checkout-run', stepId: 's3', mark: 'confirmed-bug',
    })
    const approval = stampReceiptDigest({ schemaVersion: GATE_RECEIPT_SCHEMA_VERSION, gate: 3, verdict: 'pass',
      candidateId: id, producedAtOrdinal: 8, producedBy: { opId: 'knowledge.review.apply' },
      policyApproval: { proposalId: 'kp_fixture', recordId: id },
    })
    expect(appendGateReceipt(config, id, mark)).toEqual({ kind: 'appended' })
    expect(appendGateReceipt(config, id, approval)).toEqual({ kind: 'appended' })
    const dto = KnowledgeGatesListResultSchema.parse(JSON.parse(await invoke(configPath, [id, '--json'])))
    expect(dto.kind).toBe('found')
    if (dto.kind !== 'found') throw new Error('published record not found')
    expect(dto.lines).toHaveLength(3)
    expect(dto.lines.flatMap(line => 'gate' in line ? [line.gate] : [])).toEqual([3, 3])
    expect(dto.standing).toEqual([approval])
    expect(dto.strongestPromotionPath).toBe('deterministic-verdict-floor')
    const live = dto.live.verdict === 'promote'
      ? `promote via ${dto.live.promotionPath}` : `held: ${dto.live.reason}`
    expect((await invoke(configPath, [id])).split('\n')).toEqual([
      'promotion deterministic-verdict-floor @6 cites none',
      `mark confirmed-bug @7 run checkout-run step s3 digest ${mark.receiptDigest.slice(0, 12)}`,
      `approval proposal kp_fixture @8 digest ${approval.receiptDigest.slice(0, 12)}`,
      'standing: mark none; approval proposal kp_fixture @8',
      `live: ${live}`,
    ])
  })

  it.each([
    { order: 'a mark followed by an approval', markOrdinal: 7, approvalOrdinal: 8 },
    { order: 'an approval followed by a mark', markOrdinal: 8, approvalOrdinal: 7 },
  ])('prints the one standing receipt the JSON reports after $order', async ({ markOrdinal, approvalOrdinal }) => {
    const { config, configPath, id } = fixture()
    const mark = stampReceiptDigest({ schemaVersion: GATE_RECEIPT_SCHEMA_VERSION, gate: 3, verdict: 'fail',
      candidateId: id, producedAtOrdinal: markOrdinal, producedBy: { opId: 'runs.mark' },
      runId: 'checkout-run', mark: 'false-fail',
    })
    const approval = stampReceiptDigest({ schemaVersion: GATE_RECEIPT_SCHEMA_VERSION, gate: 3, verdict: 'pass',
      candidateId: id, producedAtOrdinal: approvalOrdinal, producedBy: { opId: 'knowledge.review.apply' },
      policyApproval: { proposalId: 'kp_fixture', recordId: id },
    })
    const [first, second] = markOrdinal < approvalOrdinal ? [mark, approval] : [approval, mark]
    expect(appendGateReceipt(config, id, first)).toEqual({ kind: 'appended' })
    expect(appendGateReceipt(config, id, second)).toEqual({ kind: 'appended' })
    const dto = KnowledgeGatesListResultSchema.parse(JSON.parse(await invoke(configPath, [id, '--json'])))
    if (dto.kind !== 'found') throw new Error('published record not found')
    expect(dto.standing).toEqual([second])
    const standingLine = (await invoke(configPath, [id])).split('\n').find(line => line.startsWith('standing: '))
    expect(standingLine).toBe(second === mark
      ? `standing: mark false-fail @${markOrdinal}; approval none`
      : `standing: mark none; approval proposal kp_fixture @${approvalOrdinal}`)
  })

  it('shows a mark and the promotion it cites in human history', async () => {
    const { config, configPath, id } = fixture()
    const gate = stampReceiptDigest({
      schemaVersion: GATE_RECEIPT_SCHEMA_VERSION, gate: 3, verdict: 'pass', candidateId: id,
      producedAtOrdinal: 6, producedBy: { opId: 'runs.mark' }, runId: 'marked-run', mark: 'false-fail',
    })
    expect(appendGateReceipt(config, id, gate)).toEqual({ kind: 'appended' })
    expect(appendPromotionReceipt(config, id, {
      schemaVersion: GATE_RECEIPT_SCHEMA_VERSION, kind: 'promotion', candidateId: id,
      promotionPath: 'user-sovereign', citedReceiptDigests: [gate.receiptDigest],
      producedAtOrdinal: 7, producedBy: { opId: 'promote' },
    })).toEqual({ kind: 'appended' })
    const dto = KnowledgeGatesListResultSchema.parse(JSON.parse(await invoke(configPath, [id, '--json'])))
    if (dto.kind !== 'found') throw new Error('published record not found')
    const lines = (await invoke(configPath, [id])).split('\n')
    const digest = gate.receiptDigest.slice(0, 12)
    expect(lines.slice(0, 3)).toEqual([
      `mark false-fail @6 run marked-run digest ${digest}`,
      `promotion user-sovereign @7 cites ${digest}`,
      'standing: mark false-fail @6; approval none',
    ])
    expect(lines[3]).toBe(dto.live.verdict === 'promote'
      ? `live: promote via ${dto.live.promotionPath}` : `live: held: ${dto.live.reason}`)
    expect(lines).toHaveLength(4)
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
    const withoutOutputSpecifier = (text: string): string =>
      text.replaceAll(CORE_OUTPUT_SPECIFIER, '')
    for (const name of DATA_LAYER_PACKAGES) {
      expect(withoutOutputSpecifier(source)).not.toContain(name)
      const planted = `import { x } from '${name}'\n${source}`
      expect(withoutOutputSpecifier(planted)).toContain(name)
    }
  })
})
