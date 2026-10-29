// Lives in schema because `packages/mcp` may not import zod; the discriminant value is the op id.

import { z } from 'zod'

import {
  ConfigAuthSetInputSchema,
  ConfigChangeOutputSchema,
  ConfigFieldSetInputSchema,
  ConfigHookAddInputSchema,
  ConfigProjectScaffoldInputSchema,
  ConfigTargetCreateInputSchema,
  ConfigTargetEditInputSchema,
} from '../config-mutation/actions'
import {
  KnowledgeAcceptChangeInputSchema,
  KnowledgeChangeOutputSchema,
  KnowledgeForgetChangeInputSchema,
  KnowledgeRejectChangeInputSchema,
} from '../knowledge/change'
import {
  AuthoringDraftEditInputSchema,
  AuthoringDraftEditOutputSchema,
  AuthoringVerifyDraftInputSchema,
  AuthoringVerifyDraftOutputSchema,
} from './authoring'
import { createOutputContract } from './output-contract'
import type { OutputContract } from './output-contract'
import {
  RunsArtifactInputSchema,
  RunsArtifactOutputContract,
  RunsEvidenceInputSchema,
  RunsEvidenceOutputContract,
} from './runs'

/**
 * The key whose literal names which arm a fold call is about.
 *
 * A constant rather than the string `'action'` written at each of its call sites: the key the
 * union discriminates on, the key the tool handler strips, and the key the tool-schema test reads
 * back are THE SAME key, and two spellings of it would fail as a call that validates and then
 * dispatches nowhere.
 */
export const TOOL_FOLD_DISCRIMINANT = 'action'

// The discriminant is the one field no arm DTO describes, so its description lives here.
const DISCRIMINANT_DESCRIPTION =
  'Which registry operation this call is for. The value is the operation id itself; the rest of '
  + 'the object is that operation\'s own input.'

/** One arm's discriminant: the op id as a literal, carrying the shared prose. */
function armLiteral<Id extends string>(opId: Id): z.ZodLiteral<Id> {
  return z.literal(opId).describe(DISCRIMINANT_DESCRIPTION)
}

// Deduped by object identity, so structurally equal copies stay visible as drift.
function foldOutput(arms: readonly z.ZodType[]): z.ZodType {
  const distinct: z.ZodType[] = []
  for (const arm of arms) if (!distinct.includes(arm)) distinct.push(arm)
  const [only] = distinct
  if (only !== undefined && distinct.length === 1) return only
  return z.union(distinct as [z.ZodType, z.ZodType, ...z.ZodType[]])
}

// ---- `agent_qa_refine_test`: edit an existing test, or verify a draft ---------------------------

const refineArms = [
  AuthoringDraftEditInputSchema.extend({
    [TOOL_FOLD_DISCRIMINANT]: armLiteral('authoring.draft.edit'),
  }),
  AuthoringVerifyDraftInputSchema.extend({
    [TOOL_FOLD_DISCRIMINANT]: armLiteral('authoring.draft.verify'),
  }),
] as const

/**
 * The one fold whose arms answer DIFFERENT shapes — an edit proposal on one side, a keep-gate
 * receipt on the other — so its advertised output is a real union rather than a collapsed one.
 */
export const AuthoringRefineFoldInputSchema = z.discriminatedUnion(
  TOOL_FOLD_DISCRIMINANT,
  refineArms,
)

export type AuthoringRefineFoldInput = z.infer<typeof AuthoringRefineFoldInputSchema>

export const AuthoringRefineFoldOutputSchema = foldOutput([
  AuthoringDraftEditOutputSchema,
  AuthoringVerifyDraftOutputSchema,
])

// ---- `agent_qa_change_config`: the six direct config actions -------------------------------------

const configArms = [
  ConfigFieldSetInputSchema.extend({
    [TOOL_FOLD_DISCRIMINANT]: armLiteral('config.field.set'),
  }),
  ConfigTargetCreateInputSchema.extend({
    [TOOL_FOLD_DISCRIMINANT]: armLiteral('config.target.create'),
  }),
  ConfigTargetEditInputSchema.extend({
    [TOOL_FOLD_DISCRIMINANT]: armLiteral('config.target.edit'),
  }),
  ConfigAuthSetInputSchema.extend({
    [TOOL_FOLD_DISCRIMINANT]: armLiteral('config.auth.set'),
  }),
  ConfigHookAddInputSchema.extend({
    [TOOL_FOLD_DISCRIMINANT]: armLiteral('config.hook.add'),
  }),
  ConfigProjectScaffoldInputSchema.extend({
    [TOOL_FOLD_DISCRIMINANT]: armLiteral('config.project.scaffold'),
  }),
] as const

// `.extend()` keeps each DTO strict, so an unknown key is refused before the handler runs.
export const ConfigChangeFoldInputSchema = z.discriminatedUnion(
  TOOL_FOLD_DISCRIMINANT,
  configArms,
)

export type ConfigChangeFoldInput = z.infer<typeof ConfigChangeFoldInputSchema>

// Every arm answers the one change contract, so the union collapses to it.
export const ConfigChangeFoldOutputSchema = foldOutput(configArms.map(() => ConfigChangeOutputSchema))

const knowledgeArms = [
  KnowledgeAcceptChangeInputSchema.extend({
    [TOOL_FOLD_DISCRIMINANT]: armLiteral('knowledge.accept'),
  }),
  KnowledgeRejectChangeInputSchema.extend({
    [TOOL_FOLD_DISCRIMINANT]: armLiteral('knowledge.reject'),
  }),
  KnowledgeForgetChangeInputSchema.extend({
    [TOOL_FOLD_DISCRIMINANT]: armLiteral('knowledge.forget'),
  }),
] as const

export const KnowledgeChangeFoldInputSchema = z.discriminatedUnion(
  TOOL_FOLD_DISCRIMINANT,
  knowledgeArms,
)

export type KnowledgeChangeFoldInput = z.infer<typeof KnowledgeChangeFoldInputSchema>

export const KnowledgeChangeFoldOutputSchema = foldOutput(
  knowledgeArms.map(() => KnowledgeChangeOutputSchema),
)

// ---- the run evidence read: a step's parsed evidence, or one of its blobs by sha ---------------

function foldOutputContract(arms: readonly OutputContract[]): OutputContract {
  const distinct: OutputContract[] = []
  for (const arm of arms) if (!distinct.includes(arm)) distinct.push(arm)
  const [only] = distinct
  if (only !== undefined && distinct.length === 1) return only
  const members = distinct.map((arm) => {
    const { $schema: _dialect, ...document } = arm.outputRepresentation
    return document
  })
  return createOutputContract(foldOutput(distinct.map((arm) => arm.runtimeSchema)), {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    anyOf: members,
  })
}

const evidenceArms = [
  // `safeExtend`, not a shape spread: the evidence address carries the ARIA-only sub-action
  // refinement, and a spread into a fresh object would silently drop it.
  RunsEvidenceInputSchema.safeExtend({
    [TOOL_FOLD_DISCRIMINANT]: armLiteral('runs.evidence'),
  }),
  RunsArtifactInputSchema.extend({
    [TOOL_FOLD_DISCRIMINANT]: armLiteral('runs.artifact'),
  }),
] as const

export const RunsEvidenceFoldInputSchema = z.discriminatedUnion(
  TOOL_FOLD_DISCRIMINANT,
  evidenceArms,
)

export type RunsEvidenceFoldInput = z.infer<typeof RunsEvidenceFoldInputSchema>

export const RunsEvidenceFoldOutputContract = foldOutputContract([
  RunsEvidenceOutputContract,
  RunsArtifactOutputContract,
])
