// Self-checked against planted tokens first; the survivors are an exact-path allow-list.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** The child-process vocabulary a retired spawn family may not leave behind. */
const SPAWN_TOKENS = ['node:child_process', 'tree-kill', 'treeKill', 'SIGKILL', 'SIGTERM'] as const
/** The scrape's own wire prefix. One occurrence is one un-retired stdout channel. */
const SCRAPE_PREFIX = 'AGENT_QA_EVENT:'

/** Exact paths permitted to hold the spawn vocabulary, each with its reason recorded above. */
const SPAWN_ALLOWED = new Set([
  'db/run-owner-host.ts',
  'execution/appium-manager.ts',
  'ownership-contract.ts',
  'server/server.ts',
])

function walk(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__' || entry === '__fixtures__') continue
      found.push(...walk(full))
      continue
    }
    if (entry.endsWith('.ts')) found.push(full)
  }
  return found
}

/** Comment-filtered, so a module may NAME what it retired without satisfying the census itself. */
function codeOnly(source: string): string {
  return source
    .split('\n')
    .filter((line) => {
      const trimmed = line.trimStart()
      return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*')
    })
    .join('\n')
}

const MODULES = walk(SRC_ROOT).map((path) => ({
  path: relative(SRC_ROOT, path).split('\\').join('/'),
  code: codeOnly(readFileSync(path, 'utf8')),
}))

describe('the dashboard run path', () => {
  it('(i) THE SCANNER SEES WHAT IT FORBIDS — before any verdict about any module', () => {
    // A planted source, run through the SAME comment filter, must still carry every token.
    const planted = codeOnly([
      '// a comment naming node:child_process, treeKill, SIGKILL and AGENT_QA_EVENT: proves nothing',
      "import { spawn } from 'node:child_process'",
      "import treeKill from 'tree-kill'",
      "const PREFIX = 'AGENT_QA_EVENT:'",
      "process.kill(pid, 'SIGKILL')",
      "child.kill('SIGTERM')",
    ].join('\n'))
    for (const token of SPAWN_TOKENS) expect(planted).toContain(token)
    expect(planted).toContain(SCRAPE_PREFIX)
    // …and the filter did strip the comment, so a comment cannot satisfy the census.
    expect(planted).not.toContain('proves nothing')
    // …and the walk found a real population rather than an empty one.
    expect(MODULES.length).toBeGreaterThan(20)
    expect(MODULES.map((module) => module.path)).toContain('execution/in-process-backend.ts')
  })

  it('(ii) THE COMPLETE SET — every module holding spawn vocabulary is one of the named survivors', () => {
    const holders = MODULES
      .filter((module) => SPAWN_TOKENS.some((token) => module.code.includes(token)))
      .map((module) => module.path)
    expect([...holders].sort()).toEqual([...SPAWN_ALLOWED].sort())
  })

  it('(iii) NOBODY SENDS A SIGNAL AT A CHILD ANY MORE — the two named survivors are a manifest and a receiver', () => {
    // The allow-list above is exact, but "allowed" must not become "unexamined": these two are
    // allowed because of WHAT they do with the vocabulary, and that is the part a later edit could
    // silently change.
    const contract = MODULES.find((module) => module.path === 'ownership-contract.ts')!
    expect(contract.code).toContain("'tree-kill'")
    expect(contract.code).not.toContain('treeKill(')
    const server = MODULES.find((module) => module.path === 'server/server.ts')!
    expect(server.code).toContain("process.on('SIGTERM'")
    // No process is signalled and no signal is passed to anything. `executionBackend.kill(runId)`
    // survives and is meant to: it is a run-level `RunSession.cancel()`, which takes a run id and
    // no signal at all — the exact distinction this assertion is drawn on.
    expect(server.code).not.toContain('process.kill(')
    expect(server.code).not.toMatch(/\.kill\(\s*['"`]?SIG/)
    expect(server.code).toContain('executionBackend?.kill(runId)')
  })

  it('(iv) THE SCRAPE PREFIX IS GONE FROM THE PACKAGE ENTIRELY — no survivors, named or otherwise', () => {
    const holders = MODULES
      .filter((module) => module.code.includes(SCRAPE_PREFIX))
      .map((module) => module.path)
    expect(holders).toEqual([])
  })

  it('(v) THE RETIRED FILE IS GONE, and nothing production still names its class', () => {
    expect(MODULES.map((module) => module.path)).not.toContain('execution/test-runner.ts')
    const namers = MODULES
      .filter((module) => module.code.includes('TestRunner'))
      .map((module) => module.path)
    expect(namers).toEqual([])
  })
})

describe('queue retries are retired', () => {
  const server = readFileSync(join(SRC_ROOT, 'server', 'server.ts'), 'utf8')
  const backendInterface = readFileSync(join(SRC_ROOT, 'execution', 'execution-backend.ts'), 'utf8')

  it('NO RETRY CEILING REACHES THE BACKEND — the field is not on the options at all', () => {
    expect(codeOnly(backendInterface)).not.toContain('maxRetries')
    expect(codeOnly(backendInterface)).not.toContain('env?:')
    // The lease is data on the same options object, and it is optional.
    expect(codeOnly(backendInterface)).toContain('appiumUrl?: string')
  })

  it('the queue wiring passes no retry ceiling', () => {
    const executeCall = server.slice(server.indexOf("jobQueue.on('execute'"))
    expect(executeCall).not.toContain('maxRetries')
  })

  it('THE APPIUM LEASE BLOCK IS UNTOUCHED — only the URL delivery moved', () => {
    // The acquisition, the per-run keying and the release paths are all still here; what is gone is
    // the child environment the URL used to ride in.
    expect(server).toContain('appiumManager.acquireLease({ runId: run.id, platform })')
    expect(server).toContain('appiumManager.releaseLease(runId, reason)')
    expect(server).toContain('appiumUrl: appiumManager.getUrl()')
    expect(codeOnly(server)).not.toContain('AGENT_QA_APPIUM_URL')
  })
})
