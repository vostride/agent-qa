import { DISTILLED_OBSERVATION_SCHEMA_VERSION, GATE_RECEIPT_SCHEMA_VERSION, stampReceiptDigest, type Gate3Receipt, type GateVerdict, type Anchor, type BundleDraft, type DistilledObservation } from '@vostride/agent-qa-schema'
import { publishBundleForTest } from '@vostride/agent-qa-knowledge-local'

export function markReceipt(
  candidateId: string,
  overrides?: { producedAtOrdinal?: number; verdict?: GateVerdict },
): Gate3Receipt {
  return stampReceiptDigest({
    schemaVersion: GATE_RECEIPT_SCHEMA_VERSION, gate: 3, candidateId, verdict: overrides?.verdict ?? 'pass',
    producedAtOrdinal: overrides?.producedAtOrdinal ?? 44, producedBy: { opId: 'test' },
    runId: 'marked-run', mark: 'confirmed-bug',
  })
}

export function createPromotionFloorFixture({ knowledgeRoot }: { knowledgeRoot: string }) {
  function publishHeldCandidate(seed: string) {
    const displayName = `Held checkout ${seed}`
    const normalizedName = displayName.toLowerCase()
    const anchors: Anchor[] = [
      { t: 'el', role: 'button', name: displayName, ordinal: 0 },
      { t: 'page', route: '/checkout' },
      { t: 'selector', literal: `[data-testid="held-checkout-${seed}"]` },
    ]
    const observation: DistilledObservation = {
      schemaVersion: DISTILLED_OBSERVATION_SCHEMA_VERSION,
      step: { naturalKey: `held-checkout-${seed}`, ordinal: 0 },
      platform: 'web',
      element: { naturalKey: `button:${normalizedName}:0` },
      locator: { selector: `[data-testid="held-checkout-${seed}"]` },
      observedAtOrdinal: 42,
    }
    const draft: BundleDraft = {
      kind: 'fact',
      subtype: 'selector',
      anchors,
      scope: { tier: 'product', key: 'storefront' },
      summary: `${displayName} selector`,
      body: `The ${displayName} button was resolved and verified.`,
      distilledEvidenceRef: { id: `held-checkout-${seed}`, sha: 'a'.repeat(64) },
      originStage: 'run-curation',
    }
    const published = publishBundleForTest({
      knowledgeRoot,
      productKey: 'storefront',
      writerLeaseId: 'promotion-floor-fixture',
    }, {
      draft,
      discriminant: {
        kind: 'fact',
        subtype: 'selector',
        elementRef: { role: 'button', name: displayName },
      },
      originClass: 'agent-verified',
      createdAtOrdinal: 42,
      screenStates: [],
      initialEvents: [],
      relations: [],
      provenance: {
        mode: 'run-linked',
        runId: `held-checkout-${seed}-run`,
        testId: `held-checkout-${seed}-test`,
        stepIndex: 0,
        curationJobId: `held-checkout-${seed}-seed`,
        sourceBuildOrdinal: 42,
        authorship: {
          path: 'deterministic-fallback',
          executionContext: 'local-interactive',
        },
      },
      artifacts: [],
      evidenceMarkdown: 'Held pending canonical confirmation.\n',
      distilledObservations: [observation],
    })
    if (published.kind !== 'published') {
      throw new Error(`expected held candidate publish, got ${published.kind}`)
    }
    return { draft, published }
  }

  return { publishHeldCandidate }
}

