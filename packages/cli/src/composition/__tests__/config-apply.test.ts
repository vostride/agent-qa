// `config.field.set` writes in the call and commits nothing; an old proposal record is refused.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { UnknownFunctionError, createFunctionRegistry, invokeFunction } from '@vostride/agent-qa-agent'
import type { FunctionDeps } from '@vostride/agent-qa-agent'
import {
  MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
  base64Decode,
  sha256hexBytes,
  utf8Encode,
} from '@vostride/agent-qa-schema'
import type {
  ConfigChangeOutput,
  FunctionCaller,
} from '@vostride/agent-qa-schema'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  createConfigFilesPort,
  createConfigValidatePort,
  createConfigWritePort,
} from '../local-agent-host.js'
import * as hostModule from '../local-agent-host.js'
import { filePre432ConfigProposal } from './pre-432-config-proposal.js'

const HUMAN: FunctionCaller = {
  surface: 'test',
  origin: 'human',
}

/**
 * The seeded config, in the house style — COMMENT-DENSE ON PURPOSE.
 *
 * The comments are the subject of cell (e) and the reason the mutation goes through the yaml
 * Document API at all: `init.ts` has a whole `addYamlComments` function to put these back after a
 * stringify, so a config a person actually has is one a plain round trip would strip to nothing.
 */
const SEEDED_CONFIG = `# agent-qa Configuration

# File discovery and project settings
workspace:
  testMatch:
    - tests/**/*.yaml
  suiteMatch:
    - suites/**/*.suite.yaml
  hooksFile: hooks.yaml
  envFile: .env
  secretsFile: .env.secrets.local

# Named resource definitions (LLM configs, app targets)
registry:
  llms:
    - name: judge
      provider: openai-subscription
      model: gpt-5.6-terra
  targets:
    local-form:
      platform: web
      url: http://127.0.0.1:8931/form.html

# How runs behave by default.
use:
  llm: judge
  timeout:
    # Raise this when the app under test is slow to settle.
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

function git(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    // A `git` that ran and failed must not return quietly.
    throw new Error(`git ${args.join(' ')} exited ${result.status}: ${result.stderr}`)
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

function commitCount(): number {
  return Number(git('rev-list', '--count', 'HEAD').stdout.trim())
}

/** Where the durable store keeps a PENDING proposal — the store's own naming, not a guess. */
function pendingProposalPath(proposalId: string): string {
  return join(agentQaRoot, 'proposals', `${proposalId}.json`)
}

// Read back off disk as plain JSON, never the object handed to the store.
interface StoredPre432Record {
  readonly kind: string
  readonly payload: {
    readonly payloadKind: string
    readonly files: readonly { readonly newContentBase64: string }[]
  }
}

function storedRecord(proposalId: string): StoredPre432Record {
  return JSON.parse(readFileSync(pendingProposalPath(proposalId), 'utf8')) as StoredPre432Record
}

function storedConfigPayload(proposalId: string) {
  const record = storedRecord(proposalId)
  if (record.kind !== 'config') throw new Error(`stored ${proposalId} is a ${record.kind} proposal`)
  if (record.payload.payloadKind !== 'applyable') throw new Error('stored payload is not applyable')
  return record.payload
}

// The real config ports and no apply port, as the production host binds them.
function registryFor() {
  const deps: FunctionDeps = {
    runs: {
      list: () => Promise.resolve([]),
      get: () => Promise.resolve(undefined),
      readEvents: () => Promise.resolve([]),
      readStepEvidence: () => Promise.resolve({ kind: 'run-not-recorded' } as const),
    },
    knowledge: {
      listBundles: () => Promise.resolve([]),
      inspectRecords: () => Promise.resolve([]),
      diffSince: () => Promise.resolve([]),
      showRecord: ({ recordId }) =>
        Promise.resolve({ kind: 'not-found', schemaVersion: 2, recordId } as const),
    },
    entities: {
      resolve: () => Promise.resolve({ kind: 'none' as const, reason: 'no-match' as const }),
      get: () => Promise.resolve(undefined),
    },
    config: {
      getMasked: () => Promise.resolve({
        schemaVersion: MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
        configPath: 'agent-qa.config.yaml',
        entries: [],
      }),
    },
    // THE REAL THREE, over the real workspace and the real repository.
    configFiles: createConfigFilesPort(configPath),
    configValidate: createConfigValidatePort(),
    // The direct writer the config operations publish through.
    configWrite: createConfigWritePort(configPath, (text) => text),
  }

  return createFunctionRegistry({
    deps,
    // The registry takes no confirm port and no execution-context option.
  })
}

async function change(
  registry: ReturnType<typeof registryFor>,
  input: { path: string; value: string | number | boolean },
): Promise<ConfigChangeOutput> {
  return await invokeFunction(registry, 'config.field.set', input, HUMAN) as ConfigChangeOutput
}

/** A legacy proposal record for the tracer edit, as an old workspace holds it. */
async function pre432Proposal(): Promise<string> {
  return (await filePre432ConfigProposal({
    configPath,
    agentQaRoot,
    edits: [{ path: 'use.timeout.step', value: '45s' }],
  })).proposalId
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'config-apply-'))
  configPath = join(root, 'agent-qa.config.yaml')
  agentQaRoot = join(root, '.agent-qa')
  writeFileSync(configPath, SEEDED_CONFIG)

  git('init', '--quiet')
  // A fresh repository has no identity and may sign by default, so both are set here.
  git('config', 'user.name', 'agent-qa config apply test')
  git('config', 'user.email', 'config-apply-test@example.invalid')
  git('config', 'commit.gpgsign', 'false')
  writeFileSync(join(root, '.gitignore'), '.agent-qa/\n')
  writeFileSync(join(root, 'README.md'), 'seeded\n')
  git('add', '--', '.gitignore', 'README.md', 'agent-qa.config.yaml')
  git('commit', '--quiet', '-m', 'seed')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('the config tracer: propose, accept, ONE byte-matched commit', () => {
  it('(a) writes the edit in the call, answering the diff of the bytes it read and filing nothing', async () => {
    const seededDigest = sha256hexBytes(Uint8Array.from(readFileSync(configPath)))
    const answer = await change(registryFor(), { path: 'use.timeout.step', value: '45s' })
    expect(answer.outcome).toBe('applied')
    if (answer.outcome !== 'applied') throw new Error('unreachable')

    expect(answer.summaryLine).toBe('set use.timeout.step to 45s')
    expect(answer.files).toEqual(['agent-qa.config.yaml'])
    expect(answer.fields).toEqual(['use.timeout.step'])

    // The rendered diff really is a diff of this change against the file as it was.
    expect(answer.shownDiff).toContain('--- a/agent-qa.config.yaml')
    expect(answer.shownDiff).toContain('-    step: 30s')
    expect(answer.shownDiff).toContain('+    step: 45s')

    // THE FILE MOVED IN THE CALL, by exactly the edit, off the bytes that were there.
    expect(seededDigest).not.toBe(sha256hexBytes(Uint8Array.from(readFileSync(configPath))))
    expect(readFileSync(configPath, 'utf8')).toBe(SEEDED_CONFIG.replace('step: 30s', 'step: 45s'))

    // No record and no commit: git shows a plain modified file.
    expect(existsSync(join(agentQaRoot, 'proposals'))).toBe(false)
    expect(commitCount()).toBe(1)
    expect(git('status', '--porcelain', '--', 'agent-qa.config.yaml').stdout.trim())
      .toBe('M agent-qa.config.yaml')
  })

  it('(a2) refuses a mutation that breaks the WHOLE config, before anything surfaces', async () => {
    // `use.parallel` is a boolean, so a string there makes a candidate that does not validate.
    const answer = await change(registryFor(), { path: 'use.parallel', value: 'yes please' })

    expect(answer.outcome).toBe('blocked')
    if (answer.outcome !== 'blocked') throw new Error('unreachable')
    expect(answer.blockedReason).toBe('schema-fail')
    expect(answer.validationIssues?.length ?? 0).toBeGreaterThan(0)
    expect((answer.validationIssues ?? []).join('\n')).toContain('use.parallel')
    // No record on disk and no content in the answer.
    expect(existsSync(join(agentQaRoot, 'proposals'))).toBe(false)
    expect(JSON.stringify(answer)).not.toContain('shownDiff')
    expect(JSON.stringify(answer)).not.toContain('newContentBase64')
    // NOTHING WAS WRITTEN AND NOTHING WAS COMMITTED.
    expect(readFileSync(configPath, 'utf8')).toBe(SEEDED_CONFIG)
    expect(commitCount()).toBe(1)
  })

  it('(b) accepting an old proposal record is refused unbound: no commit, and the file keeps its bytes', async () => {
    const registry = registryFor()
    const id = await pre432Proposal()
    // The record is still on disk and still names the promised bytes; nothing applies them.
    expect(base64Decode(storedConfigPayload(id).files[0]!.newContentBase64).length).toBeGreaterThan(0)

    await expect(invokeFunction(registry, 'proposals.accept', { proposalId: id }, HUMAN))
      .rejects.toBeInstanceOf(UnknownFunctionError)

    expect(readFileSync(configPath, 'utf8')).toBe(SEEDED_CONFIG)
    expect(commitCount()).toBe(1)
    expect(git('status', '--porcelain').stdout.trim()).toBe('')
  })

  it('(c) repeating the same change answers no-change and writes nothing more', async () => {
    const registry = registryFor()
    expect((await change(registry, { path: 'use.timeout.step', value: '45s' })).outcome).toBe('applied')
    const once = readFileSync(configPath)

    const again = await change(registry, { path: 'use.timeout.step', value: '45s' })

    expect(again.outcome).toBe('no-change')
    expect(readFileSync(configPath).equals(once)).toBe(true)
    expect(commitCount()).toBe(1)
  })

  it('(d) an out-of-band edit is kept: the change lands on the bytes on disk, not over them', async () => {
    const humanEdit = SEEDED_CONFIG.replace('navigation: 2m', 'navigation: 5m')
    writeFileSync(configPath, humanEdit)

    expect((await change(registryFor(), { path: 'use.timeout.step', value: '45s' })).outcome)
      .toBe('applied')

    expect(readFileSync(configPath, 'utf8')).toBe(humanEdit.replace('step: 30s', 'step: 45s'))
    expect(commitCount()).toBe(1)
  })

  it('(e) the comments survive the applied mutation, verbatim and in place', async () => {
    await change(registryFor(), { path: 'use.timeout.step', value: '45s' })

    const written = readFileSync(configPath, 'utf8')
    // Every comment the seed carried, still there — a plain-object round trip would have kept none.
    for (const comment of [
      '# agent-qa Configuration',
      '# File discovery and project settings',
      '# Named resource definitions (LLM configs, app targets)',
      '# How runs behave by default.',
      '# Raise this when the app under test is slow to settle.',
    ]) {
      expect(written).toContain(comment)
    }
    expect(written).toBe(SEEDED_CONFIG.replace('step: 30s', 'step: 45s'))
  })

  it('(f) a whole-file publication over bytes that moved refuses before any write', async () => {
    const port = createConfigWritePort(configPath, (text) => text)
    const builtFrom = sha256hexBytes(Uint8Array.from(readFileSync(configPath)))
    const moved = SEEDED_CONFIG.replace('parallel: false', 'parallel: true')
    writeFileSync(configPath, moved)

    const outcome = await port.publishFiles({
      files: [{
        path: 'agent-qa.config.yaml',
        baseDigest: builtFrom,
        bytes: utf8Encode(SEEDED_CONFIG.replace('step: 30s', 'step: 45s')),
      }],
    })

    expect(outcome).toMatchObject({ kind: 'refused', reason: 'file-changed', written: [] })
    expect(readFileSync(configPath, 'utf8')).toBe(moved)
    expect(commitCount()).toBe(1)
  })

  it('(g) an unbound apply refuses BY NAME and leaves the repository untouched', async () => {
    const id = await pre432Proposal()

    await expect(invokeFunction(registryFor(), 'config.proposal.apply', { proposalId: id }, HUMAN))
      .rejects.toBeInstanceOf(UnknownFunctionError)

    expect(readFileSync(configPath, 'utf8')).toBe(SEEDED_CONFIG)
    expect(commitCount()).toBe(1)
  })
})

describe('the tracer edit through the direct writer', () => {
  it('publishes the field edit byte-matched with its comments, files no proposal and makes no commit', async () => {
    const create = (hostModule as Record<string, unknown>).createConfigWritePort
    expect(typeof create, 'the direct config writer is exported').toBe('function')
    const port = (create as (path: string) => NonNullable<FunctionDeps['configWrite']>)(configPath)

    const outcome = await port.applyFields({
      changes: [{ op: 'set', path: ['use', 'timeout', 'step'], value: '45s' }],
    })

    expect(outcome).toMatchObject({ kind: 'applied', file: 'agent-qa.config.yaml' })
    expect(readFileSync(configPath, 'utf8')).toBe(SEEDED_CONFIG.replace('step: 30s', 'step: 45s'))
    expect(commitCount()).toBe(1)
    expect(git('status', '--porcelain').stdout.trim()).toBe('M agent-qa.config.yaml')
    expect(existsSync(join(agentQaRoot, 'proposals'))).toBe(false)
  })
})
