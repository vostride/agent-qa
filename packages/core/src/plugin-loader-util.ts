import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export type PluginDeclarationLike = {
  package?: string
  path?: string
}

/**
 * One filesystem path, rendered as the string a PERSON reads.
 *
 * `declarationLabel` below makes this disposition for a path the loader COMPOSED from the person's
 * own config. This is the same disposition for a path the loader merely FOUND — a manifest location,
 * or a path inside text Node's loader wrote. Inside `baseDir` it renders relative, because that is
 * the route the person recognizes from their own project; anywhere else it renders as a fixed
 * placeholder, because a `../../../..` chain out of the project is neither shorter nor safer than
 * the absolute path it replaces.
 */
function personFacingPath(candidate: string, baseDir: string): string {
  let raw = candidate
  if (raw.startsWith('file://')) {
    try {
      raw = fileURLToPath(raw)
    } catch {
      return '<path>'
    }
  }
  const fromBase = relative(baseDir, raw)
  if (fromBase === '' || fromBase.startsWith('..') || isAbsolute(fromBase)) return '<path>'
  return fromBase
}

/**
 * An absolute path INSIDE prose, anchored so a slash in a word is not one.
 *
 * WHY ANCHORED. The obvious shape — "any run of non-space characters containing a separator" —
 * strips `and/or` and the person's own declared `plugins/local-auth.js` right along with the paths,
 * and a failure message that has lost its own diagnosis is a different defect from the one being
 * closed, not a fix for it. So a separator counts as the START of a path only when a boundary comes
 * first: the start of the string, whitespace, a quote, or an opening bracket. The `file://` form is
 * matched too, because that is the form Node's ESM loader quotes.
 *
 * The boundary is CAPTURED rather than looked behind, so adjacent paths separated by one space each
 * keep their own boundary available to the next match.
 */
const ABSOLUTE_PATH_IN_TEXT = /(^|[\s'"`([<])((?:file:\/\/)?(?:[A-Za-z]:)?[\\/][^\s'"`)\]>]*)/g

function stripAbsolutePaths(text: string, baseDir: string): string {
  return text.replace(
    ABSOLUTE_PATH_IN_TEXT,
    (_match, boundary: string, candidate: string) =>
      `${boundary}${personFacingPath(candidate, baseDir)}`,
  )
}

export function findPackageJson(packageName: string, baseDir: string): string | null {
  let current = resolve(baseDir)
  while (true) {
    const candidate = resolve(current, 'node_modules', ...packageName.split('/'), 'package.json')
    if (existsSync(candidate)) return candidate

    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
}

export function exportTargetFromPackageJson(pkg: Record<string, unknown>): string | null {
  const exportsField = pkg.exports
  if (typeof exportsField === 'string') return exportsField
  if (exportsField && typeof exportsField === 'object') {
    const rootExport = (exportsField as Record<string, unknown>)['.'] ?? exportsField
    if (typeof rootExport === 'string') return rootExport
    if (rootExport && typeof rootExport === 'object') {
      const conditions = rootExport as Record<string, unknown>
      if (typeof conditions.import === 'string') return conditions.import
      if (typeof conditions.default === 'string') return conditions.default
      if (typeof conditions.require === 'string') return conditions.require
    }
  }
  if (typeof pkg.module === 'string') return pkg.module
  if (typeof pkg.main === 'string') return pkg.main
  return null
}

/**
 * A third party's `package.json` this resolver could not read as JSON.
 *
 * POSITION, NEVER CONTENT — the F-01 discipline, on a JSON channel. The unguarded
 * `JSON.parse(readFileSync(...))` below threw Node's own `SyntaxError`, and that error's text quotes
 * a FRAGMENT OF THE FILE back (`Unexpected token ... in JSON at position N`, and on newer V8 an
 * excerpt of the offending line). The bytes belong to a package in `node_modules`, not to the
 * person's own committed file, which is why the verifier filed it a warning rather than an F-01
 * member — but it is the same mechanism, and this file is where the phase put the one producer.
 *
 * NO `cause`, for `PluginNotInstalledError`'s reason: an `Error` carrying a `cause` is serialized by
 * `util.inspect` on roads this project has already been burned by, and the cause here is exactly the
 * `SyntaxError` whose bytes must not travel.
 *
 * POSITION IS NOT THE SAME AS AN ABSOLUTE PATH (395-28 · CR-03, secondary). `findPackageJson`
 * returns an absolute path, and the sentence used to interpolate it straight — handing the person a
 * route through their own filesystem to say something a project-relative route says just as well.
 * The `declarationKey`/`declarationLabel` split applies one type over: the TYPED FIELD keeps the
 * absolute path, because callers use it to open the file, and the SENTENCE renders through
 * `personFacingPath`, because that is what a person reads.
 */
export class PluginPackageManifestError extends Error {
  readonly packageJsonPath: string

  constructor(packageJsonPath: string, baseDir: string) {
    super(
      `Plugin package manifest ${personFacingPath(packageJsonPath, baseDir)} could not be read `
      + `as JSON.`,
    )
    this.name = 'PluginPackageManifestError'
    this.packageJsonPath = packageJsonPath
  }
}

export function resolvePackageImportFromBase(packageName: string, baseDir: string): string | null {
  const packageJsonPath = findPackageJson(packageName, baseDir)
  if (!packageJsonPath) return null

  let pkg: Record<string, unknown>
  try {
    pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as Record<string, unknown>
  } catch {
    // THROW, RATHER THAN RETURN null. `null` here means "no export target found, try the loader's
    // own resolution" — a legitimate outcome for a package whose manifest parsed fine. Returning it
    // for an UNREADABLE manifest would send an installed-but-corrupt package down the
    // `require.resolve` fallback and out as "not installed", which is WR-05's misnaming reached
    // from a second direction.
    throw new PluginPackageManifestError(packageJsonPath, baseDir)
  }
  const target = exportTargetFromPackageJson(pkg)
  if (!target || !target.startsWith('.')) return null
  return pathToFileURL(resolve(dirname(packageJsonPath), target)).href
}

export function packageDeclarationValue(declaration: PluginDeclarationLike): string {
  return typeof declaration.package === 'string' ? declaration.package.trim() : ''
}

export function pathDeclarationValue(declaration: PluginDeclarationLike): string {
  return typeof declaration.path === 'string' ? declaration.path.trim() : ''
}

/**
 * The INTERNAL identity of a declaration — a dedup map key, and nothing a person reads.
 *
 * The absolute path and the `package:`/`path:` discriminator prefix are both correct HERE: two
 * declarations naming the same file by different relative routes must collide in
 * `loadedDeclarations`, and a package named `foo` must not collide with a file named `foo`. Use
 * `declarationLabel` for anything that reaches a message.
 */
export function declarationKey(declaration: PluginDeclarationLike, baseDir: string): string {
  const packageName = packageDeclarationValue(declaration)
  if (packageName) return `package:${packageName}`
  return `path:${resolve(baseDir, pathDeclarationValue(declaration))}`
}

/**
 * The PERSON-FACING name of a declaration.
 *
 * `declarationKey`'s value was being interpolated straight into the loaders' own error sentences —
 * `Auth plugin "path:/Users/someone/work/app/plugins/thing.js" must export …` — which hands a person
 * an absolute path out of their own filesystem and an internal discriminator prefix that means
 * nothing to them. `PluginNotInstalledError` already names declarations correctly (it composes from
 * the DECLARATION, which is the person's own one-line config entry); this brings its neighbours to
 * the same discipline while leaving the map key alone, because the map key's absoluteness is its job.
 *
 * A path OUTSIDE `baseDir` renders as declared rather than as a `../../..` chain — the point is a
 * string the person recognizes from their config, not a shorter one.
 */
export function declarationLabel(declaration: PluginDeclarationLike, baseDir: string): string {
  const packageName = packageDeclarationValue(declaration)
  if (packageName) return packageName

  const declared = pathDeclarationValue(declaration)
  if (!isAbsolute(declared)) return declared
  const fromBase = relative(baseDir, declared)
  return fromBase === '' || fromBase.startsWith('..') ? declared : fromBase
}

export type PluginDeclarationKind = 'auth' | 'provider'

/**
 * A plugin the project's own config DECLARES and the project does not have (395-21 · F-05).
 *
 * THE MEASUREMENT THAT PRODUCED THIS TYPE. `agent-qa init --platform web` — the default,
 * non-interactive road — writes `plugins.auth: [{ package: "@vostride/agent-qa-subscription-auth" }]`
 * and a `package.json` naming that package, then tells the person to fetch it. Until they do, every
 * verb that resolves the config with plugin loading enabled dies on a bare `require.resolve`:
 *
 *     Framework error: Cannot find module '@vostride/agent-qa-subscription-auth'
 *     Require stack:
 *     - /path/to/agent-qa.config.yaml
 *
 * That is Node's loader talking about its own internals — a "Require stack" naming a YAML file as
 * if it were a module — to a person whose actual next step is one install command that init itself
 * had already printed. The failure is real and must stay a failure; what changes is that it names
 * the package and the remedy instead of an import stack.
 *
 * ONE PRODUCER, BOTH MEMBERS. `loadLLMAuthPlugins` and `loadProviderPlugins` carried the identical
 * bare resolve-and-import, and this project's recurring failure mode is a guard placed on the member
 * a verifier happened to find while its sibling stays open (388/390/392/395-18). Both go through
 * `importDeclaredPluginModule` below.
 */
/**
 * The npm package-name charset, anchored.
 *
 * WHY A GATE AT ALL. The sentence below composes the declaration's `package` string into
 * `npm install <that string>` — a COMMAND LINE THE CLI TELLS A PERSON TO RUN — and the schema behind
 * that string is `z.string().trim().min(1)` with no charset restriction whatsoever. It is not RCE:
 * the config is the person's own file, and nothing here executes anything. It is a channel round 4
 * created in which a string from a data file becomes a runnable command, and a person who pastes a
 * suggested command rarely re-reads it. So the runnable form is offered only for a name that
 * actually IS an npm name, and every other declaration gets the same remedy stated as prose.
 *
 * RETUNE NOTE. This is npm's own published name grammar as of 2026-08: optional `@scope/` prefix,
 * then lowercase letters, digits, and `-._~`. It deliberately does NOT accept uppercase (npm has
 * rejected uppercase in new names since 2017) — a legacy uppercase package still gets a correct
 * message, just without the composed command. If a future registry widens the grammar, widen THIS
 * constant; do not add a second check beside the producer.
 */
const NPM_PACKAGE_NAME = /^(?:@[a-z0-9-._~]+\/)?[a-z0-9-._~]+$/

export class PluginNotInstalledError extends Error {
  readonly pluginKind: PluginDeclarationKind
  readonly pluginPackage: string | null
  readonly pluginPath: string | null

  constructor(declaration: PluginDeclarationLike, kind: PluginDeclarationKind) {
    const label = kind === 'auth' ? 'Auth' : 'Provider'
    const packageName = packageDeclarationValue(declaration)
    const pluginPath = pathDeclarationValue(declaration)
    const remedy = NPM_PACKAGE_NAME.test(packageName)
      ? `Install it with your package manager (for example: npm install ${packageName}), or remove `
        + `the plugins.${kind} entry that declares it.`
      : `Install it with your package manager, or remove the plugins.${kind} entry that declares it.`
    // NO `cause`, EVER (395-16 · D-395-16-A). The wrapped error carries a require stack of absolute
    // paths, and an `Error` with a `cause` is serialized by `util.inspect` on the roads this project
    // has already been burned by. The remedy is composed from the DECLARATION, which is the
    // person's own one-line config entry, and from nothing the loader saw.
    super(
      packageName
        ? `${label} plugin package "${packageName}" is declared in agent-qa.config.yaml but is not `
          + `installed. ${remedy}`
        : `${label} plugin file "${pluginPath}" is declared in agent-qa.config.yaml but could not be `
          + `loaded. Check that the path is correct and the file exists, or remove the `
          + `plugins.${kind} entry that declares it.`,
    )
    this.name = 'PluginNotInstalledError'
    this.pluginKind = kind
    this.pluginPackage = packageName === '' ? null : packageName
    this.pluginPath = pluginPath === '' ? null : pluginPath
  }
}

function isModuleResolutionFailure(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code
  return code === 'MODULE_NOT_FOUND' || code === 'ERR_MODULE_NOT_FOUND'
}

/**
 * A plugin package that IS installed and could not be loaded.
 *
 * THE MISNAMING THIS TYPE ENDS. `isModuleResolutionFailure` answers `MODULE_NOT_FOUND` /
 * `ERR_MODULE_NOT_FOUND`, and Node raises those codes for a resolution failure ANYWHERE in the
 * import graph — including inside the plugin's own body, when the plugin's own transitive dependency
 * is missing or its `exports` target points at a file that is not there. The doc comment above the
 * importer claimed only the plugin's own RUNTIME throws pass through untouched, and that was true of
 * runtime throws and false of resolution failures one level down. The consequence a person met was
 * `… is declared in agent-qa.config.yaml but is not installed. Install it with npm install <pkg>` —
 * for a package sitting in their `node_modules` right then. They install what they already have,
 * nothing changes, and the message has actively misdirected them.
 *
 * The distinguishing fact is not the error's code but the FILESYSTEM: `findPackageJson` either
 * located the package under a `node_modules` on the way up from `baseDir`, or it did not.
 *
 * The underlying failure travels as TEXT, not as `cause`, for `PluginNotInstalledError`'s reason.
 */
export class PluginLoadFailedError extends Error {
  readonly pluginKind: PluginDeclarationKind
  readonly pluginPackage: string

  constructor(packageName: string, kind: PluginDeclarationKind, underlying: string) {
    const label = kind === 'auth' ? 'Auth' : 'Provider'
    super(
      `${label} plugin package "${packageName}" is installed but failed to load: ${underlying}. `
      + `This is a fault in the plugin or in its own dependencies, not a missing install.`,
    )
    this.name = 'PluginLoadFailedError'
    this.pluginKind = kind
    this.pluginPackage = packageName
  }
}

/**
 * The underlying failure's FIRST LINE, with the person's filesystem taken out of it.
 *
 * THE FIRST-LINE REDUCTION IS TRUE OF CJS AND INSUFFICIENT. CJS `MODULE_NOT_FOUND` puts its
 * `Require stack:` — a list of absolute paths out of the person's own filesystem — inside `.message`
 * itself, not only on `.stack`, and dropping every line after the first removes that list. The first
 * line is also the diagnostically useful part: it names the specifier that could not be resolved,
 * which is what a person needs to know which dependency their plugin is missing. Both of those
 * remain true. What was false was the implied converse — that the first line is therefore CLEAN.
 *
 * THE DIALECT THIS FILE ACTUALLY USES SAYS OTHERWISE. `importDeclaredPluginModule`
 * calls `await import(...)`, so the ESM loader is the only loader it reaches, and ESM writes its
 * paths INTO the first line rather than under it. Measured on Node v24.10.0:
 *
 *     Cannot find module 'file:///abs/path/node_modules/@f/p/missing-entry.js' imported from
 *     /abs/path/packages/core/src/plugin-loader-util.ts
 *
 * — two absolute paths, on one line, out of the person's filesystem. So the reduction is kept and a
 * SECOND, dialect-independent step is added: strip the absolute paths from whatever survives. That
 * covers CJS's remaining `Require stack` entries if a first line ever carries one, and it covers the
 * ESM form this file takes every time. `resolutionFailureFor` already holds `baseDir`; nothing new
 * is plumbed to reach it.
 *
 * `instanceof Error` rather than a cast, for validate.ts's reason: a thrown non-Error must
 * still produce a string.
 */
function messageOf(err: unknown, baseDir: string): string {
  const text = err instanceof Error ? err.message : String(err)
  return stripAbsolutePaths(text.split('\n', 1)[0] ?? '', baseDir)
}

/**
 * Translate a module-resolution failure into the error that names what is actually wrong.
 *
 * A PATH declaration keeps `PluginNotInstalledError` — its sentence is already about a file that
 * could not be loaded and says to check the path, which is the right thing to say either way.
 */
function resolutionFailureFor(
  declaration: PluginDeclarationLike,
  baseDir: string,
  kind: PluginDeclarationKind,
  err: unknown,
): Error {
  const packageName = packageDeclarationValue(declaration)
  if (packageName && findPackageJson(packageName, baseDir) !== null) {
    return new PluginLoadFailedError(packageName, kind, messageOf(err, baseDir))
  }
  return new PluginNotInstalledError(declaration, kind)
}

/**
 * Resolve and import one declared plugin, answering the person when the module is not there.
 *
 * ONLY module-resolution failures are translated, and only for a package the filesystem says is
 * ABSENT. A plugin that IS installed rethrows as `PluginLoadFailedError` (resolution fault inside
 * its own graph) or untouched (its own runtime throw) — disguising either as "not installed" would
 * send the person to install something they already have.
 */
export async function importDeclaredPluginModule<T>(
  declaration: PluginDeclarationLike,
  baseDir: string,
  kind: PluginDeclarationKind,
): Promise<T> {
  let specifier: string
  try {
    specifier = resolveModuleSpecifier(declaration, baseDir)
  } catch (err) {
    if (isModuleResolutionFailure(err)) throw resolutionFailureFor(declaration, baseDir, kind, err)
    throw err
  }

  try {
    return await import(specifier) as T
  } catch (err) {
    if (isModuleResolutionFailure(err)) throw resolutionFailureFor(declaration, baseDir, kind, err)
    throw err
  }
}

export function resolveModuleSpecifier(declaration: PluginDeclarationLike, baseDir: string): string {
  const packageName = packageDeclarationValue(declaration)
  if (packageName) {
    const packageImport = resolvePackageImportFromBase(packageName, baseDir)
    if (packageImport) return packageImport

    const parentUrl = pathToFileURL(resolve(baseDir, 'agent-qa.config.yaml')).href
    try {
      const resolveImport = import.meta.resolve as (specifier: string, parent?: string) => string
      return resolveImport(packageName, parentUrl)
    } catch {
      const require = createRequire(resolve(baseDir, 'agent-qa.config.yaml'))
      return pathToFileURL(require.resolve(packageName)).href
    }
  }

  const pluginPath = pathDeclarationValue(declaration)
  const absolutePath = isAbsolute(pluginPath)
    ? pluginPath
    : resolve(baseDir, pluginPath)
  return pathToFileURL(absolutePath).href
}
