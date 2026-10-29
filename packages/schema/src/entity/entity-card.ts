// The ONE entity card shape.
//
// `{ kind, id, uri, title, status, url?, keyFacts[], actions[] }`, verbatim per ENTY-02 — the
// chat card, the MCP `structuredContent` and the M5 UI are all projections of this and never
// of a per-surface variant. There is exactly one producer, and it lives in the function
// layer; this file is the contract it renders INTO.
//
// `status` is a kind-DISCRIMINATED closed union. One flat status enum would have been
// smaller and would have accepted `{ kind: 'MEM', status: 'passed' }` — a memory record that
// claims a run verdict — which is precisely the class of nonsense a card must not be able to
// carry into a verdict sentence. The per-kind vocabularies live in one exported table so a
// test can walk the complete five-kind set rather than the three arms someone remembered.
//
// `url` is ABSENT by default. v52 configures no dashboard base URL, and a card that
// carried a link to a route nothing serves would be a dead link shown with confidence. M5
// turns it on by setting config — no schema change, no producer change.
//
// `actions[]` are registry op refs. A card can only advertise capabilities the
// function registry already contains, so an advertised action is invokable identically over
// chat, CLI and MCP, safe-mode listing filters apply to it automatically, and 397's parity
// suite can assert every action a card offers actually resolves. A freeform action string
// would have been a second capability vocabulary, which is the private-power drift L10
// exists to prevent.

import { z } from 'zod'

import { parseShortId } from './kinds'
import type { EntityKind } from './kinds'
import { EntityUriSchema, parseEntityUri } from './uri'

/**
 * The complete per-kind status vocabulary. The ONE table; every arm below reads its enum off
 * it, so there is no second place a status could be declared.
 */
export const ENTITY_STATUSES = {
  TST: ['active', 'quarantined'],
  RUN: ['passed', 'failed', 'running', 'unknown'],
  MEM: ['active', 'tombstoned', 'forgotten'],
  POL: ['active'],
  TGT: ['active', 'renamed', 'not-in-config'],
} as const satisfies Record<EntityKind, readonly [string, ...string[]]>

export type EntityStatusFor<K extends EntityKind> = (typeof ENTITY_STATUSES)[K][number]
export type EntityStatus = EntityStatusFor<EntityKind>

/**
 * Bounded, and the bound is the point rather than a performance guard: key facts are what a
 * reader actually reads, and a card that listed forty of them would be a data dump nobody
 * scans. Retune from what real cards need, not from a byte budget.
 */
export const ENTITY_CARD_MAX_KEY_FACTS = 12

/** Same reasoning for the action row: a card offers a few next moves, not a menu. */
export const ENTITY_CARD_MAX_ACTIONS = 6

/**
 * What each kind CALLS the machine id its address maps FROM — the label its FIRST key fact rides
 * under, on every card the one producer emits.
 *
 * IT LIVES IN THE CONTRACT RATHER THAN IN THE PRODUCER (moved here 400-08) because it is the only
 * thing that makes the machine id READABLE OFF A CARD. A card carries `{kind, id, uri, …}` and
 * deliberately no `machineId` field — the short-ID is the published address — but the identity fact
 * carries it, and a surface that has to route to a page keyed by machine id (the dashboard's
 * `/test/:t_id` and `/runs/:id`) needs to name that fact without guessing. With the table in the
 * producer's package a renderer had two ways to get there and both were wrong: read the label as a
 * literal (a second copy, free to drift the day a noun is retuned) or fish the id out of an
 * `actions[]` seed (addressing by coincidence, which `actions.ts`'s own header names as the thing
 * its seeds must never be). One declaration, imported by the producer that WRITES the fact and by
 * every surface that READS it, is what makes "the identity fact carries the machine id" a contract
 * instead of a convention.
 *
 * The label is per-kind and not cosmetic: `bundle id` and `run id` send a reader to different
 * places to correlate, and a card that said `machine id` for both would make the reader guess which
 * store to look in. A table rather than five literals so a kind cannot be added without answering
 * the question.
 */
export const ENTITY_IDENTITY_FACT_LABELS = {
  TST: 'test id',
  RUN: 'run id',
  MEM: 'bundle id',
  POL: 'policy id',
  TGT: 'target name',
} as const satisfies Record<EntityKind, string>

/**
 * One deterministic fact about the entity, computed by the producer from store data — never
 * LLM-authored. `ref` is an `agentqa://` URI so a fact can LINK another entity, which
 * is what lets a failing run's card point at the test it ran without inventing a second
 * cross-reference format.
 */
export const KeyFactSchema = z.object({
  label: z.string().min(1),
  value: z.string(),
  ref: EntityUriSchema.optional(),
}).strict()

export type KeyFact = z.infer<typeof KeyFactSchema>

/** A registry op reference: what to invoke, what to call it, and a seed input. */
export const ActionRefSchema = z.object({
  functionId: z.string().min(1),
  label: z.string().min(1),
  inputSeed: z.record(z.string(), z.unknown()),
}).strict()

export type ActionRef = z.infer<typeof ActionRefSchema>

const cardBase = {
  id: z.string().min(1),
  uri: EntityUriSchema,
  title: z.string(),
  url: z.url().optional(),
  keyFacts: z.array(KeyFactSchema).max(ENTITY_CARD_MAX_KEY_FACTS),
  actions: z.array(ActionRefSchema).max(ENTITY_CARD_MAX_ACTIONS),
}

// Written out arm by arm rather than generated by a mapped helper. A helper would have kept
// the five lines below in sync automatically and lost the inferred per-kind status type in
// the process, and the inferred type is what makes `card.status` narrow to the right
// vocabulary at every consumer. The completeness the helper would have guaranteed is instead
// asserted directly against `ENTITY_KINDS` and `ENTITY_STATUSES` in this module's suite.
const entityCardUnion = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('TST'), status: z.enum(ENTITY_STATUSES.TST), ...cardBase }).strict(),
  z.object({ kind: z.literal('RUN'), status: z.enum(ENTITY_STATUSES.RUN), ...cardBase }).strict(),
  z.object({ kind: z.literal('MEM'), status: z.enum(ENTITY_STATUSES.MEM), ...cardBase }).strict(),
  z.object({ kind: z.literal('POL'), status: z.enum(ENTITY_STATUSES.POL), ...cardBase }).strict(),
  z.object({ kind: z.literal('TGT'), status: z.enum(ENTITY_STATUSES.TGT), ...cardBase }).strict(),
])

/**
 * The card contract, with the cross-field integrity the arms cannot express on their own.
 *
 * `kind`, `id` and `uri` are three spellings of ONE address, and a card whose three spellings
 * disagreed would resolve differently depending on which field a surface happened to read.
 * The refinement below is what makes them one address rather than three fields that usually
 * match.
 */
export const EntityCardSchema = entityCardUnion.superRefine((card, ctx) => {
  const parsedId = parseShortId(card.id)
  if (parsedId === undefined || parsedId.kind !== card.kind) {
    ctx.addIssue({
      code: 'custom',
      path: ['id'],
      message: `card id ${card.id} does not name a ${card.kind} entity`,
    })
  }
  const parsedUri = parseEntityUri(card.uri)
  if (parsedUri === undefined || parsedUri.kind !== card.kind || parsedUri.shortId !== card.id) {
    ctx.addIssue({
      code: 'custom',
      path: ['uri'],
      message: `card uri ${card.uri} does not address ${card.kind} ${card.id}`,
    })
  }
})

export type EntityCard = z.infer<typeof entityCardUnion>
