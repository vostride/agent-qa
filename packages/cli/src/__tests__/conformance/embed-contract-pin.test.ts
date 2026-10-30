// The embed page's rendered bytes hash to a recorded constant; a red means the surface moved.

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

// The embed page's rendered bytes, sha256; re-mint only with a deliberate change to the page.
const EMBED_PAGE_SHA256 = 'cb66db7b6d885bb98940ce728e3ab442b53f143657ad261e78741bf8a2a2a266'

/** The same render's length in UTF-8 bytes, so a mismatch says how much moved and not just that. */
const EMBED_PAGE_BYTES = 7124

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
        + 'EMBED_PAGE_SHA256 together, in the commit that changed the page',
    ).toBe(EMBED_PAGE_BYTES)
    expect(
      measured,
      'the embed page\'s bytes moved. This surface is frozen: the MCP App embeds the liveUrl the '
        + 'run service mints and changes nothing about how it is served. A change with a reason '
        + 're-mints EMBED_PAGE_SHA256 in its own commit — see this file\'s header',
    ).toBe(EMBED_PAGE_SHA256)
  })

  it('pins the two path constants the whole live-view transport is addressed by', () => {
    // By value: these are the strings the served page, the frame socket and consumers share.
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
        + 'embed contract, free to disagree with the first',
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
