import { openKnowledgeReader } from '@vostride/agent-qa-knowledge-local/reader'
import type { KnowledgeHintReader, ServedRunBrief } from '@vostride/agent-qa-runner'
import type { ScopeKey } from '@vostride/agent-qa-schema'

/** Inputs the composition root resolves when opening the run-scoped knowledge reader. */
export interface ConstructKnowledgeReaderInput {
  knowledgeRoot: string
  product?: string
  /** Known containing scopes for a member (the suite scope on prepared-suite runs). */
  parentScopes?: readonly ScopeKey[]
  asOfBuild: number
  recordCap: number
}

// The memo holds the whole composite, so a repeat serve returns the trace from the real assembly.
export function createFrozenKnowledgeReader(reader: KnowledgeHintReader): KnowledgeHintReader {
  const briefs = new Map<string, ServedRunBrief>()
  const scopeKey = (scope: ScopeKey): string => JSON.stringify([scope.tier, scope.key])

  return {
    getRunBrief(scope, budget) {
      const key = scopeKey(scope)
      const existing = briefs.get(key)
      if (existing !== undefined) return existing
      const brief = reader.getRunBrief(scope, budget)
      briefs.set(key, brief)
      return brief
    },
    search: (query, options) => reader.search(query, options),
    read: (id, options) => reader.read(id, options),
    getCautions: (anchors, budget) => reader.getCautions(anchors, budget),
    getProcedure: (intent, screenState, availability) =>
      reader.getProcedure(intent, screenState, availability),
    emitCanaryOutcome: (payload) => reader.emitCanaryOutcome(payload),
  }
}

/**
 * Construct the run-scoped reader through the physically read-only package subpath, then freeze
 * its Channel-1 brief for the lifetime of the run.
 */
export function constructKnowledgeReader(
  input: ConstructKnowledgeReaderInput,
): KnowledgeHintReader {
  return createFrozenKnowledgeReader(openKnowledgeReader({
    knowledgeRoot: input.knowledgeRoot,
    ...(input.product === undefined ? {} : { product: input.product }),
    scopeDefaults: {
      asOfBuild: input.asOfBuild,
      ...(input.parentScopes === undefined ? {} : { parentScopes: input.parentScopes }),
    },
    budgets: { recordCap: input.recordCap },
  }))
}
