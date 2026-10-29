// Ids are imported, never literals, so renaming an op breaks this table at compile time.

import type { ActionRef, EntityDescriptor, EntityKind } from '@vostride/agent-qa-schema'

import { ENTITIES_GET_FUNCTION_ID } from '../ops/entities-ids.js'
import { KNOWLEDGE_BRIEF_WHY_FUNCTION_ID } from '../ops/knowledge-brief-why.js'
import { KNOWLEDGE_RECORD_SHOW_FUNCTION_ID } from '../ops/knowledge-record-show.js'
import { KNOWLEDGE_FORGET_FUNCTION_ID } from '../ops/knowledge-review-ids.js'
import { RUNS_GET_FUNCTION_ID } from '../ops/runs-get.js'
import { RUNS_START_FUNCTION_ID } from '../ops/runs-start.js'

type ActionTable = (descriptor: EntityDescriptor) => ActionRef[]

/** The card itself, addressed by its own short-ID. Useful wherever a card is one of several. */
function openCard(descriptor: EntityDescriptor): ActionRef {
  return {
    functionId: ENTITIES_GET_FUNCTION_ID,
    label: 'Open card',
    inputSeed: { ref: descriptor.shortId },
  }
}

/**
 * THE per-kind action table.
 *
 * `satisfies Record<EntityKind, …>` for the same reason the fact projections are: a sixth
 * kind must answer what it offers rather than inheriting a fallback. There is no fallback.
 */
export const ENTITY_ACTION_TABLES = {
  TST: (descriptor) => [
    openCard(descriptor),
    {
      functionId: RUNS_START_FUNCTION_ID,
      label: 'Run this test',
      // The variadic pattern operand `runs.start` already takes — the test's own identity.
      inputSeed: { patterns: [descriptor.machineId] },
    },
  ],
  RUN: (descriptor) => [
    openCard(descriptor),
    {
      functionId: RUNS_GET_FUNCTION_ID,
      label: 'Open run',
      inputSeed: { runId: descriptor.machineId },
    },
    {
      functionId: KNOWLEDGE_BRIEF_WHY_FUNCTION_ID,
      label: 'Explain a step',
      // DELIBERATELY partial: the why-verb answers about one step, and which step is the
      // caller's question rather than the entity's fact. Seeding a step index would be the
      // card guessing what a human meant, which is the never-guess floor in miniature.
      inputSeed: { runId: descriptor.machineId },
    },
  ],
  MEM: (descriptor) => [
    openCard(descriptor),
    {
      functionId: KNOWLEDGE_RECORD_SHOW_FUNCTION_ID,
      label: 'Show record',
      inputSeed: { recordId: descriptor.machineId },
    },
    {
      // Forget tombstones the record in the call; the seed addresses the record grain.
      functionId: KNOWLEDGE_FORGET_FUNCTION_ID,
      label: 'Forget this record',
      inputSeed: { target: { grain: 'record', recordId: descriptor.machineId } },
    },
  ],
  POL: (descriptor) => [openCard(descriptor)],
  TGT: (descriptor) => [openCard(descriptor)],
} as const satisfies Record<EntityKind, ActionTable>

/** Every id this module can ever advertise — the set the resolvability assertion iterates. */
export const ADVERTISED_FUNCTION_IDS: readonly string[] = [
  ENTITIES_GET_FUNCTION_ID,
  RUNS_START_FUNCTION_ID,
  RUNS_GET_FUNCTION_ID,
  KNOWLEDGE_BRIEF_WHY_FUNCTION_ID,
  KNOWLEDGE_RECORD_SHOW_FUNCTION_ID,
  KNOWLEDGE_FORGET_FUNCTION_ID,
]

export function actionsForKind(descriptor: EntityDescriptor): ActionRef[] {
  return ENTITY_ACTION_TABLES[descriptor.kind](descriptor)
}
