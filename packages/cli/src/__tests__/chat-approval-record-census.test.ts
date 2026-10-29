// A floor and a planted declaration, so an empty set from a walk that read nothing fails.

import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createJsonlSessionLog } from '@vostride/agent-qa-agent-local'

import {
  CURRENT_CHAT_SESSION_SCHEMA_VERSION,
  guardChatSessionEvent,
} from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'

const TESTS_DIR = dirname(fileURLToPath(import.meta.url))
/** `packages`. */
const PACKAGES_ROOT = resolve(TESTS_DIR, '..', '..', '..')

/**
 * The floor on the walker's own yield.
 *
 * Read off the tree independently of this scan (`find packages/*​/src -name '*.ts' | wc -l` was well
 * past four figures at the time of writing), never off this scan's output — a floor taken from the
 * thing it guards certifies itself.
 */
const MINIMUM_SOURCES_SCANNED = 500

/** The two packages the record used to cross: the composition root and the cli that imported it. */
const CROSSED_PACKAGES = ['agent-local', 'cli']

/**
 * Both ways TypeScript declares this name: `interface X {` and `type X =`.
 *
 * A DECLARATION MATCHER, NOT A USAGE ONE. Imports, type annotations and re-exports all mention the
 * name and none of them mints a second contract; a matcher that counted mentions would red on the
 * very promote it exists to protect (the cli surface now IMPORTS this type, and must).
 */
const DECLARATION = /^\s*(?:export\s+)?(?:declare\s+)?(?:interface\s+ChatApprovalDecisionRecord\b|type\s+ChatApprovalDecisionRecord\s*[<=])/mu

/** Every declaration site in one source, by 1-based line number. */
export function declarationLines(source: string): number[] {
  return source
    .split('\n')
    .map((line, index) => (DECLARATION.test(line) ? index + 1 : 0))
    .filter((line) => line !== 0)
}

interface ScannedSource {
  readonly pkg: string
  /** Relative to `packages/`, so a failure message reads the same on every machine. */
  readonly relPath: string
  readonly source: string
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n')
}

/** Every product `.ts` file under `packages/​*​/src`. */
function scanProductSources(packagesRoot: string = PACKAGES_ROOT): ScannedSource[] {
  const found: ScannedSource[] = []
  for (const pkgEntry of readdirSync(packagesRoot, { withFileTypes: true })) {
    if (!pkgEntry.isDirectory() || pkgEntry.name === 'node_modules') continue
    const srcRoot = join(packagesRoot, pkgEntry.name, 'src')
    let srcStat
    try {
      srcStat = statSync(srcRoot)
    } catch {
      continue
    }
    if (!srcStat.isDirectory()) continue
    const walk = (current: string): void => {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        if (entry.name === '__tests__' || entry.name === 'node_modules' || entry.name === 'dist') {
          continue
        }
        const full = join(current, entry.name)
        if (entry.isDirectory()) {
          walk(full)
          continue
        }
        if (!entry.isFile()) continue
        if (!/\.[cm]?ts$/u.test(entry.name)) continue
        if (/\.test(?:-d)?\.[cm]?ts$/u.test(entry.name)) continue
        found.push({
          pkg: pkgEntry.name,
          relPath: relative(packagesRoot, full),
          source: readFileSync(full, 'utf8'),
        })
      }
    }
    walk(srcRoot)
  }
  return found
}

/** An `approval_decision` event built by product code: the writer this phase deletes. */
const APPROVAL_EVENT_WRITE = /kind:\s*['"]approval_decision['"]/u

describe('ChatApprovalDecisionRecord has exactly one declaration, in the composition root', () => {
  const scanned = scanProductSources()

  it('scanned a tree that is actually there', () => {
    // Neither of these can be satisfied by an empty or wrong-rooted walk, and there is no branch in
    // this file that turns an unreadable file or a missing directory into a skip.
    expect(scanned.length).toBeGreaterThanOrEqual(MINIMUM_SOURCES_SCANNED)
    expect(
      [...new Set(scanned.map((entry) => entry.pkg))],
      'the walker did not reach both packages this type crosses, so its verdict is about a tree '
      + 'that is not the one under test',
    ).toEqual(expect.arrayContaining(CROSSED_PACKAGES))
  })

  it('declares the record nowhere — no approval writer contract survives', () => {
    const sites = scanned.flatMap((entry) =>
      declarationLines(entry.source).map((line) => `${entry.relPath}:${String(line)}`))

    expect(
      sites,
      'an approval-decision record was declared again; nothing asks, so nothing may record an answer',
    ).toEqual([])
  })

  it('no product source builds an approval_decision event', () => {
    expect(APPROVAL_EVENT_WRITE.test("await log.append({ kind: 'approval_decision', turnId })"))
      .toBe(true)
    // The schema declares the kind and its key set as a READER; neither is a construction.
    expect(APPROVAL_EVENT_WRITE.test("  approval_decision: ['actionClass', 'at', 'decision']"))
      .toBe(false)
    const writers = scanned
      .filter((entry) => APPROVAL_EVENT_WRITE.test(stripComments(entry.source)))
      .map((entry) => entry.relPath)
    expect(writers).toEqual([])
  })

  it('a historical approval_decision row still parses through the shipped guard', () => {
    // Older sessions carry these rows and the guard throws on unknown kinds, so the kind is kept.
    for (const row of [
      {
        kind: 'approval_decision', turnId: 'turn-1', at: '2026-09-01T10:00:00.000Z',
        actionClass: 'fn:knowledge.proposal.apply', decision: 'accept-always', source: 'gate',
      },
      {
        kind: 'approval_decision', turnId: 'turn-2', at: '2026-09-01T10:01:00.000Z',
        actionClass: 'fn:runs.start', decision: 'deny', source: 'verb',
      },
    ]) {
      expect(guardChatSessionEvent(row, CURRENT_CHAT_SESSION_SCHEMA_VERSION)).toEqual(row)
    }
  })

  // Read back through the shipped JSONL session log, so an older conversation re-opens whole.
  it('an older session holding approval_decision rows re-opens with no refused line', async () => {
    const root = mkdtempSync(join(tmpdir(), 'approval-history-'))
    try {
      const log = createJsonlSessionLog({
        root,
        now: () => '2026-09-01T10:00:00.000Z',
        model: () => 'fixture:model',
        toolsetHash: () => 'fixture-toolset',
      })
      const rows = [
        { kind: 'user_message', turnId: 'turn-1', at: '2026-09-01T10:00:00.000Z', text: 'apply it' },
        {
          kind: 'approval_decision', turnId: 'turn-1', at: '2026-09-01T10:00:01.000Z',
          actionClass: 'fn:knowledge.proposal.apply', decision: 'accept-always', source: 'gate',
        },
        { kind: 'turn_complete', turnId: 'turn-1', at: '2026-09-01T10:00:02.000Z', status: 'completed' },
      ] as const
      const opened = await log.open()
      const sessionId = opened.header.sessionId
      for (const row of rows) await opened.append(row as never)
      await opened.turnBoundary()
      await opened.close()

      const reopened = await log.open(sessionId)
      try {
        expect(reopened.refusedLines).toEqual([])
        expect(reopened.events.filter((event) => event.kind === 'approval_decision')).toEqual([rows[1]])
      } finally {
        await reopened.close()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  // RETAINED: the matcher must still see a declaration, or the empty set above certifies nothing.
  it('SEES a second declaration, and stays quiet about an import of the first', () => {
    // THE MUTATION BAR. Without this cell the census could be a matcher that never matches, which
    // is indistinguishable from a clean tree by its verdict alone. The bar is the implementation
    // the census must red on, not the suite it passes.
    expect(declarationLines([
      'export interface ChatApprovalDecisionRecord {',
      '  readonly actionClass: string',
      '}',
    ].join('\n'))).toEqual([1])
    expect(declarationLines('type ChatApprovalDecisionRecord = { actionClass: string }'))
      .toEqual([1])
    expect(declarationLines('  interface ChatApprovalDecisionRecord {')).toEqual([1])

    // AND THE OTHER HALF: the promote's whole point is that other packages MENTION this type. A
    // matcher that counted mentions would refuse the fix it was written to protect.
    expect(declarationLines([
      "import type { ChatApprovalDecisionRecord } from '@vostride/agent-qa-agent-local'",
      'const ledger = async (decision: ChatApprovalDecisionRecord): Promise<void> => {}',
      "export type { ChatApprovalDecisionRecord } from './compose-local-agent.js'",
    ].join('\n'))).toEqual([])
  })
})
