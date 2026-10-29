// The ONE lens two schema-comparison suites look through.
//
// WHAT THIS FILE IS. Four normalisations that make an advertised JSON-Schema document and the
// function layer's own inert projection comparable, plus one fold check (`foldArmFindings`,
// 2026-10-20, 446-11), and NOTHING ELSE. It converts nothing, builds
// nothing, reaches nothing: the functions below are pure, take plain objects, return plain objects,
// and name no package. That is why the file adds no entry to this package's dependency census —
// there is no specifier in it to add.
//
// WHY IT MOVED HERE OUT OF A TEST. It was authored inside `projection-fidelity.test.ts`, where it
// had exactly one consumer. Phase 397's conformance suite lives in `packages/cli` and needs the
// same lens for its structural-schema-equality leg, and no package may reach another package's
// `__tests__` directory. The two ways out were to publish the lens or to re-derive it, and D-06
// rules out the second by name: a second conversion recipe for one comparison is the
// redundant-mechanism trap, and the way it fails is silent — the copy that drifts looser is the
// one that passes over real drift, and nothing compares the two copies to each other.
//
// SO THE TWO CONSUMERS SHARE ONE OBJECT: this package's own fidelity suite, and 397's parity suite
// over in the cli package. A third would be a third consumer of the same object, not a third lens.
//
// WHY THE NORMALISATIONS EXIST AT ALL (MCPS-07's citation, and the honest one). Both stamps
// they remove are artifacts of the SDK's own conversion under SEP-2106's full JSON Schema 2020-12
// posture for tool input/output schemas, produced by the converter SEP-1613 pins on the SDK side:
// the `$schema` dialect marker it writes, and the `type: "object"` it adds to a composition root it
// can prove is object-shaped. The function layer's projection speaks the same vocabulary and writes
// neither. Nothing here normalises a difference the PRODUCT introduced — only two the transport's
// converter did. The fourth undoes the 2025-11-25 codec's `{ result }` wrap around a
// non-object output root, which is likewise the transport's and not the product's.
//
// READ THE DOCSTRINGS BEFORE WIDENING ANYTHING. Each normalisation is gated as narrowly as it is
// for a MEASURED reason, recorded in its own comment. A strip that dropped content rather than a
// dialect marker or an SDK stamp would be the way to make a drift cell pass over a contract that
// genuinely moved — which is the one failure the suites consuming this file exist to catch.

/** A JSON-Schema document as it travels: an ordinary object, with nothing runnable on it. */
export type JsonDocument = Record<string, unknown>

/**
 * Drop `$schema`, which the SDK's conversion stamps and the registry's projection does not.
 *
 * A DIALECT MARKER, not content: it says which JSON Schema draft the document speaks and describes
 * nothing about the contract. Removing it is the one normalisation this file performs, and it is
 * called out rather than buried because a normalisation that removed content would be the way to
 * make a drift cell pass over real drift.
 */
export function withoutDialect(document: unknown): JsonDocument {
  const { $schema: _dialect, ...rest } = (document ?? {}) as JsonDocument
  return stripRedundantObjectStamp(rest)
}

/**
 * Drop the `type: "object"` the SDK stamps onto a COMPOSITION root.
 *
 * The second and last normalisation, and it is as narrow as the first. `standardSchemaToJsonSchema`
 * stamps `type: "object"` on a typeless root it can prove is object-shaped — a `oneOf` whose every
 * member is `type: "object"`, which is exactly what a zod discriminated union emits. The SDK's own
 * comment calls the stamp "redundant-but-valid", and a document is not changed by adding a
 * constraint every one of its branches already imposes.
 *
 * IT IS GATED ON THE COMPOSITION KEYWORD, so a genuine `type` disagreement still reds: the only
 * case dropped is a root that carries `oneOf`/`anyOf` AND the stamp, which is the one case the SDK
 * manufactures. An ungated `delete document.type` would have made the whole drift cell blind to a
 * contract whose root type actually moved.
 */
export function stripRedundantObjectStamp(document: JsonDocument): JsonDocument {
  const composed = document.oneOf !== undefined || document.anyOf !== undefined
  if (!composed || document.type !== 'object') return document
  const { type: _stamp, ...rest } = document
  return rest
}

/**
 * One union arm of a fold's composed contract, with the fold's discriminant taken back out.
 *
 * `required: []` is DROPPED rather than kept, and the case is real rather than defensive:
 * `config.undo.propose` takes an all-optional input, so its own projection carries no `required`
 * key at all while the extended arm carries `['action']` — and removing the discriminant from that
 * leaves an empty array where the other side has nothing. JSON Schema reads an absent `required`
 * and an empty one identically, so the two documents agree; keeping the empty array would have
 * failed the cell on a difference that describes no difference.
 */
export function armWithoutDiscriminant(arm: JsonDocument, discriminant: string): JsonDocument {
  const properties = { ...((arm.properties ?? {}) as JsonDocument) }
  delete properties[discriminant]
  const required = ((arm.required ?? []) as readonly string[]).filter((key) => key !== discriminant)
  const rebuilt: JsonDocument = { ...arm, properties, required }
  if (required.length === 0) delete rebuilt.required
  return rebuilt
}

/**
 * What a fold's one listed object leaves out of, or adds to, one arm's own contract.
 *
 * a fold lists one object instead of its union, so an arm is no longer
 * a member to compare whole. It is covered when the `discriminant` enum names it, every field it
 * takes is listed with its own shape (the listing may add a description, never drop one), and the
 * listing requires nothing the arm does not. That a call is still validated arm by arm is the
 * C446-TOOL-SCHEMA counter-cell's claim, not this lens's.
 */
export function foldArmFindings(
  listed: JsonDocument,
  discriminant: string,
  opId: string,
  own: JsonDocument,
): readonly string[] {
  const findings: string[] = []
  for (const key of ['oneOf', 'anyOf', 'allOf']) {
    if (listed[key] !== undefined) findings.push(`the listing carries a top-level ${key}`)
  }
  if (listed.type !== 'object') findings.push('the listing is not type object')
  const properties = (listed.properties ?? {}) as Record<string, JsonDocument>
  const selector = properties[discriminant]?.enum
  if (!Array.isArray(selector) || !selector.includes(opId)) {
    findings.push(`${discriminant} does not list ${opId}`)
  }
  const ownProperties = (own.properties ?? {}) as Record<string, JsonDocument>
  for (const [name, field] of Object.entries(ownProperties)) {
    const shown = properties[name]
    if (shown === undefined) {
      findings.push(`${name} is not listed`)
      continue
    }
    const { description: ownNote, ...ownShape } = field
    const { description: shownNote, ...shownShape } = shown
    const merged = Array.isArray(shownShape.anyOf) && Object.keys(shownShape).length === 1
    const shapes = merged ? [shownShape, ...(shownShape.anyOf as readonly unknown[])] : [shownShape]
    if (!shapes.some((shape) => JSON.stringify(shape) === JSON.stringify(ownShape))) {
      findings.push(`${name} is listed with another shape`)
    }
    const kept = typeof shownNote === 'string' && shownNote.includes(String(ownNote))
    if (typeof ownNote === 'string' && !kept) {
      findings.push(`${name} lost its own description`)
    }
  }
  const allowed = new Set([discriminant, ...((own.required ?? []) as readonly string[])])
  for (const name of (listed.required ?? []) as readonly string[]) {
    if (!allowed.has(name)) findings.push(`the listing requires ${name}, which ${opId} does not`)
  }
  if (own.additionalProperties === false && listed.additionalProperties !== false) {
    findings.push('the listing admits fields no arm takes')
  }
  return findings
}

/**
 * Undo the SEP-2106 legacy `{ result }` wrap the SDK's 2025-11-25 codec puts around a non-object
 * output root.
 *
 * A transport artifact, like the two stamps above: the 2026-07-28 codec advertises a list's array
 * root as-is, while the 2025-11-25 codec projects it to `{ type: 'object', properties: { result },
 * required: ['result'] }` and wraps `structuredContent` to match. Gated to exactly that document —
 * nothing but those three keys (and a dialect marker), one property named `result`, and a wrapped
 * root that is not itself an object — so an op whose real output is an object with a `result`
 * field is left alone. Apply it BEFORE `withoutDialect`: the wrapped root keeps its own `$schema`.
 */
export function withoutLegacyResultWrap(document: unknown): JsonDocument {
  const wrapper = (document ?? {}) as JsonDocument
  const keys = Object.keys(wrapper).filter((key) => key !== '$schema').sort()
  if (keys.join(',') !== 'properties,required,type' || wrapper.type !== 'object') return wrapper
  const properties = wrapper.properties as JsonDocument
  const required = wrapper.required as unknown
  if (Object.keys(properties ?? {}).join(',') !== 'result') return wrapper
  if (!Array.isArray(required) || required.length !== 1 || required[0] !== 'result') return wrapper
  const natural = properties.result as JsonDocument
  if (typeof natural !== 'object' || natural === null || natural.type === 'object') return wrapper
  return natural
}
