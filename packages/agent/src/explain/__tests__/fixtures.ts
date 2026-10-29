// Every fixture goes through `CatalogRowSchema.parse`, so none is a row the producer cannot emit.

import { CatalogRowSchema } from '@vostride/agent-qa-schema'
import type { CatalogRow } from '@vostride/agent-qa-schema'

function row(declaration: unknown): CatalogRow {
  return CatalogRowSchema.parse(declaration)
}

export const OP_RUNS_START: CatalogRow = row({
  kind: 'op',
  id: 'runs.start',
  description: 'Start one run against a target and answer with its run id.',
  params: {
    type: 'object',
    properties: { target: { type: 'string' }, suite: { type: 'string' } },
    required: ['target'],
  },
  surfaces: ['chat', 'mcp'],
  mcpTool: 'agent_qa_start_run',
  docPath: 'README.md',
  docAnchor: 'CLI',
  // The producer's derived column: a required string becomes its own name in angle brackets.
  exampleCall: { arguments: { target: '<TARGET>' } },
})

export const OP_RUNS_LIST: CatalogRow = row({
  kind: 'op',
  id: 'runs.list',
  description: 'List recent runs, newest first.',
  params: { type: 'object', properties: {} },
  surfaces: ['chat', 'mcp'],
  mcpTool: 'agent_qa_list_runs',
  docPath: null,
  docAbsentReason: 'No canonical doc ships for this capability yet.',
  // No required property, so the example is the empty call; the null arm means a refusal.
  exampleCall: { arguments: {} },
})

export const ALIAS_RUN: CatalogRow = row({
  kind: 'alias',
  alias: 'run',
  targetOpId: 'runs.start',
  description: 'Start one run against a target and answer with its run id.',
  docPath: 'README.md',
  docAnchor: 'CLI',
})

export const SKILL_AUTHORING: CatalogRow = row({
  kind: 'skill',
  name: 'agent-qa-authoring',
  description: 'Use when creating, editing, validating, or running agent-qa tests or suites.',
  shortDescription: 'Author agent-qa tests safely',
  docPath: 'packages/cli/skills/agent-qa-authoring/SKILL.md',
})

export const CATALOG_ROWS: readonly CatalogRow[] = Object.freeze([
  OP_RUNS_START,
  OP_RUNS_LIST,
  ALIAS_RUN,
  SKILL_AUTHORING,
])
