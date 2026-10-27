import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { AuthoringReadPort } from '@vostride/agent-qa-agent'
import {
  BundleOutcomeEventSchema,
  canonicalJson,
  normalizeAnchor,
  type Anchor,
  type BundleDraft,
  type BundleOutcomeEvent,
  type BundleProvenance,
  type ScopeKey,
} from '@vostride/agent-qa-schema'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  applyRunOutcomes,
  createAuthoringReader,
  openIndexWriter,
  rebuildIndex,
  type BundleStoreConfig,
  type RunOutcomesProjection,
} from '../index.js'
import { publishBundle } from '../bundle-publish.test-helper.js'
import {
  makeBundleDraftFixture,
  makeProcedureBundleDraftFixture,
} from './fixtures/bundle-fixture.js'

const PRODUCT = 'authoring-storefront'
const SCOPE: ScopeKey = { tier: 'product', key: PRODUCT }
const INTENT = 'sign in with recorded credentials on /login'
const LOGIN_PAGE: Anchor = { t: 'page', route: '/login' }

function events(
  type: 'confirmed' | 'promoted',
  key: string,
  count = 1,
): BundleOutcomeEvent[] {
  return Array.from({ length: count }, (_, index) =>
    BundleOutcomeEventSchema.parse({
      type,
      evidenceToken: `${type}-${key}-${index}`,
      curationJobId: `job-${key}-${index}`,
      buildOrdinal: 10 + index,
      ...(type === 'promoted' ? {} : { origin: 'agent-verified' }),
    }))
}

function runLinkedProvenance(): BundleProvenance {
  return {
    schemaVersion: 1,
    mode: 'run-linked',
    originClass: 'agent-verified',
    runId: 'run-authoring-acceptance',
    testId: 'test-authoring-acceptance',
    stepIndex: 0,
    authorship: {
      path: 'llm',
      model: { id: 'claude-sonnet-4' },
      executionContext: 'local-interactive',
    },
  }
}

describe('createAuthoringReader through the public barrels (375-08 idiom)', () => {
  let root: string
  let knowledgeRoot: string

  beforeEach(() => {
    root = join(tmpdir(), `authoring-port-acceptance-${randomUUID()}`)
    knowledgeRoot = join(root, 'agent-qa-knowledge')
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function storeConfig(): BundleStoreConfig {
    return {
      knowledgeRoot,
      productKey: PRODUCT,
      writerLeaseId: 'authoring-acceptance',
    }
  }

  function seed(options: {
    key: string
    draft: BundleDraft
    discriminant: Parameters<typeof publishBundle>[1]['discriminant']
    initialEvents: BundleOutcomeEvent[]
    provenance?: BundleProvenance
  }): string {
    const outcome = publishBundle(storeConfig(), {
      draft: options.draft,
      discriminant: options.discriminant,
      originClass: 'agent-verified',
      createdAtOrdinal: 10,
      screenStates: [],
      initialEvents: options.initialEvents,
      relations: [],
      provenance: options.provenance
        ?? { mode: 'standalone', sourceDescription: 'authoring acceptance fixture' },
      artifacts: [],
      evidenceMarkdown: `Evidence for ${options.key}.\n`,
    })
    if (outcome.kind !== 'published') {
      throw new Error(`expected ${options.key} publication, got ${outcome.kind}`)
    }
    return String(outcome.id)
  }

  async function seedStore(): Promise<{ procedureId: string }> {
    seed({
      key: 'fact',
      draft: makeBundleDraftFixture({ scope: SCOPE }),
      discriminant: {
        kind: 'fact',
        subtype: 'selector',
        elementRef: { role: 'Button', name: 'Sign in' },
      },
      initialEvents: events('promoted', 'fact'),
    })
    seed({
      key: 'caution',
      draft: makeBundleDraftFixture({
        kind: 'caution',
        anchors: [LOGIN_PAGE],
        scope: SCOPE,
        summary: 'Sign in rate limit locks the login account after three attempts',
      }),
      discriminant: { kind: 'caution', errorKey: 'sign-in rate limit' },
      initialEvents: events('promoted', 'caution'),
    })
    const procedureId = seed({
      key: 'procedure',
      draft: makeProcedureBundleDraftFixture({ scope: SCOPE }),
      discriminant: {
        kind: 'procedure',
        flowName: 'Sign in flow',
        stepSignature: 'email>password>submit',
      },
      initialEvents: events('confirmed', 'procedure', 2),
      provenance: runLinkedProvenance(),
    })
    await rebuildIndex({ knowledgeRoot })
    return { procedureId }
  }

  function seedProjection(): void {
    const projection: RunOutcomesProjection = {
      product: PRODUCT,
      scope: SCOPE,
      runId: 'run-authoring-acceptance',
      buildOrdinal: 12,
      excluded: false,
      tests: [{
        filePath: 'auth/sign-in.spec.ts',
        testName: 'signs in with recorded credentials',
        passed: true,
        heals: 0,
        flake: false,
        anchorKeys: [canonicalJson(normalizeAnchor(LOGIN_PAGE))],
      }],
      // 393 D-15: this fixture seeds the OUTCOME counters only. The suite-fingerprint deltas ride
      // the same projection now, and an empty list is the honest value for a hand-built projection
      // that carries no step evidence to derive elements from.
      fingerprints: [],
    }
    const writer = openIndexWriter(knowledgeRoot)
    try {
      applyRunOutcomes(writer.db, projection)
    } finally {
      writer.close()
    }
  }

  it('satisfies AuthoringReadPort and answers a screenless query over a committed store', async () => {
    const { procedureId } = await seedStore()
    seedProjection()

    // Compile-time acceptance: the knowledge-local impl satisfies the agent-side port type.
    const reader: AuthoringReadPort = createAuthoringReader({
      knowledgeRoot,
      product: PRODUCT,
    })

    const brief = await reader.getAuthoringBrief(INTENT, SCOPE)

    expect(brief.facts.length).toBeGreaterThan(0)
    expect(brief.cautions.map(({ summary }) => summary).join('\n'))
      .toContain('rate limit')
    expect(brief.procedures.map(({ id }) => String(id))).toContain(procedureId)
    expect(brief.exemplars).toContainEqual(expect.objectContaining({
      filePath: 'auth/sign-in.spec.ts',
      testName: 'signs in with recorded credentials',
      unverifiedOutcomes: false,
      passRate: 1,
    }))
    expect(brief.coverage).toEqual({})
    expect(brief.admissions.length).toBeGreaterThan(0)

    const again = await reader.getAuthoringBrief(INTENT, SCOPE)
    expect(canonicalJson(again)).toBe(canonicalJson(brief))
  })

  it('serves discovered never-run tests beside projection-backed exemplars without duplicates', async () => {
    await seedStore()
    seedProjection()
    const duplicate = {
      filePath: 'auth/sign-in.spec.ts',
      testName: 'signs in with recorded credentials',
    }
    const neverRun = {
      filePath: 'auth/password-reset.spec.ts',
      testName: 'signs in after password reset',
    }
    const reader = createAuthoringReader(
      { knowledgeRoot, product: PRODUCT },
      { discoverKnownTests: () => [duplicate, neverRun, neverRun] },
    )

    const brief = await reader.getAuthoringBrief(INTENT, SCOPE)

    expect(brief.exemplars.filter(({ filePath, testName }) => (
      filePath === duplicate.filePath && testName === duplicate.testName
    ))).toEqual([expect.objectContaining({
      unverifiedOutcomes: false,
      passRate: 1,
    })])
    expect(brief.exemplars.filter(({ filePath, testName }) => (
      filePath === neverRun.filePath && testName === neverRun.testName
    ))).toEqual([expect.objectContaining({
      unverifiedOutcomes: true,
      excerpt: expect.stringContaining('unverified-outcomes'),
    })])
  })

  it('serves an identity-only discovery universe when the outcome projection is empty', async () => {
    const knownTests = [
      {
        filePath: 'auth/never-run-sign-in.spec.ts',
        testName: 'sign in with a newly issued credential',
      },
      {
        filePath: 'auth/pruned-login.spec.ts',
        testName: 'sign in after a password reset',
      },
    ]
    const reader = createAuthoringReader(
      {
        knowledgeRoot: join(root, 'missing-knowledge-root'),
        product: PRODUCT,
      },
      { discoverKnownTests: () => knownTests },
    )

    const brief = await reader.getAuthoringBrief(INTENT, SCOPE)

    expect(brief.exemplars).toHaveLength(2)
    expect(brief.exemplars.map(({ filePath, testName }) => ({ filePath, testName })))
      .toEqual(expect.arrayContaining(knownTests))
    expect(brief.exemplars.every(({ unverifiedOutcomes }) => unverifiedOutcomes)).toBe(true)
    expect(brief.exemplars.every(({ excerpt }) => excerpt.includes('unverified-outcomes')))
      .toBe(true)
  })

  it('answers a cold store with empty buckets, typed-empty coverage, and no error', async () => {
    const reader = createAuthoringReader({
      knowledgeRoot: join(root, 'missing-knowledge-root'),
      product: PRODUCT,
    })

    const brief = await reader.getAuthoringBrief(INTENT, SCOPE)

    expect(brief.exemplars).toEqual([])
    expect(brief.procedures).toEqual([])
    expect(brief.facts).toEqual([])
    expect(brief.cautions).toEqual([])
    expect(brief.coverage).toEqual({})
    expect(brief.truncation).toBe('')
    expect(brief.admissions).toEqual([])
  })
})
