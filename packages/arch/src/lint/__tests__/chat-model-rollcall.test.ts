// createModel-or-nothing, as a failing build rather than a convention.
//
// THE REQUIREMENT. Every chat model call goes through `createModel`. That is where the masking
// middleware lives, where the profile and transport are resolved, and where auth is applied — so a
// chat surface that built its own client would be a model egress with no masking on it, carrying
// whatever the conversation happened to contain. The requirement is easy to state and
// exactly as easy to forget, which is why it is scanned.
//
// THE CLAIM IS TWO-SIDED, and neither side alone is CHAT-06:
//
//   (a) NO PROVIDER SDK. Nothing in the chat subtree may name a vendor adapter package. That is
//       what "constructs no provider client" means concretely; the SDK's neutral orchestration
//       package is fine, because it can describe a tool set and issue a call against a model it was
//       handed, and it cannot build one.
//   (b) NO `createModel` EITHER. The model must ARRIVE at chat as a composition argument. A chat
//       module that imported the constructor would be a second composition root — legal by rule
//       (a), masked correctly, and still wrong: the profile in force for a session would then be
//       decided in two places, and `/model` overrides would apply to one of them.
//
// THE SCANNED SET IS PINNED, NOT GLOBBED, on the CLI side. `packages/cli/src/commands/` also holds
// `run.ts`, `doctor.ts` and `auth.ts`, which construct models entirely legitimately — they are the
// CLI's own composition roots. A directory-wide rule would either fail on those or be widened with
// exceptions until it meant nothing. So the chat SURFACES are named one file at a time, and a
// pinned file that has gone missing is an offender: a rule whose subject does not exist passes
// forever and reads like proof (the resume-path pin's own lesson).
//
// THE RULE IS PROVED ABLE TO FAIL. Two positive controls below run the scanner over fabricated
// sources and assert it reports them. A scan that cannot be shown to red is a scan that converts
// "unproven" into "proven", which is worse than no scan at all.

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

/**
 * The chat SURFACES in the CLI, by exact repo-relative path, each with the reason it is listed.
 *
 * `chat.ts` joined in the SAME COMMIT that created it (plan 08), which is the discipline this
 * asymmetry demands: a missing pin here is SILENT — the file is simply not scanned — while the
 * reverse direction is an offender the case below reports. Nothing would have told anyone.
 */
const CHAT_SURFACE_FILES: Readonly<Record<string, string>> = {
  'packages/cli/src/commands/ask.ts':
    '2026-08-09 (392 plan 01, D-01/D-24): the one-shot chat verb. It composes a local agent and '
    + 'drives the turn through invokeFunction; whatever model a turn uses is resolved by that '
    + 'composition, never here.',
  'packages/cli/src/commands/chat.ts':
    '2026-08-09 (392 plan 08, D-01/D-24): the interactive REPL. Every line is one '
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
            + ' resolution or auth that createModel applies — CHAT-06)',
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
          + ' them — CHAT-06 / D-04)',
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

// FLAGGED ASSUMPTION (edge probe CHAT-06/unclassified, surfaced rather than dropped): this rollcall
// covers STATIC module statements in the scanned set. A provider client constructed through a
// dynamic import inside a test fixture is outside what these assertions can see. The surface
// firewall and createModel's masking middleware remain the runtime backstop for that case, and the
// class rules already forbid the vendor namespace in this package outright — this rule exists to
// state the chat-specific half of CHAT-06 where a reader of the chat code will find it.
