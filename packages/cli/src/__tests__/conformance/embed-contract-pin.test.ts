// THE 403 EMBED CONTRACT, FROZEN BY MEASUREMENT (408-05 · criterion 3 · D-04 / T-408-16).
//
// WHY THIS FILE EXISTS. Phase 408's third success criterion is a promise of ABSENCE: the MCP App
// embeds the exact `liveUrl` Phase 403 mints, and nothing about the 403 embed surface — its served
// document, its transport, its two path constants — changes to make that work. Every plan in this
// phase has so far kept that promise in PROSE ("no file under `packages/dashboard-server/` in any
// commit of this plan"), and a promise phrased as a diff review is a promise that holds exactly
// until nobody reviews the diff. This file converts it into a cell: the embed page's rendered bytes
// hash to a RECORDED constant, and the two protocol constants are pinned by literal value.
//
// WHAT A RED HERE MEANS, AND WHAT TO DO ABOUT IT. It does not mean "you broke something". It means
// the frozen surface moved, which a later phase is perfectly entitled to do — the MJPEG/WebRTC
// transports LIVE-04 anticipates would move it, for instance. It means the move must be a CONSCIOUS
// act: re-mint the constant below in that phase's OWN dated commit, beside the change that earned
// it, so the re-mint is a reviewable line rather than a silent drift under a green suite. Forcing
// that act is the entire point of the pin.
//
// WHY A HASH AND NOT A GOLDEN FILE. The embed page is 5KB of HTML with an inline script; a
// committed golden of it would be a second copy of the document, free to disagree with the first,
// and re-minting it would be a 5KB diff nobody reads rather than a one-line diff everybody does.
// The hash is the smallest artifact that still names any byte-level change. The byte COUNT is
// recorded beside it for exactly one reason: a hash mismatch tells a reader nothing about the
// scale of what moved, and `5172 -> 5240` tells them where to look.
//
// WHY THE INPUT IS FIXED AND SYNTHETIC. `renderLiveEmbedPage` is a pure function of `{runId,
// nonce}` — no clock, no randomness, no environment (measured; the nonce is minted by its CALLER,
// which is what keeps the renderer pure). Two fixed strings therefore pin the whole document.
//
// THE STALE-ARTIFACT HOLE, CLOSED. This cell renders through the package barrel, i.e. through
// `dashboard-server/dist` — which is what ships, and which is also free to be older than the source
// beside it. A stale artifact would let this pin stay green across the very edit it exists to
// catch, so the freshness of the two source files that compose this contract is asserted first.
// (408-01 lost an afternoon to a stale `mcp/dist`; the gate that caught it is the reason this one
// is here.)
//
// THE THIRD CELL IS THE NO-SECOND-EMBED LAW. The MCP App wrapper and the dashboard's own
// live page are TWO CONSUMERS OF ONE embed document, not two embed documents. The wrapper is
// allowed to copy `embed-page.ts`'s IDIOMS — its state-machine shape, its `scriptLiteral` escape —
// and is not allowed to copy its bytes or to reach into the package that owns it. A second serving
// of the embed contract would be free to disagree with the first, which is the
// one-implementation-behind-doors law this repository keeps. The census reads the wrapper's own
// source file, comment-stripped, so a comment EXPLAINING the rule does not fail the rule.

import { readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  LIVE_EMBED_PATH_PREFIX,
  LIVE_VIEW_WS_PATH,
  renderLiveEmbedPage,
} from '@vostride/agent-qa-dashboard'
import { describe, expect, it } from 'vitest'

/** This directory, so every path below is resolved from this file rather than guessed. */
const CONFORMANCE_DIR = dirname(fileURLToPath(import.meta.url))

/** `packages/`, four levels up from `packages/cli/src/__tests__/conformance`. */
const PACKAGES_ROOT = resolve(CONFORMANCE_DIR, '../../../../')

/** The two sources that compose the frozen contract, and the artifact this file renders through. */
const EMBED_PAGE_SOURCE = join(PACKAGES_ROOT, 'dashboard-server/src/live-view/embed-page.ts')
const PROTOCOL_SOURCE = join(PACKAGES_ROOT, 'dashboard-server/src/live-view/protocol.ts')
const DASHBOARD_ARTIFACT = join(PACKAGES_ROOT, 'dashboard-server/dist/index.cjs')

/** The MCP App wrapper — the second consumer, which must not become a second embed document. */
const APP_WRAPPER_SOURCE = join(PACKAGES_ROOT, 'mcp/src/app-wrapper.ts')

const REBUILD_INSTRUCTION =
  'this pin measures the BUILT dashboard package: run `pnpm --filter @vostride/agent-qa-dashboard '
  + 'run build` (or `pnpm -r build`) so the artifact matches the source it is pinning.'

/** The fixed, synthetic input the recorded hash was minted over. */
const PIN_INPUT = Object.freeze({ runId: 'pin-run', nonce: 'pin-nonce' })

/**
 * The 403 embed page's rendered bytes, sha256, MEASURED on 2026-09-25 by 428 D-10 (the embed
 * paints snapshots, reports to its host, honours the host hint and names an ended editor session).
 * Re-mint only in a phase that deliberately changes the page.
 *
 * Frozen by Phase 408's criterion 3. A phase that legitimately changes the embed page re-mints this
 * in its own dated commit — see the header. Do not "fix" a red here by re-running the hash into the
 * constant as part of an unrelated change: that is the exact silent drift the pin forbids.
 */
const EMBED_PAGE_SHA256 = 'c637a7c4007e6cb51451d360869a8cfe3fbf0b7d8366d48b1a9baf792947d72a'

/** The same render's length in UTF-8 bytes, so a mismatch says how much moved and not just that. */
const EMBED_PAGE_BYTES = 7392

/** A source file with its comments removed — a comment naming a rule must not fail that rule. */
function commentStrippedFile(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n')
}

describe('the embed contract is frozen, and the freeze is measured', () => {
  it('renders through an artifact no older than the sources it pins', () => {
    // Scoped deliberately to the TWO files that compose this contract rather than to the whole
    // package tree: an unrelated edit elsewhere in `dashboard-server` must not red a pin about the
    // embed page, and an edit to the embed page must not be able to hide behind a stale artifact.
    const artifact = statSync(DASHBOARD_ARTIFACT).mtimeMs
    for (const source of [EMBED_PAGE_SOURCE, PROTOCOL_SOURCE]) {
      expect(
        statSync(source).mtimeMs <= artifact,
        `${source} is newer than the built dashboard package — ${REBUILD_INSTRUCTION}`,
      ).toBe(true)
    }
  })

  it('hashes the served embed page to the constant recorded when the contract froze', () => {
    const html = renderLiveEmbedPage({ ...PIN_INPUT })
    const measured = createHash('sha256').update(html, 'utf8').digest('hex')
    expect(
      Buffer.byteLength(html, 'utf8'),
      'the embed page changed SIZE. If that was deliberate, re-mint EMBED_PAGE_BYTES and '
        + 'EMBED_PAGE_SHA256 together, in the dated commit that changed the page',
    ).toBe(EMBED_PAGE_BYTES)
    expect(
      measured,
      'the 403 embed page\'s bytes moved. Phase 408 criterion 3 freezes this surface: the MCP App '
        + 'embeds the liveUrl 403 mints and changes nothing about how 403 serves it. A phase with a '
        + 'reason to change it re-mints EMBED_PAGE_SHA256 in its own dated commit — see this '
        + 'file\'s header',
    ).toBe(EMBED_PAGE_SHA256)
  })

  it('pins the two path constants the whole live-view transport is addressed by', () => {
    // BY VALUE, not by round-trip. Comparing the constant to itself would pass through any rename;
    // these literals are the strings a served page, a frame socket and every consumer agree on, and
    // 408 changes neither (LIVE-04: the wrapper and the embed contract must survive a transport
    // swap UNCHANGED, so the addresses are part of what is frozen).
    expect(LIVE_EMBED_PATH_PREFIX, 'the served embed page\'s path prefix').toBe('/live/')
    expect(LIVE_VIEW_WS_PATH, 'the frame socket\'s path').toBe('/api/live-view/ws')
  })

  it('keeps ONE embed document with two consumers: the App wrapper copies idioms, never bytes', () => {
    const wrapper = commentStrippedFile(APP_WRAPPER_SOURCE)

    // A scanner that reads nothing reports no leak. Prove this one is reading the file it names,
    // and reading the part of it that would carry a copy: the wrapper's own rendered attribute.
    expect(wrapper.length, `${APP_WRAPPER_SOURCE} read as empty — the census below would be vacuous`)
      .toBeGreaterThan(1_000)
    expect(
      wrapper,
      'the wrapper no longer renders its own state attribute — this census is pointed at the wrong '
        + 'file, or the wrapper stopped being a rendered document',
    ).toContain('data-app-state')

    // The embed page's OWN attribute spelling must not appear: the wrapper owns App-level states
    // (`data-app-state`), the embed page owns frame-level ones (`data-embed-state`), and a wrapper
    // carrying the second spelling is a wrapper that has started re-serving the embed document.
    expect(
      wrapper.includes('data-embed-state'),
      'the App wrapper carries the EMBED page\'s state attribute — that is a second serving of the '
        + '403 embed contract, free to disagree with the first (D-04)',
    ).toBe(false)

    // …and it must not reach into the package that owns that document at all. The wrapper is
    // self-contained by construction; the MCP package does not depend on dashboard-server, and this
    // names that fact rather than leaving it to a lockfile nobody reads.
    for (const forbidden of ['@vostride/agent-qa-dashboard', 'dashboard-server']) {
      expect(
        wrapper.includes(forbidden),
        `the App wrapper references ${forbidden} in code — the two consumers of the embed contract `
          + 'are independent, and a wrapper that imports the server that serves it is one consumer '
          + 'pretending to be two',
      ).toBe(false)
    }
  })
})
