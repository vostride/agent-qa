import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { CHAT_AGENT_CONTEXT, buildChatPrompt } from '../chat-prompt.js'
import { replayToModelMessages } from '../compaction.js'
import type { ChatPromptInput } from '../chat-prompt.js'

const moduleDir = dirname(fileURLToPath(import.meta.url))
const CHAT_PROMPT_SOURCE = readFileSync(join(moduleDir, '..', 'chat-prompt.ts'), 'utf8')

function input(overrides: Partial<ChatPromptInput> = {}): ChatPromptInput {
  return {
    utterance: 'run test 42 and write a test for 2FA',
    clauses: [
      { text: 'run test 42', index: 0 },
      { text: 'write a test for 2FA', index: 1 },
    ],
    activeModel: 'anthropic/claude-sonnet-4',
    ...overrides,
  }
}

describe('buildChatPrompt: one builder, chat blocks', () => {
  it('calls buildTieredPrompt exactly once — no sibling renderer, no second assembly', () => {
    const calls = CHAT_PROMPT_SOURCE.match(/buildTieredPrompt\(/g) ?? []
    expect(calls).toHaveLength(1)
  })

  it('passes chat its own agent_context, which is what the ONE builder is parameterized by', () => {
    expect(CHAT_PROMPT_SOURCE).toContain('agent_context')
    expect(buildChatPrompt(input()).system).toContain(CHAT_AGENT_CONTEXT)
  })

  it('answers the TEXT legs only — system and prompt, no third key', () => {
    const request = buildChatPrompt(input())
    expect(Object.keys(request).sort()).toEqual(['prompt', 'system'])
    expect(typeof request.system).toBe('string')
    expect(typeof request.prompt).toBe('string')
  })

  it('is byte-deterministic: identical inputs produce identical bytes', () => {
    const first = buildChatPrompt(input())
    const second = buildChatPrompt(input())
    expect(first.system).toBe(second.system)
    expect(first.prompt).toBe(second.prompt)
    // Spelled as bytes rather than as deep equality, because a cache hit is a byte comparison and
    // two strings that differ by a timestamp still pass a shape check.
    expect(JSON.stringify(first)).toBe(JSON.stringify(second))
  })

  it('keeps the volatile tier volatile: a different utterance moves only the prompt leg', () => {
    const base = buildChatPrompt(input())
    const other = buildChatPrompt(input({ utterance: 'show me the proposals' }))
    expect(other.system).toBe(base.system)
    expect(other.prompt).not.toBe(base.prompt)
  })

  it('states the planning discipline the reconciler and the ceiling both measure', () => {
    const system = buildChatPrompt(input()).system ?? ''
    expect(system).toContain('answer_only')
    expect(system).toContain('mark_unhandled')
    expect(system.toLowerCase()).toContain('utterance order')
  })

  it('says what a tool REQUIRES, so a clause cannot be refused over an optional field', () => {
    const system = buildChatPrompt(input()).system ?? ''
    expect(system).toContain(
      "A tool's required inputs are exactly the `required` list in its schema. Never mark a clause "
      + 'unhandled because a field outside that list is missing: omit the field, or fill it from '
      + "the person's own words when they name it.",
    )
    // ADJACENCY, asserted rather than assumed: the rule QUALIFIES the mark_unhandled guidance, so
    // it has to be read with it. A rule that drifted into the volatile tier or to the far end of a
    // long block would still satisfy the containment above while no longer being about the
    // instruction it exists to bound.
    const rule = system.indexOf("A tool's required inputs")
    const guidance = system.indexOf('Use `mark_unhandled`')
    expect(guidance).toBeGreaterThan(-1)
    expect(rule).toBeGreaterThan(guidance)
  })

  it('numbers the clause list by POSITION, so a hole-punched subset never starts at "2."', () => {
    // Stage 2 sees only unbound clauses, so `clauses` is a subset keeping its original indices.
    const { prompt, system } = buildChatPrompt(
      input({
        utterance: 'run test 42 and summarise the last failure',
        clauses: [{ text: 'summarise the last failure', index: 1 }],
      }),
    )

    expect(prompt).toContain('1. summarise the last failure')
    expect(prompt).not.toContain('2. summarise the last failure')
    // And the instruction counts THAT list rather than the whole request, while keeping the
    // ordering fragment the discipline case above pins.
    expect(system ?? '').toContain('per clause of the list below')
    expect((system ?? '').toLowerCase()).toContain('utterance order')
  })

  it('carries the clauses verbatim, so the model answers about what the splitter produced', () => {
    const { prompt } = buildChatPrompt(input())
    expect(prompt).toContain('run test 42')
    expect(prompt).toContain('write a test for 2FA')
  })

  it('names the model in force in the context tier', () => {
    expect(buildChatPrompt(input()).prompt).toContain('anthropic/claude-sonnet-4')
  })

  it('carries supplied session facts as one-liners, and nothing when none were supplied', () => {
    const withFacts = buildChatPrompt(input({ facts: ['3 proposals pending'] }))
    expect(withFacts.prompt).toContain('3 proposals pending')
    const withoutFacts = buildChatPrompt(input())
    expect(withoutFacts.prompt).not.toContain('Session facts')
  })

  it('renders the prior conversation before the current utterance', () => {
    const { prompt } = buildChatPrompt(
      input({
        // Produced by `replayToModelMessages`, the one projection from the log's replay shape.
        conversation: replayToModelMessages({
          messages: [
            { role: 'user', text: 'show me the proposals', turnId: 't1' },
            { role: 'assistant', text: 'proposals.list completed', turnId: 't1' },
          ],
          abortedTurnIds: [],
        }),
      }),
    )
    expect(prompt.indexOf('show me the proposals')).toBeLessThan(
      prompt.indexOf('run test 42 and write a test for 2FA'),
    )
  })

  it('never assembles prompt text outside the builder', () => {
    // The failure this catches is the quiet one: a caller that returns `{ system, prompt }` built
    // by hand still type-checks as a JobModelRequest and still reads fine, and the tier law is
    // gone. If this module ever returns something the builder did not produce, the single-call
    // assertion above and this one disagree, and the build says so.
    expect(CHAT_PROMPT_SOURCE).not.toMatch(/return\s*\{\s*system/)
  })
})
