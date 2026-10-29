// Ops run through `invoke` over a real `yaml` double; `cli` drives the real ports over a file.

import { createHash } from 'node:crypto'

import { isSecretAdjacentConfigField, utf8Decode, utf8Encode } from '@vostride/agent-qa-schema'
import type {
  ConfigChange,
  ConfigChangeOutput,
  FunctionCaller,
} from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'
import { Document as YamlDocument, isMap, isScalar, isSeq, parseDocument } from 'yaml'

import { FunctionInputError, invokeFunction } from '../../functions/invoke.js'
import { configProjectScaffoldSpec } from '../../functions/ops/config-project-scaffold.js'
import { createFunctionRegistry } from '../../functions/registry.js'
import type { FunctionDeps } from '../../functions/spec.js'
import { configFieldSetSummaryLine } from '../construct.js'
import type {
  ConfigFieldWriteOutcome,
  ConfigFilePublication,
  ConfigFilePublishOutcome,
  ConfigPathFacts,
  ConfigStructuredValue,
} from '../ports.js'

const CONFIG_FILE = 'agent-qa.config.yaml'
const HOOKS_FILE = 'hooks.yaml'

/** The id the double mints, so a cell can assert the pipeline used the PORT rather than a format. */
const MINTED_HOOK_ID = 'h_from-the-port-and-not-from-a-template'

/** The token the double validator refuses on. See {@link harness} — validation is MEASURED, not faked. */
// Lowercase deliberately: one of the variants below plants it in an npm package name, and npm
// package names are lowercase by the registry's own rule — an uppercase marker would have made
// that one variant silently valid, and the cell would have passed by measuring nothing.
const INVALID_MARKER = 'seeded-invalid'

const CALLER: FunctionCaller = {
  surface: 'test',
  origin: 'human',
}

// Comments are subjects: a structured write must keep them, which a plain-object round trip loses.
const CONFIG = `# agent-qa Configuration

# File discovery and project settings
workspace:
  hooksFile: hooks.yaml
  envFile: .env

# Named resource definitions
registry:
  targets:
    # Optional: add more web or mobile targets here.
    shop:
      platform: web
      url: https://shop.example.com/cart

# How runs behave by default.
use:
  parallel: false
`

const HOOKS = `hooks:
  - id: h_aster-bloom-cloud-drift-ember-field-glade-hollow-ivory-jasper
    name: Fetch the first story
    runtime: node
    file: scripts/fetch.mjs
    timeout: 30s
    network: true
`

// The spy below is an excess member, so nothing being filed stays a measurement.
interface Filed {
  readonly kind: string
  readonly emittedBy: string
  readonly payload: unknown
}

interface Validated {
  readonly configFile: string
  readonly hooksFile: string
  readonly files: readonly { path: string; text?: string }[]
}

/** One call the direct writer received: field changes, or whole files with their base digests. */
type Written =
  | { readonly kind: 'fields'; readonly changes: readonly ConfigChange[] }
  | {
    readonly kind: 'files'
    readonly files: readonly { path: string; baseDigest?: string; text: string }[]
  }

interface Harness {
  readonly deps: FunctionDeps
  readonly filed: Filed[]
  readonly validated: Validated[]
  /** Every call the direct writer (`configWrite`) received, in order. */
  readonly written: Written[]
  /** A file's text as the direct writer left it. */
  text: (path: string) => string | undefined
}

/** The config transaction's field operations, applied with the real yaml calls it makes. */
function applyFieldChanges(input: Uint8Array | undefined, changes: readonly ConfigChange[]): Uint8Array {
  const document = input === undefined ? new YamlDocument({}) : parseDocument(utf8Decode(input))
  for (const change of changes) {
    const path = change.path as (string | number)[]
    if (change.op === 'set') document.setIn(path, document.createNode(change.value))
    if (change.op === 'append') {
      const existing = document.getIn(path, true)
      if (isSeq(existing)) existing.add(document.createNode(change.value))
      else document.setIn(path, document.createNode([change.value]))
    }
  }
  return utf8Encode(document.toString())
}

/**
 * The three host doubles and the REAL yaml calls the shipped port makes.
 *
 * THE VALIDATOR IS NOT A CONSTANT `{ ok: true }`. It reads the candidate bytes it was handed and
 * refuses any member containing {@link INVALID_MARKER}, and it RECORDS what it was given. That turns
 * "validation ran" from a claim into a measurement with two independent halves: a variant seeded
 * with the marker must come back `schema-fail`, and the recorded call must contain the MUTATED bytes
 * of the file that op actually wrote — which is the half `config.hook.add` needs, because a
 * validator handed only the config yaml would return `ok` for a hooks file full of nonsense.
 */
function harness(options: {
  readonly config?: string | null
  readonly hooks?: string | undefined
  /** What the direct writer answers for whole files; published in full when absent. */
  readonly publish?: (paths: readonly string[]) => ConfigFilePublishOutcome
  /** What the direct writer answers for field changes; applied to the config file when absent. */
  readonly applyFields?: () => ConfigFieldWriteOutcome
} = {}): Harness {
  const bytes = new Map<string, Uint8Array | undefined>([
    [CONFIG_FILE, options.config === null ? undefined : utf8Encode(options.config ?? CONFIG)],
    [HOOKS_FILE, options.hooks === undefined ? undefined : utf8Encode(options.hooks)],
    ['.gitignore', utf8Encode('.agent-qa/\n')],
  ])
  const filed: Filed[] = []
  const validated: Validated[] = []
  const written: Written[] = []

  const documentFor = (input?: Uint8Array): YamlDocument =>
    input === undefined ? new YamlDocument({}) : parseDocument(utf8Decode(input))

  const deps = {
    configFiles: {
      read: () => Promise.resolve({
        configFile: CONFIG_FILE,
        hooksFile: HOOKS_FILE,
        files: [...bytes].map(([path, content]) =>
          content === undefined ? { path } : { path, bytes: content }),
      }),
      // The shipped port's calls, not a re-derivation of them: `getIn(path, true)` for the node and
      // `setIn(path, value)` for the write, so a structured value and an append past a sequence's
      // end behave here exactly as they do against a real file.
      inspect: ({ bytes: input, paths }: { bytes?: Uint8Array; paths: readonly string[] }) => {
        const document = documentFor(input)
        return Promise.resolve(paths.map((path): ConfigPathFacts => {
          const node = document.getIn(path.split('.'), true)
          if (node === undefined || node === null) return { path, present: false }
          if (isSeq(node)) return { path, present: true, kind: 'sequence', length: node.items.length }
          if (isMap(node)) {
            return {
              path,
              present: true,
              kind: 'map',
              keys: node.items.map((item) => String(isScalar(item.key) ? item.key.value : item.key)),
            }
          }
          return { path, present: true, kind: 'scalar' }
        }))
      },
      setField: (
        { bytes: input, path, value }:
        { bytes?: Uint8Array; path: string; value: ConfigStructuredValue },
      ) => {
        const document = documentFor(input)
        const segments = path.split('.')
        const previous = document.getIn(segments) as unknown
        document.setIn(segments, value)
        const mutated = utf8Encode(document.toString())
        return Promise.resolve(
          typeof previous === 'string'
            || typeof previous === 'number'
            || typeof previous === 'boolean'
            ? { bytes: mutated, previousValue: previous }
            : { bytes: mutated },
        )
      },
      mintHookId: () => MINTED_HOOK_ID,
    },
    configValidate: {
      validate: (input: {
        configFile: string
        hooksFile: string
        files: readonly { path: string; bytes?: Uint8Array }[]
      }) => {
        validated.push({
          configFile: input.configFile,
          hooksFile: input.hooksFile,
          files: input.files.map((file) => ({
            path: file.path,
            ...(file.bytes === undefined ? {} : { text: utf8Decode(file.bytes) }),
          })),
        })
        const bad = input.files.filter((file) =>
          file.bytes !== undefined && utf8Decode(file.bytes).includes(INVALID_MARKER))
        return Promise.resolve(bad.length === 0
          ? { ok: true as const }
          // Pairs, not joined strings: the pipeline joins them for the record and reads the paths.
          : {
            ok: false as const,
            issues: bad.map((file) => ({ path: file.path, message: 'seeded invalid' })),
          })
      },
    },
    configProposals: {
      put: (record: Filed) => {
        filed.push(record)
        return Promise.resolve({ proposalId: `prop-${filed.length}` })
      },
    },
    // Records what it was handed; `cli` measures what the host does with it against real files.
    configWrite: {
      applyFields: ({ changes }: { changes: readonly ConfigChange[] }) => {
        written.push({ kind: 'fields', changes })
        const scripted = options.applyFields?.()
        if (scripted !== undefined) return Promise.resolve(scripted)
        bytes.set(CONFIG_FILE, applyFieldChanges(bytes.get(CONFIG_FILE), changes))
        return Promise.resolve({
          kind: 'applied' as const,
          file: CONFIG_FILE,
          revision: 'revision-after',
          baseRevision: 'revision-before',
        })
      },
      publishFiles: ({ files }: { files: readonly ConfigFilePublication[] }) => {
        written.push({
          kind: 'files',
          files: files.map((file) => ({
            path: file.path,
            ...(file.baseDigest === undefined ? {} : { baseDigest: file.baseDigest }),
            text: utf8Decode(file.bytes),
          })),
        })
        const paths = files.map((file) => file.path)
        const scripted = options.publish?.(paths)
        if (scripted !== undefined) return Promise.resolve(scripted)
        for (const file of files) bytes.set(file.path, file.bytes)
        return Promise.resolve({ kind: 'published' as const, written: paths })
      },
    },
    // The scaffold's content, as the host producer renders it: a config, a hooks file and the
    // managed .gitignore block appended to what the project already has.
    scaffoldContent: {
      render: (input: { targetName: string; baseUrl: string; existingGitignore?: Uint8Array }) =>
        Promise.resolve([
          {
            path: CONFIG_FILE,
            bytes: utf8Encode(
              `registry:\n  targets:\n    ${input.targetName}:\n      platform: web\n`
              + `      url: ${input.baseUrl}\n`,
            ),
          },
          { path: HOOKS_FILE, bytes: utf8Encode('hooks: []\n') },
          {
            path: '.gitignore',
            bytes: utf8Encode(
              `${input.existingGitignore === undefined ? '' : utf8Decode(input.existingGitignore)}`
              + '.agent-qa/cache/\n',
            ),
          },
        ]),
    },
  } as unknown as FunctionDeps

  return {
    deps,
    filed,
    validated,
    written,
    text: (path) => {
      const content = bytes.get(path)
      return content === undefined ? undefined : utf8Decode(content)
    },
  }
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function registryFor(test: Harness) {
  return createFunctionRegistry({
    deps: test.deps,
  })
}

async function call(
  test: Harness,
  id: string,
  input: unknown,
): Promise<ConfigChangeOutput> {
  return await invokeFunction(registryFor(test), id, input, CALLER) as ConfigChangeOutput
}

/** Every 8-character window of a value — a PARTIAL disclosure is the tempting middle ground. */
function windows(value: string): string[] {
  const out: string[] = []
  for (let index = 0; index + 8 <= value.length; index++) out.push(value.slice(index, index + 8))
  return out
}

// One helper for the claim every action shares: diff as read, one write, named files, none filed.
function assertTheCfgm01Sentence(test: Harness, answer: ConfigChangeOutput, options: {
  readonly action: string
  readonly files: readonly string[]
}): void {
  expect(answer.outcome, options.action).toBe('applied')
  if (answer.outcome !== 'applied') throw new Error('unreachable')

  expect(test.filed).toHaveLength(0)
  expect(test.written).toHaveLength(1)
  expect(answer.files).toEqual(options.files)
  // THE DIFF OF THE FILES AS READ, not a description of the change: the rendered text carries the
  // unified-diff framing.
  expect(answer.shownDiff).toContain(`--- a/${options.files[0]}`)
  expect(answer.shownDiff).toContain(`+++ b/${options.files[0]}`)
  expect(answer.shownDiff).toContain('@@')
  // Whole files carry the digest of the bytes they were built from; field changes do not need one.
  const call = test.written[0]
  if (call?.kind === 'files') {
    for (const file of call.files) {
      expect(file.text.length).toBeGreaterThan(0)
      if (test.text(file.path) !== undefined && file.baseDigest !== undefined) {
        expect(file.baseDigest).toMatch(/^[0-9a-f]{64}$/)
      }
    }
  }
  // VALIDATION RAN, over the candidate this op produced — see the harness header.
  expect(test.validated).toHaveLength(1)
}

describe('config.field.set — the shared baseline', () => {
  it('carries the diff, the receipts and the config kind', async () => {
    const test = harness()
    const answer = await call(test, 'config.field.set', { path: 'use.parallel', value: true })
    expect(test.text(CONFIG_FILE)).toContain('parallel: true')
    assertTheCfgm01Sentence(test, answer, {
      action: 'config.field.set',
      files: [CONFIG_FILE],
    })
  })

  it('lands blocked schema-fail when the candidate does not validate', async () => {
    const test = harness()
    const answer = await call(
      test,
      'config.field.set',
      { path: 'use.llm', value: INVALID_MARKER },
    )
    expect(answer.outcome).toBe('blocked')
    if (answer.outcome !== 'blocked') throw new Error('unreachable')
    expect(answer.blockedReason).toBe('schema-fail')
    expect(answer.validationIssues).toEqual([`${CONFIG_FILE}: seeded invalid`])
  })
})

describe('config.target.create — a create is never an upsert (adjacency edge)', () => {
  it('carries the diff, the receipts and the config kind', async () => {
    const test = harness()
    const answer = await call(test, 'config.target.create', {
      name: 'basket',
      platform: 'web',
      url: 'https://basket.example.com',
    })
    assertTheCfgm01Sentence(test, answer, {
      action: 'config.target.create',
      files: [CONFIG_FILE],
    })
  })

  it('lands blocked schema-fail when the candidate does not validate', async () => {
    const test = harness()
    const answer = await call(test, 'config.target.create', {
      name: 'basket',
      platform: 'web',
      url: `https://basket.example.com/${INVALID_MARKER}`,
    })
    expect(answer.outcome).toBe('blocked')
    if (answer.outcome !== 'blocked') throw new Error('unreachable')
    expect(answer.blockedReason).toBe('schema-fail')
    expect(test.filed).toHaveLength(0)
    expect(test.written).toHaveLength(0)
  })

  it('THE EDGE: an existing name is a typed collision, and nothing is filed', async () => {
    const test = harness()
    const answer = await call(test, 'config.target.create', {
      name: 'shop',
      platform: 'web',
      url: 'https://shop.evil.example',
    })

    expect(answer.outcome).toBe('refused')
    if (answer.outcome !== 'refused') throw new Error('unreachable')
    expect(answer.reason).toBe('target-exists')
    // It points at the op that DOES edit one, so the refusal ends the guessing rather than starting
    // a second round of it.
    expect(answer.detail).toContain('config.target.edit')
    expect(answer.candidates).toEqual(['shop'])
    // NOTHING WRITTEN, and no diff was ever rendered: this reds on a create that merged, that
    // overwrote, or that answered a blocked report for a request that is simply wrong.
    expect(test.filed).toHaveLength(0)
    expect(test.written).toHaveLength(0)
  })

  it('writes the house-style block and leaves every existing comment standing', async () => {
    const test = harness()
    const answer = await call(test, 'config.target.create', {
      name: 'basket',
      platform: 'web',
      url: 'https://basket.example.com',
    })
    if (answer.outcome !== 'applied') throw new Error('unreachable')

    // The added lines are the block alone; a rewrite would show the whole document changed.
    const added = answer.shownDiff.split('\n').filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    expect(added).toEqual([
      '+    basket:',
      '+      platform: web',
      '+      url: https://basket.example.com',
    ])
    const removed = answer.shownDiff.split('\n').filter((line) => line.startsWith('-') && !line.startsWith('---'))
    expect(removed).toEqual([])

    // AND THE COMMENTS SURVIVE, asserted against the file as written rather than against the
    // diff — the diff only shows a window, and the claim is about the whole file.
    const content = test.text(CONFIG_FILE) ?? ''
    expect(content).toContain('    basket:\n      platform: web\n      url: https://basket.example.com')
    expect(content).toContain('# agent-qa Configuration')
    expect(content).toContain('# Optional: add more web or mobile targets here.')
    expect(content).toContain('# How runs behave by default.')
  })

  it('a created target is a NEW ORIGIN, and the retired auth-state field is refused on the input', async () => {
    const plain = harness()
    const first = await call(plain, 'config.target.create', {
      name: 'basket',
      platform: 'web',
      url: 'https://basket.example.com',
    })
    if (first.outcome !== 'applied') throw new Error('unreachable')
    expect(first.crossBoundary).toBe(true)
    expect(first.crossBoundaryReasons).toEqual(['new-origin'])

    const bound = harness()
    await expect(call(bound, 'config.target.create', {
      name: 'basket',
      platform: 'web',
      url: 'https://basket.example.com',
      authStateName: 'basket-default',
    })).rejects.toBeInstanceOf(FunctionInputError)
    expect(bound.written).toHaveLength(0)
  })
})

describe('config.target.edit — never guess, and decide from the VALUE', () => {
  it('carries the diff, the receipts and the config kind', async () => {
    const test = harness()
    const answer = await call(test, 'config.target.edit', {
      name: 'shop',
      changes: { url: 'https://shop.example.com/basket' },
    })
    assertTheCfgm01Sentence(test, answer, {
      action: 'config.target.edit',
      files: [CONFIG_FILE],
    })
  })

  it('lands blocked schema-fail when the candidate does not validate', async () => {
    const test = harness()
    const answer = await call(test, 'config.target.edit', {
      name: 'shop',
      changes: { url: `https://shop.example.com/${INVALID_MARKER}` },
    })
    expect(answer.outcome).toBe('blocked')
    if (answer.outcome !== 'blocked') throw new Error('unreachable')
    expect(answer.blockedReason).toBe('schema-fail')
  })

  it('THE EDGE: an absent target is a typed not-found that LISTS what is configured', async () => {
    const test = harness()
    const answer = await call(test, 'config.target.edit', {
      name: 'shpo',
      changes: { url: 'https://shop.example.com/basket' },
    })

    expect(answer.outcome).toBe('refused')
    if (answer.outcome !== 'refused') throw new Error('unreachable')
    expect(answer.reason).toBe('target-not-found')
    // THE NAMES, which is what turns a refusal into something a caller can act on. This reds on a
    // refusal that says only "no such target" — and on a `setIn` that would have CREATED `shpo`.
    expect(answer.candidates).toEqual(['shop'])
    expect(test.filed).toHaveLength(0)
    expect(test.written).toHaveLength(0)
  })

  it('THE EDGE: one FIXED path, two values, two different cross-boundary answers', async () => {
    // Both calls edit the same path, and the answers differ because the values do.
    const sameOrigin = harness()
    const near = await call(sameOrigin, 'config.target.edit', {
      name: 'shop',
      changes: { url: 'https://shop.example.com/basket' },
    })
    if (near.outcome !== 'applied') throw new Error('unreachable')
    expect(near.crossBoundary).toBe(false)
    expect(near.crossBoundaryReasons).toEqual([])

    const newOrigin = harness()
    const far = await call(newOrigin, 'config.target.edit', {
      name: 'shop',
      changes: { url: 'https://shop.evil.example/cart' },
    })
    if (far.outcome !== 'applied') throw new Error('unreachable')
    expect(far.crossBoundary).toBe(true)
    expect(far.crossBoundaryReasons).toEqual(['new-origin'])

    // AND THE PATH REALLY IS THE SAME ONE in both, so the pair cannot pass because the two calls
    // happened to address different fields.
    expect(isSecretAdjacentConfigField('registry.targets.shop.url')).toBe(false)
    for (const answer of [near, far]) {
      expect(answer.shownDiff).toContain('    url: https://')
    }
  })
})

describe('config.auth.set — refs only, refused on the INPUT', () => {
  it('carries the diff, the receipts and the config kind, and is secret-adjacent', async () => {
    const test = harness()
    const answer = await call(test, 'config.auth.set', {
      target: 'shop',
      pluginPackage: '@acme/auth',
    })
    assertTheCfgm01Sentence(test, answer, {
      action: 'config.auth.set',
      files: [CONFIG_FILE],
    })
    if (answer.outcome !== 'applied') throw new Error('unreachable')
    expect(answer.crossBoundaryReasons).toEqual(['secret-adjacent-field'])
    // THE DIFF CONTAINS A REFERENCE AND NOTHING ELSE: a package name, at the one path this
    // configuration declares an auth plugin.
    expect(answer.shownDiff).toContain('@acme/auth')
  })

  it('authStateName is refused on the input by all three ops, and nothing is written', async () => {
    for (const [id, input] of [
      ['config.auth.set', { target: 'shop', authStateName: 'shop-default' }],
      ['config.target.create', { name: 'basket', platform: 'web', url: 'https://basket.example.com', authStateName: 'shop-default' }],
      ['config.target.edit', { name: 'shop', changes: { authStateName: 'shop-default' } }],
    ] as const) {
      const test = harness()
      await expect(call(test, id, input), id).rejects.toBeInstanceOf(FunctionInputError)
      expect(test.written, id).toHaveLength(0)
      expect(test.filed, id).toHaveLength(0)
    }
  })

  it('lands blocked schema-fail when the candidate does not validate', async () => {
    const test = harness()
    const answer = await call(test, 'config.auth.set', {
      target: 'shop',
      pluginPackage: `@acme/${INVALID_MARKER}`,
    })
    expect(answer.outcome).toBe('blocked')
    if (answer.outcome !== 'blocked') throw new Error('unreachable')
    expect(answer.blockedReason).toBe('schema-fail')
  })

  it('appends a plugin declaration past the end rather than over the last one', async () => {
    const withPlugins = harness({
      config: `${CONFIG}plugins:\n  auth:\n    - package: "@vostride/agent-qa-subscription-auth"\n`,
    })
    const answer = await call(withPlugins, 'config.auth.set', {
      target: 'shop',
      pluginPackage: '@acme/auth',
    })
    if (answer.outcome !== 'applied') throw new Error('unreachable')
    const content = withPlugins.text(CONFIG_FILE) ?? ''
    // BOTH declarations, in order. This reds on a write at a fixed index (the existing one is gone)
    // and on writing the whole sequence back (the existing one is gone too, differently).
    expect(content.indexOf('@vostride/agent-qa-subscription-auth'))
      .toBeLessThan(content.indexOf('@acme/auth'))
    expect(content).toContain('- package: "@vostride/agent-qa-subscription-auth"')
    expect(content).toContain('- package: "@acme/auth"')
    expect(answer.crossBoundaryReasons).toEqual(['secret-adjacent-field'])
  })

  it('THE EDGE: a value that is not a reference is refused STRUCTURALLY, by what a reference IS', async () => {
    // A base64-shaped token, refused by the positive shape rule alone.
    const unnamed = 'Zm9vYmFyYmF6cXV4Cg'

    const test = harness()
    const answer = await call(test, 'config.auth.set', { target: 'shop', pluginPackage: unnamed })
    expect(answer.outcome).toBe('refused')
    if (answer.outcome !== 'refused') throw new Error('unreachable')
    expect(answer.reason).toBe('refs-only')
    expect(answer.detail).toContain('plugin-package')
    expect(answer.detail).toContain('pluginPackage')
    expect(answer.detail).toContain('workspace.secretsFile')
    // ZERO STORE AND WRITE DELTA, and the value is not quoted back: the line below proves this
    // codebase's summary channel really does print values it is given.
    expect(test.filed).toHaveLength(0)
    expect(test.written).toHaveLength(0)
    expect(configFieldSetSummaryLine('plugins.auth', unnamed)).toContain(unnamed)
    for (const window of windows(unnamed)) expect(answer.detail).not.toContain(window)

    // THE GUARD REJECTS SOMETHING ITS OWN ASSUMPTION ADMITS, in the other direction: a legal
    // reference passes, so the rule is not "refuse everything".
    const legal = harness()
    const proposed = await call(legal, 'config.auth.set', {
      target: 'shop',
      pluginPackage: '@acme/auth',
    })
    expect(proposed.outcome).toBe('applied')
  })

  it('refuses a binding for a target nobody configured, and names the ones that exist', async () => {
    const test = harness()
    const answer = await call(test, 'config.auth.set', {
      target: 'checkout',
      pluginPackage: '@acme/auth',
    })
    expect(answer.outcome).toBe('refused')
    if (answer.outcome !== 'refused') throw new Error('unreachable')
    expect(answer.reason).toBe('target-not-found')
    expect(answer.candidates).toEqual(['shop'])
  })

  it('refuses an env-var name by saying where it belongs, AFTER the reference check', async () => {
    const test = harness()
    const answer = await call(test, 'config.auth.set', {
      target: 'shop',
      envVarName: 'SHOP_API_TOKEN',
    })
    expect(answer.outcome).toBe('refused')
    if (answer.outcome !== 'refused') throw new Error('unreachable')
    expect(answer.reason).toBe('unsupported-reference')
    expect(answer.detail).toContain('the environment it runs in')
    expect(answer.detail).not.toContain('workspace.envFile')

    // PRECEDENCE: a value that is not shaped like a variable name is answered as refs-only first.
    const both = harness()
    const misshapen = await call(both, 'config.auth.set', {
      target: 'shop',
      envVarName: 'sk-PROBE-1234567890',
    })
    if (misshapen.outcome !== 'refused') throw new Error('unreachable')
    expect(misshapen.reason).toBe('refs-only')
  })
})

describe('config.hook.add — the one action that writes another file', () => {
  it('carries the diff, the receipts and the config kind — for the HOOKS file', async () => {
    const test = harness({ hooks: HOOKS })
    const answer = await call(test, 'config.hook.add', {
      name: 'Seed the cart',
      runtime: 'node',
      file: 'scripts/seed.mjs',
    })
    assertTheCfgm01Sentence(test, answer, {
      action: 'config.hook.add',
      // THE EDGE, in one line: the file this proposal touches is not the config yaml.
      files: [HOOKS_FILE],
    })
  })

  it('THE EDGE: whole-input validation was handed the MUTATED hooks file', async () => {
    const test = harness({ hooks: HOOKS })
    await call(test, 'config.hook.add', {
      name: 'Seed the cart',
      runtime: 'node',
      file: 'scripts/seed.mjs',
    })

    const call1 = test.validated[0]
    expect(test.text(HOOKS_FILE)).toContain('Seed the cart')
    expect(test.text(CONFIG_FILE)).toBe(CONFIG)
    expect(call1).toBeDefined()
    // The candidate is the whole SET, and the hooks member carries the new entry. This reds on a
    // pipeline that validated only the config yaml — which would have passed every other describe
    // in this file, because every other op writes the config yaml.
    expect(call1?.hooksFile).toBe(HOOKS_FILE)
    const hooksMember = call1?.files.find((file) => file.path === HOOKS_FILE)
    expect(hooksMember?.text).toContain('Seed the cart')
    // ...and the config yaml went along UNCHANGED, so "whole set" is not "whole set, mutated".
    const configMember = call1?.files.find((file) => file.path === CONFIG_FILE)
    expect(configMember?.text).toBe(CONFIG)
  })

  it('lands blocked schema-fail when the hooks file does not validate', async () => {
    const test = harness({ hooks: HOOKS })
    const answer = await call(test, 'config.hook.add', {
      name: INVALID_MARKER,
      runtime: 'bash',
      file: 'scripts/seed.sh',
    })
    expect(answer.outcome).toBe('blocked')
    if (answer.outcome !== 'blocked') throw new Error('unreachable')
    expect(answer.blockedReason).toBe('schema-fail')
    expect(answer.validationIssues).toEqual([`${HOOKS_FILE}: seeded invalid`])
    expect(answer.paths).toEqual([HOOKS_FILE])
  })

  it('THE EDGE: every hook addition flags hook-added, and the id comes from the PORT', async () => {
    const test = harness({ hooks: HOOKS })
    const answer = await call(test, 'config.hook.add', {
      name: 'Seed the cart',
      runtime: 'node',
      file: 'scripts/seed.mjs',
      timeout: '45s',
      network: false,
    })
    if (answer.outcome !== 'applied') throw new Error('unreachable')

    // A hook is code this project runs, so the flag is unconditional.
    expect(answer.crossBoundary).toBe(true)
    expect(answer.crossBoundaryReasons).toEqual(['hook-added'])

    const added = answer.shownDiff.split('\n').filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    expect(added).toEqual([
      `+  - id: ${MINTED_HOOK_ID}`,
      '+    name: Seed the cart',
      '+    runtime: node',
      '+    file: scripts/seed.mjs',
      '+    timeout: 45s',
      '+    network: false',
    ])
    // APPENDED, NOT OVERWRITTEN: the committed hook is untouched, so nothing was removed.
    expect(answer.shownDiff.split('\n').filter((line) =>
      line.startsWith('-') && !line.startsWith('---'))).toEqual([])
  })

  it('creates the hooks file when a project has none, and scans the whole new file', async () => {
    const test = harness({ hooks: undefined })
    const answer = await call(test, 'config.hook.add', {
      name: 'Seed the cart',
      runtime: 'node',
      file: 'scripts/seed.mjs',
    })
    if (answer.outcome !== 'applied') throw new Error('unreachable')

    const publication = test.written[0]
    if (publication?.kind !== 'files') throw new Error('expected a whole-file publication')
    // A created file has no base digest, because there is no base — a fact, not an omission.
    expect(publication.files[0]?.path).toBe(HOOKS_FILE)
    expect(publication.files[0]?.baseDigest).toBeUndefined()
    expect(test.text(HOOKS_FILE)).toContain('Seed the cart')
    // The default timeout is written, because `HookDefinitionSchema` requires one and the DTO makes
    // it optional. A hook proposed without a duration would be refused at the next run.
    expect(answer.shownDiff).toContain('+    timeout: 30s')
  })
})

const EXPECTED_CONFIG_FAMILY = [
  'config.auth.set',
  'config.field.set',
  'config.get',
  'config.hook.add',
  'config.project.scaffold',
  'config.target.create',
  'config.target.edit',
] as const

describe('the config action class is CLOSED, and the registry is where that is legible', () => {
  it('registers exactly the expected config family, and every member is config-write', () => {
    const registry = registryFor(harness())
    const declarations = registry.list(CALLER)
    const family = declarations
      .map((declaration) => declaration.id)
      .filter((id) => id.startsWith('config.'))
      .sort()

    expect(family).toEqual([...EXPECTED_CONFIG_FAMILY])

    // Each is a registry op the planner picks by tool name; every writing member declares a write.
    for (const id of EXPECTED_CONFIG_FAMILY) {
      const declaration = declarations.find((entry) => entry.id === id)
      expect(declaration, id).toBeDefined()
      if (id === 'config.get') {
        expect(declaration?.risk.readOnly, id).toBe(true)
        continue
      }
      expect(declaration?.risk.readOnly, id).toBe(false)
    }
  })

  it('every config op names the direct writer as its binding and refuses by name without it', async () => {
    // Without the direct writer, every op refuses by name rather than filing the change elsewhere.
    const test = harness({ config: null })
    const { configWrite: _dropped, ...withoutWriter } = test.deps as unknown as Record<string, unknown>
    const registry = createFunctionRegistry({
      deps: withoutWriter as unknown as FunctionDeps,
    })
    const status = new Map(registry.list(CALLER).map((entry) => [entry.id, entry.bindingStatus]))
    for (const id of [
      'config.field.set',
      'config.target.create',
      'config.target.edit',
      'config.auth.set',
      'config.hook.add',
    ]) {
      expect(status.get(id), id).toBe('unbound')
    }
    await expect(
      invokeFunction(registry, 'config.project.scaffold', { domain: 'booking.com' }, CALLER),
    ).rejects.toThrow(/not bound/i)
    expect(test.filed).toHaveLength(0)
  })
})

// ---- every config operation writes in the call that asked for it ----

async function change(test: Harness, id: string, input: unknown): Promise<ConfigChangeOutput> {
  return await invokeFunction(registryFor(test), id, input, CALLER) as ConfigChangeOutput
}

function addedLines(diff: string): string[] {
  return diff.split('\n').filter((line) => line.startsWith('+') && !line.startsWith('+++'))
}

describe('field, target create and target edit write in the call', () => {
  it('config.field.set writes the field and answers what it changed', async () => {
    const test = harness()
    const answer = await change(test, 'config.field.set', { path: 'use.parallel', value: true })

    expect(answer).toMatchObject({
      outcome: 'applied',
      summaryLine: configFieldSetSummaryLine('use.parallel', true),
      files: [CONFIG_FILE],
      fields: ['use.parallel'],
    })
    expect(answer).not.toHaveProperty('proposalId')
    expect(test.written).toEqual([
      { kind: 'fields', changes: [{ op: 'set', path: ['use', 'parallel'], value: true }] },
    ])
    if (answer.outcome !== 'applied') throw new Error('unreachable')
    expect(addedLines(answer.shownDiff)).toEqual(['+  parallel: true'])
    expect(test.filed).toHaveLength(0)
  })

  it('config.target.create writes the entry only while the name is still free',
    async () => {
      const test = harness()
      const answer = await change(test, 'config.target.create', {
        name: 'basket',
        platform: 'web',
        url: 'https://basket.example.com',
        environment: 'production',
      })

      // No `use.authState` set rides along.
      expect(answer).toMatchObject({
        outcome: 'applied',
        files: [CONFIG_FILE],
        fields: [
          'registry.targets.basket.platform',
          'registry.targets.basket.url',
          'registry.targets.basket.environment',
        ],
      })
      // The expect comes first, so a target someone else created meanwhile refuses the write
      // rather than being replaced by it.
      expect(test.written).toEqual([{
        kind: 'fields',
        changes: [
          { op: 'expect', path: ['registry', 'targets', 'basket'], value: null },
          {
            op: 'set',
            path: ['registry', 'targets', 'basket'],
            value: { platform: 'web', url: 'https://basket.example.com', environment: 'production' },
          },
        ],
      }])
      expect(test.filed).toHaveLength(0)
    })

  it('config.target.edit writes the changed url and nothing else', async () => {
    const test = harness()
    const answer = await change(test, 'config.target.edit', {
      name: 'shop',
      changes: { url: 'https://shop.example.com/basket' },
    })

    expect(answer).toMatchObject({
      outcome: 'applied',
      files: [CONFIG_FILE],
      fields: ['registry.targets.shop.url'],
    })
    expect(test.written).toEqual([{
      kind: 'fields',
      changes: [
        { op: 'set', path: ['registry', 'targets', 'shop', 'url'], value: 'https://shop.example.com/basket' },
      ],
    }])
    expect(test.filed).toHaveLength(0)
  })

  it('a request refusal writes nothing and files nothing', async () => {
    const collision = harness()
    const refused = await change(collision, 'config.target.create', {
      name: 'shop',
      platform: 'web',
      url: 'https://shop.example.com',
    })
    expect(refused).toMatchObject({ outcome: 'refused', reason: 'target-exists' })

    const missing = harness()
    const notFound = await change(missing, 'config.target.edit', {
      name: 'shpo',
      changes: { url: 'https://shop.example.com/basket' },
    })
    expect(notFound).toMatchObject({ outcome: 'refused', reason: 'target-not-found', candidates: ['shop'] })

    for (const test of [collision, missing]) {
      expect(test.written).toEqual([])
      expect(test.filed).toEqual([])
    }
  })

  it('the same value twice is no change, and the writer is not called', async () => {
    const test = harness()
    const answer = await change(test, 'config.field.set', { path: 'use.parallel', value: false })
    expect(answer).toEqual({ outcome: 'no-change', path: 'set use.parallel' })
    expect(test.written).toEqual([])
    expect(test.filed).toEqual([])
  })

  it('a create the transaction refuses answers the refusal and claims nothing',
    async () => {
      // The name was free when the call read the file and taken by the time the write took its
      // turn: the transaction's expect refuses, and the answer says the file moved.
      const test = harness({
        applyFields: () => ({
          kind: 'refused',
          file: CONFIG_FILE,
          error: 'field_changed',
          path: ['registry', 'targets', 'basket'],
        }),
      })
      const answer = await change(test, 'config.target.create', {
        name: 'basket',
        platform: 'web',
        url: 'https://basket.example.com',
      })
      expect(answer).toMatchObject({ outcome: 'refused', reason: 'field-changed' })
      if (answer.outcome !== 'refused') throw new Error('unreachable')
      expect(answer.detail).toContain('registry.targets.basket')
      expect(answer.detail).toContain('nothing was written')
      expect(test.filed).toEqual([])
    })
})

describe('auth, hook and scaffold write in the call as well', () => {
  it('config.auth.set appends the plugin as a field change',
    async () => {
      const test = harness()
      const answer = await change(test, 'config.auth.set', {
        target: 'shop',
        pluginPackage: '@acme/auth',
      })

      expect(answer).toMatchObject({
        outcome: 'applied',
        files: [CONFIG_FILE],
        fields: ['plugins.auth.0.package'],
        crossBoundaryReasons: ['secret-adjacent-field'],
      })
      expect(test.written).toEqual([{
        kind: 'fields',
        changes: [
          { op: 'append', path: ['plugins', 'auth'], value: { package: '@acme/auth' } },
        ],
      }])
      expect(test.filed).toHaveLength(0)
    })

  it('config.auth.set refuses a value that is not a reference before anything is written', async () => {
    const test = harness()
    const answer = await change(test, 'config.auth.set', {
      target: 'shop',
      pluginPackage: 'AKIAQWERTYUIOPASDFGH',
    })
    expect(answer).toMatchObject({ outcome: 'refused', reason: 'refs-only' })
    expect(test.written).toEqual([])
  })

  it('config.hook.add publishes the hooks file over the bytes it was built from',
    async () => {
      const test = harness({ hooks: HOOKS })
      const answer = await change(test, 'config.hook.add', {
        name: 'Seed the cart',
        runtime: 'node',
        file: 'scripts/seed.mjs',
      })

      expect(answer).toMatchObject({
        outcome: 'applied',
        files: [HOOKS_FILE],
        crossBoundaryReasons: ['hook-added'],
      })
      if (answer.outcome !== 'applied') throw new Error('unreachable')
      expect(answer.fields).toContain('hooks.1.id')
      expect(answer.fields).toContain('hooks.1.file')

      expect(test.written).toHaveLength(1)
      const call = test.written[0]
      if (call?.kind !== 'files') throw new Error('expected a whole-file publication')
      expect(call.files.map((file) => file.path)).toEqual([HOOKS_FILE])
      expect(call.files[0]?.baseDigest).toBe(sha256(HOOKS))
      // The canonical id is the port's, the committed hook is kept, and the new one follows it.
      expect(call.files[0]?.text.startsWith(HOOKS)).toBe(true)
      expect(call.files[0]?.text).toContain(`id: ${MINTED_HOOK_ID}`)
      expect(test.filed).toHaveLength(0)
    })

  it('a hooks file that does not exist yet is published with no base digest',
    async () => {
      const test = harness({ hooks: undefined })
      const answer = await change(test, 'config.hook.add', {
        name: 'Seed the cart',
        runtime: 'bash',
        file: 'scripts/seed.sh',
      })
      expect(answer).toMatchObject({ outcome: 'applied', files: [HOOKS_FILE] })
      const call = test.written[0]
      if (call?.kind !== 'files') throw new Error('expected a whole-file publication')
      expect(call.files[0]).not.toHaveProperty('baseDigest')
      expect(call.files[0]?.text).toContain('timeout: 30s')
    })

  it('config.project.scaffold publishes every file of the scaffold in one call',
    async () => {
      const test = harness({ config: null })
      const answer = await change(test, 'config.project.scaffold', { domain: 'booking.com' })

      expect(answer).toMatchObject({
        outcome: 'applied',
        files: ['.gitignore', CONFIG_FILE, HOOKS_FILE],
        fields: ['registry.targets.booking-com.platform', 'registry.targets.booking-com.url'],
      })
      const call = test.written[0]
      if (call?.kind !== 'files') throw new Error('expected a whole-file publication')
      // Every file is checked against what the call read: the project's own .gitignore by its
      // digest, and the two new files by their absence.
      expect(call.files.map((file) => [file.path, file.baseDigest])).toEqual([
        ['.gitignore', sha256('.agent-qa/\n')],
        [CONFIG_FILE, undefined],
        [HOOKS_FILE, undefined],
      ])
      expect(call.files[0]?.text).toBe('.agent-qa/\n.agent-qa/cache/\n')
      expect(test.written).toHaveLength(1)
      expect(test.filed).toHaveLength(0)
    })
})

describe('a partial publication is reported as exactly what happened', () => {
  it('a failure after the first file names the written, failed and unreached files',
    async () => {
      const test = harness({
        config: null,
        publish: (paths) => ({
          kind: 'interrupted',
          written: [paths[0]!],
          failed: { path: paths[1]!, reason: 'write-failed', message: 'EACCES' },
          unwritten: paths.slice(2),
        }),
      })
      const answer = await change(test, 'config.project.scaffold', { domain: 'booking.com' })

      expect(answer).toMatchObject({
        outcome: 'interrupted',
        written: ['.gitignore'],
        failed: { path: CONFIG_FILE, reason: 'write-failed' },
        unwritten: [HOOKS_FILE],
      })
      if (answer.outcome !== 'interrupted') throw new Error('unreachable')
      expect(answer.detail).toContain('.gitignore')
      expect(answer.detail).toContain(CONFIG_FILE)
      // Nothing claims success: the verdict is a failure and no applied file list exists.
      expect(answer).not.toHaveProperty('files')
      expect(configProjectScaffoldSpec.classify(answer).status).toBe('failed')
      expect(test.filed).toHaveLength(0)
    })

  it('a file that changed before any write refuses and nothing is written',
    async () => {
      const test = harness({
        hooks: HOOKS,
        publish: (paths) => ({
          kind: 'refused',
          reason: 'file-changed',
          path: paths[0]!,
          written: [],
        }),
      })
      const answer = await change(test, 'config.hook.add', {
        name: 'Seed the cart',
        runtime: 'node',
        file: 'scripts/seed.mjs',
      })
      expect(answer).toMatchObject({ outcome: 'refused', reason: 'file-changed' })
      if (answer.outcome !== 'refused') throw new Error('unreachable')
      expect(answer.detail).toContain(HOOKS_FILE)
      expect(answer.detail).toContain('nothing was written')
    })
})
