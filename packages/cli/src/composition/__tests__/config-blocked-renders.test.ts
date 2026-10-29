// CFGM-01's blocked road, measured on RENDERS through the production composition (395-04 · D-10).
//
// 2026-09-30, 432-11 D-05: a blocked change is ANSWERED and nothing is kept, so the surfaces a
// person reads are the answer itself and the runtime root, which must hold nothing about the block.
// 2026-10-01 (432-17): the `proposals` verb is deleted, so the runtime root is read directly.
//
// 2026-10-14 (441-18, D-15/D-23): a config change is not scanned for secrets. The cells whose
// subject was the construction scan — its seeded half, the context-line and range blocks, the
// environment-slice control and the guardrail no-write cell — are deleted with it. What remains is
// the validation road: a yaml parse failure names WHERE and never WHAT, and nothing is kept.
//
// Nothing here is stubbed: the registry, the validator and the writer are the shipped ones, over a
// real workspace, with `composeCliLocalAgent` building the host.
//
//   (G) POSITION — 395-10 plus WR-11. A yaml parse failure whose issue string is built from the
//                  LIBRARY'S error text: the vendored `yaml` package pretty-prints its parse errors
//                  with an excerpt of the offending source line, so `errorText(error)` would publish
//                  whatever that line held. The channel is closed by REDUCING the issue to its
//                  position. It also pins WR-11: the answer's `paths` names the file the issue is
//                  about.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { invokeFunction } from '@vostride/agent-qa-agent'
import type { ConfigChangeOutput } from '@vostride/agent-qa-schema'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { CLI_FUNCTION_CALLER, composeCliLocalAgent } from '../local-agent-host.js'

const CONFIG_FILE = 'agent-qa.config.yaml'
const HOOKS_FILE = 'hooks.yaml'

function configText(options: { readonly note: string }): string {
  // The house-style config, valid against the real schema — `use.llm` names a registry entry that
  // exists, so a block here comes from the file this suite breaks and not from this one.
  return `# agent-qa Configuration
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

use:
  llm: judge
  # deploy note: ${options.note}
  timeout:
    step: 30s
    test: 90m
    navigation: 2m
  mobile:
    appState: reset
  parallel: false
`
}

/**
 * Everything this workspace persisted, as one text — paths included.
 *
 * THE WHOLE STORE RATHER THAN ONE RECORD PATH, so a leak that landed in a sibling file (an index, a
 * decision trail, a log) is found too.
 */
function persistedText(dir: string): string {
  const out: string[] = []
  if (!existsSync(dir)) return ''
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    out.push(full)
    if (statSync(full).isDirectory()) out.push(persistedText(full))
    else out.push(readFileSync(full, 'utf8'))
  }
  return out.join('\n')
}

let root: string
let configPath: string
let agentQaRoot: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'config-blocked-renders-'))
  configPath = join(root, CONFIG_FILE)
  agentQaRoot = join(root, '.agent-qa')
  mkdirSync(agentQaRoot, { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** Change through the PRODUCTION composition. */
async function propose(input: {
  readonly path: string
  readonly value: string
}): Promise<ConfigChangeOutput> {
  const host = composeCliLocalAgent({ agentQaRoot, configPath })
  try {
    return await invokeFunction(
      host.registry,
      'config.field.set',
      input,
      CLI_FUNCTION_CALLER,
    ) as ConfigChangeOutput
  } finally {
    await host.close()
  }
}

describe('on the surfaces a person reads', () => {
  it('(G) a yaml parse failure names WHERE, never WHAT — and the record names the right file',
    async () => {
      const marker = 'zeta-nine-deploy-marker'
      writeFileSync(configPath, configText({ note: 'nothing to see here' }))
      writeFileSync(join(root, HOOKS_FILE), `# project hooks
hooks:
  - name: nightly
    note: ${marker}: oops
`)

      const answer = await propose({ path: 'use.timeout.step', value: '45s' })

      expect(answer.outcome).toBe('blocked')
      if (answer.outcome !== 'blocked') throw new Error('unreachable')
      expect(answer.blockedReason).toBe('schema-fail')

      // POSITION-ONLY. The issue names the file, the line and the column, and nothing else — no
      // property of the thrown error other than where it happened reaches this string.
      const issues = answer.validationIssues ?? []
      const parseIssue = issues.find((issue) => issue.startsWith(`${HOOKS_FILE}: `))
      expect(parseIssue).toBeDefined()
      expect(parseIssue).toMatch(
        new RegExp(`^${HOOKS_FILE}: not readable as YAML at line \\d+, column \\d+$`),
      )

      // WR-11: the record points a person at the file the issue is ABOUT, unioned with the file the
      // change diffed.
      expect(answer.paths).toContain(HOOKS_FILE)
      expect(answer.paths).toContain(CONFIG_FILE)

      const returned = JSON.stringify(answer)
      const persisted = persistedText(agentQaRoot)

      // PRESENCE FIRST: the answer really reports this refusal, its reason, and the issue about
      // this file. 432-11: nothing is persisted about it.
      expect(returned).toContain('schema-fail')
      expect(returned).toContain(HOOKS_FILE)
      expect(returned).toContain('not readable as YAML at line')
      expect(persisted).not.toContain('schema-fail')

      // AND NEITHER CARRIES THE SOURCE LINE'S TEXT.
      expect(returned).not.toContain(marker)
      expect(persisted).not.toContain(marker)
    })
})

// ---- 432-11 D-05: a blocked change is an answer in the call, and nothing is kept ---------------
//
// C432-CONFIG-BLOCKED-NO-WRITE  through the production composition: a blocked change answers the
//                               report with no record reference, writes no proposal file anywhere
//                               under the runtime root, and leaves the config byte-for-byte as it
//                               was. A clean change beside it is written in the same call.

function proposalFiles(): string[] {
  const dir = join(agentQaRoot, 'proposals')
  try {
    return readdirSync(dir).filter((name) => name.endsWith('.json'))
  } catch {
    return []
  }
}

describe('a blocked change is refused in the call and leaves no record', () => {
  it('a schema failure answers position-only issues and files nothing',
    async () => {
      const marker = 'zeta-nine-deploy-marker'
      writeFileSync(configPath, configText({ note: 'nothing to see here' }))
      writeFileSync(join(root, HOOKS_FILE), `# project hooks\nhooks:\n  - name: nightly\n    note: ${marker}: oops\n`)
      const answer = await propose({ path: 'use.timeout.step', value: '45s' }) as Record<string, unknown>

      expect(answer).toMatchObject({ outcome: 'blocked', blockedReason: 'schema-fail' })
      expect(answer).not.toHaveProperty('proposalId')
      expect(JSON.stringify(answer)).not.toContain(marker)
      expect(proposalFiles()).toEqual([])
      expect(readFileSync(configPath, 'utf8')).toBe(configText({ note: 'nothing to see here' }))
    })

  it('CONTROL: the same edit on a clean config is written in the call', async () => {
    writeFileSync(configPath, configText({ note: 'nothing to see here' }))
    const answer = await propose({ path: 'use.timeout.step', value: '45s' }) as Record<string, unknown>

    expect(answer).toMatchObject({
      outcome: 'applied',
      files: [CONFIG_FILE],
      fields: ['use.timeout.step'],
    })
    expect(readFileSync(configPath, 'utf8'))
      .toBe(configText({ note: 'nothing to see here' }).replace('step: 30s', 'step: 45s'))
    expect(proposalFiles()).toEqual([])
  })
})
