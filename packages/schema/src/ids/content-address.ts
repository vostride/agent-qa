// Mutable bundle state hashes separately; the two hashes must never share inputs.
import type { BundleKind, FactSubtype } from '../delta/envelope'
import { canonicalJson } from '../determinism/canonical-json'
import { sha256hex } from '../determinism/sha256'
import type { Anchor } from '../identity/anchor'
import { normalizeAnchor } from '../identity/normalize-anchor'
import type { ScopeKey } from '../identity/scope-key'
import { normalizeAccessibleName } from '../screen/normalize-name'
import { asRecordId, type RecordId } from './record-id'
import { slugBranch } from './slug'

export const BUNDLE_ID_HASH_SUFFIX_LENGTH = 16
export const BUNDLE_SLUG_MAX_LENGTH = 48

type ElementFactSubtype = Exclude<FactSubtype, 'measurement'>

export type BundleDiscriminant =
  | {
      kind: 'fact'
      subtype: ElementFactSubtype
      elementRef: { role: string; name: string }
      /** Real Supersede evidence identifies the replacement validity-window generation. */
      validityWindowEvidenceToken?: string
    }
  | { kind: 'fact'; subtype: 'measurement'; metricKey: string }
  | { kind: 'procedure'; flowName: string; stepSignature: string }
  | { kind: 'caution'; errorKey: string }
  | { kind: 'unknown'; conflictRecordIds: readonly string[] }
  | { kind: 'policy'; ruleKey: string; validityWindowEvidenceToken?: string }

// Model-authored prose, including title, summary and body, never enters the identity hash.
export interface BundleIdentityCore {
  kind: BundleKind
  subtype: FactSubtype | null
  primaryAnchor: Anchor
  scope: ScopeKey
  discriminantKey: string
}

export interface BundleIdentityInput {
  kind: BundleKind
  subtype?: FactSubtype
  primaryAnchor: Anchor
  scope: ScopeKey
  discriminantKey: string
}

function text(input: string): string {
  return `${input.length}:${input}`
}

function normalizeText(input: string): string {
  return input.trim().replace(/\s+/g, ' ').toLowerCase()
}

function normalizedErrorKey(input: string): string {
  const normalized = normalizeAnchor({ t: 'error', message: input })
  return normalized.t === 'error' ? normalized.message : input
}

// Independent of all authored prose.
export function deriveDiscriminantKey(discriminant: BundleDiscriminant): string {
  switch (discriminant.kind) {
    case 'fact':
      if (discriminant.subtype === 'measurement') {
        return canonicalJson({
          kind: discriminant.kind,
          metricKey: normalizeText(discriminant.metricKey),
          subtype: discriminant.subtype,
        })
      }
      return canonicalJson({
        elementRef: {
          name: normalizeAccessibleName(discriminant.elementRef.name),
          role: normalizeText(discriminant.elementRef.role),
        },
        kind: discriminant.kind,
        subtype: discriminant.subtype,
        ...(discriminant.validityWindowEvidenceToken === undefined ? {} : {
          validityWindowEvidenceToken: discriminant.validityWindowEvidenceToken,
        }),
      })
    case 'procedure':
      return canonicalJson({
        flowName: normalizeAccessibleName(discriminant.flowName),
        kind: discriminant.kind,
        stepSignature: discriminant.stepSignature,
      })
    case 'caution':
      return canonicalJson({
        errorKey: normalizedErrorKey(discriminant.errorKey),
        kind: discriminant.kind,
      })
    case 'unknown':
      return canonicalJson({
        conflictRecordIds: [...new Set(discriminant.conflictRecordIds)].sort(),
        kind: discriminant.kind,
      })
    case 'policy':
      return canonicalJson({
        kind: discriminant.kind,
        ruleKey: normalizeText(discriminant.ruleKey),
        ...(discriminant.validityWindowEvidenceToken === undefined ? {} : {
          validityWindowEvidenceToken: discriminant.validityWindowEvidenceToken,
        }),
      })
  }
}

/** Ordered procedure-step identity; length framing prevents concatenation ambiguity. */
export function computeStepSequenceSignature(orderedStepKeys: readonly string[]): string {
  return sha256hex(orderedStepKeys.map(text).join(''))
}

// Normalizes before hashing, so callers may pass a raw anchor.
export function computeBundleIdentityHash(core: BundleIdentityInput): string {
  const identityCore: BundleIdentityCore = {
    kind: core.kind,
    subtype: core.subtype ?? null,
    primaryAnchor: normalizeAnchor(core.primaryAnchor),
    scope: core.scope,
    discriminantKey: core.discriminantKey,
  }
  return sha256hex(canonicalJson(identityCore))
}

function anchorSlugText(anchor: Anchor): string {
  switch (anchor.t) {
    case 'el':
      return `el-${anchor.role}-${anchor.name}`
    case 'page':
      return `page-${anchor.route}`
    case 'flow':
      return `flow-${anchor.name}`
    case 'error':
      return `error-${anchor.message}`
    case 'selector':
      return `sel-${anchor.literal}`
    case 'platform':
      return `platform-${anchor.platform}`
  }
}

/** Human-reviewable, non-authoritative id prefix bounded to one safe path segment. */
export function bundleSlug(kind: BundleKind, primaryAnchor: Anchor): string {
  const raw = `${kind}-${anchorSlugText(normalizeAnchor(primaryAnchor))}`
  const kebab = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  const bounded = kebab.slice(0, BUNDLE_SLUG_MAX_LENGTH).replace(/-+$/g, '')
  return slugBranch(bounded)
}

// The hash suffix alone is the identity; the slug only eases human review.
export function mintBundleId(core: BundleIdentityInput): RecordId {
  const identityHash = computeBundleIdentityHash(core)
  return asRecordId(
    `${bundleSlug(core.kind, core.primaryAnchor)}-${identityHash.slice(0, BUNDLE_ID_HASH_SUFFIX_LENGTH)}`,
  )
}
