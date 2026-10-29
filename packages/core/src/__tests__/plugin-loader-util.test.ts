// Fixtures are built on disk: the messages turn on what `findPackageJson` finds walking up.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  PluginLoadFailedError,
  PluginNotInstalledError,
  PluginPackageManifestError,
  declarationKey,
  declarationLabel,
  importDeclaredPluginModule,
  resolveModuleSpecifier,
  resolvePackageImportFromBase,
} from '../plugin-loader-util.js'

let root: string

/**
 * A sentinel planted INSIDE the malformed manifest, owned by this fixture.
 *
 * A NEGATIVE ASSERTION IS ONLY WORTH ITS RED. This value and the fixture body below were CALIBRATED
 * against the pre-fix code: V8's `SyntaxError` quotes roughly a ten-character window around the
 * parse position, so a long sentinel is truncated in the excerpt and the negative grep passes on the
 * unfixed tree for the wrong reason — measuring the excerpt's width instead of the guard. Measured
 * pre-fix, this exact pair produced
 *
 *     Unexpected token 'S', ..."{ "main": SEKRET395 "... is not valid JSON
 *
 * with the sentinel WHOLE inside it. Keep them together: shortening the body or lengthening the
 * sentinel silently re-vacuums the cell.
 */
const MANIFEST_SENTINEL = 'SEKRET395'
const MALFORMED_MANIFEST = `{ "main": ${MANIFEST_SENTINEL} }`

/** Fixture-owned package names, unique enough that no real `node_modules` above tmp can supply one. */
const BROKEN_MANIFEST_PACKAGE = '@fixture-395-24/broken-manifest-pkg'
const INSTALLED_BUT_BROKEN_PACKAGE = '@fixture-395-24/installed-but-broken-pkg'
const GENUINELY_ABSENT_PACKAGE = '@fixture-395-24/never-installed-pkg'
const LEGIBILITY_PACKAGE = '@fixture-395-28/legibility-pkg'

function installPackage(name: string, manifestText: string): string {
  const dir = join(root, 'node_modules', ...name.split('/'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), manifestText)
  return dir
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'plugin-loader-util-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('an unreadable package manifest reports its POSITION, never its content', () => {
  it('a malformed node_modules package.json throws a typed error carrying zero of its bytes', () => {
    // MALFORMED, AND THE SENTINEL IS THE OFFENDING TOKEN ITSELF — see the calibration note above.
    installPackage(BROKEN_MANIFEST_PACKAGE, MALFORMED_MANIFEST)

    let thrown: unknown
    try {
      resolvePackageImportFromBase(BROKEN_MANIFEST_PACKAGE, root)
    } catch (err) {
      thrown = err
    }

    expect(thrown, 'an unreadable manifest must not resolve silently').toBeInstanceOf(
      PluginPackageManifestError,
    )
    const message = (thrown as Error).message
    // The message names the manifest by its package route, never by an absolute path.
    expect(message, `the fault did not say which manifest:\n${message}`).toContain(
      join('node_modules', ...BROKEN_MANIFEST_PACKAGE.split('/'), 'package.json'),
    )
    expect(
      occurrences(message, root),
      `the fault republished the person's filesystem:\n${message}`,
    ).toBe(0)
    expect(message).toContain('could not be read as JSON')
    // THE TYPED FIELD KEEPS THE ABSOLUTE PATH — the `declarationKey`/`declarationLabel` split, one
    // type over: internal identity stays absolute, the sentence a person reads does not.
    expect((thrown as PluginPackageManifestError).packageJsonPath).toBe(
      join(root, 'node_modules', ...BROKEN_MANIFEST_PACKAGE.split('/'), 'package.json'),
    )
    // None of the content on `.message`, `.stack` or `util.inspect`, the channels a person sees.
    expect(
      occurrences(message, MANIFEST_SENTINEL),
      `the fault republished the manifest's own bytes:\n${message}`,
    ).toBe(0)
    expect(occurrences(String((thrown as Error).stack ?? ''), MANIFEST_SENTINEL)).toBe(0)
    expect(occurrences(JSON.stringify(thrown, Object.getOwnPropertyNames(thrown)), MANIFEST_SENTINEL))
      .toBe(0)
  })

  it('a WELL-FORMED manifest still resolves — the guard fired zero times', () => {
    const dir = installPackage(BROKEN_MANIFEST_PACKAGE, '{ "name": "ok", "main": "./entry.js" }')
    writeFileSync(join(dir, 'entry.js'), 'export const ok = true\n')

    const resolved = resolvePackageImportFromBase(BROKEN_MANIFEST_PACKAGE, root)

    expect(resolved, 'a readable manifest must still resolve its export target').not.toBeNull()
    expect(resolved).toContain('entry.js')
  })
})

describe('an installed package that fails to load is not called missing', () => {
  it('installed-but-broken names the package and the underlying failure', async () => {
    // INSTALLED — the manifest is on disk and `findPackageJson` finds it — and BROKEN: the entry
    // file its `main` names was never written, so the import resolves to a file that is not there.
    installPackage(INSTALLED_BUT_BROKEN_PACKAGE, '{ "name": "broken", "main": "./missing-entry.js" }')

    let thrown: unknown
    try {
      await importDeclaredPluginModule({ package: INSTALLED_BUT_BROKEN_PACKAGE }, root, 'auth')
    } catch (err) {
      thrown = err
    }

    expect(thrown, 'a broken installed plugin must still be a failure').toBeInstanceOf(
      PluginLoadFailedError,
    )
    const message = (thrown as Error).message
    expect(message, `the failure did not name the package:\n${message}`)
      .toContain(INSTALLED_BUT_BROKEN_PACKAGE)
    expect(message, `the failure did not carry what actually went wrong:\n${message}`)
      .toContain('failed to load')
    // THE MISDIRECTION CLAUSE — the whole point of the type. Sending a person to install a package
    // they already have is worse than saying nothing: they run the install, nothing changes, and
    // they now distrust the message that was going to help them.
    expect(message, `the failure told them to install what they already have:\n${message}`)
      .not.toContain('is not installed')
    expect(message, `the failure told them to install what they already have:\n${message}`)
      .not.toContain('npm install')
    // ESM never emits the require-stack marker, so the check is on the absolute path itself.
    expect(
      occurrences(message, root),
      `the failure republished the person's filesystem:\n${message}`,
    ).toBe(0)
    // THE MEASURED ROAD IS THE ESM ROAD, and this measures it rather than asserting it. The loader
    // resolves a `file://` URL and hands it to `await import(...)`; importing that same specifier
    // here raises the ESM code, never the CJS one. Without this, the cell above could be read as a
    // CJS reproduction whose absence of an absolute path proves nothing about the road taken.
    const specifier = resolveModuleSpecifier({ package: INSTALLED_BUT_BROKEN_PACKAGE }, root)
    expect(specifier.startsWith('file:'), `not a module URL: ${specifier}`).toBe(true)
    let underlyingCode: unknown
    try {
      await import(specifier)
    } catch (err) {
      underlyingCode = (err as { code?: unknown }).code
    }
    expect(underlyingCode, 'the road under test is not the ESM road').toBe('ERR_MODULE_NOT_FOUND')
    // AND THE DIAGNOSIS SURVIVES THE STRIPPING: the entry file that is not there is still named,
    // relative to the project. A filter that deleted the underlying text would pass the line above.
    expect(message, `the failure no longer says what went wrong:\n${message}`)
      .toContain('missing-entry.js')
  })

  it('a genuinely absent package is still reported as not installed', async () => {
    let thrown: unknown
    try {
      await importDeclaredPluginModule({ package: GENUINELY_ABSENT_PACKAGE }, root, 'auth')
    } catch (err) {
      thrown = err
    }

    // Without a case the new branch rejects, deleting the error class would still pass.
    expect(thrown, 'an absent package must still be reported absent').toBeInstanceOf(
      PluginNotInstalledError,
    )
    const message = (thrown as Error).message
    expect(message).toContain(GENUINELY_ABSENT_PACKAGE)
    expect(message).toContain('is declared in agent-qa.config.yaml but is not installed')
    expect(message).toContain(`npm install ${GENUINELY_ABSENT_PACKAGE}`)
  })

  it('the stripping removes paths and leaves ordinary text alone', async () => {
    // Both directions on one message: the absolute path goes, `and/or` and a relative path survive.
    const dir = installPackage(LEGIBILITY_PACKAGE, '{ "name": "legibility", "main": "./index.js" }')
    const absolute = join(root, 'node_modules', 'somewhere', 'deep', 'inner.js')
    const underlying =
      `Loader failed for plugins/local-auth.js and/or ${absolute} while linking.`
    writeFileSync(
      join(dir, 'index.js'),
      `const e = new Error(${JSON.stringify(underlying)})\n`
      + `e.code = 'ERR_MODULE_NOT_FOUND'\n`
      + `throw e\n`,
    )

    let thrown: unknown
    try {
      await importDeclaredPluginModule({ package: LEGIBILITY_PACKAGE }, root, 'auth')
    } catch (err) {
      thrown = err
    }

    expect(thrown).toBeInstanceOf(PluginLoadFailedError)
    const message = (thrown as Error).message

    // DIRECTION ONE — the person's filesystem does not travel.
    expect(occurrences(message, root), `an absolute path survived:\n${message}`).toBe(0)
    // An unanchored path shape breaks both of these, which is what this control catches.
    expect(message, `a slash inside a word was mauled:\n${message}`).toContain('and/or')
    expect(message, `the person's own declared token was mauled:\n${message}`)
      .toContain('plugins/local-auth.js')
    // AND THE STRIPPED PATH IS STILL LOCATED, relative to the project, rather than erased.
    expect(message, `the fault lost its own diagnosis:\n${message}`)
      .toContain(join('node_modules', 'somewhere', 'deep', 'inner.js'))
    expect(message).toContain('while linking')
  })
})

describe('the install suggestion is a command only when the name is one', () => {
  it('a package string carrying shell metacharacters composes NO command line', () => {
    // NOT RCE, AND THE CELL DOES NOT PRETEND IT IS: the config is the person's own file and nothing
    // here executes anything. What it is, is a string from a DATA FILE arriving inside a command the
    // CLI tells a person to paste — and the schema behind that string is
    // `z.string().trim().min(1)`, which accepts every byte below.
    const hostile = 'evil; rm -rf ~ #'

    const message = new PluginNotInstalledError({ package: hostile }, 'auth').message

    expect(message, `a runnable command was composed from an unvalidated string:\n${message}`)
      .not.toContain('npm install')
    // THE REMEDY IS STILL THERE, stated rather than composed — a gate that swallowed the answer
    // would trade one bad message for another.
    expect(message, `the package was not named:\n${message}`).toContain(hostile)
    expect(message, `the person was left with no remedy:\n${message}`)
      .toContain('Install it with your package manager')
    expect(message).toContain('remove the plugins.auth entry that declares it')
  })

  it('an ordinary scoped name keeps the runnable example', () => {
    // An ordinary name keeps the runnable command; dropping it everywhere is the cheap wrong fix.
    const message = new PluginNotInstalledError(
      { package: '@vostride/agent-qa-subscription-auth' },
      'auth',
    ).message

    expect(message).toContain('npm install @vostride/agent-qa-subscription-auth')
  })

  it('the gate accepts npm\'s grammar and refuses what is not in it', () => {
    const composes = (name: string): boolean =>
      new PluginNotInstalledError({ package: name }, 'auth').message.includes('npm install')

    // Accepted: the shapes npm actually publishes.
    expect(composes('lodash')).toBe(true)
    expect(composes('@scope/name')).toBe(true)
    expect(composes('some.pkg_name-2~x')).toBe(true)
    // Refused: every byte class that could turn a suggestion into a second command.
    for (const hostile of ['a b', 'a;b', 'a&&b', 'a|b', 'a`b`', 'a$(b)', 'a\nb', '../../etc/passwd']) {
      expect(composes(hostile), `"${hostile}" must not be composed into a command line`).toBe(false)
    }
  })
})

describe('the map key and the person\'s name for a declaration are different strings', () => {
  it('a path declaration reads back relative to baseDir, while the key stays absolute', () => {
    const declaration = { path: 'plugins/local-auth.js' }

    // THE KEY KEEPS ITS JOB: absolute, so two relative routes to one file collide in the loaders'
    // dedup set, and prefixed, so a package cannot collide with a file.
    expect(declarationKey(declaration, root)).toBe(`path:${resolve(root, 'plugins/local-auth.js')}`)

    // THE LABEL IS WHAT A PERSON READS — the string out of their own config, with neither the
    // absolute route through their filesystem nor the internal discriminator.
    const label = declarationLabel(declaration, root)
    expect(label).toBe('plugins/local-auth.js')
    expect(label, 'the person-facing name carried the map key\'s prefix').not.toContain('path:')
    expect(label, 'the person-facing name carried an absolute path').not.toContain(root)
  })

  it('an absolute declaration under baseDir renders relative; one outside renders as declared', () => {
    const inside = join(root, 'plugins', 'inside.js')
    expect(declarationLabel({ path: inside }, root)).toBe(join('plugins', 'inside.js'))

    // A `../../..` chain is not more readable than the path the person typed, so a declaration
    // outside the project renders as declared.
    const outside = resolve(root, '..', 'elsewhere', 'outside.js')
    expect(declarationLabel({ path: outside }, root)).toBe(outside)
  })

  it('a package declaration labels as the bare package name', () => {
    expect(declarationLabel({ package: '@vostride/agent-qa-subscription-auth' }, root))
      .toBe('@vostride/agent-qa-subscription-auth')
  })
})
