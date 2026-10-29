// Catalog-row fixtures for the explain unit proofs.
//
// EVERY FIXTURE GOES THROUGH `CatalogRowSchema.parse`. `packages/agent` is storageNeutral and
// cannot read the committed artifact, so the produced-not-literal law cannot be honoured here in
// its strong form (that is D-12's op-level proof, plan 07, which drives the real loader). Its
// weakest useful form IS available and is what this file does: a fixture that the row contract
// would refuse is not a row, and a corpus of unparseable shapes proves things about inputs the
// producer can never emit.

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
  // the column the producer derives from `params`. Spelled here to match what that
  // derivation answers for the schema above — a required string becomes its own name in angle
  // brackets — because this file's contract is that a fixture is something the producer could
  // actually emit, and a row parsed without the column is a row nothing produces.
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
  docAbsentReason: 'D-07 (dated 2026-08-17): no canonical doc ships for this capability yet.',
  // No required property, so the honest example is the empty call — which is a real call, not an
  // absence. The null arm means the derivation REFUSED.
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
