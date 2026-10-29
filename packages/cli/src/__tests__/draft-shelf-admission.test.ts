// The draft shelf's two-sided admission property.
//
// BOTH DIRECTIONS OR NEITHER. A shelf that only satisfies (i) pollutes every suite run and gate
// 3's corpus with unfinished drafts; a shelf that only satisfies (ii) is a place no run can ever
// reach, which makes the whole verify-before-present stage unreachable. Only a location that
// satisfies both at once is a shelf, so both are asserted here in one file rather than in two that
// could drift apart:
//
//   (i)  a staged draft RESOLVES through `resolveWorkspaceFileTarget({kind:'test'})` as a literal
//        path — the exact call `runs.start` makes on its `patterns`;
//   (ii) `discoverWorkspaceFiles({kind:'test'})` does NOT enumerate it, while still returning the
//        workspace's real tests.
//
// The location this pins — `tests/.agent-qa-drafts/` — is measured, not preferred: see the RED
// differential recorded in 394-01-SUMMARY.md, where pointing the constants at `.agent-qa/drafts`
// makes (i) fail with the workspace-patterns refusal.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { discoverWorkspaceFiles, resolveWorkspaceFileTarget, resolveWorkspacePaths } from '@vostride/agent-qa-core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  DRAFT_SHELF_DIR_NAME,
  DRAFT_SHELF_PARENT,
  DraftShelfOutsideWorkspaceError,
  createDraftShelf,
  draftShelfDir,
  shelfPathFor,
} from '../composition/local-agent-host.js'
import { loadConfigFile } from '../config.js'

const DRAFT_BYTES = `name: a draft
steps:
  - "go to the login page"
`

const REAL_TEST_BYTES = `name: a real test
steps:
  - "go to the home page"
`

let root: string
let configPath: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'draft-shelf-'))
  configPath = join(root, 'agent-qa.config.yaml')
  // The house config verbatim (demo/init/agent-qa.config.yaml) — the shelf exists to satisfy THIS
  // pattern, so a bespoke one here would be measuring a workspace nobody has.
  writeFileSync(
    configPath,
    `workspace:
  testMatch:
    - tests/**/*.yaml
  suiteMatch:
    - suites/**/*.suite.yaml
  hooksFile: hooks.yaml
  envFile: .env
  secretsFile: .env.secrets.local
`,
  )
  for (const name of ['hooks.yaml', '.env', '.env.secrets.local']) {
    writeFileSync(join(root, name), '')
  }
  mkdirSync(join(root, 'tests'), { recursive: true })
  writeFileSync(join(root, 'tests', 'real-test.yaml'), REAL_TEST_BYTES)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/**
 * The workspace resolution `runs.start` performs, from the real file on disk.
 *
 * Deliberately `loadConfigFile` rather than the whole-config `resolveConfig`: admission reads
 * `config.workspace` and nothing else, and validating a complete four-bucket config here would
 * make this file fail for a missing `use.mobile.appState` — a fact about config completeness, not
 * about whether a shelf path is admitted.
 */
async function workspace() {
  const config = (await loadConfigFile(configPath)) as Parameters<typeof resolveWorkspacePaths>[0]['config']
  return resolveWorkspacePaths({ config, configPath })
}

describe('the draft shelf location', () => {
  it('is a dot directory under the workspace test root', () => {
    expect(DRAFT_SHELF_PARENT).toBe('tests')
    expect(DRAFT_SHELF_DIR_NAME).toBe('.agent-qa-drafts')
    expect(draftShelfDir(root)).toBe(resolve(root, 'tests', '.agent-qa-drafts'))
  })

  it('ADMITS a staged draft as a literal runs.start pattern', async () => {
    const shelf = createDraftShelf(root)
    const identityPath = shelf.write('abc123', DRAFT_BYTES)

    const resolved = await resolveWorkspaceFileTarget({
      workspace: await workspace(),
      kind: 'test',
      filePath: identityPath,
      requireExisting: true,
    })

    expect(resolved.workspaceRelativePath).toBe('tests/.agent-qa-drafts/abc123.yaml')
    expect(readFileSync(resolved.absolutePath, 'utf8')).toBe(DRAFT_BYTES)
  })

  it('is INVISIBLE to suite discovery, while the real test still enumerates', async () => {
    const shelf = createDraftShelf(root)
    shelf.write('abc123', DRAFT_BYTES)

    const discovered = await discoverWorkspaceFiles({ workspace: await workspace(), kind: 'test' })

    expect(discovered.map(file => file.workspaceRelativePath)).toEqual(['tests/real-test.yaml'])
  })
})

describe('the draft shelf store', () => {
  it('creates nothing until the first write', () => {
    createDraftShelf(root)
    expect(() => readFileSync(draftShelfDir(root))).toThrow()
    expect(createDraftShelf(root).list()).toEqual([])
  })

  it('leaves no .tmp artifact enumerable by its own listing', () => {
    const shelf = createDraftShelf(root)
    shelf.write('bbb', DRAFT_BYTES)
    shelf.write('aaa', DRAFT_BYTES)

    // Sorted, and the pid-suffixed in-flight sibling is never a draft.
    expect(shelf.list()).toEqual([
      'tests/.agent-qa-drafts/aaa.yaml',
      'tests/.agent-qa-drafts/bbb.yaml',
    ])
    expect(shelf.list().some(entry => entry.endsWith('.tmp'))).toBe(false)
  })

  it('refuses a digest that could name a path, by the named class', () => {
    for (const digest of ['../escape', 'nested/child', '..', 'a'.repeat(129), '']) {
      expect(() => shelfPathFor(root, digest)).toThrow(DraftShelfOutsideWorkspaceError)
    }
    // The differential's other half: a legitimate digest is NOT refused, so the case above is
    // measuring the guard rather than a function that throws at everything.
    expect(() => shelfPathFor(root, 'a1b2-c3_d4')).not.toThrow()
  })
})
