// The `eval replay-gate` host. DATA crosses it in both directions: a candidate reader
// projection in, a gate receipt to the leased writer capability out. Eval execution stays
// behind the existing session composition boundary, loaded only when invoked.
import { dirname, resolve } from 'node:path'
import { trustPriorsForHost, type ResolveTrustPriors } from '../curation/trust-priors.js'
import type { KnowledgeReaderPort } from '@vostride/agent-qa-agent'
import {
  createKnowledgeReader,
  LOCAL_CURATION_CAPABILITIES,
  type LocalCurationCapabilities,
} from '@vostride/agent-qa-agent-local'
import {
  GateReceiptSchema,
  receiptDigestOf,
  type GateReceipt,
} from '@vostride/agent-qa-schema'
import { resolveConfiguredKnowledgeRoot } from '../config.js'
import type {
  EvalSession,
  RunReplayGateInput,
  RunReplayGateResult,
} from '../eval-session-composition.js'

export interface ReplayGateHostDeps {
  resolveTrustPriors?: ResolveTrustPriors
  configPath: string
  agentQaRoot: string
  record: boolean
  session: EvalSession
  composition: Omit<
    RunReplayGateInput,
    'injection' | 'committedRoot' | 'agentQaRoot' | 'mask' | 'producedBy'
  >
  reader?: KnowledgeReaderPort
  curation?: Pick<LocalCurationCapabilities, 'recordGateReceipt'> & {
    maintenance: Pick<
      LocalCurationCapabilities['maintenance'],
      'acquireWriterLease' | 'releaseLease'
    >
  }
  runReplayGate?: (input: RunReplayGateInput) => Promise<RunReplayGateResult>
}
export type ReplayGateVerbResult =
  | {
      kind: 'receipt'
      receipt: GateReceipt
      recorded: 'appended' | 'duplicate' | 'dry-run' | 'lease-held' | 'lease-refused'
      lines: string[]
      notices: string[]
      exit: 0 | 1 | 2
    }
  | { kind: 'refused'; refusal: { path: string; reason: string }; notices: string[]; exit: 2 }
export interface ReplayGateHost {
  run(candidateId: string): Promise<ReplayGateVerbResult>
}
function checkedReceipt(value: unknown, candidateId: string): GateReceipt {
  const receipt = GateReceiptSchema.parse(value)
  if (receipt.gate !== 1 || receipt.candidateId !== candidateId ||
    receipt.receiptDigest !== receiptDigestOf(receipt))
    throw new Error('Gate 1 returned a foreign candidate, wrong gate or invalid receipt digest')
  return receipt
}
export function createReplayGateHost(deps: ReplayGateHostDeps): ReplayGateHost {
  const resolveTrustPriors = deps.resolveTrustPriors ?? trustPriorsForHost(deps).resolve
  const configDir = dirname(resolve(deps.configPath))
  const knowledgeRoot = resolveConfiguredKnowledgeRoot(deps.session.config, configDir)
  const reader = deps.reader ?? createKnowledgeReader(() => knowledgeRoot, undefined, resolveTrustPriors)
  const curation = deps.curation ?? LOCAL_CURATION_CAPABILITIES
  async function run(candidateId: string): Promise<ReplayGateVerbResult> {
    const read = reader.candidateInjection
    if (read === undefined) throw new Error('knowledge reader binds no candidateInjection')
    const found = await read.call(reader, { candidateId })
    if (found.kind === 'not-found')
      return {
        kind: 'refused',
        refusal: {
          path: knowledgeRoot,
          reason: `candidate ${candidateId} not found`,
        },
        notices: [],
        exit: 2,
      }
    if (found.injection.candidateId !== candidateId)
      throw new Error('Gate 1 reader returned a foreign candidate')
    const runGate =
      deps.runReplayGate ?? (await import('../eval-session-composition.js')).runReplayGate
    const result = await runGate({
      ...deps.composition,
      injection: found.injection,
      committedRoot: resolve(configDir, 'agent-qa-eval'),
      agentQaRoot: deps.agentQaRoot,
      mask: deps.session.mask,
      producedBy: { opId: 'eval.replay-gate' },
    })
    if (result.kind === 'refused') return { ...result, exit: 2 }
    const receipt = checkedReceipt(result.receipt, candidateId)
    const answer: Extract<ReplayGateVerbResult, { kind: 'receipt' }> = {
      kind: 'receipt',
      receipt,
      lines: result.lines,
      notices: [...result.notices],
      recorded: 'dry-run',
      exit: receipt.verdict === 'pass' ? 0 : receipt.verdict === 'fail' ? 1 : 2,
    }
    if (!deps.record) return answer
    const lease = curation.maintenance.acquireWriterLease(knowledgeRoot)
    if (lease.kind !== 'acquired') {
      answer.recorded = lease.kind === 'held' ? 'lease-held' : 'lease-refused'
      answer.exit = 2
      answer.notices.push(
        lease.kind === 'held'
          ? 'writer lease held by another process; receipt printed, not recorded — re-run when the daemon releases it'
          : `writer lease refused: ${lease.reason}; receipt printed, not recorded`,
      )
      return answer
    }
    try {
      const outcome = await curation.recordGateReceipt({
        resolveTrustPriors,
        receipt,
        lease: { leaseId: lease.leaseId, epoch: lease.epoch },
        knowledgeRoot,
        executionContext: deps.session.executionContext,
        sourceBuildOrdinal: receipt.producedAtOrdinal,
      })
      answer.recorded = outcome.kind
      return answer
    } finally {
      curation.maintenance.releaseLease({ knowledgeRoot, leaseId: lease.leaseId })
    }
  }
  return { run }
}
