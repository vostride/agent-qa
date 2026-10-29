// A payload whose manifest digest does not match is not authoritative; correctness beats scan cost.
import { readdirSync } from 'node:fs'
import { basename, join } from 'node:path'

import { canonicalJson, normalizeAnchor } from '@vostride/agent-qa-schema'
import type {
  Anchor,
  BundleStatus,
  DerivedTrustState,
  RecordId,
} from '@vostride/agent-qa-schema'

import { deriveBundleTrust, loadBundle, verifyBundleIntegrity } from './bundle-read.js'
import type { LoadedBundle } from './bundle-read.js'

export interface KnowledgeHit {
  bundleId: string
  product: string
  kind: LoadedBundle['frontmatter']['kind']
  subtype: string | null
  status: BundleStatus
  trust: number
  validity: DerivedTrustState['validity']
  summary: string
  embeddingInput: string
}

export interface ScanBundlesOptions {
  knowledgeRoot: string
  text?: string
  anchor?: Anchor
  product?: string
  k?: number
}

export interface ScanBundleByIdOptions {
  knowledgeRoot: string
  bundleId: string
}

export type CanonicalBundleAnchorLookup =
  | {
      kind: 'resolved'
      bundleId: RecordId
      product: string
      anchors: Anchor[]
    }
  | { kind: 'unresolved'; reason: 'not-found' }
  | { kind: 'unresolved'; reason: 'invalid'; detail: string }

export interface EnumeratedBundleDir {
  product: string
  dir: string
}

export interface ProductQualifiedBundleDir extends EnumeratedBundleDir {
  recordId: string
}

export class BundleTargetResolutionError extends Error {
  override readonly name = 'BundleTargetResolutionError'
  readonly recordId: string
  readonly product: string | undefined
  readonly reason: 'not-found' | 'ambiguous'

  constructor(
    recordId: string,
    product: string | undefined,
    reason: 'not-found' | 'ambiguous',
  ) {
    super(
      product === undefined
        ? `bundle target ${recordId} is ${reason}`
        : `bundle target ${product}/${recordId} is ${reason}`,
    )
    this.recordId = recordId
    this.product = product
    this.reason = reason
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function childDirectories(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return []
  }
}

/** Enumerate bundle directories in stable product-then-directory order. */
export function enumerateBundleDirs(knowledgeRoot: string): EnumeratedBundleDir[] {
  const memoryDir = join(knowledgeRoot, 'memory')
  const products = childDirectories(memoryDir)
    .filter((product) => !product.startsWith('.') && product !== 'index' && product !== 'queue')
    .sort(compareText)

  return products.flatMap((product) => {
    const bundlesDir = join(memoryDir, product, 'bundles')
    return childDirectories(bundlesDir)
      .filter((bundleDir) => !bundleDir.startsWith('.'))
      .sort(compareText)
      .map((bundleDir) => ({ product, dir: join(bundlesDir, bundleDir) }))
  })
}

/**
 * Extract a record id without assuming the host separator. Native Windows paths appear in
 * production while POSIX fixtures may deliberately exercise them during portability tests.
 */
export function bundleDirRecordId(dir: string): string {
  const portable = dir.replaceAll('\\', '/')
  return portable.slice(portable.lastIndexOf('/') + 1)
}

/** Resolve exactly one product-qualified target; record-only ambiguity is never first-match. */
export function resolveProductQualifiedBundleDir(input: {
  knowledgeRoot: string
  recordId: string
  product?: string
}): ProductQualifiedBundleDir {
  const matches = enumerateBundleDirs(input.knowledgeRoot)
    .filter((entry) => (
      bundleDirRecordId(entry.dir) === input.recordId
      && (input.product === undefined || entry.product === input.product)
    ))
  if (matches.length === 0) {
    throw new BundleTargetResolutionError(input.recordId, input.product, 'not-found')
  }
  if (matches.length !== 1) {
    throw new BundleTargetResolutionError(input.recordId, input.product, 'ambiguous')
  }
  return { ...matches[0]!, recordId: input.recordId }
}

/** The single withdrawn-fact firewall reused by degraded and indexed reader paths. */
export function isServable(trust: Pick<DerivedTrustState, 'status' | 'validity'>): boolean {
  return (
    (trust.status === 'active' || trust.status === 'candidate')
    && trust.validity.closedAtOrdinal === undefined
  )
}

function toHit(
  bundle: LoadedBundle,
  trustState: DerivedTrustState,
  product: string,
): KnowledgeHit {
  return {
    bundleId: bundle.manifest.id,
    product,
    kind: bundle.frontmatter.kind,
    subtype: bundle.frontmatter.subtype ?? null,
    status: trustState.status,
    trust: trustState.trust,
    validity: trustState.validity,
    summary: bundle.summary,
    embeddingInput: bundle.manifest.embeddingInput,
  }
}

// Matches stored normalized anchor forms too, because a bundle scan has no dense leg.
function textMatches(bundle: LoadedBundle, queryTokens: readonly string[]): boolean {
  if (queryTokens.length === 0) return true
  const searchableText = [
    bundle.manifest.embeddingInput,
    bundle.summary,
    ...bundle.frontmatter.anchors.map(({ raw }) => canonicalJson(raw)),
    ...bundle.frontmatter.anchors.map(({ normalized }) => canonicalJson(normalized)),
  ]
    .join('\n')
    .toLowerCase()
  return queryTokens.every((token) => searchableText.includes(token))
}

// The normalized-name fallback lives here because a bundle scan is always `vec: none`.
function anchorMatches(bundle: LoadedBundle, queryAnchor: Anchor | undefined): boolean {
  if (queryAnchor === undefined) return true
  const canonicalQuery = canonicalJson(queryAnchor)
  return bundle.frontmatter.anchors.some(({ normalized }) => {
    if (canonicalJson(normalized) === canonicalQuery) return true
    return normalized.t === 'el'
      && queryAnchor.t === 'el'
      && normalized.role === queryAnchor.role
      && normalized.name === queryAnchor.name
  })
}

function servableHit(dir: EnumeratedBundleDir): KnowledgeHit | undefined {
  const outcome = loadBundle(dir.dir)
  if (outcome.kind !== 'loaded') return undefined
  if (!verifyBundleIntegrity(dir.dir).ok) return undefined
  const trustState = deriveBundleTrust(outcome.bundle)
  return isServable(trustState)
    ? toHit(outcome.bundle, trustState, dir.product)
    : undefined
}

function scanBundlesWithPosture(
  opts: ScanBundlesOptions,
  servingOnly: boolean,
): KnowledgeHit[] {
  const queryTokens = (opts.text ?? '')
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token !== '')
  const queryAnchor = opts.anchor === undefined
    ? undefined
    : normalizeAnchor(opts.anchor)

  const hits: KnowledgeHit[] = []
  for (const entry of enumerateBundleDirs(opts.knowledgeRoot)) {
    if (opts.product !== undefined && entry.product !== opts.product) continue
    const outcome = loadBundle(entry.dir)
    if (outcome.kind !== 'loaded') continue
    if (!verifyBundleIntegrity(entry.dir).ok) continue

    const trustState = deriveBundleTrust(outcome.bundle)
    if (servingOnly && !isServable(trustState)) continue
    if (!textMatches(outcome.bundle, queryTokens)) continue
    if (!anchorMatches(outcome.bundle, queryAnchor)) continue
    hits.push(toHit(outcome.bundle, trustState, entry.product))
  }

  hits.sort(
    (left, right) => compareText(left.product, right.product)
      || compareText(left.bundleId, right.bundleId),
  )
  return opts.k === undefined
    ? hits
    : hits.slice(0, Math.max(0, Math.floor(opts.k)))
}

export function scanBundles(opts: ScanBundlesOptions): KnowledgeHit[] {
  return scanBundlesWithPosture(opts, true)
}

/** Internal retrieval scan: status and validity are filtered by the composed pipeline. */
export function scanBundlesForRetrieval(opts: ScanBundlesOptions): KnowledgeHit[] {
  return scanBundlesWithPosture(opts, false)
}

export function scanBundleById(opts: ScanBundleByIdOptions): KnowledgeHit | undefined {
  for (const entry of enumerateBundleDirs(opts.knowledgeRoot)) {
    if (basename(entry.dir) !== opts.bundleId) continue
    const hit = servableHit(entry)
    if (hit !== undefined) return hit
  }
  return undefined
}

/**
 * Trusted, read-only lookup for post-verdict attribution. Unlike scanBundleById this deliberately
 * ignores serving lifecycle state: a handoff may outlive a candidate's promotion, supersession, or
 * deprecation. Canonical bytes still have to parse and pass the complete integrity oracle.
 */
export function readCanonicalBundleAnchors(input: {
  knowledgeRoot: string
  bundleId: RecordId
}): CanonicalBundleAnchorLookup {
  const found = enumerateBundleDirs(input.knowledgeRoot)
    .find(({ dir }) => basename(dir) === input.bundleId)
  if (found === undefined) return { kind: 'unresolved', reason: 'not-found' }

  const loaded = loadBundle(found.dir)
  if (loaded.kind !== 'loaded') {
    return {
      kind: 'unresolved',
      reason: 'invalid',
      detail: `canonical bundle could not be loaded (${loaded.kind})`,
    }
  }
  if (loaded.bundle.manifest.id !== input.bundleId) {
    return {
      kind: 'unresolved',
      reason: 'invalid',
      detail: 'canonical bundle id does not match its directory identity',
    }
  }

  const integrity = verifyBundleIntegrity(found.dir)
  if (!integrity.ok) {
    return {
      kind: 'unresolved',
      reason: 'invalid',
      detail: integrity.violations.join('; '),
    }
  }

  return {
    kind: 'resolved',
    bundleId: input.bundleId,
    product: found.product,
    anchors: loaded.bundle.frontmatter.anchors.map(({ normalized }) => normalized),
  }
}
