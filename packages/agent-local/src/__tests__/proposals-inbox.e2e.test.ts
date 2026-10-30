// A legacy proposal file stays as found, the retired ids are not capabilities, nothing reads it.

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { UnknownFunctionError, invokeFunction } from '@vostride/agent-qa-agent'
import type { JobModelCapability } from '@vostride/agent-qa-agent'
import { publishBundleForTest } from '@vostride/agent-qa-knowledge-local'
import type { BundleStoreConfig } from '@vostride/agent-qa-knowledge-local'
import {
  MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
} from '@vostride/agent-qa-schema'
import type {
  Anchor,
  FunctionCaller,
  KnowledgeChangeOutput,
  MaskedResolvedConfig,
} from '@vostride/agent-qa-schema'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { composeLocalAgent } from '../composition/compose-local-agent.js'
import type { LocalAgentHost } from '../composition/compose-local-agent.js'
import { fileLeftoverKnowledgeProposal } from './leftover-knowledge-proposal.js'

const RETIRED_IDS = [
  'proposals.list',
  'proposals.show',
  'proposals.accept',
  'proposals.reject',
  'knowledge.proposal.apply',
  'config.proposal.apply',
  'config.undo.propose',
] as const

const ANCHOR: Anchor = { t: 'el', role: 'Button', name: 'Checkout' }

const MASKED_CONFIG: MaskedResolvedConfig = {
  schemaVersion: MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
  configPath: '/fixture/agent-qa.config.yaml',
  entries: [],
}

const HUMAN: FunctionCaller = {
  surface: 'test',
  origin: 'human',
}

const MINT_IDENTITY = (filePath: string): string => filePath

const MODEL: JobModelCapability = {
  modelId: 'fixture:inbox-model',
  generate: () => Promise.resolve({ text: 'unused' }),
}

function snapshot(dir: string): Readonly<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const name of readdirSync(dir).sort()) out[name] = readFileSync(join(dir, name), 'utf8')
  return out
}

describe('the composed host leaves legacy proposal files alone', () => {
  let root: string
  let agentQaRoot: string
  let knowledgeRoot: string
  let host: LocalAgentHost
  const hosts: LocalAgentHost[] = []

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'proposals-inbox-e2e-'))
    agentQaRoot = join(root, '.agent-qa')
    knowledgeRoot = join(root, 'agent-qa-knowledge')
    mkdirSync(agentQaRoot, { recursive: true })
    host = compose()
  })

  afterEach(() => {
    for (const composed of hosts.splice(0)) composed.close()
    rmSync(root, { recursive: true, force: true })
  })

  function compose(nowIso?: () => string): LocalAgentHost {
    const composed = composeLocalAgent({
      mask: (text) => text,
      mintQuarantineIdentityPath: MINT_IDENTITY,
      agentQaRoot,
      config: { getMasked: () => Promise.resolve(MASKED_CONFIG) },
      knowledgeRoot: () => knowledgeRoot,
      model: () => MODEL,
      ...(nowIso === undefined ? {} : { clock: { now: nowIso } }),
    })
    hosts.push(composed)
    return composed
  }

  function storeConfig(): BundleStoreConfig {
    return {
      knowledgeRoot,
      productKey: 'Inbox E2E Product',
    }
  }

  /** A real published record, so a proposal below has something real to be about. */
  function publish(summary: string, ordinal: number): string {
    const outcome = publishBundleForTest(storeConfig(), {
      draft: {
        kind: 'fact',
        subtype: 'selector',
        anchors: [ANCHOR],
        scope: { tier: 'product', key: 'inbox-e2e' },
        summary,
        body: `Selecting ${summary} advances to the payment page.`,
        distilledEvidenceRef: { id: `inbox-${summary}`, sha: 'a'.repeat(64) },
        originStage: 'run-curation',
      },
      discriminant: {
        kind: 'fact',
        subtype: 'selector',
        elementRef: { role: 'Button', name: summary },
      },
      originClass: 'agent-verified',
      createdAtOrdinal: ordinal,
      screenStates: [],
      initialEvents: [],
      relations: [],
      provenance: { mode: 'run-linked', runId: 'inbox-e2e', testId: 't', stepIndex: 0 },
      artifacts: [],
    })
    if (outcome.kind !== 'published') throw new Error(`fixture publish failed: ${outcome.kind}`)
    return outcome.id
  }

  async function propose(summary: string, ordinal: number): Promise<{ recordId: string; proposalId: string }> {
    const recordId = publish(summary, ordinal)
    const proposalId = await fileLeftoverKnowledgeProposal({
      agentQaRoot, knowledgeRoot, verb: 'forget', target: { grain: 'record', recordId },
    })
    return { recordId, proposalId }
  }

  it('the composed host lists none of the retired ids and refuses each as unknown', async () => {
    await propose('checkout button', 11)
    const ids = host.registry.list(HUMAN).map((declaration) => declaration.id)
    expect(ids.length).toBeGreaterThan(0)
    expect(RETIRED_IDS.filter((id) => ids.includes(id))).toEqual([])
    for (const id of RETIRED_IDS) {
      await expect(invokeFunction(host.registry, id, {}, HUMAN), id).rejects.toBeInstanceOf(UnknownFunctionError)
    }
  })

  it('a direct change beside a legacy proposal neither reads nor rewrites it', async () => {
    const { recordId } = await propose('checkout button', 11)
    await propose('payment button', 12)
    const inbox = join(agentQaRoot, 'proposals')
    const before = snapshot(inbox)
    expect(Object.keys(before)).toHaveLength(2)

    const changed = await invokeFunction(host.registry, 'knowledge.forget',
      { target: { grain: 'record', recordId } }, HUMAN) as KnowledgeChangeOutput
    expect(changed).toMatchObject({ outcome: 'applied', verb: 'forget', recordIds: [recordId] })

    // A second host composed over the same workspace finds the files exactly as they were.
    compose()
    expect(snapshot(inbox)).toEqual(before)
  })
})
