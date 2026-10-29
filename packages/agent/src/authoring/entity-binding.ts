// Binds only on the resolver's unique strong hit; `none.closestSuggestion` is never promoted.

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

// A separate class: ambiguity has candidates to offer, an unresolved name has none.
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

// Refuses the whole set on the first failure, so no caller gets a partially bound edit.
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
