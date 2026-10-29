// Runs before dispatch; a project with no targets and no hostname in the request is refused.

import { parseHostnameToken } from './hostname-gate.js'

// A bracketed IPv6 origin keeps its brackets; anything a hostname or key cannot hold splits words.
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
    // A project with targets authors against them, so a file name parsed as a host is no scaffold.
    if (configured.size > 0) return { kind: 'passthrough' }
    // A kept scheme or port travels as the base URL; a plain derivation as the bare domain.
    const domain = verdict.baseUrl === `https://${verdict.domain}` ? verdict.domain : verdict.baseUrl
    return { kind: 'scaffold', domain, targetName: verdict.targetName }
  }

  // A project with targets can author against them without being told which; a project with none
  // has nothing at all, and that is the one case where silence is unanswerable.
  return configured.size > 0 ? { kind: 'passthrough' } : { kind: 'refuse' }
}

// The scaffold writes the configuration in its own call, then the test is authored.
export const WRITE_TEST_UNCONFIGURED_DETAIL
  = 'this project has no agent-qa configuration, so there is no target to write a test against. '
    + 'Name the site\'s address (for example "write a test for example.com") and I will write the '
    + 'configuration for it, then author the test. I will not guess which site you meant.'

// A scaffold answer that left nothing to author says why in its own words.
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
