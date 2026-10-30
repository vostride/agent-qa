// Validates what the shipped `init --platform web` writes, its declared auth plugin uninstalled.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const CONFIG_FILE = 'agent-qa.config.yaml'

// Drives the built `dist/cli.js`, so a stale dist measures the previous build.
const CLI_DIST = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'dist', 'cli.js')

// Printed over an empty set, this sentence is a false attestation.
const SUCCESS_SENTENCE = 'All files valid'

// One planted value per file class, so a whole-output failure says which file leaked.
const PLANTED_CONFIG_CREDENTIAL = 'sk-ant-api03-CONFIGFIXTUREONLYnotarealkey'
const PLANTED_TEST_CREDENTIAL = 'sk-ant-api03-TESTFIXTUREONLYnotarealkey'
const PLANTED_HOOKS_CREDENTIAL = 'sk-ant-api03-HOOKSFIXTUREONLYnotarealkey'

/** The package the default scaffold declares and a fresh project has not installed. */
const SUBSCRIPTION_AUTH_PACKAGE = '@vostride/agent-qa-subscription-auth'

/** A canonical test id of this fixture's own, distinct from every id the scaffold writes. */
const FIXTURE_TEST_ID = 't_zebra-quartz-ledger-marble-signal-timber-violet-walnut-yellow-anchor'

/** A valid plain test yaml the scaffold's own `testMatch` finds. */
const VALID_TEST = `test-id: ${FIXTURE_TEST_ID}
name: the file this project's own validator must actually check
target: example-web
steps:
  - Verify the page says "Example Domain"
`

// The duplicate key is the credential's line, so a pretty printer puts it on both channels.
const POISONED_TEST = `name: log in to the app
target: example-web
steps:
  - Click the login button

# pasted in from the provider dashboard, and again after a bad merge
apiToken: ${PLANTED_TEST_CREDENTIAL}
apiToken: ${PLANTED_TEST_CREDENTIAL}
`

let root: string

function git(...args: string[]): void {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    // `result.error` is set only when spawn fails, so a non-zero exit must be checked too.
    throw new Error(`git ${args.join(' ')} exited ${result.status}: ${result.stderr}`)
  }
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

/** The shipped binary, its WHOLE output — no stream filter and no line filter. */
function runShippedCli(...args: string[]): { status: number | null; combined: string } {
  const run = spawnSync(process.execPath, [CLI_DIST, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
  })
  return { status: run.status, combined: `${run.stdout ?? ''}${run.stderr ?? ''}` }
}

/**
 * THE FIXTURE, PRODUCED BY THE PRODUCT ITSELF.
 *
 * `dist/cli.js init --platform web` — the NON-INTERACTIVE road, which `init.ts:881` selects
 * whenever `--platform` is given, so no prompt is fed and no exported machinery is substituted for
 * the command. This is the road a person takes from a README, and its generated config is what the
 * cells below validate.
 */
function scaffoldWithShippedInit(): string {
  const run = spawnSync(process.execPath, [CLI_DIST, 'init', '--platform', 'web', '--dir', root], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
  })
  const combined = `${run.stdout ?? ''}${run.stderr ?? ''}`
  expect(run.status, `the product's own init must succeed:\n${combined}`).toBe(0)
  const configText = readFileSync(join(root, CONFIG_FILE), 'utf-8')
  // THE PRECONDITION OF THE WHOLE DEFECT, ASSERTED RATHER THAN ASSUMED: the default non-interactive
  // scaffold DECLARES the optional subscription-auth plugin. If a later change stops it declaring
  // one, this line reds and says so, instead of the cells below quietly measuring a project that
  // never had the problem.
  expect(
    configText,
    'the default `init --platform web` scaffold must declare the auth plugin for F-05 to exist',
  ).toMatch(/plugins:\s*\n\s*auth:\s*\n\s*-\s*package:/)
  return configText
}

/** Every yaml the scaffold's own globs match, walked off disk. */
function discoveredFileCount(): number {
  const walk = (dir: string, suffix: string): number => {
    if (!existsSync(dir)) return 0
    let found = 0
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const child = join(dir, entry.name)
      if (entry.isDirectory()) found += walk(child, suffix)
      else if (entry.name.endsWith(suffix)) found += 1
    }
    return found
  }
  // `testMatch: tests/**/*.yaml`, `suiteMatch: suites/**/*.suite.yaml` — the scaffold's own globs.
  return walk(join(root, 'tests'), '.yaml') + walk(join(root, 'suites'), '.suite.yaml')
}

function writeFileUnder(relativePath: string, text: string): void {
  const absolute = join(root, relativePath)
  mkdirSync(dirname(absolute), { recursive: true })
  writeFileSync(absolute, text)
}

/** The scaffolded config, made SCHEMA-INVALID at a field the schema names, carrying a credential. */
function makeConfigUnresolvable(configText: string): void {
  const broken = configText
    .replace(/\n\s*name: chromium\n/, '\n    name: netscape\n')
    + `\n# pasted in from the provider dashboard months ago\napiToken: ${PLANTED_CONFIG_CREDENTIAL}\n`
  expect(broken, 'the illegal enum value must actually be written').toContain('name: netscape')
  writeFileSync(join(root, CONFIG_FILE), broken)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'validate-resolution-'))
  git('init', '--quiet')
  git('config', 'user.name', 'agent-qa validate resolution test')
  git('config', 'user.email', 'validate-resolution-test@example.invalid')
  git('config', 'commit.gpgsign', 'false')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('a project the product scaffolds is validated, not attested over an empty set', () => {
  it('bare `validate` in an init-scaffolded project CHECKS FILES', () => {
    scaffoldWithShippedInit()
    writeFileUnder(join('tests', 'z1-added.yaml'), VALID_TEST)

    const expected = discoveredFileCount()
    expect(expected, 'the scaffold plus the added member is a non-empty set').toBeGreaterThan(1)

    const { status, combined } = runShippedCli('validate')

    // The count is the assertion: `All files valid` over zero files with exit 0 is a false pass.
    const reported = /All files valid \((\d+) file\(s\) checked\)/.exec(combined)
    expect(reported, `bare validate did not report a clean check:\n${combined}`).not.toBeNull()
    const checked = Number(reported?.[1])
    expect(checked, `the validator attested over an empty set:\n${combined}`).toBeGreaterThanOrEqual(1)
    expect(checked, `the checked count does not match the file set on disk:\n${combined}`).toBe(expected)
    expect(status, `an all-valid project is a clean exit:\n${combined}`).toBe(0)

    // AND THE SET, BY MEMBERSHIP. A count can be produced by checking the wrong files; poisoning one
    // known member and reading its name back out of the report says the set contains it.
    writeFileUnder(join('tests', 'z1-membership.yaml'), 'name: a test with no steps at all\ntarget: example-web\n')
    const second = runShippedCli('validate')
    expect(
      second.combined,
      `the discovered set does not contain the added member:\n${second.combined}`,
    ).toContain('z1-membership.yaml')
    expect(second.status, `a member with errors is an error exit:\n${second.combined}`).toBe(1)
  }, 180_000)

  it('a config that cannot be resolved is named LOUDLY, exits non-zero, and leaks nothing', () => {
    const configText = scaffoldWithShippedInit()
    makeConfigUnresolvable(configText)

    const { status, combined } = runShippedCli('validate')

    // THE DISCLOSURE ASSERTION FIRST: the surfaced line carries the thrown error's MESSAGE, and a
    // resolution failure's message is about the schema's own field paths — never the file's bytes.
    expect(
      occurrences(combined, PLANTED_CONFIG_CREDENTIAL),
      `validate's output carried the planted credential:\n${combined}`,
    ).toBe(0)
    // THE SUCCESS SENTENCE IS UNREACHABLE FROM A FAILED RESOLUTION. This is the structural clause:
    // not "the count was zero" but "the sentence was never printed".
    expect(
      combined,
      `validate attested success over an unresolvable project:\n${combined}`,
    ).not.toContain(SUCCESS_SENTENCE)
    // THE FAILURE IS NAMED, not merely counted. `Config resolution failed:` is the captured throw
    // surfaced on stderr; the schema path is what the message itself carries.
    expect(combined, `the resolution failure was not named:\n${combined}`)
      .toContain('Config resolution failed:')
    expect(combined, `the resolution failure did not say what was wrong:\n${combined}`)
      .toMatch(/use\.browser\.name/)
    expect(status, `an unresolvable config is a non-zero exit:\n${combined}`).not.toBe(0)
  }, 180_000)

  it('the verbs that DO load the declared plugin name the package and the remedy, not a require stack', () => {
    // `run` and `devices list` reach the plugin loader by different roads, so both are driven.
    scaffoldWithShippedInit()

    for (const verb of [['run', 'tests/examples/komazon-checkout.yaml'], ['devices', 'list']]) {
      const { status, combined } = runShippedCli(...verb)

      expect(status, `a project missing its declared plugin must still fail (${verb.join(' ')}):\n${combined}`)
        .not.toBe(0)
      expect(combined, `the failure did not name the package (${verb.join(' ')}):\n${combined}`)
        .toContain(SUBSCRIPTION_AUTH_PACKAGE)
      expect(combined, `the failure did not name the remedy (${verb.join(' ')}):\n${combined}`)
        .toMatch(/npm install @vostride\/agent-qa-subscription-auth/)
      // A message still carrying Node's loader boilerplate means the typed error replaced nothing.
      expect(combined, `the failure still speaks Node's loader dialect (${verb.join(' ')}):\n${combined}`)
        .not.toContain('Require stack')
      expect(combined, `the failure still speaks Node's loader dialect (${verb.join(' ')}):\n${combined}`)
        .not.toContain('Cannot find module')
    }
  }, 180_000)

  it('the workspace-match gate is BACK in the init-scaffolded project — the amplifier road is closed', () => {
    // `hooks.yaml` matches neither `testMatch` nor `suiteMatch`, so the workspace gate answers.
    scaffoldWithShippedInit()
    writeFileUnder(
      'hooks.yaml',
      `${readFileSync(join(root, 'hooks.yaml'), 'utf-8')}
# pasted in from the provider dashboard, and again after a bad merge
apiToken: ${PLANTED_HOOKS_CREDENTIAL}
apiToken: ${PLANTED_HOOKS_CREDENTIAL}
`,
    )

    const { status, combined } = runShippedCli('validate', 'hooks.yaml')

    expect(
      combined,
      `the workspace-match gate did not answer — the amplifier road is open:\n${combined}`,
    ).toContain('File is not matched by configured workspace testMatch or suiteMatch patterns')
    expect(
      occurrences(combined, PLANTED_HOOKS_CREDENTIAL),
      `validate republished the hooks file's own bytes:\n${combined}`,
    ).toBe(0)
    expect(status, `a refused file is an error exit:\n${combined}`).toBe(1)
  }, 180_000)

  it('explicit-file validate of a poisoned plain test in an UNRESOLVABLE project renders position-only', () => {
    // An unresolved config skips the workspace gate; core's formatter alone keeps the value out.
    const configText = scaffoldWithShippedInit()
    makeConfigUnresolvable(configText)
    writeFileUnder(join('tests', 'z5-poisoned.yaml'), POISONED_TEST)
    git('add', '--', join('tests', 'z5-poisoned.yaml'))
    git('commit', '--quiet', '-m', 'the project commits a test file with a pasted credential')

    const { combined } = runShippedCli('validate', join('tests', 'z5-poisoned.yaml'))

    expect(
      occurrences(combined, PLANTED_TEST_CREDENTIAL),
      `validate republished the test file's own bytes:\n${combined}`,
    ).toBe(0)
    // The surfaced resolution failure on stderr must not carry the config's credential either.
    expect(
      occurrences(combined, PLANTED_CONFIG_CREDENTIAL),
      `the surfaced resolution failure republished the config's own bytes:\n${combined}`,
    ).toBe(0)
    expect(combined, `the fault was not reported by position:\n${combined}`)
      .toMatch(/line \d+, column \d+/)
    expect(combined, `the person was not told which file to open:\n${combined}`)
      .toContain('z5-poisoned.yaml')
  }, 180_000)

  // An argument-bearing commander action receives `(...args, options, command)`.

  it('`--config staging.yaml validate` validates STAGING.YAML — the flag is not ignored', () => {
    const configText = scaffoldWithShippedInit()
    // THE NON-DEFAULT NAME, AND NO DEFAULT FILE AT ALL. With `agent-qa.config.yaml` still present the
    // cell could pass on the defect: the fallback would find a valid config and report a real count.
    // Removing it makes the flag load-bearing.
    writeFileSync(join(root, 'staging.yaml'), configText)
    rmSync(join(root, CONFIG_FILE))
    writeFileUnder(join('tests', 'w1-added.yaml'), VALID_TEST)
    expect(existsSync(join(root, CONFIG_FILE)), 'the default config must be absent').toBe(false)

    const expected = discoveredFileCount()
    expect(expected, 'the scaffold plus the added member is a non-empty set').toBeGreaterThan(1)

    const { status, combined } = runShippedCli('--config', 'staging.yaml', 'validate')

    const reported = /All files valid \((\d+) file\(s\) checked\)/.exec(combined)
    expect(reported, `validate did not resolve the config the person named:\n${combined}`).not.toBeNull()
    expect(Number(reported?.[1]), `the validator attested over an empty set:\n${combined}`).toBe(expected)
    expect(status, `a valid project named by --config is a clean exit:\n${combined}`).toBe(0)
    // THE NAMING CLAUSE ON THE SUCCESS ARM TOO: the default filename must not appear anywhere in
    // what the person reads, because it is not a file this invocation has anything to do with.
    expect(
      occurrences(combined, CONFIG_FILE),
      `validate spoke about a file the person did not ask about:\n${combined}`,
    ).toBe(0)
  }, 180_000)

  it('a failure names the file the person ASKED ABOUT, never one they did not', () => {
    // The naming control: a missing `--config` file is reported by its own name, not the default.
    writeFileSync(join(root, 'README.md'), 'a project that was never initialized\n')

    const { status, combined } = runShippedCli('--config', 'missing.yaml', 'validate')

    expect(status, `an unresolvable config is a non-zero exit:\n${combined}`).toBe(1)
    expect(combined, `the failure did not name the file the person asked about:\n${combined}`)
      .toContain('missing.yaml')
    expect(
      occurrences(combined, CONFIG_FILE),
      `the failure named a file the person did not ask about:\n${combined}`,
    ).toBe(0)
  }, 120_000)

  it('a project with NO config refuses — the state the guard must reject, before and after', () => {
    // Without a case the guard rejects, every cell here sits inside the rule's own assumption.
    writeFileSync(join(root, 'README.md'), 'a project that was never initialized\n')

    const { status, combined } = runShippedCli('validate')

    expect(status, `a project with no config is a refusal:\n${combined}`).not.toBe(0)
    expect(combined, `the config read failure was not named:\n${combined}`)
      .toMatch(/Cannot read config file|Config file not found/)
    expect(combined, `no attestation is possible with no config:\n${combined}`)
      .not.toContain(SUCCESS_SENTENCE)
  }, 120_000)
})
