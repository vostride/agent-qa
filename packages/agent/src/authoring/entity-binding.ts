// Never-guess binding for an LLM-supplied entity name.
//
// A name a model chose decides WHICH of a person's tests an edit rewrites. D-19's rule is that such
// a name binds only on a UNIQUE HIGH-CONFIDENCE hit; ambiguity, weakness and absence are each a
// typed refusal, and none of them is ever a silent guess into a file this project keeps.
//
// THE HOUSE RESOLVER ALREADY IS THAT RULE, WHICH IS WHY THERE IS NO SECOND MATCHER HERE. The spec's
// §8.1 sketch is a fuse.js threshold of about 0.4 applied at the authoring surface. This project
// shipped the same decision as a three-tier resolver in 387 — an exact-address tier, a strong-hit
// tier gated on BOTH an absolute score and a margin over the runner-up, and a disambiguation tier —
// and its `applyStrongHitRule` answers `none` for a lone candidate that clears neither. So the
// binding below REUSES that contract rather than restating it: adding a matcher and a threshold
// here would be a second answer to "which entity did the model mean", free to disagree with the
// first, and this codebase's arch lints exist because that class of drift is expensive. If the
// resolver's tiers are ever measured wrong for authoring, that is a change to the resolver.
//
// THE ONE PLACE THIS FILE DECIDES ANYTHING is what to do with `none.closestSuggestion`. The resolver
// attaches it when a single candidate ranked but did not clear the bar — which is EXACTLY the
// low-confidence lone match D-19 names — and it is offered so a surface can say "did you mean". A
// binder that promoted a suggestion to a binding would turn the resolver's refusal back into the
// guess it refused, one field away, and would look entirely reasonable in review. It is refused
// here by name, and the refusal carries the suggestion so a person can still be asked.
//
// WHY THIS REACHES THE PORT RATHER THAN THE REGISTERED OP. `entities.resolve` renders CARDS, and a
// card deliberately carries no test identity — D-12's render-never-recompute boundary drops it, so
// the op's answer cannot say which file a bound test lives in, and a binder reading one would have
// to recover a path from a title, which is the plausible-but-wrong attribution that boundary exists
// to prevent. `EntityDirectoryPort` is the SAME port that op invokes, on every op's `FunctionDeps`,
// and it answers descriptors. Nothing is widened by reaching it: the resolution is a read, the op
// that performs this binding declares `read`, and `entities.resolve` requires exactly `read` — so
// every caller who can reach this binding could already have called that op directly.

import { suiteTestRef } from '@vostride/agent-qa-schema'
import type { EntityDescriptor } from '@vostride/agent-qa-schema'

import type { EntityDirectoryPort } from '../functions/spec.js'

/** The identity halves a bound test is addressed by — never `testId`, which is per-run. */
export interface BoundTestIdentity {
  readonly filePath: string
  readonly testName: string
}

/**
 * What one name bound to.
 *
 * `source` is on the record rather than inferred, because the two tiers answer with different
 * confidence in different senses and a consumer that has to know which one it holds should not be
 * reconstructing it from which optional fields happen to be present. An exact reference is a parse;
 * a resolver hit is a ranking that cleared a bar.
 *
 * `identity` is OPTIONAL and its absence is honest rather than degraded: a resolved descriptor for
 * a kind that is not a test, or for a store that did not report a test identity, names a real
 * entity that this build cannot open a file for. The op that needs a file refuses on the absence by
 * name instead of guessing at one.
 */
export interface EntityBinding {
  /** The name as it arrived — what a refusal message and a receipt both have to echo. */
  readonly name: string
  readonly source: 'exact-ref' | 'resolver'
  /** The canonical reference this name bound to, in the one house spelling. */
  readonly ref: string
  readonly identity?: BoundTestIdentity
}

/**
 * The name matched more than one entity.
 *
 * A SEPARATE CLASS from {@link UnresolvedEntityNameError} rather than one error with a kind, on the
 * `authoring-verify-draft.ts` precedent, and here the distinction is what a caller does next:
 * ambiguity has candidates to put in front of a person — 387's disambiguation card — while an
 * unresolved name has nothing to choose between and needs a different question. A caller reading a
 * string to tell those apart is a caller that will one day read it wrong.
 */
export class AmbiguousEntityNameError extends Error {
  constructor(
    readonly entityName: string,
    /** The candidates the resolver offered, best-first, in its own words. */
    readonly candidates: readonly { readonly ref: string; readonly title: string; readonly score: number }[],
  ) {
    super(
      `the name "${entityName}" matches ${candidates.length} entities `
        + `(${candidates.map((candidate) => candidate.ref).join(', ')}); `
        + 'it was NOT bound — a name that matches several tests must be chosen between, never picked',
    )
    this.name = 'AmbiguousEntityNameError'
  }
}

/**
 * The name matched nothing the binder may act on.
 *
 * ONE class for two situations that are the same DECISION — nothing was bound — and different
 * facts, which is why `closestSuggestion` is a field rather than a second class: an honest miss and
 * a lone weak match both leave the caller with no binding, and the only thing a surface does
 * differently is offer the near miss. Splitting them would make every catch site handle two classes
 * to take one action.
 */
export class UnresolvedEntityNameError extends Error {
  constructor(
    readonly entityName: string,
    readonly reason: string,
    /** The near miss the resolver declined to bind, when it offered one. NEVER auto-applied. */
    readonly closestSuggestion?: string,
  ) {
    super(
      `the name "${entityName}" resolved to nothing this binding may act on (${reason})`
        + (closestSuggestion === undefined
          ? ''
          : `; the closest match was ${closestSuggestion}, which did not clear the resolver's bar `
            + 'and is offered as a question rather than applied'),
    )
    this.name = 'UnresolvedEntityNameError'
  }
}

export interface BindEntityNamesDeps {
  readonly entities: EntityDirectoryPort
}

/**
 * The exact-address tier: `<filePath>::<testName>`, the ONE spelling this project prints.
 *
 * Deterministic, no scoring, no model — the same posture the resolver's own tier (a) takes for an
 * address, and for the same reason: answering an exact address with whatever happened to rank is
 * the silent guess the whole mechanism exists to prevent. It matters that this tier exists at all,
 * because it is the spelling a dedup refusal already hands a person (`AuthoringDedupRefusal`), so
 * "edit that one" round-trips without a fuzzy match ever being consulted.
 *
 * The separator is required on BOTH sides: a ref with an empty path or an empty name is not an
 * address, and treating it as one would open a file this host never named.
 */
function parseExactRef(name: string): BoundTestIdentity | undefined {
  const separator = name.indexOf('::')
  if (separator <= 0) return undefined
  const filePath = name.slice(0, separator)
  const testName = name.slice(separator + 2)
  return testName.length === 0 ? undefined : { filePath, testName }
}

/** A descriptor's identity halves, when its owning store reported them. See {@link EntityBinding}. */
function identityOf(descriptor: EntityDescriptor): BoundTestIdentity | undefined {
  const identity = descriptor.testIdentity
  return identity === undefined
    ? undefined
    : { filePath: identity.filePath, testName: identity.testName }
}

/**
 * Bind every supplied name, or refuse by name on the first one that cannot be bound.
 *
 * REFUSES ON THE FIRST FAILURE, and refuses the WHOLE set — the applier's own posture and
 * the repair fence's. Binding what it could and reporting the rest would hand a caller a
 * partially-bound edit, which is the shape in which somebody eventually applies the bound half.
 *
 * Order is preserved, so a caller that supplied `[testRef]` reads its answer at index 0 without
 * having to search for it.
 */
export async function bindEntityNames(
  names: readonly string[],
  deps: BindEntityNamesDeps,
): Promise<readonly EntityBinding[]> {
  const bindings: EntityBinding[] = []

  for (const name of names) {
    const exact = parseExactRef(name)
    if (exact !== undefined) {
      bindings.push({
        name,
        source: 'exact-ref',
        ref: suiteTestRef(exact.filePath, exact.testName),
        identity: exact,
      })
      continue
    }

    const resolution = await deps.entities.resolve(name)
    switch (resolution.kind) {
      case 'resolved': {
        const identity = identityOf(resolution.descriptor)
        bindings.push({
          name,
          source: 'resolver',
          ref: resolution.descriptor.uri,
          ...(identity === undefined ? {} : { identity }),
        })
        break
      }
      case 'ambiguous':
        throw new AmbiguousEntityNameError(
          name,
          resolution.candidates.map((candidate) => ({
            ref: candidate.descriptor.uri,
            title: candidate.descriptor.title,
            score: candidate.score,
          })),
        )
      case 'none':
        // THE LOW-CONFIDENCE DIRECTION, and it is the one a permissive implementation gets wrong.
        // `closestSuggestion` is passed through as EVIDENCE and never as a fallback binding.
        throw new UnresolvedEntityNameError(
          name,
          resolution.reason,
          resolution.closestSuggestion,
        )
    }
  }

  return bindings
}
