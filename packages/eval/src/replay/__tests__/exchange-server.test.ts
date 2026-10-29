import type { ToolExchangeEvidence } from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'
import {
  ActionToolCollisionError,
  UnservableDivergenceError,
  buildRecordedExchangeServer,
} from '../exchange-server'
import { createNullAdapter, ReplayExecutionForbiddenError } from '../null-adapter'

function exchange(
  tool: string,
  args: Record<string, unknown>,
  result: unknown,
): ToolExchangeEvidence {
  return { tool, args, result }
}

// The exact set of message substrings planner.ts's catch rewraps on, plus the duck-typed
// provider fields it reads. A mid-replay divergence thrown through a real plan() call must
// carry none of them so it survives to the final rethrow as the same class.
const REWRAP_SUBSTRINGS = [
  'no such tool',
  'tool_not_found',
  'unknown tool',
  'invalid_tool_input',
  'tool input',
  'schema validation',
]

describe('buildRecordedExchangeServer', () => {
  it('serves the recorded result for canonically-equal but byte-different args', () => {
    const server = buildRecordedExchangeServer({
      exchanges: [exchange('inspect_context', { b: 2, a: 1 }, { answer: 'yes' })],
      actionToolNames: new Set(['click', 'fill']),
    })
    // Key order permuted — canonicalization makes the two args equal.
    const result = server.nonActionTools['inspect_context'].execute({ a: 1, b: 2 })
    expect(result).toEqual({ answer: 'yes' })
  })

  it('consumes once — a second identical call throws UnservableDivergenceError', () => {
    const server = buildRecordedExchangeServer({
      exchanges: [exchange('inspect_context', { q: 'x' }, 42)],
      actionToolNames: new Set(),
    })
    expect(server.nonActionTools['inspect_context'].execute({ q: 'x' })).toBe(42)
    expect(() => server.nonActionTools['inspect_context'].execute({ q: 'x' })).toThrow(
      UnservableDivergenceError,
    )
  })

  it('throws UnservableDivergenceError naming the tool and canonical args on a different question', () => {
    const server = buildRecordedExchangeServer({
      exchanges: [exchange('inspect_context', { q: 'recorded' }, 'r')],
      actionToolNames: new Set(),
    })
    let thrown: unknown
    try {
      server.nonActionTools['inspect_context'].execute({ q: 'different' })
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(UnservableDivergenceError)
    const err = thrown as UnservableDivergenceError
    expect(err.tool).toBe('inspect_context')
    expect(err.canonicalArgs).toEqual({ q: 'different' })
  })

  it('serves duplicate identical recorded exchanges FIFO as a queue of depth 2', () => {
    const server = buildRecordedExchangeServer({
      exchanges: [
        exchange('inspect_context', { q: 'x' }, 'first'),
        exchange('inspect_context', { q: 'x' }, 'second'),
      ],
      actionToolNames: new Set(),
    })
    expect(server.nonActionTools['inspect_context'].execute({ q: 'x' })).toBe('first')
    expect(server.nonActionTools['inspect_context'].execute({ q: 'x' })).toBe('second')
    expect(() => server.nonActionTools['inspect_context'].execute({ q: 'x' })).toThrow(
      UnservableDivergenceError,
    )
  })

  it('enumerates never-requested recorded exchanges via unconsumed()', () => {
    const server = buildRecordedExchangeServer({
      exchanges: [
        exchange('inspect_context', { q: 'used' }, 'u'),
        exchange('inspect_context', { q: 'leftover' }, 'l'),
        exchange('read_doc', { id: 7 }, 'd'),
      ],
      actionToolNames: new Set(),
    })
    server.nonActionTools['inspect_context'].execute({ q: 'used' })
    const leftover = server.unconsumed()
    expect(leftover).toEqual(
      expect.arrayContaining([
        { tool: 'inspect_context', args: { q: 'leftover' } },
        { tool: 'read_doc', args: { id: 7 } },
      ]),
    )
    expect(leftover).toHaveLength(2)
  })

  it('throws ActionToolCollisionError at construction for a recorded name shadowing an action tool', () => {
    expect(() =>
      buildRecordedExchangeServer({
        exchanges: [exchange('click', { ref: 'e1' }, 'never')],
        actionToolNames: new Set(['click', 'fill']),
      }),
    ).toThrow(ActionToolCollisionError)
  })

  it('mints a divergence error that survives planner.ts rewrapping and carries no provider fields', () => {
    const server = buildRecordedExchangeServer({
      exchanges: [exchange('inspect_context', { q: 'x' }, 'r')],
      actionToolNames: new Set(),
    })
    let thrown: unknown
    try {
      server.nonActionTools['inspect_context'].execute({ q: 'miss' })
    } catch (err) {
      thrown = err
    }
    const err = thrown as UnservableDivergenceError
    const message = err.message.toLowerCase()
    for (const substring of REWRAP_SUBSTRINGS) {
      expect(message).not.toContain(substring)
    }
    expect('statusCode' in err).toBe(false)
    expect('responseBody' in err).toBe(false)
  })
})

describe('createNullAdapter', () => {
  it('hard-errors from execute() and every other action-capable method', () => {
    const adapter = createNullAdapter()
    expect(() => adapter.execute({ type: 'click', ref: 'e1' } as never)).toThrow(
      ReplayExecutionForbiddenError,
    )
    expect(() => adapter.observe()).toThrow(ReplayExecutionForbiddenError)
    expect(() => adapter.setup({} as never)).toThrow(ReplayExecutionForbiddenError)
    expect(() => adapter.cleanup()).toThrow(ReplayExecutionForbiddenError)
  })
})
