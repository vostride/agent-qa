// Comments are stripped and every source file scanned, with planted acquisition forms as controls.

import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { RunsStartInputSchema } from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'

/** `packages/cli/src/__tests__` → one level up is the package's whole shipped source tree. */
const CLI_SRC = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The invocation core, read as TEXT from the sibling package.
 *
 * The census's non-vacuity witness in the other direction: it proves a `startRun` call still EXISTS
 * to be found, so "zero in the CLI" is a statement about where the call lives rather than about a
 * symbol that stopped being used. Read rather than imported — a census must not depend on the thing
 * it is counting being loadable.
 */
const CORE_SOURCE_PATH = join(
  CLI_SRC,
  '..', '..', 'agent-local', 'src', 'composition', 'run-invocation-core.ts',
)

/**
 * Drop block and line comments so a name that appears only in prose is never read as code.
 *
 * The `[^:]` guard keeps a protocol-relative URL from being mistaken for a line comment, which is
 * how this kind of stripper usually eats a file. (Same shape as the core's own hygiene census in
 * one stripper idiom for the phase, so a reader compares like with like.)
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

/**
 * Every shipped `.ts` file in this package.
 *
 * `__tests__` directories are excluded because a test naming `startRun` is a test ABOUT the symbol,
 * not a door that can start a run — this very file names it a dozen times. `.d.ts` is excluded as
 * generated. Nothing else is excluded, and the exclusion list is deliberately this short: every
 * additional filter is a place the complete set can quietly stop being complete.
 */
function shippedSourceFiles(root: string): string[] {
  const found: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === '__tests__' || entry.name === 'node_modules') continue
        walk(path)
        continue
      }
      if (!entry.name.endsWith('.ts')) continue
      if (entry.name.endsWith('.d.ts')) continue
      found.push(path)
    }
  }
  walk(root)
  return found
}

/** Does this source ACQUIRE the run shell's entry point, in any form? */
function acquiresStartRun(source: string): boolean {
  return /\bstartRun\b/.test(stripComments(source))
}

/**
 * The forms the symbol can arrive in. A census that only knew `startRun({` would be satisfied by a
 * door that aliased the import, called it through a namespace, or split the call across lines.
 */
const ACQUISITION_FORMS = [
  "import { startRun } from '@vostride/agent-qa-runner'",
  "const { startRun } = await import('@vostride/agent-qa-runner')",
  'const session = startRun({ runId })',
  'const session = runner.startRun(config)',
  'const session = startRun(\n  config,\n)',
  'export { startRun } from "@vostride/agent-qa-runner"',
] as const

// The files the call would live in, named so a walker that stops seeing them fails.
const REQUIRED_CENSUS_MEMBERS = [
  join('commands', 'run.ts'),
  join('composition', 'run-assembly.ts'),
] as const

describe('the predicate self-check — before any verdict about this package', () => {
  it('sees every acquisition form of the run shell entry point', () => {
    for (const form of ACQUISITION_FORMS) {
      expect(
        acquiresStartRun(form),
        `the scan cannot see \`${form}\` — every file would pass it vacuously`,
      ).toBe(true)
    }
  })

  it('does NOT see the symbol in prose — the case this package actually presents', () => {
    expect(acquiresStartRun('// the console reporter is attached at the startRun site\n')).toBe(false)
    expect(acquiresStartRun('/* both startRun sites call this helper (Pitfall 8) */\nconst x = 1\n')).toBe(false)
    // A comment on the same line as real code: the code survives, the prose does not.
    expect(acquiresStartRun("const x = 1 // startRun used to be here\n")).toBe(false)
    expect(stripComments("const x = 1 // startRun used to be here\n")).toContain('const x = 1')
  })

  it('does not eat code it should keep (the protocol-relative-URL trap)', () => {
    expect(stripComments("const url = 'https://example.com' // trailing\n")).toContain('https://example.com')
  })

  it('ranges the files the claim is about — the discovery self-check', () => {
    const scanned = shippedSourceFiles(CLI_SRC).map((path) => relative(CLI_SRC, path))

    // A floor, so an empty or near-empty walk cannot read as a clean package.
    expect(scanned.length).toBeGreaterThan(50)
    // …and the two named members, which is the assertion a floor cannot make: a walker rooted at
    // the wrong-but-existing directory could still return 50 files.
    for (const member of REQUIRED_CENSUS_MEMBERS) {
      expect(scanned, `the census is not ranging ${member}`).toContain(member)
    }
    // Every scanned path really is inside the package's source tree.
    for (const path of scanned) {
      expect(path.startsWith(`..${sep}`)).toBe(false)
    }
  })
})

describe('no file in the CLI package acquires startRun', () => {
  it('the complete set is empty — the core is the only way this door can begin a run', () => {
    const offenders = shippedSourceFiles(CLI_SRC)
      .filter((path) => acquiresStartRun(readFileSync(path, 'utf8')))
      .map((path) => relative(CLI_SRC, path))

    expect(
      offenders,
      'a CLI source file can begin a run without passing the run gate',
    ).toEqual([])
  })

  it('and the call it no longer holds is alive in the core, one line below the gate', () => {
    // The witness that "zero here" means "moved" rather than "deleted". Without this, a census over
    // a package that had stopped starting runs at all would look identical.
    const core = stripComments(readFileSync(CORE_SOURCE_PATH, 'utf8'))
    expect(core).toContain('startRun')
    expect(core.match(/\bstartRun\s*\(/g) ?? []).toHaveLength(1)
  })

  it('both of the door\'s paths reach it through the core, and through nothing else', () => {
    const runSource = stripComments(readFileSync(join(CLI_SRC, 'commands', 'run.ts'), 'utf8'))
    const driveSource = stripComments(
      readFileSync(join(CLI_SRC, 'composition', 'in-process-run-execution.ts'), 'utf8'),
    )
    // `run.ts` composes the core nowhere; the drive composes it once and both door paths reach it.
    expect(runSource.match(/createRunInvocationCore\(/g) ?? []).toHaveLength(0)
    expect(driveSource.match(/createRunInvocationCore\(/g) ?? []).toHaveLength(1)
    expect(runSource.match(/runInProcessCliRun as typeof RunInProcessCliRun\)\(/g) ?? []).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------------------------
// `--dry-run`, `--junit-output` and `--detach` are composed around the core by the `run` command
// and are not fields of `RunsStartInput`: the strict input refuses a caller naming any of them.
describe('the CLI-surface options are refused by the run-start input', () => {
  it.each(['junitOutput', 'detach', 'dryRun', 'trustSession'])(
    'a caller naming %s is REFUSED rather than silently ignored (the strict shape)',
    (option) => {
      const result = RunsStartInputSchema.safeParse({ [option]: true })
      expect(result.success).toBe(false)
    },
  )
})
