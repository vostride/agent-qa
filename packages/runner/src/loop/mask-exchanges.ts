import type { ToolExchangeEvidence } from '@vostride/agent-qa-schema'

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function maskStringLeaves(value: unknown, mask: (text: string) => string): unknown {
  if (typeof value === 'string') return mask(value)
  if (Array.isArray(value)) return value.map((entry) => maskStringLeaves(entry, mask))
  if (!isPlainObject(value)) return value

  const masked: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    masked[key] = maskStringLeaves(entry, mask)
  }
  return masked
}

/**
 * Apply the run-scoped masking map to every string leaf in exchange arguments and
 * results before evidence recording. Tool names remain unchanged identifiers.
 * Full fidelity is preserved: this helper performs no truncation, size cap, or artifact
 * spillover because upstream guardBlob already bounded what entered the conversation.
 */
export function maskToolExchanges(
  exchanges: readonly ToolExchangeEvidence[],
  mask: (text: string) => string,
): ToolExchangeEvidence[] {
  return exchanges.map((exchange) => ({
    tool: exchange.tool,
    args: maskStringLeaves(exchange.args, mask) as Record<string, unknown>,
    result: maskStringLeaves(exchange.result, mask),
  }))
}
