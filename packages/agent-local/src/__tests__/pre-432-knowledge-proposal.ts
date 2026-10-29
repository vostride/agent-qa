// A legacy knowledge proposal, planted as the bytes the deleted store wrote under `proposals/`.

import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { KnowledgeTargetRef } from '@vostride/agent-qa-schema'

export type Pre432KnowledgeVerb = 'accept' | 'reject' | 'forget'

export interface FilePre432KnowledgeProposalInput {
  readonly agentQaRoot: string
  /** Kept for the callers' shape; a planted file reads nothing from the knowledge root. */
  readonly knowledgeRoot?: string
  readonly verb: Pre432KnowledgeVerb
  readonly target: KnowledgeTargetRef
  /** Recorded on a reject, as the retired op's input contract required it. */
  readonly reason?: string
  readonly runId?: string
}

/** Plant one legacy knowledge proposal file and answer its id. */
export async function filePre432KnowledgeProposal(input: FilePre432KnowledgeProposalInput): Promise<string> {
  const proposalId = `prop_${randomUUID()}`
  const proposedAt = 1_700_000_000_000
  const record = {
    schemaVersion: 1,
    id: proposalId,
    kind: 'knowledge',
    origin: {
      emittedBy: `knowledge.${input.verb}.propose`,
      ...(input.runId === undefined ? {} : { runId: input.runId }),
      at: proposedAt,
    },
    payload: {
      schemaVersion: 1,
      proposalId,
      verb: input.verb,
      targetRef: input.target,
      deltas: [],
      ...(input.verb === 'reject' ? { reason: input.reason ?? 'rejected' } : {}),
      proposedAt,
      status: 'pending',
    },
  }
  const dir = join(input.agentQaRoot, 'proposals')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${proposalId}.json`), `${JSON.stringify(record, undefined, 2)}\n`, 'utf8')
  return await Promise.resolve(proposalId)
}
