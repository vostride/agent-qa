// The read-only bundle listing served by the /reader entry (Phase 384, D-06).
//
// `knowledge.bundles.list` had no reader-entry function before this module: bundle
// enumeration and loading lived only behind the writer-gated main entry, so a surface that
// wanted a listing had to reach through the write side. This composes the two existing read
// faces — `enumerateBundleDirs` and `loadBundle`/`deriveBundleTrust` — into the schema-owned
// `KnowledgeBundleSummary` projection and nothing else. No writer, no lease, no index.

import { relative } from 'node:path'

import type { KnowledgeBundleSummary } from '@vostride/agent-qa-schema'

import { deriveBundleTrust, loadBundle } from './bundle-read.js'
import { enumerateBundleDirs } from './bundle-scan.js'

/**
 * List every committed bundle under a knowledge root, newest lifecycle state first-class.
 *
 * Deliberately UNFILTERED by serving lifecycle: unlike `scanBundles`, a listing is a review
 * surface, and a superseded or withdrawn record is exactly what a reviewer needs to see. The
 * serving firewall (`isServable`) belongs on retrieval paths, not on a catalog.
 *
 * A bundle whose canonical files do not strictly parse is SKIPPED rather than thrown on, so
 * one damaged bundle never hides every other bundle from the listing. A missing knowledge
 * root is an ordinary empty result — `enumerateBundleDirs` already treats an unreadable
 * directory as empty.
 *
 * Order is total and stable: product, then bundle directory name (which is the record id).
 * `enumerateBundleDirs` already sorts on exactly those two keys.
 */
export function listBundles(knowledgeRoot: string): KnowledgeBundleSummary[] {
  const rows: KnowledgeBundleSummary[] = []

  for (const entry of enumerateBundleDirs(knowledgeRoot)) {
    const outcome = loadBundle(entry.dir)
    if (outcome.kind !== 'loaded') continue

    const { bundle } = outcome
    const trust = deriveBundleTrust(bundle)

    rows.push({
      bundleId: bundle.manifest.id,
      product: entry.product,
      // Relative and slash-normalized so a row is portable across hosts and checkouts.
      dir: relative(knowledgeRoot, entry.dir).replaceAll('\\', '/'),
      kind: bundle.frontmatter.kind,
      ...(bundle.frontmatter.subtype === undefined
        ? {}
        : { subtype: bundle.frontmatter.subtype }),
      scope: bundle.frontmatter.scope,
      status: trust.status,
      trust: trust.trust,
      counters: trust.counters,
      openedAtOrdinal: trust.validity.openedAtOrdinal,
      ...(trust.validity.closedAtOrdinal === undefined
        ? {}
        : { closedAtOrdinal: trust.validity.closedAtOrdinal }),
      lastConfirmedOrdinal: trust.lastConfirmedOrdinal,
      summary: bundle.summary,
      evidenceIncomplete: bundle.manifest.evidenceIncomplete,
    })
  }

  return rows
}
