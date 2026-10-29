// The planner's action vocabulary IS the registry.
//
// Three claims, and they are deliberately not the same claim:
//
//   1. THE SET. The toolset ids equal the registry walk plus exactly two meta-tools. Computed
//      from the walk, never from a number: a literal count would make this file a census of the
//      catalogue as it stood the day it was written, and 393-395's new ops would fail it rather
//      than joining it. The always-send-all law says the model sees everything the registry
//      offers; the assertion says it sees nothing else.
//   2. NOTHING RUNS. No tool in the set carries an execute callback, asserted per tool. This is
//      what makes D-10's "reconciliation completes BEFORE the first side effect" structural: the
//      SDK has no function to call, so `generateText` returns a plan and cannot enact one. A
//      comment saying so would be a promise; an absent property is a fact.
//   3. THE NAME MAPPING IS LOSSLESS. Round-tripped over EVERY id the walk produced, not over a
//      sample — a misdispatch costs whichever single op happened to collide, so a sample is the
//      one measurement shape that can miss it (Pitfall 8 / T-392-15).

import { asSchema } from 'ai'
import { MASKED_RESOLVED_CONFIG_SCHEMA_VERSION } from '@vostride/agent-qa-schema'
import type { FunctionCaller } from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'

import { createFunctionRegistry } from '../../functions/registry.js'
import type { FunctionDeclaration, FunctionDeps } from '../../functions/spec.js'
// Read from the module the STAMP lives in, on purpose: the claim under test is that the projection
// withholds exactly what `stampSessionFacts` writes, so the two sides must read one value.
import {
  SESSION_STAMPED_FUNCTION_IDS,
  WINDOW_STAMPED_FUNCTION_IDS,
} from '../turn-engine.js'
// The THIRD projection set, read from the leaf module the other two live in. It is not a stamp —
// nothing is written at the invoke — so it is not re-exported from `turn-engine.js`: what it
// declares is that the COMPOSITION resolves the field, and the sentence the model is shown says so
import { HOST_DERIVED_SCOPE_FUNCTION_IDS } from '../session-stamps.js'
import {
  ANSWER_ONLY_TOOL_NAME,
  CHAT_META_TOOL_NAMES,
  ChatToolNameError,
  MARK_UNHANDLED_TOOL_NAME,
  fromToolName,
  isChatMetaToolName,
  toToolName,
} from '../tool-names.js'
import { projectPlannerTools } from '../planner-tools.js'

/**
 * The required deps, at their emptiest.
 *
 * This file's subject is the CATALOGUE, not any op's behaviour: `list()` reads ids, summaries and
 * contract projections, and consults the deps only to answer bound-or-unbound. Handing it richer
 * fakes would add nothing an assertion here could see.
 */
function emptyDeps(): FunctionDeps {
  return {
    runs: {
      list: () => Promise.resolve([]),
      get: () => Promise.resolve(undefined),
      readEvents: () => Promise.resolve([]),
      readStepEvidence: () => Promise.resolve({ kind: 'run-not-recorded' } as const),
    },
    knowledge: {
      listBundles: () => Promise.resolve([]),
      inspectRecords: () => Promise.resolve([]),
      diffSince: () => Promise.resolve([]),
      showRecord: ({ recordId }) =>
        Promise.resolve({ kind: 'not-found', schemaVersion: 2, recordId } as const),
    },
    entities: {
      resolve: () => Promise.resolve({ kind: 'none' as const, reason: 'no-match' as const }),
      get: () => Promise.resolve(undefined),
    },
    config: {
      getMasked: () =>
        Promise.resolve({
          schemaVersion: MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
          configPath: 'agent-qa.config.yaml',
          entries: [],
        }),
    },
  }
}

/**
 * The planner's caller: agent origin (Pitfall 1), and NOT in safe mode.
 *
 * Safe mode is a cosmetic listing filter, so composing the toolset through a safe-mode caller
 * would hand the model a smaller vocabulary than the host can run — the hidden-door shape the
 * always-send-all law exists to refuse. The composition mints this caller; the walk equivalence
 * below compares against the SAME caller either way, which is why that assertion holds whatever
 * a host decides here.
 */
const PLANNER_CALLER: FunctionCaller = {
  surface: 'chat',
  origin: 'agent',
}

function registry() {
  return createFunctionRegistry({ deps: emptyDeps() })
}

describe('tool-names: the dotted-id <-> provider-safe bijection', () => {
  it('maps the dot taxonomy onto the provider-safe charset', () => {
    expect(toToolName('runs.start')).toBe('runs_start')
    expect(fromToolName('runs_start')).toBe('runs.start')
  })

  it('round-trips EVERY id the registry walk produces, not a sample', () => {
    const ids = registry().list(PLANNER_CALLER).map((declaration) => declaration.id)
    expect(ids.length).toBeGreaterThan(0)
    for (const id of ids) {
      expect(fromToolName(toToolName(id))).toBe(id)
    }
  })

  it('produces a name inside the provider-safe charset for every id in the walk', () => {
    for (const declaration of registry().list(PLANNER_CALLER)) {
      expect(toToolName(declaration.id)).toMatch(/^[a-zA-Z0-9_-]+$/)
    }
  })

  it('refuses an id carrying the separator it would map ONTO, rather than colliding quietly', () => {
    // The mapping is a bijection over the id grammar it accepts, and this is where it says so.
    // An id already carrying an underscore has two pre-images under the inverse, so the honest
    // answer is a named refusal at the projection rather than a tool name that silently
    // misdispatches to whichever op the reverse mapping happened to land on.
    expect(() => toToolName('runs.post_processing')).toThrow(ChatToolNameError)
  })

  it('refuses in BOTH directions on a meta-tool name, so orchestration cannot be read as an op', () => {
    // `answer_only` reverses to `answer.only`, which is a perfectly plausible op id. If the
    // catalogue ever gained one, an orchestration call and a capability call would be the same
    // bytes on the wire — so both halves refuse rather than one.
    expect(() => fromToolName(ANSWER_ONLY_TOOL_NAME)).toThrow(ChatToolNameError)
    expect(() => fromToolName(MARK_UNHANDLED_TOOL_NAME)).toThrow(ChatToolNameError)
    expect(() => toToolName('answer.only')).toThrow(ChatToolNameError)
    expect(() => toToolName('mark.unhandled')).toThrow(ChatToolNameError)
  })

  it('names exactly two meta-tools', () => {
    expect([...CHAT_META_TOOL_NAMES]).toEqual([ANSWER_ONLY_TOOL_NAME, MARK_UNHANDLED_TOOL_NAME])
    expect(isChatMetaToolName(ANSWER_ONLY_TOOL_NAME)).toBe(true)
    expect(isChatMetaToolName('runs_start')).toBe(false)
  })
})

describe('projectPlannerTools: the registry walk IS the toolset', () => {
  it('projects every registered op 1:1, plus exactly the two meta-tools, and nothing else', () => {
    const walked = registry().list(PLANNER_CALLER)
    const tools = projectPlannerTools(registry(), PLANNER_CALLER)

    // The denominator is the WALK. No numeric literal appears here on purpose: a count would
    // freeze the catalogue at today's size, and 393-395 add ops whose whole arrival proof is
    // that they appear in this set without anyone editing it.
    const expected = [
      ...walked.map((declaration) => toToolName(declaration.id)),
      ...CHAT_META_TOOL_NAMES,
    ].sort()

    expect(Object.keys(tools).sort()).toEqual(expected)
  })

  it('includes agent.ask itself — op-calls-op recursion is ordinary composition', () => {
    const tools = projectPlannerTools(registry(), PLANNER_CALLER)
    expect(Object.hasOwn(tools, 'agent_ask')).toBe(true)
  })

  it('carries NO execute callback on any tool — nothing can run before reconciliation', () => {
    const tools = projectPlannerTools(registry(), PLANNER_CALLER)
    for (const [name, definition] of Object.entries(tools)) {
      expect(
        { name, hasExecute: 'execute' in definition },
      ).toEqual({ name, hasExecute: false })
    }
  })

  it('describes each action tool with the declaration summary a catalogue renders', () => {
    const walked = registry().list(PLANNER_CALLER)
    const tools = projectPlannerTools(registry(), PLANNER_CALLER)
    for (const declaration of walked) {
      const projected = tools[toToolName(declaration.id)]
      // A description-bearing op's description is its summary PLUS the sentence its set owns, and
      // the describe below owns those claims; here the summary is still the whole of it (394-22,
      // 394-26). The set-equality cell is what keeps this skip list from growing silently.
      if (
        WINDOW_STAMPED_FUNCTION_IDS.has(declaration.id)
        || HOST_DERIVED_SCOPE_FUNCTION_IDS.has(declaration.id)
      ) continue
      expect(projected?.description).toBe(declaration.summary)
    }
  })

  it('gives every action tool the declaration INPUT projection, never an invented schema', async () => {
    const walked = registry().list(PLANNER_CALLER)
    const tools = projectPlannerTools(registry(), PLANNER_CALLER)
    for (const declaration of walked) {
      const projected = tools[toToolName(declaration.id)]
      expect(projected).toBeDefined()
      // The stamped ops' projections are the declaration's MINUS what the host writes at the
      // invoke; the describe below pins that subtraction field by field (394-22, G-1).
      if (
        SESSION_STAMPED_FUNCTION_IDS.has(declaration.id)
        || WINDOW_STAMPED_FUNCTION_IDS.has(declaration.id)
      ) continue
      // Compared as a DOCUMENT rather than by identity: `jsonSchema()` normalises what it is
      // handed, so object identity would be an assertion about the SDK's internals. What matters
      // is that the tool's schema is the declaration's published projection — the same view 396's
      // MCP listing consumes — and not a second one derived here.
      expect(await schemaDocumentOf(projected?.inputSchema)).toEqual(declaration.input)
    }
  })

  it('shapes both meta-tools around the CLAUSE they are about', async () => {
    const tools = projectPlannerTools(registry(), PLANNER_CALLER)
    const unhandled = tools[MARK_UNHANDLED_TOOL_NAME]
    const answer = tools[ANSWER_ONLY_TOOL_NAME]
    expect(unhandled).toBeDefined()
    expect(answer).toBeDefined()

    const unhandledSchema = await schemaDocumentOf(unhandled?.inputSchema)
    const answerSchema = await schemaDocumentOf(answer?.inputSchema)
    expect(Object.keys(unhandledSchema.properties ?? {}).sort()).toEqual(['clause', 'reason'])
    // `answer_only` names its clause too, and that field is what makes the coverage claim
    // per-clause rather than per-turn: without it one answer consumed every unbound clause of a
    // compound request. The two meta-tools now agree on the vocabulary.
    expect(Object.keys(answerSchema.properties ?? {}).sort()).toEqual(['clause', 'text'])
    expect((answerSchema.required ?? []).slice().sort()).toEqual(['clause', 'text'])
  })

  it('FORBIDS refusing over an optional field, in the tool description itself', () => {
    // 394-30's live refusal, stated as a rule the model reads at the tool it misused. The planner
    // called `mark_unhandled` on a turn whose only obstacle was an OMITTED OPTIONAL FIELD — a field
    // its own contract lists outside `required` — so the refusal was not "no tool can do this" but
    // "I decided a tool I have needs something it says it does not". The description below is the
    // nearest surface to that decision: it is attached to the very call being made.
    const tools = projectPlannerTools(registry(), PLANNER_CALLER)
    const description = tools[MARK_UNHANDLED_TOOL_NAME]?.description ?? ''

    // NON-VACUITY: the existing contract text is still there, so this cell reds on the ABSENCE of
    // the new sentence rather than on any rewrite of the tool's meaning.
    expect(description).toContain('cannot be carried out with the tools available')
    expect(description).toContain(
      'Do not use this because an optional field is missing — optional fields never make a request '
      + 'unhandleable.',
    )
  })

  it('walks the registry it was handed, so a host with fewer ops gets fewer tools', () => {
    // The projection holds no catalogue of its own. Handing it a listing source that answers
    // with one declaration produces one action tool — which is the same statement as the walk
    // equivalence above, made from the other side: there is no built-in floor.
    const oneOp = registry().list(PLANNER_CALLER).slice(0, 1)
    const tools = projectPlannerTools({ list: () => oneOp }, PLANNER_CALLER)
    expect(Object.keys(tools).sort()).toEqual(
      [toToolName(oneOp[0]!.id), ...CHAT_META_TOOL_NAMES].sort(),
    )
  })
})

describe('projectPlannerTools: the model is not shown what the host stamps', () => {
  it('WITHHOLDS sessionRef from every op the host stamps it onto, and nothing else', async () => {
    // The declaration objects the transform actually sees, so the last assertion is about the
    // shared projection rather than about a second listing that would hide an in-place edit.
    const walked = registry().list(PLANNER_CALLER)
    const tools = projectPlannerTools({ list: () => walked }, PLANNER_CALLER)
    expect(SESSION_STAMPED_FUNCTION_IDS.size).toBeGreaterThan(0)

    for (const id of SESSION_STAMPED_FUNCTION_IDS) {
      const declaration = walked.find((entry) => entry.id === id)
      expect({ id, listed: declaration !== undefined }).toEqual({ id, listed: true })
      const declared = schemaOf(declaration!)

      // NON-VACUITY, first: the declaration DOES carry the field, so the absence below is a
      // removal that happened rather than a key that was never in this contract.
      expect({ id, declares: Object.hasOwn(declared.properties ?? {}, 'sessionRef') })
        .toEqual({ id, declares: true })

      const document = await schemaDocumentOf(tools[toToolName(id)]?.inputSchema)
      // EXACTLY one key gone, named by id on failure. `not.toHaveProperty` alone would be
      // satisfied by a transform that emptied the schema entirely.
      expect({ id, keys: Object.keys(document.properties ?? {}).sort() }).toEqual({
        id,
        keys: Object.keys(declared.properties ?? {}).filter((key) => key !== 'sessionRef').sort(),
      })
      // THE RULE, NOT TODAY'S ACCIDENT. This pinned the projected `required` list EQUAL to
      // the declared one, which is true only because `sessionRef` is optional on both stamped ops
      // — so `dropRequired` cannot currently fire and the cell certified a no-op. What the
      // transform promises is a SUBTRACTION: the day a sibling op declares the ref required, this
      // stays green on the correct behaviour instead of redding on it, and a transform that
      // stopped subtracting reds by the id it left behind.
      expect({ id, required: [...(document.required ?? [])].sort() }).toEqual({
        id,
        required: [...(declared.required ?? [])].filter((key) => key !== 'sessionRef').sort(),
      })

      // the declaration's projection is the registry's SHARED inert view — the same one
      // 396's MCP listing reads — so the transform must have cloned before editing.
      expect({ id, stillDeclares: Object.hasOwn(schemaOf(declaration!).properties ?? {}, 'sessionRef') })
        .toEqual({ id, stillDeclares: true })
    }
  })

  it('makes window OPTIONAL, keeps the wider arms, and says the host supplies it', async () => {
    const walked = registry().list(PLANNER_CALLER)
    const tools = projectPlannerTools({ list: () => walked }, PLANNER_CALLER)
    expect(WINDOW_STAMPED_FUNCTION_IDS.size).toBeGreaterThan(0)

    for (const id of WINDOW_STAMPED_FUNCTION_IDS) {
      const declaration = walked.find((entry) => entry.id === id)
      expect({ id, listed: declaration !== undefined }).toEqual({ id, listed: true })
      const declared = schemaOf(declaration!)

      // NON-VACUITY: the contract as declared REQUIRES the window, which is what a live planner
      // refused over — it cannot know a session ref, so a required session-shaped window is a
      // field it can only guess at (UAT item 1).
      expect({ id, declaredRequired: [...(declared.required ?? [])] })
        .toEqual({ id, declaredRequired: ['window'] })

      const document = await schemaDocumentOf(tools[toToolName(id)]?.inputSchema)
      expect({ id, required: document.required }).toEqual({ id, required: undefined })
      // The PROPERTY stays: a model may legitimately ask all-time or last-n.
      expect({ id, keeps: Object.hasOwn(document.properties ?? {}, 'window') })
        .toEqual({ id, keeps: true })

      const arms = unionArms(document.properties?.window)
      const declaredArms = unionArms(declared.properties?.window)
      expect({ id, arms: arms.length }).toEqual({ id, arms: 3 })
      expect({ id, arms: arms.length }).toEqual({ id, arms: declaredArms.length })
      for (const [index, arm] of arms.entries()) {
        const declaredArm = declaredArms[index]!
        if (!Object.hasOwn(declaredArm.properties ?? {}, 'sessionRef')) {
          // The wider arms pass through structurally untouched.
          expect({ id, index, arm }).toEqual({ id, index, arm: declaredArm })
          continue
        }
        expect({ id, was: [...(declaredArm.required ?? [])].sort() })
          .toEqual({ id, was: ['scope', 'sessionRef'] })
        expect({ id, now: [...(arm.required ?? [])] }).toEqual({ id, now: ['scope'] })
        // The session arm, minus exactly the ref — the arm is otherwise structurally the
        // declaration's. Comparing against the declared arm UNCHANGED is what certified the
        // property staying, which is the accident WR-02 named.
        const { sessionRef: _withheld, ...expectedArmProperties } = declaredArm.properties ?? {}
        expect({ id, arm: { ...arm, required: null } }).toEqual({
          id,
          arm: { ...declaredArm, properties: expectedArmProperties, required: null },
        })
      }

      const description = tools[toToolName(id)]?.description ?? ''
      // The catalogue text is still the catalogue's — the sentence is APPENDED, never a rewrite,
      // because `declaration.summary` is what 396's MCP listing renders.
      expect({ id, startsWithSummary: description.startsWith(declaration!.summary) })
        .toEqual({ id, startsWithSummary: true })
      expect(description).toContain('The host supplies a session-scoped')
      expect(description).toContain('omit it to ask about the current session')
    }
  })

  it('TRANSFORMS EXACTLY THE STAMPED UNION — the two sides cannot drift apart', async () => {
    // THE TWO-SIDED PIN, in the shape `session-stamp-vocabulary.test.ts` uses one layer down: the
    // derived side is read off the LIVE projection (which ids came back structurally different
    // from their declaration), the pinned side is the union of the two constants the STAMP
    // consults. A stamped op the transform misses reds by the omitted NAME; a transform that
    // starts editing an unstamped op's schema reds by the extra one.
    const walked = registry().list(PLANNER_CALLER)
    const tools = projectPlannerTools({ list: () => walked }, PLANNER_CALLER)

    const transformed: string[] = []
    for (const declaration of walked) {
      const document = await schemaDocumentOf(tools[toToolName(declaration.id)]?.inputSchema)
      if (canonical(document) !== canonical(declaration.input)) transformed.push(declaration.id)
    }

    const stamped = [...SESSION_STAMPED_FUNCTION_IDS, ...WINDOW_STAMPED_FUNCTION_IDS]
    // The guard the equality leans on: an empty walk or an empty union satisfies it perfectly and
    // measures nothing — the sibling file's own non-vacuity idiom.
    expect(walked.length).toBeGreaterThan(0)
    expect(stamped.length).toBeGreaterThan(0)
    expect(transformed.slice().sort()).toEqual(stamped.slice().sort())
  })

  it('TELLS the planner to pass a scope the person named, and states the refusal honestly', async () => {
    // WINDOWS 110's projection half, ROUND 5. 394-26 made the field optional at the registry, gave
    // the host the derivation, and said so in this sentence — and 394-30 measured a live planner
    // refusing the turn anyway, on a scope requirement its own tool contract denies. The sentence
    // that shipped closed with "pass `scope` only to author for a DIFFERENT target", which reads as
    // an instruction NOT to supply a scope the person had already named, and it promised a host
    // derivation that in fact refuses on any multi-product project (six candidates on the demo
    // workspace → `AuthoringScopeUnresolvableError`). Both halves are re-pinned here: the planner is
    // told to carry the person's own words into `scope`, and the multi-product refusal is stated as
    // what it is rather than implied away.
    const walked = registry().list(PLANNER_CALLER)
    const tools = projectPlannerTools({ list: () => walked }, PLANNER_CALLER)
    expect(HOST_DERIVED_SCOPE_FUNCTION_IDS.size).toBeGreaterThan(0)

    for (const id of HOST_DERIVED_SCOPE_FUNCTION_IDS) {
      const declaration = walked.find((entry) => entry.id === id)
      expect({ id, listed: declaration !== undefined }).toEqual({ id, listed: true })

      // NON-VACUITY: the contract must actually CARRY a scope the sentence can be about, and it
      // must be OPTIONAL — a required one would make the sentence a promise the schema refuses.
      const declared = schemaOf(declaration!)
      expect({ id, declares: Object.hasOwn(declared.properties ?? {}, 'scope') })
        .toEqual({ id, declares: true })
      expect({ id, requiresScope: [...(declared.required ?? [])].includes('scope') })
        .toEqual({ id, requiresScope: false })

      const description = tools[toToolName(id)]?.description ?? ''
      // APPENDED, never a rewrite: `declaration.summary` is what 396's MCP listing renders.
      expect({ id, startsWithSummary: description.startsWith(declaration!.summary) })
        .toEqual({ id, startsWithSummary: true })
      // Pinned VERBATIM and whole, not by fragment: the defect was a subordinate clause at the end
      // of a sentence whose opening was unobjectionable, so a `toContain` on the opening would have
      // stayed green across the exact edit this cell exists to force.
      expect(description).toContain(
        "When the person's request names the page, product or target it is for, pass `scope` with "
        + 'that target\'s key. When `scope` is omitted the host derives it only when this project '
        + 'has exactly one candidate product; otherwise the call returns a typed refusal naming '
        + 'every candidate — it never guesses.',
      )
      // And the retired clause is GONE rather than merely outnumbered. A description carrying both
      // sentences would satisfy the containment above while still telling the planner to withhold
      // the scope the person named.
      expect(description).not.toContain('only to author for a different target')
    }
  })

  it('shows NO sessionRef in a window arm either — the not-shown law has no exception',
    async () => {
      // WR-02. `modelFacingInput`'s window branch dropped the session arm's REQUIREDNESS and left
      // the property in place, while its own comment claimed the ref was gone — so the model was
      // still shown a field the host overwrites unconditionally, one level down from where the
      // top-level withhold removes it. The law at the module's head is "not shown at all"; this
      // cell is that law read at the arm.
      const walked = registry().list(PLANNER_CALLER)
      const tools = projectPlannerTools({ list: () => walked }, PLANNER_CALLER)
      expect(WINDOW_STAMPED_FUNCTION_IDS.size).toBeGreaterThan(0)

      let armsChecked = 0
      for (const id of WINDOW_STAMPED_FUNCTION_IDS) {
        const declaration = walked.find((entry) => entry.id === id)
        expect({ id, listed: declaration !== undefined }).toEqual({ id, listed: true })
        const declared = schemaOf(declaration!)
        const declaredArms = unionArms(declared.properties?.window)
        const arms = unionArms((await schemaDocumentOf(
          tools[toToolName(id)]?.inputSchema,
        )).properties?.window)
        expect({ id, arms: arms.length }).toEqual({ id, arms: declaredArms.length })

        for (const [index, declaredArm] of declaredArms.entries()) {
          // NON-VACUITY, per arm: only the arm that DECLARES the ref can have it removed, so the
          // counter below is what separates "the property is gone" from "there was no such arm".
          if (!Object.hasOwn(declaredArm.properties ?? {}, 'sessionRef')) continue
          armsChecked += 1
          const arm = arms[index]!
          expect({ id, index, shows: Object.hasOwn(arm.properties ?? {}, 'sessionRef') })
            .toEqual({ id, index, shows: false })
          // EXACTLY that key gone, named on failure: an arm emptied entirely would satisfy a bare
          // absence claim.
          expect({ id, index, keys: Object.keys(arm.properties ?? {}).sort() }).toEqual({
            id,
            index,
            keys: Object.keys(declaredArm.properties ?? {})
              .filter((key) => key !== 'sessionRef')
              .sort(),
          })
          // T-394-85 at the arm: the shared inert declaration still carries it.
          expect({ id, index, stillDeclares: Object.hasOwn(
            unionArms(schemaOf(declaration!).properties?.window)[index]?.properties ?? {},
            'sessionRef',
          ) }).toEqual({ id, index, stillDeclares: true })
        }
      }
      expect(armsChecked).toBeGreaterThan(0)
    })

  it('ANNOTATES EXACTLY THE DESCRIPTION-BEARING UNION — the two sides cannot drift apart', () => {
    // The 394-22 two-sided pin, applied to the DESCRIPTION channel rather than the schema one. The
    // derived side is read off the live projection — which ids came back with a description that
    // is not their catalogue summary — and the pinned side is the union of the two constants that
    // OWN a sentence. An op that gains a sentence without joining a set reds by its extra name; an
    // op in a set whose sentence never got appended reds by its omitted one.
    const walked = registry().list(PLANNER_CALLER)
    const tools = projectPlannerTools({ list: () => walked }, PLANNER_CALLER)

    const annotatedIds = walked
      .filter((declaration) =>
        (tools[toToolName(declaration.id)]?.description ?? '') !== declaration.summary)
      .map((declaration) => declaration.id)

    const described = [...WINDOW_STAMPED_FUNCTION_IDS, ...HOST_DERIVED_SCOPE_FUNCTION_IDS]
    // The guards the equality leans on, in the sibling cells' idiom: an empty walk or an empty
    // union satisfies it perfectly and measures nothing. Both sets are asserted non-empty
    // separately, so one of them emptying cannot hide behind the other.
    expect(walked.length).toBeGreaterThan(0)
    expect(WINDOW_STAMPED_FUNCTION_IDS.size).toBeGreaterThan(0)
    expect(HOST_DERIVED_SCOPE_FUNCTION_IDS.size).toBeGreaterThan(0)
    expect(annotatedIds.slice().sort()).toEqual(described.slice().sort())
  })

  it('CONTROL: an op in neither stamped set is handed its projection untouched', async () => {
    const walked = registry().list(PLANNER_CALLER)
    const tools = projectPlannerTools({ list: () => walked }, PLANNER_CALLER)
    const control = walked.find((entry) => entry.id === 'quarantine.list')
    expect(control).toBeDefined()
    expect(SESSION_STAMPED_FUNCTION_IDS.has('quarantine.list')).toBe(false)
    expect(WINDOW_STAMPED_FUNCTION_IDS.has('quarantine.list')).toBe(false)

    const projected = tools[toToolName('quarantine.list')]
    expect(await schemaDocumentOf(projected?.inputSchema)).toEqual(control!.input)
    expect(projected?.description).toBe(control!.summary)
  })

})

/** A declaration's input projection, read as the object-schema shape every current op projects. */
function schemaOf(declaration: FunctionDeclaration): {
  properties?: Record<string, unknown>
  required?: readonly string[]
} {
  return declaration.input as { properties?: Record<string, unknown>; required?: readonly string[] }
}

/**
 * The arms of a projected union, under whichever keyword zod emitted.
 *
 * Discriminated unions project as `oneOf` today and plain ones as `anyOf`; which keyword carries
 * the arms is a library detail rather than a contract, so both are read and a union that carried
 * neither answers empty — which the arm-count assertion above then reds on.
 */
function unionArms(
  node: unknown,
): readonly { properties?: Record<string, unknown>; required?: readonly string[] }[] {
  const union = node as { oneOf?: unknown; anyOf?: unknown } | null | undefined
  const arms = Array.isArray(union?.oneOf) ? union.oneOf : union?.anyOf
  return Array.isArray(arms)
    ? (arms as { properties?: Record<string, unknown>; required?: readonly string[] }[])
    : []
}

/** A key-order-independent rendering, so "structurally different" is not "serialised differently". */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'undefined'
}

/**
 * The JSON-Schema document behind whatever flexible schema a tool was given.
 *
 * The SDK's own `asSchema` normalises both forms this file produces — a zod object for the two
 * meta-tools, a `jsonSchema()` wrapper for every action tool — so the assertions above read one
 * shape and cannot accidentally be asserting the difference between the two.
 */
async function schemaDocumentOf(
  flexible: unknown,
): Promise<{ properties?: Record<string, unknown>; required?: readonly string[] }> {
  const normalised = asSchema(flexible as Parameters<typeof asSchema>[0])
  return (await normalised.jsonSchema) as {
    properties?: Record<string, unknown>
    required?: readonly string[]
  }
}
