// Chat names no provider SDK and no `createModel`: the model arrives as a composition argument.

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { parseModuleStatements } from '../evaluate-pin.js'
import { sourceFilesFor } from '../extract-specifiers.js'

const testDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(testDir, '..', '..', '..', '..', '..')

/** Every provider SDK, as a prefix — the set is open and naming its members would date this file. */
const PROVIDER_SDK_PREFIX = '@ai-sdk/'

/** The package the model constructor lives in, and the symbol itself. */
const MODEL_PACKAGE = ['@vostride/agent', 'qa', 'model'].join('-')
const MODEL_CONSTRUCTOR = 'createModel'

/**
 * The chat orchestration subtree, scanned whole.
 *
 * A directory rather than a file list here, and deliberately the opposite choice from the CLI side
 * below: everything under it is chat orchestration by construction, so a new module added to it
 * should inherit the rule without anyone remembering to enrol it. `sourceFilesFor` drops
 * `__tests__` by its own contract, which is the (c) clause of this rollcall — a test that exercises
 * the shipped model registry is not a chat surface.
 */
const CHAT_ORCHESTRATION_DIR = 'packages/agent/src/chat'

// A missing entry here is silent, because an unlisted file is simply not scanned.
const CHAT_SURFACE_FILES: Readonly<Record<string, string>> = {
  'packages/cli/src/commands/ask.ts':
    'the one-shot chat verb. It composes a local agent and '
    + 'drives the turn through invokeFunction; whatever model a turn uses is resolved by that '
    + 'composition, never here.',
  'packages/cli/src/commands/chat.ts':
    'the interactive REPL. Every line is one '
    + 'invokeFunction(agent.ask); the model in force for a session is decided by the composition '
    + 'and moved only by the /model directive the engine handles, so a constructor here would be '
    + 'a second place that decision lived.',
}

interface ScannedFile {
  /** Repo-relative, forward slashes. */
  readonly file: string
  readonly source: string
}

function normalize(file: string): string {
  return file.replaceAll('\\', '/')
}

/** The real input: the chat subtree plus the pinned surfaces, read off disk. */
function scannedFiles(): ScannedFile[] {
  const subtree = sourceFilesFor('packages/agent', repoRoot)
    .map((abs) => normalize(relative(repoRoot, abs)))
    .filter((file) => file.startsWith(`${CHAT_ORCHESTRATION_DIR}/`))

  const pinned = Object.keys(CHAT_SURFACE_FILES).filter((file) =>
    existsSync(join(repoRoot, file)),
  )

  return [...subtree, ...pinned].sort().map((file) => ({
    file,
    source: readFileSync(join(repoRoot, file), 'utf8'),
  }))
}

/**
 * Every statement in one file that acquires model-construction power.
 *
 * Statements, never token matches: `createModel` appears in prose in more than one chat module,
 * explaining that the model arrives already built, and a token scan would report the documentation
 * of the rule as a violation of it. Type-only acquisitions are dropped for the reason the
 * evaluate-pin drops them — a type is erased before anything runs, so a file holding one cannot
 * construct anything.
 */
export function findChatModelOffenders(files: readonly ScannedFile[]): string[] {
  const offenders: string[] = []

  for (const entry of files) {
    for (const statement of parseModuleStatements(entry.source)) {
      const clause = statement.clause
      if (/^type\b/.test(clause)) continue

      if (statement.specifier.startsWith(PROVIDER_SDK_PREFIX)) {
        offenders.push(
          `chat-model-rollcall: ${entry.file}:${statement.line} ⇏ ${statement.specifier}`
            + ' (a provider SDK is a model constructor under a vendor name; a chat surface that'
            + ' built its own client would be a model egress with none of the masking, profile'
            + ' resolution or auth that createModel applies)',
        )
        continue
      }

      const namesModelPackage =
        statement.specifier === MODEL_PACKAGE
        || statement.specifier.startsWith(`${MODEL_PACKAGE}/`)
      if (!namesModelPackage) continue

      const braced = /\{([\s\S]*)\}/.exec(clause)
      const acquires =
        braced === null
        || (braced[1] ?? '')
          .split(',')
          .map((name) => name.trim())
          .filter((name) => !/^type\b/.test(name))
          .map((name) => (name.split(/\s+as\s+/)[0] ?? name).trim())
          .includes(MODEL_CONSTRUCTOR)

      if (!acquires) continue
      offenders.push(
        `chat-model-rollcall: ${entry.file}:${statement.line} ⇏ ${MODEL_CONSTRUCTOR}`
          + ' (the model must ARRIVE at chat as a composition argument. Importing the constructor'
          + ' here would make this a second composition root: the profile in force for a session'
          + ' would be decided in two places, and a /model override would apply to only one of'
          + ' them)',
      )
    }
  }

  return offenders
}

describe('chat-model-rollcall: createModel-or-nothing', () => {
  it('scans a non-empty set — a rule with no subject passes forever and reads like proof', () => {
    const files = scannedFiles()
    expect(files.length).toBeGreaterThan(0)
    // Named modules rather than a bare count: the count is satisfied by any one file surviving a
    // path change, and what this case is protecting is that the ORCHESTRATION CORE is in scope.
    const scanned = files.map((entry) => entry.file)
    expect(scanned).toContain(`${CHAT_ORCHESTRATION_DIR}/planner-stage.ts`)
    expect(scanned).toContain(`${CHAT_ORCHESTRATION_DIR}/turn-engine.ts`)
    expect(scanned).toContain(`${CHAT_ORCHESTRATION_DIR}/planner-tools.ts`)
  })

  it('drops __tests__ — a suite exercising the shipped registry is not a chat surface', () => {
    expect(scannedFiles().every((entry) => !entry.file.includes('__tests__'))).toBe(true)
  })

  it('has every pinned chat surface on disk — a moved pin checks nothing', () => {
    for (const file of Object.keys(CHAT_SURFACE_FILES)) {
      expect({ file, exists: existsSync(join(repoRoot, file)) }).toEqual({ file, exists: true })
    }
  })

  it('finds no provider SDK and no createModel anywhere in the chat surfaces', () => {
    expect(findChatModelOffenders(scannedFiles())).toEqual([])
  })

  it('POSITIVE CONTROL: reports a provider-SDK import in a chat module', () => {
    const offenders = findChatModelOffenders([
      {
        file: `${CHAT_ORCHESTRATION_DIR}/planner-stage.ts`,
        source: ["import { anthropic }", "'@ai-sdk/anthropic'"].join(' from '),
      },
    ])
    expect(offenders).toHaveLength(1)
    expect(offenders[0]).toContain('@ai-sdk/anthropic')
  })

  it('POSITIVE CONTROL: reports a createModel import in a chat module, alias included', () => {
    const build = [`import { ${MODEL_CONSTRUCTOR} as build }`, `'${MODEL_PACKAGE}'`].join(' from ')
    expect(
      findChatModelOffenders([{ file: `${CHAT_ORCHESTRATION_DIR}/x.ts`, source: build }]),
    ).toHaveLength(1)

    const namespace = ['import * as model', `'${MODEL_PACKAGE}'`].join(' from ')
    expect(
      findChatModelOffenders([{ file: `${CHAT_ORCHESTRATION_DIR}/y.ts`, source: namespace }]),
    ).toHaveLength(1)
  })

  it('NEGATIVE CONTROL: leaves the neutral orchestration package and prose alone', () => {
    const neutral = ['import { generateText }', "'ai'"].join(' from ')
    const typeOnly = [`import type { ModelCapabilities }`, `'${MODEL_PACKAGE}'`].join(' from ')
    const prose = `// the model arrives already built by ${MODEL_CONSTRUCTOR} at the host`
    expect(
      findChatModelOffenders([
        { file: `${CHAT_ORCHESTRATION_DIR}/a.ts`, source: neutral },
        { file: `${CHAT_ORCHESTRATION_DIR}/b.ts`, source: typeOnly },
        { file: `${CHAT_ORCHESTRATION_DIR}/c.ts`, source: prose },
      ]),
    ).toEqual([])
  })
})

