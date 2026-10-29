// The one thing the committed grant ledger was committed FOR: an approval recorded on machine A is
// visible in the pull request and inherited by checkout B (Phase 391, D-11 / PROP-01).
//
// RE-SPELLED 2026-10-01 (432-18, D-14/D-15/D-22). `init` probed `grants.jsonl` as a commit-visible
// file and refused a knowledge `.gitignore` that hid it, because an ignored ledger would have gone on
// authorizing on the machine that wrote it. The ledger, its reader, its path helper and its verbs are
// deleted, and D-22 removes the probe with them: an old `grants.jsonl` is left exactly as it is and
// never read, so whether git sees it is no longer agent-qa's concern. The three cells keep their
// measurements and invert their claim:
//
//   the rules half    a real `agent-qa init` writes no rule naming the old ledger and creates no
//                     ledger — a fresh workspace holds no approval state
//   the verifier half `verifyEffectiveGitignore` over the SHIPPED probe table accepts a custom rule
//                     that hides the old file, because nothing about it is checked any more
//   the path half     nothing in knowledge-local addresses the ledger at all
//
// `git check-ignore` is still asked about real files in real repositories, with the same control.

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { Command } from 'commander'
import * as knowledgeLocal from '@vostride/agent-qa-knowledge-local'
import { afterEach, describe, expect, it } from 'vitest'

import { KNOWLEDGE_GITIGNORE_PROBES, verifyEffectiveGitignore } from '../commands/init-filesystem.js'
import { createInitCommand } from '../commands/init.js'

const KNOWLEDGE_ROOT_DIR = 'agent-qa-knowledge'
/** The file name a pre-432 build committed its grants under. Nothing in this build names it. */
const LEGACY_LEDGER = 'grants.jsonl'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'grant-ledger-portability-'))
  roots.push(root)
  return root
}

function initializeGit(root: string): void {
  execFileSync('git', ['init', '--quiet'], { cwd: root, stdio: 'pipe' })
}

/** git's OWN answer about one path. Never a re-implementation of `.gitignore` matching. */
function gitIgnores(cwd: string, path: string): boolean {
  const result = spawnSync('git', ['check-ignore', '--no-index', '--quiet', '--', path], {
    cwd,
    encoding: 'utf8',
    stdio: 'pipe',
  })
  if (result.status === 0) return true
  if (result.status === 1) return false
  throw new Error(
    `git check-ignore could not decide "${path}": status ${result.status ?? 'null'} ${result.stderr}`,
  )
}

async function runRealInit(dir: string): Promise<void> {
  const parent = new Command()
  parent.addCommand(createInitCommand())
  await parent.parseAsync(['node', 'test', 'init', '--dir', dir, '--platform', 'web'])
}

describe('init neither probes nor creates the old grant ledger', () => {
  // RE-SPELLED 2026-10-01 (432-18) from 'escapes every rule the tool actually writes into the
  // knowledge .gitignore': the emitted rules still do not name it, and init no longer creates or asks
  // about it.
  it('a real init writes no ledger and no rule naming it', async () => {
    const root = tempRoot()
    await runRealInit(root)
    const knowledgeRoot = join(root, KNOWLEDGE_ROOT_DIR)

    expect(existsSync(join(knowledgeRoot, LEGACY_LEDGER)), 'a fresh workspace was given a grant ledger')
      .toBe(false)
    const emitted = readFileSync(join(knowledgeRoot, '.gitignore'), 'utf8')
    expect(emitted).not.toContain(LEGACY_LEDGER)
    expect(emitted).toContain('memory/index/')

    // Git's own answer about an old file a person still has: the emitted rules leave it as it is.
    initializeGit(knowledgeRoot)
    writeFileSync(join(knowledgeRoot, LEGACY_LEDGER), 'left by a pre-432 build\n', 'utf8')
    expect(gitIgnores(knowledgeRoot, LEGACY_LEDGER)).toBe(false)

    // THE CONTROL: a rule that really does match the file comes back true through the same call.
    const ignoringRoot = tempRoot()
    initializeGit(ignoringRoot)
    writeFileSync(join(ignoringRoot, '.gitignore'), `${LEGACY_LEDGER}\n`, 'utf8')
    writeFileSync(join(ignoringRoot, LEGACY_LEDGER), '', 'utf8')
    expect(gitIgnores(ignoringRoot, LEGACY_LEDGER)).toBe(true)
  }, 120_000)

  // RE-SPELLED 2026-10-01 (432-18) from 'is a `visible` probe in the shipped table, so init REFUSES a
  // rule that hides it': there is no probe, so a person's rule hiding the old file is accepted.
  it('no probe names it, so a custom rule hiding it is accepted', () => {
    expect(KNOWLEDGE_GITIGNORE_PROBES.filter((entry) => entry.path.includes('grant'))).toEqual([])

    const root = tempRoot()
    initializeGit(root)
    const rules = [
      'memory/index/',
      'memory/queue/',
      'memory/*/bundles/.staging/',
      '.lease',
      '.epoch',
      '.writer-authority.sqlite*',
      '**/artifacts/',
      'skills/.staging/',
      '.*.agent-qa-init-*.tmp',
      LEGACY_LEDGER,
      '',
    ].join('\n')
    writeFileSync(join(root, '.gitignore'), rules, 'utf8')
    for (const entry of KNOWLEDGE_GITIGNORE_PROBES) {
      const absolute = join(root, entry.path)
      mkdirSync(dirname(absolute), { recursive: true })
      writeFileSync(absolute, 'fixture\n')
    }
    writeFileSync(join(root, LEGACY_LEDGER), 'left by a pre-432 build\n', 'utf8')

    expect(
      verifyEffectiveGitignore({
        cwd: root,
        label: 'agent-qa-knowledge/.gitignore',
        probes: KNOWLEDGE_GITIGNORE_PROBES,
      }),
    ).toEqual({ checked: true })
    // The control: the same table still refuses a rule that hides a file it DOES probe.
    writeFileSync(join(root, '.gitignore'), `${rules}policies/\n`, 'utf8')
    expect(() =>
      verifyEffectiveGitignore({
        cwd: root,
        label: 'agent-qa-knowledge/.gitignore',
        probes: KNOWLEDGE_GITIGNORE_PROBES,
      }),
    ).toThrow('must remain commit-visible')
  })

  // RE-SPELLED 2026-10-01 (432-18) from 'addresses the ledger relative to the knowledge root — the
  // same bytes on any checkout': nothing addresses it any more.
  it('knowledge-local publishes no ledger path or file name', () => {
    const exported = Object.keys(knowledgeLocal)
    expect(exported).not.toContain('grantsLedgerPath')
    expect(exported).not.toContain('GRANT_LEDGER_FILENAME')
    expect(exported.filter((name) => /grant/i.test(name))).toEqual([])
  })
})
