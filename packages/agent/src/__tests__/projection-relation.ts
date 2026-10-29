// A relation, not a shape check: expected keys are read off each paired spec's live zod shape.

import { expect } from 'vitest'
import type { z } from 'zod'

import { agentAskSpec } from '../functions/ops/agent-ask.js'
import { explainSpec } from '../functions/ops/explain.js'
import { analysisGetSpec } from '../functions/ops/analysis-get.js'
import { authoringDraftEditSpec } from '../functions/ops/authoring-draft-edit.js'
import { authoringDraftWriteSpec } from '../functions/ops/authoring-draft-write.js'
import { authoringFunnelGetSpec } from '../functions/ops/authoring-funnel-get.js'
import { authoringVerifyDraftSpec } from '../functions/ops/authoring-verify-draft.js'
import { configFieldSetSpec } from '../functions/ops/config-field-set.js'
import { configGetSpec } from '../functions/ops/config-get.js'
import { configAuthSetSpec } from '../functions/ops/config-auth-set.js'
import { configHookAddSpec } from '../functions/ops/config-hook-add.js'
import { configTargetCreateSpec } from '../functions/ops/config-target-create.js'
import { configTargetEditSpec } from '../functions/ops/config-target-edit.js'
import { configProjectScaffoldSpec } from '../functions/ops/config-project-scaffold.js'
import { entitiesGetSpec } from '../functions/ops/entities-get.js'
import { entitiesResolveSpec } from '../functions/ops/entities-resolve.js'
import { knowledgeBriefWhySpec } from '../functions/ops/knowledge-brief-why.js'
import { knowledgeBundlesListSpec } from '../functions/ops/knowledge-bundles-list.js'
import { knowledgeGatesListSpec } from '../functions/ops/knowledge-gates-list.js'
import { knowledgeAcceptSpec } from '../functions/ops/knowledge-accept-propose.js'
import { knowledgeForgetSpec } from '../functions/ops/knowledge-forget-propose.js'
import { knowledgeRecordShowSpec } from '../functions/ops/knowledge-record-show.js'
import { knowledgeRecordsDiffSpec } from '../functions/ops/knowledge-records-diff.js'
import { knowledgeRecordsInspectSpec } from '../functions/ops/knowledge-records-inspect.js'
import { knowledgeRejectSpec } from '../functions/ops/knowledge-reject-propose.js'
import { quarantineAddSpec } from '../functions/ops/quarantine-add.js'
import { quarantineListSpec } from '../functions/ops/quarantine-list.js'
import { quarantineReleaseSpec } from '../functions/ops/quarantine-release.js'
import { runsEventsSpec } from '../functions/ops/runs-events.js'
import { runsLiveUrlSpec } from '../functions/ops/runs-live-url.js'
import { editorLiveUrlSpec } from '../functions/ops/editor-live-url.js'
import { runsDigestSpec } from '../functions/ops/runs-digest.js'
import { runsArtifactSpec } from '../functions/ops/runs-artifact.js'
import { runsDetailSpec } from '../functions/ops/runs-detail.js'
import { runsEvidenceSpec } from '../functions/ops/runs-evidence.js'
import { runsMarkSpec } from '../functions/ops/runs-mark.js'
import { runsMarkPreviewSpec } from '../functions/ops/runs-mark-preview.js'
import { runsMarksHistorySpec } from '../functions/ops/runs-marks-history.js'
import { runsOverviewSpec } from '../functions/ops/runs-overview.js'
import { runsGetSpec } from '../functions/ops/runs-get.js'
import { runsKnowledgeSpec } from '../functions/ops/runs-knowledge.js'
import { runsListSpec } from '../functions/ops/runs-list.js'
import { runsPostProcessingSpec } from '../functions/ops/runs-post-processing.js'
import { runsStartSpec } from '../functions/ops/runs-start.js'

/** The live half of the pair: the zod contracts a spec declares, before any projection. */
export interface DeclaredContracts {
  readonly input: z.ZodType
  readonly output: z.ZodType
}

// A growth seam: both callers compare its keys with the registry's ids, so new ops need a pair.
export const CONTRACTS_BY_ID: Readonly<Record<string, DeclaredContracts>> = {
  // Pairs this read's live contracts with its registry projection.
  'knowledge.gates.list': knowledgeGatesListSpec,
  // Deeply nested outputs like this receipt are what a careless projection flattens.
  'authoring.draft.verify': authoringVerifyDraftSpec,
  // `draftRef` and `receipt` are optional, absent on the stage-2 refusal arm.
  'authoring.draft.edit': authoringDraftEditSpec,
  'authoring.draft.write': authoringDraftWriteSpec,
  // The map is compared by exact key set with the registry, so every op needs a row.
  'authoring.funnel.get': authoringFunnelGetSpec,
  'agent.ask': agentAskSpec,
  // A discriminated union over two strict arms, which a careless projection collapses.
  'agent.explain': explainSpec,
  'analysis.get': analysisGetSpec,
  'config.field.set': configFieldSetSpec,
  'config.auth.set': configAuthSetSpec,
  'config.get': configGetSpec,
  'config.hook.add': configHookAddSpec,
  'config.target.create': configTargetCreateSpec,
  'config.target.edit': configTargetEditSpec,
  'config.project.scaffold': configProjectScaffoldSpec,
  'entities.get': entitiesGetSpec,
  'entities.resolve': entitiesResolveSpec,
  'knowledge.accept': knowledgeAcceptSpec,
  'knowledge.bundles.list': knowledgeBundlesListSpec,
  'knowledge.brief.why': knowledgeBriefWhySpec,
  'knowledge.forget': knowledgeForgetSpec,
  'knowledge.record.show': knowledgeRecordShowSpec,
  'knowledge.records.diff': knowledgeRecordsDiffSpec,
  'knowledge.records.inspect': knowledgeRecordsInspectSpec,
  'knowledge.reject': knowledgeRejectSpec,
  'quarantine.add': quarantineAddSpec,
  'quarantine.list': quarantineListSpec,
  'quarantine.release': quarantineReleaseSpec,
  // The 64-lowercase-hex `sha` constraint is what refuses a path like `../../etc/passwd`.
  'runs.artifact': runsArtifactSpec,
  'runs.detail': runsDetailSpec,
  'runs.evidence': runsEvidenceSpec,
  // Projects the mark validators through the same inert-declaration law.
  'runs.mark': runsMarkSpec,
  'runs.mark.preview': runsMarkPreviewSpec,
  'runs.marks.history': runsMarksHistorySpec,
  'runs.overview': runsOverviewSpec,
  'runs.events': runsEventsSpec,
  'runs.get': runsGetSpec,
  'runs.knowledge': runsKnowledgeSpec,
  'runs.list': runsListSpec,
  'runs.liveurl': runsLiveUrlSpec,
  'editor.liveurl': editorLiveUrlSpec,
  'runs.postprocessing': runsPostProcessingSpec,
  'runs.digest': runsDigestSpec,
  'runs.start': runsStartSpec,
}

/** A zod node's definition, read structurally so an unfamiliar kind degrades rather than throws. */
interface ZodNodeDef {
  type: string
  innerType?: unknown
  in?: unknown
  getter?: unknown
  element?: unknown
  options?: unknown
  left?: unknown
  right?: unknown
  shape?: unknown
}

const MAX_UNWRAP_STEPS = 32

function defOf(node: unknown): ZodNodeDef | undefined {
  if (typeof node !== 'object' || node === null) return undefined
  const def = (node as { def?: unknown }).def
  if (typeof def !== 'object' || def === null) return undefined
  const type = (def as { type?: unknown }).type
  return typeof type === 'string' ? (def as ZodNodeDef) : undefined
}

/**
 * Strip the wrappers that carry no key information.
 *
 * A `pipe` unwraps to its INPUT side, and the direction is load-bearing: `toSchemaProjection`
 * projects with `io: 'input'`, so the published document describes what a caller SENDS. That
 * is the opposite of the config visibility walker's rule, which reads the output side —
 * two modules, two correct answers, for two different questions.
 */
function unwrap(node: unknown): unknown {
  let current = node
  for (let step = 0; step < MAX_UNWRAP_STEPS; step++) {
    const def = defOf(current)
    if (def === undefined) return current
    switch (def.type) {
      case 'optional':
      case 'nullable':
      case 'nonoptional':
      case 'default':
      case 'prefault':
      case 'catch':
      case 'readonly':
        current = def.innerType
        break
      case 'lazy':
        if (typeof def.getter !== 'function') return current
        current = (def.getter as () => unknown)()
        break
      case 'pipe':
        current = def.in
        break
      default:
        return current
    }
  }
  return current
}

/** A property the caller may omit — exactly what JSON Schema leaves out of `required`. */
function isOptionalLike(node: unknown): boolean {
  const def = defOf(node)
  if (def === undefined) return false
  return def.type === 'optional' || def.type === 'default' || def.type === 'prefault'
}

function armsOf(def: ZodNodeDef): readonly unknown[] {
  if (Array.isArray(def.options)) return def.options
  if (def.left !== undefined || def.right !== undefined) {
    return [def.left, def.right].filter((arm) => arm !== undefined)
  }
  return []
}

/**
 * Assert that `projection` is derived from `schema` — the load-bearing acceptance criterion.
 *
 * Object roots: the projection's `properties` key set equals the zod shape's OWN key set,
 * and its `required` set equals the shape keys whose property is not optional-like. Array
 * roots: the projection carries `items` and the relation recurses into the element. Union
 * roots: the projection carries an option list of matching arity and the relation recurses
 * per arm. Both sides of every equality are computed from the values in hand.
 */
export function expectProjectionDerivedFrom(
  schema: unknown,
  projection: unknown,
  label: string,
): void {
  const def = defOf(unwrap(schema))
  if (def === undefined) throw new Error(`${label}: paired schema exposes no zod definition`)
  expect(typeof projection, label).toEqual('object')
  expect(projection, label).not.toBeNull()
  const document = projection as Record<string, unknown>

  if (def.type === 'object' || def.type === 'interface') {
    const shape = def.shape as Record<string, unknown> | undefined
    if (typeof shape !== 'object' || shape === null) {
      throw new Error(`${label}: object contract exposes no shape`)
    }
    const shapeKeys = Object.keys(shape)
    const properties = (document['properties'] ?? {}) as Record<string, unknown>
    expect(Object.keys(properties).sort(), `${label}.properties`).toEqual([...shapeKeys].sort())

    const published = (document['required'] ?? []) as readonly string[]
    expect([...published].sort(), `${label}.required`).toEqual(
      shapeKeys.filter((key) => !isOptionalLike(shape[key])).sort(),
    )
    return
  }

  if (def.type === 'array') {
    const items = document['items']
    if (items === undefined) throw new Error(`${label}: array contract projected without items`)
    expectProjectionDerivedFrom(def.element, items, `${label}[]`)
    return
  }

  if (def.type === 'union') {
    const arms = armsOf(def)
    const published = (document['anyOf'] ?? document['oneOf']) as unknown[] | undefined
    if (!Array.isArray(published)) {
      throw new Error(`${label}: union contract projected without an option list`)
    }
    expect(published.length, `${label}.anyOf arity`).toEqual(arms.length)
    arms.forEach((arm, index) => {
      expectProjectionDerivedFrom(arm, published[index], `${label}|${index}`)
    })
    return
  }

  // A scalar-rooted contract has no key set to relate, so the relation would need extending.
  expect(Object.keys(document).length, label).toBeGreaterThan(0)
}
