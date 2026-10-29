// D-02's three-tier approval, enforced TWO-SIDED and measured on the production composition
// (395-07 · CFGM-01 · spec/v2 §4.3, spec/v2/execution-safety.md §2.4).
//
// RE-SPELLED AS DIRECT CHANGES THAT COMMIT NOTHING. The two
// sides this file measured were two refusals on the road a pre-432 config proposal took into a
// commit: the MINT side (`proposals.accept --always` on a flagged proposal records no grant) and the
// READ side (a covering grant does not open `config.proposal.apply` for a flagged proposal). That
// road ends here. The CLI host binds no config apply port and no undo source, so both pre-432 verbs
// refuse by name before a file or a ref moves, and a config change is made directly in the call.
// What each cell now measures:
//
//   (M0) headless control     — a flagged change applies headless in the call, with no ask, and
//                               writes no grant.
//   (M1) flagged change       — it lands in the file, names its reasons (`secret-adjacent-field`),
//                               and leaves the non-empty grant ledger byte-identical and the
//                               history where it was.
//   (M2) in-scope change      — the same, with no reasons; the ledger still does not move, so no
//                               change records an approval of any kind.
//   (R1)-(R4)                 — a pre-432 record, flagged or in-scope, with or without a covering
//                               grant, doctored or not, is refused unbound by `config.proposal.apply`
//                               and commits nothing.
//   (B)  the grant read       — 432-18 deleted `grants.list` with the ledger: it is an unknown
//                               function, and the old ledger is left byte-identical.
//
// C432-NO-CONFIG-UNDO-PORT is the absence of the undo source: no export, `config.undo.propose`
// listed and answered unbound, and nothing filed.
//
// The two-sided design notes this header carried before 432-16 are in this file's git history.

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { invokeFunction } from '@vostride/agent-qa-agent'
import type { ConfigChangeOutput } from '@vostride/agent-qa-schema'

/** A planted pre-432 record, read as the plain JSON it is (432-17 deleted the record schema). */
interface PlantedConfigRecord {
  readonly kind: string
  readonly payload: { payloadKind: string; crossBoundary: boolean; crossBoundaryReasons: string[] }
}
import { runSafetyScope } from '@vostride/agent-qa-safety-local'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import * as cliHost from '../local-agent-host.js'
import { CLI_FUNCTION_CALLER, composeCliLocalAgent } from '../local-agent-host.js'
import { filePre432ConfigProposal } from './pre-432-config-proposal.js'

/** The class a pre-432 grant covered, as the retired apply op carried it. */
const CONFIG_APPLY_CLASS = 'fn:config.proposal.apply'

/**
 * A real, registered class that is NOT the one under test.
 *
 * The seeded ledger line uses it so that every "the ledger did not change" assertion below compares
 * a non-empty file against itself.
 */
const UNRELATED_CLASS = 'fn:knowledge.forget'

const CONFIG_FILE = 'agent-qa.config.yaml'

/** The house-style config, valid against the real schema. */
const SEEDED_CONFIG = `# agent-qa Configuration

workspace:
  testMatch:
    - tests/**/*.yaml
  suiteMatch:
    - suites/**/*.suite.yaml
  hooksFile: hooks.yaml
  envFile: .env
  secretsFile: .env.secrets.local

registry:
  llms:
    - name: judge
      provider: openai-subscription
      model: gpt-5.6-terra
  targets:
    local-form:
      platform: web
      url: http://127.0.0.1:8931/form.html

use:
  llm: judge
  timeout:
    step: 30s
    test: 90m
    navigation: 2m
  mobile:
    appState: reset
  parallel: false
`

let root: string
let configPath: string
let agentQaRoot: string
let knowledgeRoot: string

function git(...args: string[]): { status: number | null; stdout: string } {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    // a `git` that ran and failed must not return quietly; see
    // validate-resolution-surface.test.ts for the full note.
    throw new Error(`git ${args.join(' ')} exited ${result.status}: ${result.stderr}`)
  }
  return { status: result.status, stdout: result.stdout }
}

function commitCount(): number {
  return Number(git('rev-list', '--count', 'HEAD').stdout.trim())
}

/** The committed ledger's exact bytes, or `undefined` when no file exists at all. */
function ledgerBytes(): string | undefined {
  const path = join(knowledgeRoot, 'grants.jsonl')
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined
}

function ledgerLines(): string[] {
  return (ledgerBytes() ?? '').split('\n').filter((line) => line.trim().length > 0)
}

/**
 * One committed grant line, planted as the bytes a pre-432 build's mint wrote.
 *
 * RE-SPELLED 2026-10-01: the mint is deleted with the ledger, so the line is a literal
 * of the shape it produced. Nothing in this build reads or rewrites it.
 */
async function mintGrant(actionClass: string): Promise<void> {
  mkdirSync(knowledgeRoot, { recursive: true })
  const grantId = `grant_${createHash('sha256').update(actionClass).digest('hex').slice(0, 16)}`
  writeFileSync(
    join(knowledgeRoot, 'grants.jsonl'),
    `${ledgerBytes() ?? ''}${JSON.stringify({
      schemaVersion: 1, kind: 'grant', at: '2026-08-14T09:00:00.000Z', grantId, actionClass,
      scope: { project: 'local-workspace' },
    })}\n`,
    'utf8',
  )
  await Promise.resolve()
}

function pendingProposalPath(proposalId: string): string {
  return join(agentQaRoot, 'proposals', `${proposalId}.json`)
}

/** Make one config change directly, through the production composition, in the given context. */
async function change(
  input: { readonly path: string; readonly value: string },
  executionContext: 'local-interactive' | 'local-headless' = 'local-interactive',
): Promise<Extract<ConfigChangeOutput, { outcome: 'applied' }>> {
  const host = composeCliLocalAgent({ agentQaRoot, configPath })
  try {
    const answer = await runSafetyScope({ executionContext }, async () =>
      await invokeFunction(host.registry, 'config.field.set', input, CLI_FUNCTION_CALLER) as ConfigChangeOutput)
    if (answer.outcome !== 'applied') throw new Error(`expected applied, got ${answer.outcome}`)
    return answer
  } finally {
    await host.close()
  }
}

/** The secret-adjacent change the pre-432 suite flagged: `workspace.envFile` names the secrets. */
const FLAGGED = { path: 'workspace.envFile', value: '.env.staging' } as const
const IN_SCOPE = { path: 'use.timeout.step', value: '45s' } as const

/** A pre-432 record for this change, carrying the reasons the old classifier recorded. */
async function pre432Record(input: typeof FLAGGED | typeof IN_SCOPE): Promise<string> {
  return (await filePre432ConfigProposal({
    configPath,
    agentQaRoot,
    edits: [input],
    crossBoundaryReasons: input === FLAGGED ? ['secret-adjacent-field'] : [],
  })).proposalId
}

/** The retired READ side's driver: `config.proposal.apply`, headless. */
async function applyHeadless(proposalId: string): Promise<unknown> {
  const host = composeCliLocalAgent({ agentQaRoot, configPath })
  try {
    return await runSafetyScope({ executionContext: 'local-headless' }, async () =>
      await invokeFunction(host.registry, 'config.proposal.apply', { proposalId }, CLI_FUNCTION_CALLER))
  } finally {
    await host.close()
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'config-grant-enforcement-'))
  configPath = join(root, CONFIG_FILE)
  agentQaRoot = join(root, '.agent-qa')
  knowledgeRoot = join(root, 'agent-qa-knowledge')
  mkdirSync(agentQaRoot, { recursive: true })
  mkdirSync(knowledgeRoot, { recursive: true })
  writeFileSync(configPath, SEEDED_CONFIG)

  git('init', '--quiet')
  git('config', 'user.name', 'agent-qa grant enforcement test')
  git('config', 'user.email', 'grant-enforcement-test@example.invalid')
  git('config', 'commit.gpgsign', 'false')
  writeFileSync(join(root, '.gitignore'), '.agent-qa/\nagent-qa-knowledge/\n')
  git('add', '--', '.gitignore', CONFIG_FILE)
  git('commit', '--quiet', '-m', 'seed')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('a config change applies in the call and records no approval', () => {
  // RE-SPELLED 2026-10-01: was the headless denial of `proposals.accept` (before 432-13)
  // and then its mint-side refusal with no ask. The change is now made directly.
  it('CONTROL: headless, a flagged change applies with no ask and writes no grant', async () => {
    await mintGrant(UNRELATED_CLASS)
    const before = ledgerBytes()

    const answer = await change(FLAGGED, 'local-headless')

    expect(answer.crossBoundaryReasons).toContain('secret-adjacent-field')
    expect(readFileSync(configPath, 'utf8')).toContain('envFile: .env.staging')
    expect(ledgerBytes()).toBe(before)
    expect(commitCount()).toBe(1)
  })

  // RE-SPELLED 2026-10-01: was 'refuses the mint, applies anyway, and leaves the ledger
  // byte-identical'. There is no mint to refuse; the change carries its reasons as data.
  it('a flagged change lands, names its reasons, and leaves the ledger and history alone', async () => {
    await mintGrant(UNRELATED_CLASS)
    const before = ledgerBytes()
    expect(before).toBeDefined()
    expect(ledgerLines()).toHaveLength(1)

    const answer = await change(FLAGGED)

    expect(answer.crossBoundaryReasons).toContain('secret-adjacent-field')
    expect(readFileSync(configPath, 'utf8')).toContain('envFile: .env.staging')
    expect(ledgerBytes()).toBe(before)
    expect(ledgerBytes()).not.toContain(CONFIG_APPLY_CLASS)
    expect(commitCount()).toBe(1)
    expect(git('status', '--porcelain', '--', CONFIG_FILE).stdout.trim()).toBe(`M ${CONFIG_FILE}`)
  })

  // RE-SPELLED 2026-10-01: was 'an in-scope proposal accepted with --always DOES record
  // one'. No change records an approval now, in scope or not.
  it('an in-scope change lands with no reasons and records nothing either', async () => {
    await mintGrant(UNRELATED_CLASS)
    const before = ledgerBytes()

    const answer = await change(IN_SCOPE)

    expect(answer.crossBoundaryReasons).toEqual([])
    expect(readFileSync(configPath, 'utf8')).toBe(SEEDED_CONFIG.replace('step: 30s', 'step: 45s'))
    expect(ledgerBytes()).toBe(before)
    expect(ledgerLines()).toHaveLength(1)
    expect(commitCount()).toBe(1)
  })

  // 432-16 task 2: the retry edge. A repeated flagged change is the same change: it answers
  // no-change, writes nothing, and still records no approval.
  it('retrying the flagged change answers no-change and records nothing', async () => {
    await mintGrant(UNRELATED_CLASS)
    const before = ledgerBytes()
    await change(FLAGGED)
    const once = readFileSync(configPath, 'utf8')

    const host = composeCliLocalAgent({ agentQaRoot, configPath })
    try {
      const again = await invokeFunction(host.registry, 'config.field.set', FLAGGED, CLI_FUNCTION_CALLER) as ConfigChangeOutput
      expect(again.outcome).toBe('no-change')
    } finally {
      await host.close()
    }

    expect(readFileSync(configPath, 'utf8')).toBe(once)
    expect(ledgerBytes()).toBe(before)
    expect(commitCount()).toBe(1)
  })
})

describe('the retired config apply and undo verbs are unbound on the CLI host', () => {
  it('the host exports no undo source or config apply port', () => {
    const exported = Object.keys(cliHost)
    for (const name of [
      'createConfigUndoSourcePort',
      'ConfigUndoSourceOutOfSetError',
      'createConfigApplyPort',
      'applyConfigProposalAsOneCommit',
      'ConfigApplyStaleError',
      'ConfigApplyDirtyOutsideSetError',
      'ConfigApplyDiffMismatchError',
      'CONFIG_REPROPOSE_CLI_VERB',
      'NO_DIFF_RECOMPUTED',
    ]) {
      expect(exported, name).not.toContain(name)
    }
  })

  // RE-SPELLED 2026-10-01: both verbs are deleted, so they are not listed at all
  // and each is refused as an unknown function; the undo still reads no history and files nothing.
  it('both verbs are listed unbound, and the undo reads no history and files nothing', async () => {
    const host = composeCliLocalAgent({ agentQaRoot, configPath })
    try {
      const listed = new Map(host.registry.list(CLI_FUNCTION_CALLER).map((entry) => [entry.id, entry]))
      expect(listed.has('config.undo.propose')).toBe(false)
      expect(listed.has('config.proposal.apply')).toBe(false)
      // The direct change ops are what is bound.
      expect(listed.get('config.field.set')?.bindingStatus).toBe('bound')

      await expect(invokeFunction(host.registry, 'config.undo.propose', {}, CLI_FUNCTION_CALLER))
        .rejects.toMatchObject({ name: 'UnknownFunctionError' })
    } finally {
      await host.close()
    }
    expect(existsSync(join(agentQaRoot, 'proposals'))
      ? readdirSync(join(agentQaRoot, 'proposals'))
      : []).toEqual([])
    expect(readFileSync(configPath, 'utf8')).toBe(SEEDED_CONFIG)
    expect(commitCount()).toBe(1)
  })

  it('an unknown id is refused unbound before any record is read', async () => {
    const host = composeCliLocalAgent({ agentQaRoot, configPath })
    try {
      await expect(invokeFunction(
        host.registry, 'config.proposal.apply', { proposalId: 'prop_00000000-0000-4000-8000-000000000000' },
        CLI_FUNCTION_CALLER,
      )).rejects.toMatchObject({ name: 'UnknownFunctionError' })
    } finally {
      await host.close()
    }
    expect(existsSync(join(agentQaRoot, 'proposals'))).toBe(false)
    expect(readFileSync(configPath, 'utf8')).toBe(SEEDED_CONFIG)
  })
})

// "refused unbound" became "refused as an unknown function" with the apply's
// deletion; the claims (nothing committed, the grant does not decide) are unchanged.
describe('an old proposal record is refused unbound, grant or no grant', () => {
  // RE-SPELLED 2026-10-01: (R3) with no grant the flagged apply applied directly after
  // 432-13; (R1) a covering grant did not match a flagged record; (R2) the same grant admitted an
  // in-scope one; (R4) a doctored flag with no reasons was still refused. With no config apply port
  // bound, every one of them is refused by name above every mutation, so the grant is no longer
  // what decides and nothing is committed.
  it.each([
    ['a flagged record with no grant', FLAGGED, false, false],
    ['a flagged record under a covering grant', FLAGGED, true, false],
    ['an in-scope record under the same grant', IN_SCOPE, true, false],
    ['a record doctored to carry the flag with no reasons', IN_SCOPE, true, true],
  ] as const)('%s is refused unbound and commits nothing', async (
    _label, input, grant, doctor,
  ) => {
    if (grant) await mintGrant(CONFIG_APPLY_CLASS)
    const proposalId = await pre432Record(input)
    if (doctor) {
      const record = JSON.parse(readFileSync(pendingProposalPath(proposalId), 'utf8')) as PlantedConfigRecord
      if (record.kind !== 'config' || record.payload.payloadKind !== 'applyable') {
        throw new Error('unreachable')
      }
      record.payload.crossBoundary = true
      record.payload.crossBoundaryReasons = []
      writeFileSync(pendingProposalPath(proposalId), `${JSON.stringify(record, null, 2)}\n`)
    }
    const before = readFileSync(configPath, 'utf8')

    await expect(applyHeadless(proposalId)).rejects.toMatchObject({ name: 'UnknownFunctionError' })

    expect(readFileSync(configPath, 'utf8')).toBe(before)
    expect(commitCount()).toBe(1)
    expect(git('status', '--porcelain', '--', CONFIG_FILE).stdout.trim()).toBe('')
  })

  // RE-SPELLED 2026-10-01 from '(B) the grant read still folds the committed ledger until
  // 432-18 deletes it': the read is deleted with the ledger.
  it('the grant read is an unknown function, and the old ledger is untouched', async () => {
    await mintGrant(CONFIG_APPLY_CLASS)
    const before = ledgerBytes()
    const host = composeCliLocalAgent({ agentQaRoot, configPath })
    try {
      await expect(runSafetyScope({ executionContext: 'local-headless' }, async () =>
        await invokeFunction(host.registry, 'grants.list', {}, CLI_FUNCTION_CALLER)))
        .rejects.toMatchObject({ name: 'UnknownFunctionError' })
    } finally {
      await host.close()
    }
    expect(ledgerBytes()).toBe(before)
  })
})
