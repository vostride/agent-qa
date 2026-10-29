// Stable bytes lead in `system` so provider prompt caches see the same prefix every call.

import type { JobModelRequest } from '../jobs/record-llm-authorship.js'

/**
 * One named section inside a tier. `title` renders as a `##` header; `body` is the
 * caller's prose, carried verbatim.
 */
export interface PromptTierBlock {
  readonly title: string
  readonly body: string
}

export interface TieredPromptInput {
  /** Who is asking and why — stable-tier provenance (§1.4's `agent_context` parameter). */
  readonly agent_context: string
  /** Invariant instructions: role, output contract. Renders into `system`. */
  readonly stable: readonly PromptTierBlock[]
  /** Run-level facts. Renders into `prompt`, before the volatile tier. */
  readonly context: readonly PromptTierBlock[]
  /** Per-test evidence. Renders into `prompt`, last — the cache-hostile bytes trail. */
  readonly volatile: readonly PromptTierBlock[]
}

/** The stable separator between rendered blocks — one blank line, never accumulated. */
const BLOCK_SEPARATOR = '\n\n'

function renderBlock(block: PromptTierBlock): string {
  return `## ${block.title}${BLOCK_SEPARATOR}${block.body}`
}

/**
 * Assemble the three tiers into the text legs of a `JobModelRequest`.
 *
 * An empty tier contributes zero bytes — no dangling header, no trailing separator —
 * because blocks are joined, never appended, so structure exists only where content does.
 */
export function buildTieredPrompt(input: TieredPromptInput): JobModelRequest {
  const system = [
    `Agent context: ${input.agent_context}`,
    ...input.stable.map(renderBlock),
  ].join(BLOCK_SEPARATOR)

  const prompt = [...input.context.map(renderBlock), ...input.volatile.map(renderBlock)].join(
    BLOCK_SEPARATOR,
  )

  return { system, prompt }
}
