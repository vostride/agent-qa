// `agent-qa validate`'s own resolution posture, measured in the project the product scaffolds
// (395-21 · F-05).
//
// THE DEFECT THIS FILE IS THE ACCEPTANCE FOR. In a project created by the product's own
// `agent-qa init --platform web`, the generated config declares an OPTIONAL subscription-auth
// plugin. `resolveConfig` (cli/src/config.ts:278-324) loads auth plugins unless the caller opts
// out, `loadLLMAuthPlugins` (core/src/auth/plugin-loader.ts) resolves the declared package with a
// bare `require.resolve`, and in a fresh project that package is not installed yet — so resolution
// THROWS. `commands/validate.ts` caught that throw with a bare `catch {}`, left `workspace`
// undefined, and `validateProject` silently degraded: the bare road discovered NOTHING and the
// command reported
//
//     ✔ All files valid (0 file(s) checked)
//
// with exit 0. A validator that reports success while checking nothing is a FALSE GREEN in the
// person's hands — the verifier measured it (395-VERIFICATION · F-05), and it is also what put
// explicit-file `validate` onto F-01-R3a's unhardened arm, because an undefined workspace also
// drops the workspace-match gate.
//
// THE CLOSURE, IN TWO MOVES, BOTH IN `commands/validate.ts`:
//   1. resolution WITHOUT auth-plugin loading. A validator reads config VALUES; auth plugins are
//      execution machinery, and loading them cannot change which files exist or which schema
//      applies. An optional plugin's absence must not be able to blind the validator.
//   2. capture-and-surface instead of a bare swallow. The diagnostics themselves are still
//      deferred to `validateProject` (its config arm re-detects read/parse/schema faults — (Z2)
//      and (Z3) are the proof), but the caught failure's MESSAGE is now named on stderr and the
//      exit status is non-zero, and the success sentence is structurally unreachable from a failed
//      resolution.
//
// THE FIXTURE IS PRODUCED, NEVER A LITERAL — and here that is the whole finding, not a house rule
// applied by habit: the defect is that THE PRODUCT'S OWN SCAFFOLD breaks THE PRODUCT'S OWN
// VALIDATOR. A hand-written imitation of what init emits would measure this executor's idea of the
// scaffold. Every cell below runs the shipped `dist/cli.js init --platform web` and validates what
// it wrote.
//
// WHAT MAKES EACH CELL RED:
//
//  (Z1) the false green, killed — bare `validate` in an init-scaffolded project must CHECK FILES.
//       The count is pinned against the file set discovered off disk, not merely asserted
//       non-zero, and the second half of the cell proves SET MEMBERSHIP by poisoning one file and
//       reading its name back out of the report. A cell that only checked "no error printed"
//       would pass on the defect itself.
//  (Z2) loud on unresolvable — a config that is PRESENT and cannot be resolved is named on the
//       output, exits non-zero, and never reaches the success sentence. Zero occurrences of the
//       planted value: the surfaced line carries the thrown message and nothing of the file.
//  (Z4) the init-side member — the verbs that DO need the declared plugin (`run`, `devices list`)
//       answer with the package name and the install command instead of Node's require stack. Its
//       mechanism lives in core's plugin loaders, not in `validate.ts`, so it stays green under
//       this plan's own mutation leg.
//  (Z6) the amplifier road, closed — with resolution succeeding in the scaffolded project, the
//       workspace-match gate answers `validate hooks.yaml` again. That gate's absence is what put
//       the verifier onto the unhardened arm; its zero-occurrence clause is 395-18's closure and
//       holds on both sides of the leg.
//  (Z3) the no-config control — the precondition-guarded case, the state the new posture's guard
//       must REJECT. Measured before and after the fix: a genuine standalone project with no
//       config is a refusal today and stays one, and this plan introduces no successful
//       no-config validate state.
//  (Z5) the interaction cell — explicit-file `validate` of a poisoned PLAIN TEST yaml in
//       a project whose config does NOT resolve. That is the exact road the verifier drove and got
//       a hooks credential verbatim, pre-395-18. The F-01 class must stay closed where the
//       workspace-match gate is absent, and it must stay closed under this plan's own mutation
//       leg — its closure lives in core's formatter, not in `validate.ts`.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const CONFIG_FILE = 'agent-qa.config.yaml'

/**
 * The SHIPPED binary, resolved from this file's own location.
 *
 * `packages/cli/src/composition/__tests__` -> three levels up is `packages/cli`. Every cell drives
 * `dist/cli.js` in a real child process, because the false green this file is about is what a
 * PERSON sees on their terminal, and because a reading taken on a stale dist measures the previous
 * build (395-18 · §7.2 — that trap fired inside a plan written to respect it).
 */
const CLI_DIST = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'dist', 'cli.js')

/** The sentence F-05 is about: printed over an EMPTY set, it is a false attestation. */
const SUCCESS_SENTENCE = 'All files valid'

/**
 * The planted values, `sk-ant-`-shaped and OWNED BY THIS FIXTURE.
 *
 * One per file class, for the reason the 395-16/18 corpus keeps them distinct: when a whole-output
 * cell reds, the value says WHICH file leaked rather than only that something did.
 */
const PLANTED_CONFIG_CREDENTIAL = 'sk-ant-api03-395twentyoneCONFIGFIXTUREONLYnotarealkey'
const PLANTED_TEST_CREDENTIAL = 'sk-ant-api03-395twentyoneTESTFIXTUREONLYnotarealkey'
const PLANTED_HOOKS_CREDENTIAL = 'sk-ant-api03-395twentyoneHOOKSFIXTUREONLYnotarealkey'

/** The package the default scaffold declares and a fresh project has not installed. */
const SUBSCRIPTION_AUTH_PACKAGE = '@vostride/agent-qa-subscription-auth'

/** A canonical test id of this fixture's own, distinct from every id the scaffold writes. */
const FIXTURE_TEST_ID = 't_zebra-quartz-ledger-marble-signal-timber-violet-walnut-yellow-anchor'

/** A valid plain test yaml the scaffold's own `testMatch` finds — (Z1)'s added member. */
const VALID_TEST = `test-id: ${FIXTURE_TEST_ID}
name: the file this project's own validator must actually check
target: example-web
steps:
  - Verify the page says "Example Domain"
`

/**
 * A plain test yaml carrying the planted value on a DUPLICATED key — 395-18's adjacency idiom.
 *
 * The duplicate key IS the credential's own line, so a pretty-printing parser would put the value
 * on both of `formatYamlError`'s channels. (Z5) asserts it reaches neither.
 */
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
    // A FAILED `git` MUST NOT RETURN QUIETLY. `result.error` is set only when the
    // CHILD PROCESS COULD NOT BE SPAWNED; a `git commit` that ran and exited non-zero (nothing
    // staged, a hook refusing, a bad identity) came back through here indistinguishable from a
    // success, and every cell downstream then measured a fixture that was never built. In a suite
    // whose whole value is that its measurements are trustworthy, that is the most expensive kind
    // of silence — a GREEN that means nothing.
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

/** Every yaml the scaffold's own globs match, walked off disk — the SET (Z1) pins its count to. */
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

    // THE COUNT IS THE ASSERTION, not the absence of an error message. On pre-fix HEAD this
    // command printed `✔ All files valid (0 file(s) checked)` and exited 0 — a cell that only
    // asserted "no failure" would have passed on the defect itself.
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
    // THE INIT-SIDE MEMBER, DISPOSED AS A SOURCE FIX (395-21 · Task 2). Task 1 took validate off the
    // plugin road entirely, which is right for a validator and wrong as a general answer: `run` and
    // `devices list` genuinely need the plugin the scaffold declared, and in a fresh project they
    // met Node's own module-resolution stack — `Cannot find module ...` over a `Require stack:`
    // naming agent-qa.config.yaml as if a YAML file were a module. The failure stays a failure. What
    // it now says is the package and the one install command init itself had already printed.
    //
    // BOTH VERBS IN ONE CELL, deliberately: `run` reaches the loader through `resolveConfig`'s auth
    // road and `devices list` through its own, and a fix pinned on one of them is exactly how this
    // project has re-opened a class three rounds running.
    scaffoldWithShippedInit()

    for (const verb of [['run', 'tests/examples/komazon-checkout.yaml'], ['devices', 'list']]) {
      const { status, combined } = runShippedCli(...verb)

      expect(status, `a project missing its declared plugin must still fail (${verb.join(' ')}):\n${combined}`)
        .not.toBe(0)
      expect(combined, `the failure did not name the package (${verb.join(' ')}):\n${combined}`)
        .toContain(SUBSCRIPTION_AUTH_PACKAGE)
      expect(combined, `the failure did not name the remedy (${verb.join(' ')}):\n${combined}`)
        .toMatch(/npm install @vostride\/agent-qa-subscription-auth/)
      // THE TWO CLAUSES THAT WERE RED. Node's loader boilerplate is what the person used to get,
      // and a message that still carried it would mean the typed error had not replaced anything.
      expect(combined, `the failure still speaks Node's loader dialect (${verb.join(' ')}):\n${combined}`)
        .not.toContain('Require stack')
      expect(combined, `the failure still speaks Node's loader dialect (${verb.join(' ')}):\n${combined}`)
        .not.toContain('Cannot find module')
    }
  }, 180_000)

  it('the workspace-match gate is BACK in the init-scaffolded project — the amplifier road is closed', () => {
    // THE REACHABILITY AMPLIFIER, ON ITS OWN FILE. A swallowed resolution did two things, and only
    // one of them was the false green: it also left `workspace` undefined, which drops
    // `validateProject`'s workspace-match gate and sends `validate <any>.yaml` straight down the
    // explicit-file arm. That is how the verifier came to run `agent-qa validate hooks.yaml` in a
    // freshly-init'd project and get the hooks credential back verbatim, pre-395-18.
    //
    // `hooks.yaml` is the file the verifier drove and it is matched by NEITHER `testMatch` nor
    // `suiteMatch`, so with resolution succeeding the gate is what answers. The zero-occurrence
    // clause holds on both sides of leg M-Z1 and is not this plan's closure to claim — it is
    // 395-18's, measured here on the road where the gate is not backing it up.
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
    // THE ROAD THE VERIFIER ACTUALLY DROVE (395-VERIFICATION · CR-02's reachability paragraph).
    // When the config does not resolve, `workspace` is undefined and `validateProject` takes the
    // ungated explicit-file arm — no workspace-match refusal, straight into `validateTestFile` ->
    // `parseTestFile` -> `formatYamlError`. In that exact state the verifier ran
    // `agent-qa validate hooks.yaml` and got a credential back verbatim.
    //
    // THIS CELL IS WHY THIS PLAN DEPENDS ON 395-18, and it is deliberately measuring something this
    // plan did NOT fix: the closure lives in core's formatter, one layer below `validate.ts`. Leg
    // M-Z1 tears out this plan's own fix and (Z5) must stay green under it — that is the proof the
    // two mechanisms are independent rather than one entangled patch.
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
    // THE CONFIG'S VALUE TOO. This plan opened a NEW output channel on this exact road — the
    // captured resolution failure on stderr — and the config in this fixture carries a credential of
    // its own. A watchdog on the channel this plan added, on the road where it fires.
    expect(
      occurrences(combined, PLANTED_CONFIG_CREDENTIAL),
      `the surfaced resolution failure republished the config's own bytes:\n${combined}`,
    ).toBe(0)
    expect(combined, `the fault was not reported by position:\n${combined}`)
      .toMatch(/line \d+, column \d+/)
    expect(combined, `the person was not told which file to open:\n${combined}`)
      .toContain('z5-poisoned.yaml')
  }, 180_000)

  // THE FLAG THE PERSON TYPED, HONORED.
  //
  // `validate` is declared with an ARGUMENT (`[files...]`), and commander hands an argument-bearing
  // action `(…args, options, command)` — three parameters here, not two. `validate.ts:9` destructured
  // `(files, command)`, so the second binding was the OPTIONS OBJECT, `command.parent` was undefined,
  // and the config path fell all the way through to the `'agent-qa.config.yaml'` default. `--config`
  // was silently ignored on this road.
  //
  // AND ROUND 4 MADE IT WORSE IN PRACTICE, which is why this is measured on the shipped binary rather
  // than argued at source. Before 395-21 a swallowed resolution merely degraded quietly; now every
  // `--config` invocation fails LOUDLY, naming a file the person never mentioned. (W2) is that
  // half — the misnaming is its own defect and gets its own cell, because a fix that made
  // `--config` resolve while still reporting the default's name would pass (W1) alone.

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
    // THE NAMING CONTROL. Pre-fix this printed
    //   Cannot read config file: ENOENT: … open 'agent-qa.config.yaml'
    //   Config resolution failed: Config file not found: agent-qa.config.yaml
    // in a project where the person had typed `--config missing.yaml` — a report about a file that
    // was never part of the question.
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
    // THE PRECONDITION-GUARDED CONTROL (384 · round 4): without a case the new posture's guard
    // REJECTS, every cell here is drawn from inside the rule's own assumption. There is no
    // successful no-config validate state today and this plan introduces none.
    writeFileSync(join(root, 'README.md'), 'a project that was never initialized\n')

    const { status, combined } = runShippedCli('validate')

    expect(status, `a project with no config is a refusal:\n${combined}`).not.toBe(0)
    expect(combined, `the config read failure was not named:\n${combined}`)
      .toMatch(/Cannot read config file|Config file not found/)
    expect(combined, `no attestation is possible with no config:\n${combined}`)
      .not.toContain(SUCCESS_SENTENCE)
  }, 120_000)
})
