import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { AGENT_QA_TOOL_PROJECTIONS } from '@vostride/agent-qa-mcp'
import {
  AgentQaAnalyticsEventSchema,
  ANALYTICS_EVENT_MEMBERS,
  ANALYTICS_EVENT_NAMES,
  ANALYTICS_EVENT_SCHEMA_BY_NAME,
  ANALYTICS_MCP_TOOL_NAMES,
  assertNoUnconstrainedStrings,
  RETIRED_V33_EVENT_NAMES,
} from '../events.js'
import type { AnalyticsEventName } from '../events.js'
import { sourceModulesContaining, withoutComments } from './source-scan.js'

describe('the closed event union and its membership', () => {
  it('is the declared membership and nothing else, pinned by equality', () => {
    expect([...ANALYTICS_EVENT_NAMES]).toEqual([
      'agent-qa.test_run.completed',
      'agent-qa.suite_run.completed',
      'agent-qa.chat.session.completed',
      'agent-qa.chat.turn.completed',
      'agent-qa.daemon.job.completed',
      'agent-qa.mcp.server.lifecycle',
      'agent-qa.mcp.tool.invoked',
      'agent-qa.init.completed',
      'agent-qa.explain.answered',
      'agent-qa.explain.abstained',
    ])
  })

  // Retired names are listed, so a deliberate re-add differs from a forgotten member.
  it('carries the retired v33 names as a closed constant, disjoint from membership', () => {
    expect([...RETIRED_V33_EVENT_NAMES]).toEqual([
      'agent-qa.analytics.initialized',
      'agent-qa.analytics.test_event',
      'agent-qa.dashboard.opened',
      'agent-qa.dashboard.live_mode.started',
      'agent-qa.dashboard.entity.created',
    ])

    for (const retired of RETIRED_V33_EVENT_NAMES) {
      expect(ANALYTICS_EVENT_NAMES as readonly string[]).not.toContain(retired)
    }
  })

  it('the schema table covers the membership in BOTH directions', () => {
    expect(Object.keys(ANALYTICS_EVENT_SCHEMA_BY_NAME).sort()).toEqual([...ANALYTICS_EVENT_NAMES].sort())
    expect(ANALYTICS_EVENT_MEMBERS.length).toBe(ANALYTICS_EVENT_NAMES.length)
  })

  // PRODUCED, NOT RETYPED. The tool-name vocabulary is the one `mapping.ts` declares; a hand-copied
  // list here would be a second catalogue of tool names, drifting the moment one is renamed.
  it('the tool-invocation vocabulary is the mapping table, both directions', () => {
    expect([...ANALYTICS_MCP_TOOL_NAMES].sort()).toEqual(
      AGENT_QA_TOOL_PROJECTIONS.map((projection) => projection.name).sort(),
    )
    expect(ANALYTICS_MCP_TOOL_NAMES.length).toBe(20)
    expect(ANALYTICS_MCP_TOOL_NAMES).toContain('agent_qa_change_knowledge')
    expect(ANALYTICS_MCP_TOOL_NAMES).toContain('agent_qa_change_config')
    for (const retired of [
      'agent_qa_propose_knowledge_change', 'agent_qa_propose_config_change', 'agent_qa_apply_proposal',
      'agent_qa_apply_config_proposal', 'agent_qa_list_proposals', 'agent_qa_show_proposal',
    ]) expect(ANALYTICS_MCP_TOOL_NAMES as readonly string[], retired).not.toContain(retired)
    expect(ANALYTICS_MCP_TOOL_NAMES).toContain('agent_qa_mark_run')
    expect(ANALYTICS_MCP_TOOL_NAMES).toContain('agent_qa_list_knowledge_gates')
    expect(ANALYTICS_MCP_TOOL_NAMES).toContain('agent_qa_get_run_marks')
    expect(ANALYTICS_MCP_TOOL_NAMES).toContain('agent_qa_preview_run_mark')
  })
})

describe('no free text is representable', () => {
  // THE CLEAN SIDE. On its own this proves nothing — a checker that returns unconditionally passes
  // it too — which is why it is stated beside the planted legs rather than as the claim.
  it('the shipped union passes the range checker', () => {
    expect(() => assertNoUnconstrainedStrings(ANALYTICS_EVENT_MEMBERS)).not.toThrow()
  })

  it('REDs on a planted plain string field, naming the member and the field', () => {
    const planted = z.strictObject({
      name: z.literal('agent-qa.planted.free_text'),
      properties: z.strictObject({ query_text: z.string() }),
    })

    expect(() => assertNoUnconstrainedStrings([...ANALYTICS_EVENT_MEMBERS, planted])).toThrowError(
      /agent-qa\.planted\.free_text[\s\S]*properties\.query_text/,
    )
  })

  // The tag is not a password. A string carrying the known-id marker but NO refinement admits
  // anything, so tagging alone must not buy passage — otherwise the escape from the rule is one
  // `.meta()` call away and the rule is advisory.
  it('REDs on a string tagged as a known id that constrains nothing', () => {
    const planted = z.strictObject({
      name: z.literal('agent-qa.planted.tagged'),
      properties: z.strictObject({
        pretend_id: z.string().meta({ analyticsVocabulary: 'known-id', analyticsCodec: 'nothing' }),
      }),
    })

    expect(() => assertNoUnconstrainedStrings([...ANALYTICS_EVENT_MEMBERS, planted])).toThrowError(
      /agent-qa\.planted\.tagged[\s\S]*properties\.pretend_id/,
    )
  })

  it('REDs on a free string hidden inside an optional, a record value and an array', () => {
    const optionalPlant = z.strictObject({
      name: z.literal('agent-qa.planted.optional'),
      properties: z.strictObject({ note: z.string().optional() }),
    })
    expect(() => assertNoUnconstrainedStrings([optionalPlant])).toThrowError(
      /agent-qa\.planted\.optional[\s\S]*properties\.note/,
    )

    const recordPlant = z.strictObject({
      name: z.literal('agent-qa.planted.record'),
      properties: z.strictObject({ bag: z.record(z.string(), z.string()) }),
    })
    expect(() => assertNoUnconstrainedStrings([recordPlant])).toThrowError(
      /agent-qa\.planted\.record[\s\S]*properties\.bag/,
    )

    const arrayPlant = z.strictObject({
      name: z.literal('agent-qa.planted.array'),
      properties: z.strictObject({ tags: z.array(z.string()) }),
    })
    expect(() => assertNoUnconstrainedStrings([arrayPlant])).toThrowError(
      /agent-qa\.planted\.array[\s\S]*properties\.tags/,
    )
  })

  it('accepts enums, string literals, refined known-id codecs, numbers and booleans', () => {
    const clean = z.strictObject({
      name: z.literal('agent-qa.planted.clean'),
      properties: z.strictObject({
        kind: z.enum(['a', 'b']),
        fixed: z.literal('constant'),
        run_id: z.string().regex(/^r_/u).meta({ analyticsVocabulary: 'known-id', analyticsCodec: 'run' }),
        count: z.number().int(),
        flag: z.boolean(),
      }),
    })

    expect(() => assertNoUnconstrainedStrings([clean])).not.toThrow()
  })
})

describe('every member REFUSES an unknown key (.strict, never .strip)', () => {
  it('a valid payload plus one unknown key fails to parse', () => {
    const valid = {
      name: 'agent-qa.explain.answered' as const,
      properties: { agent_qa_version: '0.1.21', surface: 'chat' as const, cited_row_count: 2 },
    }

    expect(AgentQaAnalyticsEventSchema.safeParse(valid).success).toBe(true)
    expect(
      AgentQaAnalyticsEventSchema.safeParse({
        ...valid,
        properties: { ...valid.properties, query_text: 'how do I run a suite' },
      }).success,
    ).toBe(false)
  })

  it('every member schema refuses an unknown key, not just the one above', () => {
    for (const [name, schema] of Object.entries(ANALYTICS_EVENT_SCHEMA_BY_NAME)) {
      const result = schema.safeParse({
        name,
        properties: { agent_qa_version: '0.1.21', __smuggled: 'secret' },
      })
      expect(result.success, `${name} accepted an unknown property key`).toBe(false)
    }
  })

  // The key is built from two halves so the whole token never appears in source.
  it('the retired healing-attempt counter is not a key of the completion shape, and is REFUSED', () => {
    const retiredKey = 'healing_attempt' + '_count'
    const base = {
      name: 'agent-qa.test_run.completed' as const,
      properties: { agent_qa_version: '0.1.21', step_count: 3, passed_step_count: 3 },
    }
    expect(AgentQaAnalyticsEventSchema.safeParse(base).success).toBe(true)
    expect(
      AgentQaAnalyticsEventSchema.safeParse({
        ...base,
        properties: { ...base.properties, [retiredKey]: 2 },
      }).success,
    ).toBe(false)

    // And the three token fields DO parse — the same shape, from the other direction, so this
    // cell cannot pass by the completion member having lost its optional integers wholesale.
    expect(
      AgentQaAnalyticsEventSchema.safeParse({
        ...base,
        properties: { ...base.properties, input_tokens: 11, output_tokens: 6, total_tokens: 17 },
      }).success,
    ).toBe(true)
  })

  // The scanner reads code, so a comment that names `.strip()` is not a call to it.
  it('no module in this package calls .strip()', () => {
    expect(sourceModulesContaining('.strip(')).toEqual([])
  })

  // The scanner is itself a detector, so it gets the same treatment as the rules that use it: a
  // token in a comment is invisible, a token in a string literal is a hit, and a `//` inside a URL
  // does not start a comment. Without this, a scanner that returned '' would satisfy every cell
  // above by finding nothing anywhere.
  it('the source scanner drops comments, keeps string literals, and survives a URL', () => {
    const stripped = withoutComments(
      [
        '// a comment naming .strip( and DO_NOT_TRACK',
        '/* a block comment naming .strip( too */',
        'const host = "https://us.i.posthog.com" // trailing',
        "const literal = 'DO_NOT_TRACK'",
        'const call = schema.strip()',
      ].join('\n'),
    )

    expect(stripped).not.toContain('a comment naming')
    expect(stripped).not.toContain('a block comment')
    expect(stripped).toContain('https://us.i.posthog.com')
    expect(stripped).toContain("'DO_NOT_TRACK'")
    expect(stripped).toContain('schema.strip()')
  })
})

// Key-set equality: the strict parse cannot see a field re-added to the declaration.

/** The properties `z.strictObject` declares for a member, in declaration order. */
function propertyKeysOf(name: AnalyticsEventName): string[] {
  const schema = ANALYTICS_EVENT_SCHEMA_BY_NAME[name] as unknown as {
    shape: { properties: { shape: Record<string, unknown> } }
  }
  return Object.keys(schema.shape.properties.shape)
}

// The shared base every member carries, spelled once for the pins below.
const BASE_KEYS = [
  'agent_qa_version',
  'surface',
  'runtime_context',
  'is_internal',
  'agent_product',
  '$process_person_profile',
]

const COMPLETION_KEYS = [
  'trigger_source',
  'runner',
  'platform',
  'status',
  'failure_category',
  'duration_ms',
  'run_id',
  'step_count',
  'passed_step_count',
  'failed_step_count',
  'skipped_step_count',
  'retry_count',
  'input_tokens',
  'output_tokens',
  'total_tokens',
  'is_flaky',
  'memory_enabled',
]

describe('the run-completion shape is a closed set', () => {
  it('declares EXACTLY the base keys, the completion keys and its own discriminating id', () => {
    expect(propertyKeysOf('agent-qa.test_run.completed')).toEqual([
      ...BASE_KEYS,
      ...COMPLETION_KEYS,
      'test_id',
    ])
  })

  it('shares that same shape with the suite member, which adds only suite facts', () => {
    expect(propertyKeysOf('agent-qa.suite_run.completed')).toEqual([
      ...BASE_KEYS,
      ...COMPLETION_KEYS,
      'suite_id',
      'suite_child_count',
      'suite_passed_count',
      'suite_failed_count',
      'suite_skipped_count',
      'suite_execution_mode',
    ])
  })

  // Retired fields are named, because an unnamed absence looks like a forgotten field.
  it('carries neither retired producer-less field, on EITHER completion member', () => {
    const retired = [
      { label: 'the healing-attempt counter', key: 'healing_attempt' + '_count' },
      { label: 'the parent-link property', key: 'parent_run' + '_id' },
    ]
    for (const member of ['agent-qa.test_run.completed', 'agent-qa.suite_run.completed'] as const) {
      const keys = propertyKeysOf(member)
      for (const { label, key } of retired) {
        expect(keys, `${member} re-declared ${label}`).not.toContain(key)
      }
    }
  })

  it('still declares the three token fields the run subscriber fills', () => {
    const keys = propertyKeysOf('agent-qa.test_run.completed')
    expect(keys).toContain('input_tokens')
    expect(keys).toContain('output_tokens')
    expect(keys).toContain('total_tokens')
  })
})
