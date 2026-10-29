// The hash must notice a write, or an invariance assertion over it passes forever.

import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

import type { Anchor, BundleDraft } from '@vostride/agent-qa-schema'
import { asRunId, asRecordId, asEvidenceToken, type KnowledgeMarkInput, IMPROVEMENT_PLAN_SCHEMA_VERSION } from '@vostride/agent-qa-schema'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { publishBundle, type BundleStoreConfig } from '../../bundle-publish.test-helper.js'
import {
  makeBundleDraftFixture,
  makeScreenStateFixture,
  scaffoldKnowledgeRoot,
} from '../../__tests__/fixtures/bundle-fixture.js'
import { applyExplicitReview } from '../apply-review.js'
import type { ExplicitReviewRequest } from '../apply-review.js'
import {
  MarkPlanIntegrityError,
  resolveReviewTarget,
  reviewDeltasFor,
} from '../propose-review.js'

const ANCHOR: Anchor = { t: 'el', role: 'Button', name: 'Checkout' }

/**
 * A content hash of every regular file under a directory tree, path-relative and sorted.
 *
 * Paths are part of the digest, not just contents: a propose that created an empty marker file
 * or renamed a bundle directory would leave every byte of content identical, and a
 * contents-only digest would call that "unchanged".
 */
function hashTree(root: string): string {
  const digest = createHash('sha256')
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        digest.update(`D:${relative(root, path)}\n`)
        walk(path)
        continue
      }
      digest.update(`F:${relative(root, path)}:${statSync(path).size}:`)
      digest.update(readFileSync(path))
      digest.update('\n')
    }
  }
  walk(root)
  return digest.digest('hex')
}

describe('a change computes its target and deltas, and a refused change writes nothing', () => {
  let root: string
  let knowledgeRoot: string
  let agentQaRoot: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'knowledge-review-propose-'))
    knowledgeRoot = join(root, 'agent-qa-knowledge')
    agentQaRoot = join(root, '.agent-qa')
    scaffoldKnowledgeRoot(knowledgeRoot)
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function storeConfig(product: string): BundleStoreConfig {
    return {
      knowledgeRoot,
      productKey: product,
    }
  }

  function publish(summary: string, overrides: Partial<BundleDraft> = {}): string {
    const outcome = publishBundle(storeConfig('Review Product'), {
      draft: makeBundleDraftFixture({
        kind: 'fact',
        anchors: [ANCHOR],
        scope: { tier: 'product', key: 'review-storefront' },
        summary,
        ...overrides,
      }),
      discriminant: {
        kind: 'fact',
        subtype: 'selector',
        elementRef: { role: 'Button', name: summary },
      },
      originClass: 'agent-verified',
      createdAtOrdinal: 10,
      screenStates: [makeScreenStateFixture()],
      initialEvents: [],
      relations: [],
      provenance: {
        mode: 'run-linked',
        runId: `review-${summary}`,
        testId: 'review-test',
        stepIndex: 0,
      },
      artifacts: [],
    })
    if (outcome.kind !== 'published') throw new Error(`fixture publish failed: ${outcome.kind}`)
    return outcome.id
  }

  function markInput(recordId: string): KnowledgeMarkInput {
    const runId = asRunId('review-mark-run')
    const target = { grain: 'record' as const, recordId }
    const mark = { markId: 'mark_0123456789ab', runId, testIndex: 0,
      kind: 'false-fail' as const, fix: 'fact' as const }
    const scope = { tier: 'product' as const, key: 'review-storefront' }
    return { target, mark, plan: { schemaVersion: IMPROVEMENT_PLAN_SCHEMA_VERSION, markId: mark.markId, kind: 'knowledge',
      fix: 'fact', target, wording: 'floor', feedbackSource: { runId, testIndex: 0, kind: mark.kind },
      runTraceRef: { runId, runSlug: runId }, deltas: [{ kind: 'Supersede', origin: 'user', scope,
        citedIds: [asRecordId(recordId)], victimId: asRecordId(recordId),
        evidenceToken: asEvidenceToken(`mark:${mark.markId}`),
        newBundle: makeBundleDraftFixture({ scope, anchors: [ANCHOR] }),
      }] } }
  }

  let changes = 0
  async function change(request: ExplicitReviewRequest, resolveBundleShortId?: (shortId: string) => string | undefined) {
    changes += 1
    return await applyExplicitReview({ agentQaRoot, knowledgeRoot, operationId: `propose-apply-${changes}`,
      opId: request.verb === 'mark' ? 'runs.mark' : `knowledge.${request.verb}`,
      executionContext: 'local-interactive', request,
      ...(resolveBundleShortId === undefined ? {} : { resolveBundleShortId }) })
  }

  it.each(['origin', 'citation', 'scope', 'stamp', 'target'] as const)(
    'refuses a mark plan with invalid %s before writing', async (field) => {
      const input = markInput(publish('checkout button'))
      if (field === 'origin') input.plan.deltas[0]!.origin = 'agent'
      if (field === 'citation') input.plan.deltas[0]!.citedIds = [asRecordId('foreign-record')]
      if (field === 'scope') input.plan.deltas[0]!.scope = { tier: 'global', key: 'global' }
      if (field === 'stamp') input.mark.markId = 'mark_abcdefabcdef'
      if (field === 'target') input.plan.target = { grain: 'record', recordId: 'foreign-record' }
      const before = hashTree(join(knowledgeRoot, 'memory'))
      await expect(change({ verb: 'mark', input })).rejects.toThrow(MarkPlanIntegrityError)
      expect(existsSync(join(agentQaRoot, 'proposals'))).toBe(false)
      expect(hashTree(join(knowledgeRoot, 'memory'))).toBe(before)
    })

  it('POTENCY CONTROL: the tree hash notices a single byte written into the knowledge root', () => {
    publish('checkout button')
    const before = hashTree(knowledgeRoot)
    writeFileSync(join(knowledgeRoot, 'a-single-byte'), 'x', 'utf8')
    // If this were equal, every invariance assertion in this file would be measuring nothing.
    expect(hashTree(knowledgeRoot)).not.toBe(before)
    rmSync(join(knowledgeRoot, 'a-single-byte'))
    expect(hashTree(knowledgeRoot)).toBe(before)
  })

  it('forget tombstones the same record through a bundle ref and a record ref alike', async () => {
    const recordId = publish('checkout button')
    const resolved = resolveReviewTarget(knowledgeRoot, { grain: 'bundle', shortId: 'MEM-001' },
      (shortId) => (shortId === 'MEM-001' ? recordId : undefined))
    expect(resolved?.recordId).toBe(recordId)
    expect(resolveReviewTarget(knowledgeRoot, { grain: 'record', recordId })?.recordId).toBe(recordId)

    const byBundle = await change({ verb: 'forget', input: { target: { grain: 'bundle', shortId: 'MEM-001' } } },
      (shortId) => (shortId === 'MEM-001' ? recordId : undefined))
    if (byBundle.outcome !== 'applied') throw new Error(`forget by bundle did not apply: ${byBundle.outcome}`)
    // Provenance is REQUIRED on every tombstoned record: a receipt listing an id with no provenance
    // is a list nobody can act on.
    expect(byBundle.forgetReceipt?.tombstonedRecords.map((row) => row.recordId)).toEqual([recordId])
    expect(byBundle.forgetReceipt?.tombstonedRecords[0]?.provenance.mode).toBe('run-linked')
  })

  it('accept and reject compute a user Confirm and a reasoned Deprecate, and carry no tombstones', () => {
    const recordId = publish('checkout button')
    const resolved = resolveReviewTarget(knowledgeRoot, { grain: 'record', recordId })
    if (resolved === undefined) throw new Error('the fixture record must resolve')
    const accept = reviewDeltasFor({ verb: 'accept', input: { target: { grain: 'record', recordId } } },
      resolved, 'prop_propose-apply-accept')
    const reject = reviewDeltasFor({ verb: 'reject', input: { target: { grain: 'record', recordId },
      reason: 'superseded by a newer selector' } }, resolved, 'prop_propose-apply-reject')

    expect(accept.map((delta) => delta.kind)).toEqual(['Confirm'])
    expect(reject.map((delta) => delta.kind)).toEqual(['Deprecate'])
    // The reject's reason travels into the delta rather than being invented at commit time.
    expect((reject[0] as { reason?: string }).reason).toBe('superseded by a newer selector')
    // origin `user`: a review verb records that a PERSON decided, and `agent` is the origin
    // disposition's autonomy floor downgrades precisely so an agent cannot decide for itself.
    expect(accept[0]?.origin).toBe('user')
    // The accept's evidence is the change identity, so a retried change is the same token.
    expect((accept[0] as { evidenceToken?: string }).evidenceToken).toBe('review-accept:prop_propose-apply-accept')
  })

  it('answers a typed not-found for an unknown target — never a throw', async () => {
    publish('checkout button')
    const before = hashTree(join(knowledgeRoot, 'memory'))

    const missingRecord = await change({ verb: 'accept', input: { target: { grain: 'record', recordId: 'rec-nope' } } })
    expect(missingRecord).toMatchObject({
      outcome: 'target-not-found',
      target: { grain: 'record', recordId: 'rec-nope' },
    })

    // A short-ID nothing resolves is the same answer, and it must not fall through to a scan:
    // no resolver is supplied at all here.
    const missingBundle = await change({ verb: 'forget', input: { target: { grain: 'bundle', shortId: 'MEM-404' } } })
    expect(missingBundle.outcome).toBe('target-not-found')

    // Nothing was written for either, and nothing was filed.
    expect(hashTree(join(knowledgeRoot, 'memory'))).toBe(before)
    expect(existsSync(join(agentQaRoot, 'proposals'))).toBe(false)
  })
})
