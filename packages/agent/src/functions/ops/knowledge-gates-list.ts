// One read of a record's committed receipts and live promotion verdict for every function-layer surface.
import { KnowledgeGatesListInputSchema, KnowledgeGatesListResultSchema,
  type KnowledgeGatesListInput, type KnowledgeGatesListResult } from '@vostride/agent-qa-schema'
import type { FunctionSpec } from '../spec.js'

export const KNOWLEDGE_GATES_LIST_FUNCTION_ID = 'knowledge.gates.list'
export class KnowledgeGatesUnboundError extends Error {
  constructor() {
    super('knowledge.gates.list: the knowledge reader port binds no gateReceipts')
    this.name = 'KnowledgeGatesUnboundError'
  }
}
export const knowledgeGatesListSpec: FunctionSpec<KnowledgeGatesListInput, KnowledgeGatesListResult> = {
  id: KNOWLEDGE_GATES_LIST_FUNCTION_ID,
  summary: 'Read a knowledge record’s mark and approval receipts, promotion lines and live promotion verdict.',
  resultKind: 'unary',
  input: KnowledgeGatesListInputSchema,
  output: KnowledgeGatesListResultSchema,
  risk: { name: 'fn:knowledge.gates.list', recognized: true, readOnly: true },
  classify(output) {
    if (output.kind === 'not-found') return { status: 'executed', outcome: 'record not found' }
    return { status: 'executed', outcome: `${output.lines.length} gate line(s); ${output.live.verdict === 'promote'
      ? 'promote via ' + output.live.promotionPath : 'held: ' + output.live.reason}` }
  },
  async invoke(input, deps) {
    if (deps.knowledge.gateReceipts === undefined) throw new KnowledgeGatesUnboundError()
    return deps.knowledge.gateReceipts({ candidateId: input.recordId })
  },
}
