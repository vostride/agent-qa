// The keyed consume-once recorded-exchange server. It plugs into the
// plan-368-01 runner planning-turn seam as a NonActionToolMap: each recorded non-action
// exchange is served back to the model verbatim when a call's name + canonicalized args
// match, exactly once, FIFO across duplicates. A miss is a typed hard error naming the
// tool and its canonical args — never a silent live fallthrough. The server ONLY
// key-matches and returns recorded results as opaque data; it never interprets, parses,
// or runs recorded content (eval ownership-contract law, T-368-04).

import type { Tool } from 'ai'
import { tool } from 'ai'
import { z } from 'zod'
import type { ToolExchangeEvidence } from '@vostride/agent-qa-schema'
import type { NonActionToolMap } from '@vostride/agent-qa-runner'
import { canonicalJson, canonicalValue } from '../canonical-json'
import type { UnconsumedExchange } from './result'

/**
 * A recorded name that collides with the platform action slice — a construction-time
 * integrity refusal (RESEARCH Pitfall 5). Serving it as a non-action tool would let a
 * recorded exchange shadow a real action tool. The engine maps this to the
 * 'action-tool-collision' ReplayRefusal.
 */
export class ActionToolCollisionError extends Error {
  readonly tool: string
  constructor(tool: string) {
    super(`recorded exchange name "${tool}" is reserved by the action slice and cannot be served`)
    this.name = 'ActionToolCollisionError'
    this.tool = tool
  }
}

/**
 * A mid-replay divergence: the model asked a question no recorded exchange answers, or a
 * once-only exchange was already consumed. Carries the tool name and the canonicalized
 * args as typed fields. The message and the instance are deliberately shaped so a real
 * plan() call rethrows it unchanged: it holds none of the message substrings planner.ts's
 * catch rewraps on and defines no provider-shaped statusCode/responseBody fields.
 */
export class UnservableDivergenceError extends Error {
  readonly tool: string
  readonly canonicalArgs: Record<string, unknown>
  constructor(tool: string, canonicalArgs: Record<string, unknown>) {
    super(`replay divergence: no recorded exchange for ${tool}`)
    this.name = 'UnservableDivergenceError'
    this.tool = tool
    this.canonicalArgs = canonicalArgs
  }
}

// Cassettes record args/results only, never JSON schemas. A permissive loose-object
// schema accepts any recorded arg shape; the runner extracts args and calls execute()
// directly, so this schema only shapes the model-visible tool surface, never validation.
const looseArgsSchema = z.record(z.string(), z.unknown())

interface RecordedQueue {
  canonicalArgs: Record<string, unknown>
  results: unknown[]
}

export interface RecordedExchangeServer {
  nonActionTools: NonActionToolMap
  unconsumed(): UnconsumedExchange[]
}

export interface BuildRecordedExchangeServerInput {
  exchanges: readonly ToolExchangeEvidence[]
  actionToolNames: ReadonlySet<string>
}

export function buildRecordedExchangeServer(
  input: BuildRecordedExchangeServerInput,
): RecordedExchangeServer {
  const { exchanges, actionToolNames } = input

  // tool name -> canonicalJson(args) -> FIFO queue of recorded results
  const queues = new Map<string, Map<string, RecordedQueue>>()

  for (const recorded of exchanges) {
    if (actionToolNames.has(recorded.tool)) {
      throw new ActionToolCollisionError(recorded.tool)
    }
    const canonicalArgs = canonicalValue(recorded.args) as Record<string, unknown>
    const key = canonicalJson(recorded.args)
    let byArgs = queues.get(recorded.tool)
    if (byArgs === undefined) {
      byArgs = new Map<string, RecordedQueue>()
      queues.set(recorded.tool, byArgs)
    }
    let queue = byArgs.get(key)
    if (queue === undefined) {
      queue = { canonicalArgs, results: [] }
      byArgs.set(key, queue)
    }
    queue.results.push(recorded.result)
  }

  const nonActionTools: NonActionToolMap = {}
  for (const name of queues.keys()) {
    const definition: Tool = tool({
      description: `Recorded non-action exchange "${name}" — replay serves the recorded result verbatim.`,
      inputSchema: looseArgsSchema,
    })
    nonActionTools[name] = {
      tool: definition,
      execute(args: Record<string, unknown>): unknown {
        const key = canonicalJson(args)
        const queue = queues.get(name)?.get(key)
        if (queue === undefined || queue.results.length === 0) {
          throw new UnservableDivergenceError(
            name,
            canonicalValue(args) as Record<string, unknown>,
          )
        }
        return queue.results.shift()
      },
    }
  }

  return {
    nonActionTools,
    unconsumed(): UnconsumedExchange[] {
      const leftover: UnconsumedExchange[] = []
      for (const [name, byArgs] of queues) {
        for (const queue of byArgs.values()) {
          for (let i = 0; i < queue.results.length; i++) {
            leftover.push({ tool: name, args: queue.canonicalArgs })
          }
        }
      }
      return leftover
    },
  }
}
