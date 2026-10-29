// Where a write_test request goes when the project has no target for it (395-08, D-14/D-15 ·
// CFGM-05).
//
// THIS IS THE SEAM, AND FINDING IT WAS THE FIRST THING THIS PLAN HAD TO DO. The plan's design note
// says "where the chat turn resolves a write_test request's target against configuredTargetNames".
// No such place exists. `AuthoringDraftWriteInputSchema` carries `intent` (free text) and an
// optional `scope`; the TARGET is decided inside the authoring loop, by a model, from a draft it
// compiled — `loop.ts:583` reads the vocabulary and `loop.ts:647` checks the emitted name against
// it, both AFTER an LLM call. So the pre-dispatch question cannot be "does the request's target
// match" (there is no target on the request). It is: given this project's configured vocabulary and
// the words the person actually typed, is there anything to author against at all?
//
// THE AUTHORING LOOP'S OWN BACKSTOP IS UNTOUCHED, WHICH IS RESEARCH PITFALL 6. This resolver runs
// BEFORE dispatch and answers about the REQUEST; `AuthoringDraftUnconfiguredTargetError` runs after
// compilation and answers about what the MODEL emitted. They guard different failures — a project
// with nothing to write for, and a model that named a target this project does not declare — and
// collapsing either into the other would leave one of them unguarded.
//
// THE PASSTHROUGH ARM IS THE COMMON CASE AND IT IS DELIBERATELY WIDE. "Write a test for the login
// flow" in a configured project names no target and no hostname, and it must reach authoring
// exactly as it does today: `deriveDefaultAuthoringScope` resolves the scope from the project's own
// targets and committed tests, and the loop's backstop catches an emission that goes wrong. A
// resolver that refused every intent it could not attribute would break the shipped path for the
// majority of real requests, in the name of a from-zero case none of them are.
//
// THE REFUSAL ARM IS THEREFORE NARROW, AND ITS PRECONDITION IS THE PROJECT RATHER THAN THE WORDING:
// a project that declares NO targets, and an utterance carrying no hostname. That is exactly D-15's
// sentence — "anything else with no configured-target match gets a typed refusal asking for a URL or
// target name" — read where it is actually true.
//
// THE SCAFFOLD ARM CARRIES THE SAME PRECONDITION SINCE 395-12. Scaffolding is the FROM-ZERO
// path; a project that already declares targets authors against them. Offering the scaffold there
// traded a working dispatch for a refusal about a site nobody named — a token like `readme.md` or
// `index.html` parses as a hostname, and in a configured project that turn used to end in
// `already-configured` for `readme-md`. The precondition is the project, in both arms.
//
// THE ARM TABLE, IN ORDER, BECAUSE THE ORDER IS THE CONTRACT:
//
//   1. a token that IS a configured target name              -> configured
//   2. a hostname token whose DERIVED name is configured      -> configured
//   3. a hostname token in a project that declares targets    -> passthrough
//   4. a hostname token in a project that declares none       -> scaffold
//   5. no hostname, and the project declares targets          -> passthrough
//   6. no hostname, and the project declares none             -> refuse
//
// TOKENS, NOT SUBSTRINGS. A configured target named `shop` must not match the word `workshop`, and
// a hostname must be a whole word rather than a fragment of one. The split is on characters that
// cannot appear in a hostname or in a target name, so the tokens this sees are the words a person
// typed.

import { parseHostnameToken } from './hostname-gate.js'

/**
 * A word: either a bracketed IPv6 origin, whose brackets must survive, or a run of what
 * a hostname and a registry key CAN hold. Everything else separates words.
 */
const TOKEN = /(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/)?\[[0-9A-Fa-f:.]+\][A-Za-z0-9.:/?=&@_-]*|[A-Za-z0-9.:/?=&@_-]+/g

export type WriteTestRoute =
  | {
    /** A configured target is named in the utterance. Dispatch authoring, unchanged. */
    readonly kind: 'configured'
    readonly name: string
  }
  | {
    /** Nothing to decide here. The authoring loop derives its own scope, as it always has. */
    readonly kind: 'passthrough'
  }
  | {
    /** A hostname this project does not configure. Scaffold it, then author. */
    readonly kind: 'scaffold'
    readonly domain: string
    readonly targetName: string
  }
  | {
    /** No targets, no hostname. Ask; never guess. */
    readonly kind: 'refuse'
  }

/**
 * Route one write_test request, deterministically.
 *
 * ORDER IS THE CONTRACT. A configured name wins over a hostname, because a project that already
 * declares `booking-com` and is asked about `booking.com` wants the target it has — and scaffolding
 * would refuse `already-configured` one layer down anyway, which is a worse sentence for a request
 * that had a perfectly good answer.
 */
export function resolveWriteTestRoute(input: {
  readonly intent: string
  readonly configuredTargetNames: readonly string[]
}): WriteTestRoute {
  const tokens = input.intent.match(TOKEN) ?? []
  const configured = new Set(input.configuredTargetNames)

  for (const token of tokens) {
    if (configured.has(token)) return { kind: 'configured', name: token }
  }

  for (const token of tokens) {
    const verdict = parseHostnameToken(token)
    if (verdict.kind !== 'hostname') continue
    // A hostname whose DERIVED name this project already declares is that target, spelled as a
    // domain. Answering `scaffold` here would send a person to a refusal for a target they have.
    if (configured.has(verdict.targetName)) {
      return { kind: 'configured', name: verdict.targetName }
    }
    // WR-05. A project that declares targets authors against them; `readme.md` and
    // `index.html` both parse as hostnames, and offering a scaffold for one of them is how a turn
    // that had a perfectly good authoring dispatch ended in `already-configured` for a site nobody
    // named. The scaffold arm is the from-zero path and this is where it says so.
    if (configured.size > 0) return { kind: 'passthrough' }
    // The scaffold op re-parses what it is handed, so a kept scheme or port travels as the base URL
    // A plain derivation still travels as the bare domain it always did.
    const domain = verdict.baseUrl === `https://${verdict.domain}` ? verdict.domain : verdict.baseUrl
    return { kind: 'scaffold', domain, targetName: verdict.targetName }
  }

  // A project with targets can author against them without being told which; a project with none
  // has nothing at all, and that is the one case where silence is unanswerable.
  return configured.size > 0 ? { kind: 'passthrough' } : { kind: 'refuse' }
}

/**
 * The refusal a write_test request against an unconfigurable project earns (D-15, 387's posture).
 *
 * 2026-10-03 (quick 261003-cpv, 432 review WR-02): it no longer promises a review. The scaffold
 * writes the configuration in its own call and the test is authored after it.
 */
export const WRITE_TEST_UNCONFIGURED_DETAIL
  = 'this project has no agent-qa configuration, so there is no target to write a test against. '
    + 'Name the site\'s address (for example "write a test for example.com") and I will write the '
    + 'configuration for it, then author the test. I will not guess which site you meant.'

/**
 * Why a scaffold the write_test route asked for left nothing to author against, in its own words
 * (261003-cpv, 432 review WR-03). A refused or interrupted answer carries its own `detail`; a
 * blocked one carries its summary line and reason; a no-change one wrote nothing because the
 * configuration already held it. The no-configuration sentence is never the answer here: the
 * person named the site, and the scaffold said why it wrote nothing.
 */
export function writeTestScaffoldStopDetail(answer: {
  readonly outcome?: string
  readonly detail?: string
  readonly summaryLine?: string
  readonly blockedReason?: string
  readonly validationIssues?: readonly string[]
  readonly path?: string
}): string {
  if (answer.detail !== undefined && answer.detail !== '') return answer.detail
  const attempted = answer.summaryLine === undefined ? '' : ` (${answer.summaryLine})`
  if (answer.outcome === 'blocked') {
    const issues = answer.validationIssues === undefined || answer.validationIssues.length === 0
      ? ''
      : ` Validation said: ${answer.validationIssues.join('; ')}.`
    return 'the configuration was not written because the result would not be valid'
      + `${attempted}, so there is no target to write a test against.${issues}`
  }
  if (answer.outcome === 'no-change') {
    return 'the configuration already holds what scaffolding would write'
      + `${answer.path === undefined ? '' : ` (${answer.path})`}, so nothing was written, and it `
      + 'declares no target to write a test against.'
  }
  return 'the configuration change answered without naming a file it wrote'
    + `${attempted}, so there is no target to write a test against.`
}
