// The ONE runtime read path for the committed capability catalog.
//
// ONE LOADER, FOUR CONSUMERS. `init --agent`, the chat `/` type-ahead, the starter prompts and the
// `explain` op all answer questions about what exists, and every one of them answers from these
// bytes through this function. A second read path — a `JSON.parse` spelled at a call site, a
// consumer that kept its own list — is the drift SC-1 exists to make impossible, and it would be
// invisible: both copies would be right on the day they were written.
//
// FAILS LOUD, NEVER EMPTY. A missing or unparseable artifact throws {@link
// CapabilityCatalogUnavailableError} carrying the regen instruction. The alternative — returning
// an empty catalog — is the worst possible failure for this artifact specifically: the `explain`
// op's abstention arm is CORRECT behaviour for an empty catalog, so a silently empty load
// would present a broken install as a well-behaved product that simply knows nothing.
//
// A PRODUCED EMPTY CATALOG IS VALID (edge XPLN-01/empty). Zero rows that came out of the producer
// and through this parser is a real state and loads as one; it is only the ABSENCE of the artifact
// that is an error. The two are different facts and the loader keeps them apart.
//
// THE RESOLUTION IS THE SKILLS WALK. `commands/skills.ts` already solved "find the package root
// from wherever this module was loaded" for a directory that ships beside `dist`, and the catalog
// ships the same way (`package.json` `files` carries `capability-catalog`). Walking rather than
// guessing from `process.cwd()` is what makes the loader work identically from the repo, from a
// global install and from `npx`.

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

/** The ONE writer. There is no test-runner update path to this artifact (397 D-07's discipline). */
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
