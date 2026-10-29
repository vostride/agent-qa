// The ONE host-side authoring scope derivation.
//
// WHY THIS FILE IS IN `packages/cli`. The derivation reads the resolved config's targets and the
// workspace's committed tests, which needs `resolveConfig` plus `resolveWorkspacePaths` /
// `discoverWorkspaceFiles` / `parseTestFile` from `@vostride/agent-qa-core` — the FUNC-02 surface
// firewall keeps that reach inside `local-agent-host.ts`, so this is the only package where the
// derivation and a real workspace can be in the same process.
//
// D-19'S POSTURE IS THE SUBJECT. A unique candidate binds; ambiguity REFUSES and names every
// candidate it saw. The refusal arm has its own cell rather than being implied by the derive arm,
// because a deriver that guessed the first candidate would satisfy every positive cell here.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  AuthoringScopeUnresolvableError,
  deriveDefaultAuthoringScope,
} from '../composition/local-agent-host.js'

// The house shape, as `agent-qa init` writes it (`buildScaffoldConfig`), for the reason
// `draft-shelf-admission.test.ts` gives: a bespoke workspace measures a workspace nobody has. The
// `use.mobile.appState` line is not decoration — `resolveConfig` REFUSES a config without it, so a
// fixture omitting it would measure the config validator rather than the derivation.
const WORKSPACE_BLOCK = `workspace:
  testMatch:
    - tests/**/*.yaml
  suiteMatch:
    - suites/**/*.suite.yaml
  hooksFile: hooks.yaml
  envFile: .env
  secretsFile: .env.secrets.local
use:
  mobile:
    appState: preserve
`

/** One configured web target, product taken from the target NAME (`product` absent). */
const ONE_TARGET = `registry:
  targets:
    local-form:
      platform: web
      url: http://127.0.0.1:8931
`

/** Two configured targets, the second carrying an explicit `product` that differs from its name. */
const TWO_TARGETS = `registry:
  targets:
    local-form:
      platform: web
      url: http://127.0.0.1:8931
    storefront-web:
      product: storefront
      platform: web
      url: https://storefront.example
`

const TEST_IDS = [
  't_amber-birch-coral-delta-ember-falcon-garden-harbor-island-jungle',
  't_aster-bloom-cloud-drift-ember-field-glade-hollow-ivory-jasper',
] as const

function committedTest(target: string, index: number): string {
  return `name: Exercise ${target}
test-id: ${TEST_IDS[index] ?? TEST_IDS[0]}
target: ${target}
steps:
  - Open the application
  - Verify the heading says "Welcome"
`
}

let root: string
let configPath: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'authoring-scope-'))
  configPath = join(root, 'agent-qa.config.yaml')
  for (const name of ['hooks.yaml', '.env', '.env.secrets.local']) {
    writeFileSync(join(root, name), '')
  }
  mkdirSync(join(root, 'tests'), { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function writeConfig(...blocks: string[]): void {
  writeFileSync(configPath, [WORKSPACE_BLOCK, ...blocks].join(''))
}

function writeTest(fileName: string, target: string, index = 0): void {
  writeFileSync(join(root, 'tests', fileName), committedTest(target, index))
}

describe('deriveDefaultAuthoringScope: a singleton binds', () => {
  it('derives {tier:product} from the one product the committed tests exercise', async () => {
    writeConfig(ONE_TARGET)
    writeTest('form.yaml', 'local-form')

    // The mapping is `agent-qa run`'s own — a target's `product` when present, the target name
    // otherwise — so the scope a draft is authored for is the scope its runs are attributed to.
    expect(await deriveDefaultAuthoringScope(configPath))
      .toEqual({ tier: 'product', key: 'local-form' })
  })

  it('NARROWS to the product the tests exercise when the config offers more', async () => {
    writeConfig(TWO_TARGETS)
    writeTest('storefront.yaml', 'storefront-web')

    // Two configured targets and one exercised product: the workspace answers the question the
    // config alone cannot. The explicit `product` key wins over the target name here, which is
    // what makes this cell a measurement of the mapping rather than of the name.
    expect(await deriveDefaultAuthoringScope(configPath))
      .toEqual({ tier: 'product', key: 'storefront' })
  })

  it('BOOTSTRAP: zero committed tests and exactly one configured target still derives', async () => {
    writeConfig(ONE_TARGET)

    // The fresh-project arm. A workspace with nothing committed has no tests to narrow by, and
    // one configured target is still exactly one candidate — refusing here would make the very
    // first authored test in a project unreachable from chat.
    expect(await deriveDefaultAuthoringScope(configPath))
      .toEqual({ tier: 'product', key: 'local-form' })
  })
})

describe('deriveDefaultAuthoringScope: ambiguity REFUSES and names its evidence', () => {
  it('throws naming BOTH products when the committed tests span two', async () => {
    writeConfig(TWO_TARGETS)
    writeTest('form.yaml', 'local-form', 0)
    writeTest('storefront.yaml', 'storefront-web', 1)

    // THE CASE THE GUARD REJECTS. Without it every cell above is drawn from inside the deriver's
    // own assumption — a function that returned its first candidate would pass all three.
    let caught: unknown
    try {
      await deriveDefaultAuthoringScope(configPath)
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(AuthoringScopeUnresolvableError)
    const message = (caught as Error).message
    // EVERY candidate by name, asserted one at a time: a message naming only the first would be a
    // refusal that cannot be acted on, and `toContain` over a joined string would pass on it.
    expect(message).toContain('local-form')
    expect(message).toContain('storefront')
    expect(message).toContain('scope')
    expect((caught as AuthoringScopeUnresolvableError).candidates)
      .toEqual(['local-form', 'storefront'])
  })

  it('throws when the config declares two targets and NOTHING is committed', async () => {
    writeConfig(TWO_TARGETS)

    // The bootstrap arm's own refusal half: with nothing to narrow by, two configured targets are
    // two candidates. Deriving one here would pick a product by config key order.
    let caught: unknown
    try {
      await deriveDefaultAuthoringScope(configPath)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(AuthoringScopeUnresolvableError)
    expect((caught as AuthoringScopeUnresolvableError).candidates)
      .toEqual(['local-form', 'storefront'])
  })

  it('throws when the config declares NO targets at all — zero is not a default', async () => {
    writeConfig()

    let caught: unknown
    try {
      await deriveDefaultAuthoringScope(configPath)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(AuthoringScopeUnresolvableError)
    expect((caught as AuthoringScopeUnresolvableError).candidates).toEqual([])
  })

  it('ADVISORY DISCOVERY: an unparsable test file cannot make the derivation fail', async () => {
    writeConfig(ONE_TARGET)
    writeTest('form.yaml', 'local-form')
    writeFileSync(join(root, 'tests', 'broken.yaml'), 'name: [unclosed\n')

    // One broken file in a repository must not make authoring unreachable — the same advisory
    // posture `suiteTextCorpus` already takes over this walk. The direction the omission moves the
    // candidate set is the safe one: it can only make the set smaller, and a set of one still has
    // to survive the singleton check.
    expect(await deriveDefaultAuthoringScope(configPath))
      .toEqual({ tier: 'product', key: 'local-form' })
  })

  it('ADVISORY DISCOVERY: a test naming an UNCONFIGURED target contributes no candidate', async () => {
    writeConfig(ONE_TARGET)
    writeTest('form.yaml', 'local-form', 0)
    writeTest('ghost.yaml', 'not-in-config', 1)

    // A target the config does not declare has no product mapping at all, so it cannot narrow and
    // it cannot ambiguate. Treating it as a candidate would refuse a workspace whose only real
    // product is unambiguous.
    expect(await deriveDefaultAuthoringScope(configPath))
      .toEqual({ tier: 'product', key: 'local-form' })
  })
})
