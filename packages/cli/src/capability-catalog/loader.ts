// Fails loud on a missing artifact, because an empty catalog would pass for a working install.

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { CapabilityCatalogSchema, type CapabilityCatalog } from '@vostride/agent-qa-schema'

/** The directory the artifact ships in, beside `dist` — see `package.json`'s `files`. */
export const CAPABILITY_CATALOG_DIR_NAME = 'capability-catalog'

/**
 * The artifact's file name, spelled ONCE in the workspace.
 *
 * Everything else — the producer's `CATALOG_PATH`, the regen script's target, the failure messages
 * — reaches the file through this constant or through {@link resolveCapabilityCatalogPath}. A
 * second spelling is a second place a writer could open it.
 */
export const CAPABILITY_CATALOG_FILE_NAME = 'capability-catalog.json'

// The one writer; no test-runner update path reaches this artifact.
export const CATALOG_REGEN_SCRIPT = 'scripts/regen-capability-catalog.sh'

/**
 * What a person holding a broken catalog has to DO, in the imperative.
 *
 * Exported so the loader's error, the producer's failure messages and the artifact's own `$note`
 * are one string rather than three that agree until the script is renamed.
 */
export const CATALOG_REGEN_INSTRUCTION =
  `run ${CATALOG_REGEN_SCRIPT} --write from the agent-qa root `
  + 'and commit the capability catalog as a reviewed change'

/**
 * The artifact could not be read, and the message says what to do about it.
 *
 * A NAMED class rather than a bare `Error`: a caller has to be able to tell `this install is
 * incomplete` apart from `this query has no answer`, and a string match on a message is not a
 * distinction, it is a hope.
 *
 * (The backticks above are not stylistic. `packages/arch`'s dependency lint scans every line of
 * every source file for import specifiers, and a quoted phrase after the word "from" in a comment
 * reads to it as a package this file depends on. Measured: it did, the first time this file ran.)
 */
export class CapabilityCatalogUnavailableError extends Error {
  readonly path: string

  constructor(path: string, cause: string) {
    super(
      `the capability catalog at ${path} could not be loaded (${cause}) — `
      + `it is a generated artifact, so ${CATALOG_REGEN_INSTRUCTION}`,
    )
    this.name = 'CapabilityCatalogUnavailableError'
    this.path = path
  }
}

/**
 * The package root, by the `commands/skills.ts` walk.
 *
 * Duplicated rather than imported because `commands/skills.ts` keeps it private and exporting it
 * would widen a command module's surface for one caller; the walk is four lines and this comment
 * is the tie. If it ever grows a third caller it should be extracted, not spelled a third time.
 */
function findPackageRoot(startDir: string): string {
  let current = resolve(startDir)
  while (true) {
    const packagePath = join(current, 'package.json')
    if (existsSync(packagePath)) {
      try {
        const pkg = JSON.parse(readFileSync(packagePath, 'utf-8')) as { name?: string }
        if (pkg.name === 'agent-qa') return current
      } catch {
        // Keep walking; a malformed package file is publish validation's failure, not this walk's.
      }
    }
    const parent = dirname(current)
    if (parent === current) return resolve(startDir)
    current = parent
  }
}

/** Where the committed artifact lives, found rather than guessed from a working directory. */
export function resolveCapabilityCatalogPath(
  startDir: string = dirname(fileURLToPath(import.meta.url)),
): string {
  return join(findPackageRoot(startDir), CAPABILITY_CATALOG_DIR_NAME, CAPABILITY_CATALOG_FILE_NAME)
}

/**
 * The committed catalog, parsed through the schema DTOs.
 *
 * `overridePath` exists for PRODUCED FIXTURES only — the zero-row differential writes a catalog
 * through the same canonical recipe and loads it back through this same parser, so the fixture is
 * something the producer can actually produce rather than a literal somebody typed. No shipped
 * consumer passes it.
 */
export function loadCapabilityCatalog(overridePath?: string): CapabilityCatalog {
  const path = overridePath ?? resolveCapabilityCatalogPath()

  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    throw new CapabilityCatalogUnavailableError(
      path,
      error instanceof Error ? error.message : String(error),
    )
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new CapabilityCatalogUnavailableError(
      path,
      `the file is not JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  const result = CapabilityCatalogSchema.safeParse(parsed)
  if (!result.success) {
    throw new CapabilityCatalogUnavailableError(
      path,
      `the file does not match the catalog contract: ${result.error.message}`,
    )
  }
  return result.data
}
