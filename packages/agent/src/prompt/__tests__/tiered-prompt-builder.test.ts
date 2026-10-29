// The D-04 §1.4 tiered prompt-builder contract.
//
// Four pins, each on a property plan 04's author and 392's chat extension both lean on:
//
//   determinism  identical tier inputs → byte-identical {system, prompt}. The stable tier
//                leads so the cache-friendly bytes are the same bytes every call.
//   tier order   stable renders into `system`; context then volatile render into `prompt`,
//                in that order — a stable marker always precedes a context marker, which
//                always precedes a volatile marker in the full rendered output.
//   empty tiers  an empty volatile tier renders a structurally valid prompt: no dangling
//                section header, no trailing separator debris.
//   output shape exactly the TEXT legs of `JobModelRequest` — `{system?, prompt}`,
//                assignable without a cast. The request's optional images leg is attached
//                by the author at request assembly (plan 04), never by the tier renderer.

import { describe, expect, it } from 'vitest'
import type { JobModelRequest } from '../../jobs/record-llm-authorship.js'
import { buildTieredPrompt } from '../tiered-prompt-builder.js'
import type { TieredPromptInput } from '../tiered-prompt-builder.js'

const STABLE_MARKER = 'STABLE-MARKER-a7f3'
const CONTEXT_MARKER = 'CONTEXT-MARKER-b2e9'
const VOLATILE_MARKER = 'VOLATILE-MARKER-c5d1'

function fullInput(): TieredPromptInput {
  return {
    agent_context: 'analyze-run: author per-test verdict sentences',
    stable: [
      { title: 'Role', body: `You classify failed QA runs. ${STABLE_MARKER}` },
      { title: 'Output contract', body: 'Return one JSON object only.' },
    ],
    context: [
      { title: 'Run facts', body: `Run run-1 on build 7. ${CONTEXT_MARKER}` },
    ],
    volatile: [
      { title: 'Evidence pack: test 0', body: `The submit click failed. ${VOLATILE_MARKER}` },
      { title: 'Evidence pack: test 3', body: 'The login step timed out.' },
    ],
  }
}

describe('buildTieredPrompt (§1.4 skeleton)', () => {
  it('is byte-deterministic: identical tier inputs produce identical {system, prompt}', () => {
    const first = buildTieredPrompt(fullInput())
    const second = buildTieredPrompt(fullInput())
    expect(second.system).toBe(first.system)
    expect(second.prompt).toBe(first.prompt)
    expect(second).toEqual(first)
  })

  it('renders stable → context → volatile: markers appear in tier order across the full output', () => {
    const built = buildTieredPrompt(fullInput())
    // Stable lives in system; context and volatile live in prompt — so the full rendered
    // output, in the order a model receives it, is system then prompt.
    const rendered = `${built.system}\n\n${built.prompt}`
    const stableAt = rendered.indexOf(STABLE_MARKER)
    const contextAt = rendered.indexOf(CONTEXT_MARKER)
    const volatileAt = rendered.indexOf(VOLATILE_MARKER)
    expect(stableAt).toBeGreaterThanOrEqual(0)
    expect(contextAt).toBeGreaterThan(stableAt)
    expect(volatileAt).toBeGreaterThan(contextAt)
    // The split itself is a tier fact: stable never leaks into prompt, volatile never into system.
    expect(built.system).toContain(STABLE_MARKER)
    expect(built.prompt).not.toContain(STABLE_MARKER)
    expect(built.prompt).toContain(VOLATILE_MARKER)
    expect(built.system).not.toContain(VOLATILE_MARKER)
  })

  it('lands agent_context in the stable tier (system), never in prompt', () => {
    const built = buildTieredPrompt(fullInput())
    expect(built.system).toContain('analyze-run: author per-test verdict sentences')
    expect(built.prompt).not.toContain('analyze-run: author per-test verdict sentences')
  })

  it('renders an empty volatile tier as a structurally valid prompt with no dangling headers', () => {
    const input: TieredPromptInput = { ...fullInput(), volatile: [] }
    const built = buildTieredPrompt(input)
    // The context tier still renders whole…
    expect(built.prompt).toContain(CONTEXT_MARKER)
    // …and nothing volatile-shaped dangles after it: no trailing separator, no header
    // with an empty body, no volatile bytes at all.
    expect(built.prompt).toBe(built.prompt.trimEnd())
    expect(built.prompt).not.toMatch(/##[^\n]*$/)
    expect(built.prompt).not.toContain(VOLATILE_MARKER)
  })

  it('renders empty context AND volatile tiers without fabricating prompt bytes beyond structure', () => {
    const input: TieredPromptInput = { ...fullInput(), context: [], volatile: [] }
    const built = buildTieredPrompt(input)
    expect(built.prompt).toBe(built.prompt.trimEnd())
    expect(built.system).toContain(STABLE_MARKER)
  })

  it('outputs exactly {system?, prompt} — assignable to JobModelRequest without cast', () => {
    // The compile-time half of the pin: this assignment is what tsc verifies.
    const request: JobModelRequest = buildTieredPrompt(fullInput())
    // The runtime half: no extra members ride along into the request.
    expect(Object.keys(request).sort()).toEqual(['prompt', 'system'])
    expect(typeof request.prompt).toBe('string')
    expect(typeof request.system).toBe('string')
  })
})
