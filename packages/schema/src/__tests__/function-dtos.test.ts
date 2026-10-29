// the seed function-layer DTOs plans 03/04 bind their ops to.
//
// Three properties are pinned here, one per plan behavior:
//  1. every exported function DTO schema is `.strict()` — an unknown key is a rejection,
//     never a silently-carried field crossing a surface boundary;
//  2. RunsStartInputSchema surfaces the D-10 `gateRun` carrier as an optional literal;
//  3. every exported function DTO schema projects to JSON Schema — the guarantee
//     396's MCP tool catalog and 397's golden snapshot are both derived from.
//
// Imports come through the package barrel chain (`../index`) rather than the package name:
// it is the same module the name resolves to, and it exercises the SOURCE barrel instead of
// a possibly-stale `dist`.
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import {
  ConfigGetInputSchema,
  KnowledgeBundleSummarySchema,
  KnowledgeBundlesListInputSchema,
  MaskedResolvedConfigSchema,
  RunDetailSchema,
  RunEventEnvelopeSchema,
  RunsEventsInputSchema,
  RunStartAcknowledgementSchema,
  RunsGetInputSchema,
  RunsListInputSchema,
  RunsStartInputSchema,
  RunSummarySchema,
  MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
} from '../index'

const DECLARED_MARKER = '[secret:PW_441]'

/** The complete exported function-DTO schema set, by the name the barrel publishes. */
const functionSchemas: Record<string, z.ZodType> = {
  RunSummarySchema,
  RunsListInputSchema,
  RunDetailSchema,
  RunsGetInputSchema,
  RunsStartInputSchema,
  RunsEventsInputSchema,
  RunStartAcknowledgementSchema,
  RunEventEnvelopeSchema,
  KnowledgeBundleSummarySchema,
  KnowledgeBundlesListInputSchema,
  MaskedResolvedConfigSchema,
  ConfigGetInputSchema,
}

function makeRunDetail() {
  return {
    runId: 'run-abc',
    scope: { tier: 'suite', key: 'checkout' },
    buildOrdinal: 12,
    executionContext: 'ci',
    aggregateVerdict: 'failed',
    configDigests: { suiteConfigDigest: 'suite-d', testConfigDigest: 'test-d' },
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_010_000,
    tests: [
      {
        testId: 'checkout-guest-1',
        testName: 'Guest checkout with promo',
        filePath: 'checkout.spec.yaml',
        testIndex: 0,
        outcome: 'failed',
        stepCount: 3,
        rootCause: {
          class: 'app_bug',
          producer: 'analyze-run',
          confidence: 0.8,
          rationale: 'promo code rejected on a valid cart',
        },
      },
    ],
  }
}

function makeBundleSummary() {
  return {
    bundleId: 'fact-el-cart-button-0123456789abcdef',
    product: 'storefront',
    dir: 'memory/storefront/bundles/fact-el-cart-button-0123456789abcdef',
    kind: 'fact',
    subtype: 'selector',
    scope: { tier: 'product', key: 'storefront' },
    status: 'active',
    trust: 0.82,
    counters: { confirmed: 4, contradicted: 0, helpful: 2, harmful: 0 },
    openedAtOrdinal: 7,
    lastConfirmedOrdinal: 41,
    summary: 'Cart button on checkout',
    evidenceIncomplete: false,
  }
}

function makeMaskedConfig() {
  return {
    schemaVersion: MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
    configPath: 'agent-qa.config.yaml',
    entries: [
      { key: 'use.browser.headless', value: 'true', source: 'config-file', masked: false },
      { key: 'llm.apiKey', value: DECLARED_MARKER, source: 'env', masked: true },
    ],
  }
}

describe('function DTO schemas are strict', () => {
  it('rejects an unknown key on every exported function DTO schema', () => {
    for (const [name, schema] of Object.entries(functionSchemas)) {
      const parsed = schema.safeParse({ definitelyNotAField: 1 })
      expect(parsed.success, `${name} admitted an unknown key`).toBe(false)
    }
  })

  it('accepts the canonical valid document for each result DTO', () => {
    expect(RunDetailSchema.parse(makeRunDetail()).runId).toBe('run-abc')
    expect(KnowledgeBundleSummarySchema.parse(makeBundleSummary()).status).toBe('active')
    expect(MaskedResolvedConfigSchema.parse(makeMaskedConfig()).entries).toHaveLength(2)
  })

  it('carries the two run markers as optional literals on RunDetail', () => {
    const ordinary = RunDetailSchema.parse(makeRunDetail())
    const gate = RunDetailSchema.parse({ ...makeRunDetail(), gateRun: true })

    expect('gateRun' in ordinary).toBe(false)
    expect(gate.gateRun).toBe(true)
    expect(RunDetailSchema.safeParse({ ...makeRunDetail(), gateRun: false }).success).toBe(false)
  })

  // a masked entry's value is its declared marker; the config placeholder is deleted.
  it('keeps every masked config entry declaring whether the declared mask changed its value', () => {
    const parsed = MaskedResolvedConfigSchema.parse(makeMaskedConfig())
    const secret = parsed.entries.find((entry) => entry.key === 'llm.apiKey')

    expect(secret?.masked).toBe(true)
    expect(secret?.value).toBe(DECLARED_MARKER)
  })

  it('takes no arguments on the two listing ops', () => {
    expect(RunsListInputSchema.parse({})).toEqual({})
    expect(KnowledgeBundlesListInputSchema.parse({})).toEqual({})
    expect(ConfigGetInputSchema.parse({})).toEqual({})
  })
})

describe('runs op inputs', () => {
  it('accepts the gateRun carrier on the runs.start input and rejects unknown keys', () => {
    expect(RunsStartInputSchema.parse({ gateRun: true }).gateRun).toBe(true)
    expect('gateRun' in RunsStartInputSchema.parse({})).toBe(false)
    expect(RunsStartInputSchema.safeParse({ gateRun: false }).success).toBe(false)
    expect(RunsStartInputSchema.safeParse({ gate_run: true }).success).toBe(false)
  })

  it('requires a runId on runs.get', () => {
    expect(RunsGetInputSchema.parse({ runId: 'run-abc' }).runId).toBe('run-abc')
    expect(RunsGetInputSchema.safeParse({}).success).toBe(false)
  })

  it('admits a recorded bus envelope as the runs.events stream element', () => {
    const recorded = {
      seq: 4,
      ts: 1_700_000_000_004,
      runId: 'run-abc',
      type: 'stepFinalized',
      payload: { testIndex: 0, stepIndex: 1 },
    }

    expect(RunEventEnvelopeSchema.parse(recorded).seq).toBe(4)
    // `seq` is the resume token, so it is never zero and never fractional.
    expect(RunEventEnvelopeSchema.safeParse({ ...recorded, seq: 0 }).success).toBe(false)
    expect(RunEventEnvelopeSchema.safeParse({ ...recorded, type: 'notAnEvent' }).success).toBe(false)
  })

  it('takes an optional non-negative lastEventId resume token on runs.events', () => {
    expect(RunsEventsInputSchema.parse({ runId: 'run-abc' }).lastEventId).toBeUndefined()
    expect(RunsEventsInputSchema.parse({ runId: 'run-abc', lastEventId: 12 }).lastEventId).toBe(12)
    expect(RunsEventsInputSchema.safeParse({ runId: 'run-abc', lastEventId: -1 }).success).toBe(false)
    expect(RunsEventsInputSchema.safeParse({ runId: 'run-abc', lastEventId: 1.5 }).success).toBe(false)
  })
})

describe('JSON-Schema projectability', () => {
  it('projects every exported function DTO schema without throwing', () => {
    for (const [name, schema] of Object.entries(functionSchemas)) {
      // `io: 'input'` is the wire projection: the branded-RunId schemas carry a
      // `.transform(asRunId)`, and zod refuses to represent a transform in its default
      // output mode. Branding is type-level only, so the input projection is the exact
      // JSON shape a surface sends and receives.
      expect(() => z.toJSONSchema(schema, { io: 'input' }), name).not.toThrow()
      const projected = z.toJSONSchema(schema, { io: 'input' }) as { type?: string }
      expect(projected.type, name).toBe('object')
    }
  })
})
