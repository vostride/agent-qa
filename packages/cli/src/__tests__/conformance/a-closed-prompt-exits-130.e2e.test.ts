// A prompt whose input is closed before an answer ends the command as a cancel: Cancelled. and 130.

import { mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  CLI_ENTRY,
  REBUILD_INSTRUCTION,
  buildFreshness,
  cleanupTempRoots,
  spawnCollecting,
  trackTempRoot,
} from './spawned-chat.js'

const CELL_BUDGET_MS = 60_000

afterEach(() => {
  cleanupTempRoots()
})

function listing(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' }).sort()
}

describe('a closed prompt', () => {
  it(
    'auth set with no secret and stdin closed prints Cancelled., exits 130 and saves nothing',
    async () => {
      const freshness = buildFreshness()
      expect(
        { missing: freshness.missing, stale: freshness.stale },
        `these cells drive the built CLI: ${REBUILD_INSTRUCTION}`,
      ).toEqual({ missing: [], stale: [] })
      const root = trackTempRoot(mkdtempSync(join(tmpdir(), 'agent-qa-closed-prompt-')))
      const home = trackTempRoot(mkdtempSync(join(tmpdir(), 'agent-qa-closed-prompt-home-')))
      const env = { HOME: home, USERPROFILE: home }

      const init = await spawnCollecting(
        root,
        [CLI_ENTRY, 'init', '--platform', 'web', '--llm', 'gemini'],
        env,
      )
      expect(init.code, `${init.stdout}\n${init.stderr}`).toBe(0)
      const homeBefore = listing(home)

      const outcome = await spawnCollecting(
        root,
        [CLI_ENTRY, 'auth', 'set', '--config', 'default', '--type', 'api-key'],
        env,
      )

      const text = `${outcome.stdout}\n${outcome.stderr}`
      expect(outcome.code, text).toBe(130)
      expect(outcome.stderr.split('\n')).toContain('Cancelled.')
      expect(text.split('\n').filter((line) => /^\s+at\s/u.test(line))).toEqual([])
      expect(text).not.toContain('ExitPromptError')
      expect(listing(home)).toEqual(homeBefore)
    },
    CELL_BUDGET_MS,
  )
})
