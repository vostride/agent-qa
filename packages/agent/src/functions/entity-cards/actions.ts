// The card's `actions[]`.
//
// A card's actions are REGISTRY OP REFS. A card can therefore only advertise capabilities the
// registry already contains, which is what makes an advertised action invokable identically
// over chat, CLI and MCP, subjects it to safe-mode listing filters for free, and lets 397's
// parity suite assert that every action any card offers actually resolves. A freeform action
// string would have been a second capability vocabulary — the private-power drift L10 exists
// to prevent — and there is deliberately no way to construct one here.
//
// EVERY id below is IMPORTED from the module that declares it, never written as a literal.
// That is the drift proof: renaming an op's id is a compile error in this table rather than a
// card that keeps advertising a capability nothing answers to. The one place a literal would
// have been convenient — a table keyed by id string — is exactly where it would have been
// wrong.
//
// `inputSeed` carries the entity's OWN references. A seed is a seed and may be partial (the
// why-verb needs a step index no card knows), but every field it does set is a real field of
// that op's input contract, filled with a value this entity actually is. What it must never be
// is a value that ADDRESSES BY COINCIDENCE: `knowledge.record.show` is seeded with a MEM
// entity's machine id because in this store a bundle directory's name IS the record id
// (`listBundles` and `showRecord` both read `bundle.manifest.id`), not because the two strings
// happen to look alike.
//
// One decision worth stating rather than leaving to be inferred. `runs.start` is in the
// default spec list but binds only in a composition that supplies a `runInvocation` port, so a
// read-only host lists it `unbound`. A TST card advertises it anyway, because D-11 says cards
// advertise what the REGISTRY contains and `bindingStatus` exists precisely so an unbound
// capability is VISIBLE rather than silent. Advertising is not granting: the ref still
// crosses `invokeFunction`, which refuses an unbound id by name and gates every scope. A card
// that hid the capability would be making a claim about the host that the card producer — which
// receives no caller and no composition — is in no position to make.

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
      // D-11's table completion. 2026-09-30, 432-12: forget is the explicit
      // removal and it applies in the call, so the action says what it does. The record is
      // tombstoned, never destroyed, and the card at this address then reads `tombstoned`. The
      // seed addresses the RECORD grain because a descriptor carries the machine id it was
      // sighted under, and the bundle grain takes a short-ID whose resolution is the writer's job
      // rather than the card's.
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
