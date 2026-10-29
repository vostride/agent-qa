// The relation between a declared contract and the projection published for it
// (Phase 384, Plan 11 — WR-02 / M-03).
//
// Not a test file (the suite collects `*.test.ts`), and not production code either: it is
// the shared half of an acceptance criterion that both agent test files state.
//
// WHY IT EXISTS. The gate it replaces asserted only the SHAPE of a projection — a plain
// object, a nonzero key count, one of `type`/`properties`/`anyOf`/`items`, no `parse`. The
// round-3 verifier replaced `toSchemaProjection`'s body with a frozen constant that
// discards its `schema` argument and the entire agent suite passed, 78/78. A criterion that
// a constant satisfies certifies nothing, and 396's MCP tool listing and 397's golden
// snapshot are both admitted through this one.
//
// The remedy is not a stricter shape check — it is writing the criterion as a RELATION
// between two artifacts. Every expected key set below is READ off the paired spec's own
// live zod shape with `Object.keys`; no field name, no key list and no per-id expected
// document appears anywhere in this file or in its callers. Two forms were falsified by the
// verifier and are deliberately absent: comparing projections to each other for
// distinctness (only 4 of 6 shipped projections are distinct, so a near-constant passes),
// and enumerating expected values by id (a seventh capability re-opens the hole).

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

/**
 * Every spec singleton, keyed by the id its declaration is listed under.
 *
 * This map is a GROWTH SEAM, and both callers assert exact set equality between its keys
 * and the ids the registry lists — so a seventh capability added in 386 or 387 reddens both
 * files until its spec is paired here, rather than silently arriving with an unchecked
 * projection. It reproduces the discipline `INVOCATION_SAMPLES` already applies to calling.
 */
export const CONTRACTS_BY_ID: Readonly<Record<string, DeclaredContracts>> = {
  // pair the new read's live contracts with its registry projection.
  'knowledge.gates.list': knowledgeGatesListSpec,
  // 392 D-24. Paired the day it is registered (the growth seam working as designed). Its OUTPUT
  // is the first in this map carrying an ARRAY of per-clause receipts beside an optional refusal
  // object, which is exactly the shape a careless projection flattens — and flattening it would
  // leave 396's MCP catalogue unable to say that a turn refused before anything ran, the one
  // claim D-10's atomicity rests on.
  // 393 D-01. Paired the day it is registered (the growth seam working as designed). Its OUTPUT is
  // the draft receipt — four separately-named gate objects, a per-step classification table, a
  // per-run record list and an adds-value finding — which is the deepest nesting in this map, and
  // exactly the shape a careless projection flattens. Flattening it would leave 396's MCP catalogue
  // unable to say that the four booleans are reported SEPARATELY, which is the literal text of
  // WTST-02.
  'authoring.draft.verify': authoringVerifyDraftSpec,
  // 394 D-01. Paired the day it is registered (the growth seam working as designed). Its OUTPUT
  // embeds the receipt above — so it inherits that nesting — beside two OPTIONAL members and a
  // closed outcome enum, and the optionality is the part a careless projection loses. `draftRef`
  // and `receipt` are absent exactly on the stage-2 refusal arm (plan 04), so a catalogue that
  // published them as required would tell 396's consumers that every authoring call yields a
  // receipt, which is the one claim the honesty funnel's side counters exist to contradict.
  'authoring.draft.edit': authoringDraftEditSpec,
  'authoring.draft.write': authoringDraftWriteSpec,
  // the funnel read's contracts, on its siblings' footing. The map is compared for
  // exact key-set equality against the registry, so this row is what stops a capability joining
  // the layer without its contracts being reachable for the projection relation.
  'authoring.funnel.get': authoringFunnelGetSpec,
  'agent.ask': agentAskSpec,
  // 398 D-09. Paired the day it is registered (the growth seam working as designed). Its OUTPUT is
  // a DISCRIMINATED UNION over two strict arms, which is the shape this map had not carried before
  // and exactly the one a careless projection collapses. Collapsing it would leave a catalogue
  // unable to say that an answer and an abstention are different results — and "the abstention is
  // a typed arm, not a flag on an answer" is the whole of XPLN-02's honesty claim.
  'agent.explain': explainSpec,
  // 389 D-11. Paired the day it is registered (the growth seam working as designed): its
  // output is the first here carrying two parallel per-test arrays plus a nested cluster
  // list, so an unchecked projection would be where a `sentences` member could quietly stop
  // appearing in a published catalogue.
  'analysis.get': analysisGetSpec,
  // 395 D-01/D-03 · CFGM-01/03. Paired the day they are registered (the growth seam working as
  // designed). `config.field.set`'s OUTPUT is a three-arm discriminated union — proposed, invalid,
  // no-change — and the arms are exactly what a careless projection flattens: a catalogue that
  // published the union as one object would tell 396's consumers that every propose call yields a
  // proposal id, which is the one claim CFGM-01's validate-before-surfacing law denies.
  // `config.proposal.apply`'s OUTPUT is the two-arm apply outcome, and the `already-applied` arm
  // flattened away would erase CFGM-03's idempotency answer from every projected surface.
  'config.field.set': configFieldSetSpec,
  'config.auth.set': configAuthSetSpec,
  'config.get': configGetSpec,
  'config.hook.add': configHookAddSpec,
  // 395-05 D-01. Paired the day they are registered. Both project the SAME three-arm propose union
  // as `config.field.set` plus the `refused` arm 395-05 adds, and that fourth arm is exactly what a
  // careless projection flattens: a catalogue that published it as one object would tell 396's
  // consumers that a create against an existing target answers with a proposal id.
  'config.target.create': configTargetCreateSpec,
  'config.target.edit': configTargetEditSpec,
  // 395-06 D-07. The undo projects the SAME four-arm propose union as its six siblings, which is
  // the point: a catalogue consumer needs no undo-shaped arm, because the undo is not a new kind
  // of answer — it is the same proposal a person decides on, built from a different set of bytes.
  'config.project.scaffold': configProjectScaffoldSpec,
  'entities.get': entitiesGetSpec,
  'entities.resolve': entitiesResolveSpec,
  // 391 PROP-01 / D-03 paired `grants.list` and `grants.revoke` here; 432-18 deletes both ops.
  'knowledge.accept': knowledgeAcceptSpec,
  'knowledge.bundles.list': knowledgeBundlesListSpec,
  'knowledge.brief.why': knowledgeBriefWhySpec,
  'knowledge.forget': knowledgeForgetSpec,
  'knowledge.record.show': knowledgeRecordShowSpec,
  'knowledge.records.diff': knowledgeRecordsDiffSpec,
  'knowledge.records.inspect': knowledgeRecordsInspectSpec,
  'knowledge.reject': knowledgeRejectSpec,
  // 391 PROP-03. Paired the day they are registered. `show` and `reject` are the first
  // contracts in this map whose output union carries a WHOLE nested DTO per arm — the inbox
  // envelope, payload and all — so an unchecked projection is exactly where a published
  // catalogue could lose `decision` or `evidenceRefs` and leave a surface unable to render the
  // decision trail it exists to render.
  // 391 PROP-01 / D-01. Paired the day it is registered. Its OUTPUT is the first in this map with
  // TWO independent unions in one object — the apply half and the mint half — which is exactly the
  // shape a careless projection flattens, and flattening it would leave a surface unable to say
  // that an apply committed while its escalation was refused.
  // 390 D-13. Paired the day they are registered, which is what the growth seam is for. The
  // two write verbs are the first contracts in this map whose OUTPUT is a discriminated union,
  // so an unchecked projection would be exactly where a published catalogue could lose an arm
  // — and losing `no-entry` or `renewed` would leave a caller with no way to learn that its
  // release matched nothing or that its add renewed rather than entered.
  'quarantine.add': quarantineAddSpec,
  'quarantine.list': quarantineListSpec,
  'quarantine.release': quarantineReleaseSpec,
  // 405-01 D-03. Paired here the day it is registered, on the growth seam's own rule. Its output
  // is the first in this map carrying THREE nested arrays of objects plus an object whose three
  // numeric members are OPTIONAL BY DESIGN (`RunTokenTotals` — absent means unmeasured, never
  // zero), so an unchecked projection is exactly where a published catalogue could start
  // declaring those sums as required and turn "nobody measured" into "the value is 0".
  // 405-05 D-12/D-13. Paired here the day it is registered, on the growth seam's own rule. Its
  // input is the first in this map carrying a REGEX-constrained string, and that constraint is
  // load-bearing rather than cosmetic: the 64-lowercase-hex shape is what makes a malformed sha a
  // refusal before any path exists, so a projection that dropped it would publish a contract under
  // which `../../etc/passwd` is a well-formed request.
  'runs.artifact': runsArtifactSpec,
  'runs.detail': runsDetailSpec,
  'runs.evidence': runsEvidenceSpec,
  // project the real mark validators through the same inert-declaration law.
  'runs.mark': runsMarkSpec,
  'runs.mark.preview': runsMarkPreviewSpec,
  'runs.marks.history': runsMarksHistorySpec,
  'runs.overview': runsOverviewSpec,
  'runs.events': runsEventsSpec,
  'runs.get': runsGetSpec,
  // 407-01 D-05. Paired here the day it is registered, on the growth seam's own rule. Its output
  // is the first in this map carrying a TOP-LEVEL discriminated union whose two arms differ in
  // nearly every field — `evidence-incomplete` holds only a run id where `ready` holds the whole
  // panel — so an unchecked projection is exactly where a published catalogue could lose the
  // absence arm and leave a caller with no declared way to learn that a run's evidence is gone.
  'runs.knowledge': runsKnowledgeSpec,
  'runs.list': runsListSpec,
  // 403-01 D-03. Paired here the day it is registered, on the growth seam's own rule. Its output
  // carries a DISCRIMINATED UNION (`stream`), which is the first in this map — an unchecked
  // projection is exactly where a published catalogue could lose the `none` arm, leaving a caller
  // with no declared way to learn that a target has no live preview at all.
  'runs.liveurl': runsLiveUrlSpec,
  // the editor subject's minter, paired the day it is registered. Its output
  // reuses runs.liveurl's `stream` union, so the `none` arm is checked here a second time.
  'editor.liveurl': editorLiveUrlSpec,
  // 388 D-14. Paired here the day it is registered, which is exactly what the growth seam is
  // for: its output contract is the first in this map with a nested optional object, so an
  // unchecked projection would have been the first place a `notification` could quietly stop
  // appearing in a published catalogue.
  'runs.postprocessing': runsPostProcessingSpec,
  // the digest's output is the SECOND contract here with a nested optional
  // object (`chain.outcome`) and the first with an imported nested array schema — the analysis
  // cluster view, borrowed rather than restated — so an unchecked projection would be the first
  // place a borrowed sub-contract could quietly stop appearing in a published catalogue.
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

  // A scalar-rooted contract has no key set to relate. None of the twelve contracts this
  // phase registers is one; if a later phase declares one, the relation above is what needs
  // extending, and this clause is deliberately narrow so that is visible.
  expect(Object.keys(document).length, label).toBeGreaterThan(0)
}
