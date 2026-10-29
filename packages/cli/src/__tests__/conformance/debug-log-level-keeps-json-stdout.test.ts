// a project may set its log level to debug, and the per-test debug lines
// are the terminal door's to print. A protocol door's stdout holds only its protocol.

import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  CountingTarget,
  createInProcessFixture,
  removeInProcessFixtures,
} from '../../composition/__tests__/in-process-run-fixture.js'
import type { InProcessFixture } from '../../composition/__tests__/in-process-run-fixture.js'
import { refuseWithoutPosixRunLifecycle, startCliRun } from './cli-run-fixture.js'
import type { CliRunExit } from './cli-run-fixture.js'
import { populatedRunSpawnEnv } from './populated-run-fixture.js'

const CELL_BUDGET_MS = 300_000
const DEBUG_LINES = /^\s*(Platform|Model): /mu

const target = new CountingTarget()

beforeAll(async () => { await target.listen() })
afterAll(async () => {
  await target.close()
  removeInProcessFixtures()
})

function debugProject(): InProcessFixture {
  refuseWithoutPosixRunLifecycle()
  const browsers = populatedRunSpawnEnv().PLAYWRIGHT_BROWSERS_PATH
  if (browsers === undefined) {
    throw new Error('No installed Chromium; these cells need a real browser setup and never skip')
  }
  const at = createInProcessFixture({ origin: target.origin })
  appendFileSync(at.configPath, 'services:\n  logging:\n    level: debug\n')
  return at
}

async function run(at: InProcessFixture, args: readonly string[]): Promise<CliRunExit> {
  return startCliRun(at, args, populatedRunSpawnEnv()).done
}

const flat = (text: string): string => text.replace(/\s*\n\s*/gu, ' | ').slice(0, 800)

function finishedRuns(at: InProcessFixture): string[] {
  const runs = join(at.agentQaRoot, 'runs')
  if (!existsSync(runs)) return []
  return readdirSync(runs).filter((id) => {
    const events = join(runs, id, 'events.jsonl')
    return existsSync(events) && readFileSync(events, 'utf8').includes('"runFinished"')
  })
}

describe('a project at debug log level', () => {
  it(
    'fn --json on a project at debug log level leaves stdout one JSON document through its run',
    async () => {
      const at = debugProject()
      const input = JSON.stringify({ patterns: [at.testPattern] })

      const exit = await run(at, ['fn', 'runs.start', '--input', input, '--json'])

      expect(finishedRuns(at).length, `finished runs; stderr: ${flat(exit.stderr)}`).toBe(1)
      let parsed: unknown
      try {
        parsed = JSON.parse(exit.stdout)
      } catch {
        parsed = undefined
      }
      const notJson = parsed === undefined ? flat(exit.stdout) : ''
      expect(notJson, 'stdout that is not one JSON document').toBe('')
    },
    CELL_BUDGET_MS,
  )

  it(
    'agent-qa run on a project at debug log level still prints its Platform and Model lines',
    async () => {
      const at = debugProject()

      const exit = await run(at, ['run', at.testPattern])

      expect(finishedRuns(at).length, `finished runs; stderr: ${flat(exit.stderr)}`).toBe(1)
      const lines = exit.stdout
        .split('\n')
        .filter((line) => DEBUG_LINES.test(line))
        .map((line) => line.trim())
      expect(lines.join(' | '), `the debug lines on stdout: ${flat(exit.stdout)}`).toBe(
        'Platform: web | Model: gpt-4o-mini (openai-compatible)',
      )
    },
    CELL_BUDGET_MS,
  )
})
