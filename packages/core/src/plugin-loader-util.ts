import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export type PluginDeclarationLike = {
  package?: string
  path?: string
}

// Inside `baseDir` renders relative; elsewhere a fixed placeholder, never a `../` chain.
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

// A separator starts a path only after a boundary, so `and/or` and a relative path survive.
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

// Position, never content: Node's JSON `SyntaxError` quotes the file, so it is not the `cause`.
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
    // Throw rather than return `null`, or a corrupt manifest falls through as not installed.
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

// A dedup key only; use `declarationLabel` for anything that reaches a message.
export function declarationKey(declaration: PluginDeclarationLike, baseDir: string): string {
  const packageName = packageDeclarationValue(declaration)
  if (packageName) return `package:${packageName}`
  return `path:${resolve(baseDir, pathDeclarationValue(declaration))}`
}

// What a person reads: the declaration as written, never the absolute key.
export function declarationLabel(declaration: PluginDeclarationLike, baseDir: string): string {
  const packageName = packageDeclarationValue(declaration)
  if (packageName) return packageName

  const declared = pathDeclarationValue(declaration)
  if (!isAbsolute(declared)) return declared
  const fromBase = relative(baseDir, declared)
  return fromBase === '' || fromBase.startsWith('..') ? declared : fromBase
}

export type PluginDeclarationKind = 'auth' | 'provider'

// The command is offered only for a real npm name, because a person runs what is suggested.
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
    // No `cause`: the wrapped error's require stack holds absolute paths `util.inspect` prints.
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

// Installed but unloadable; resolution codes also fire for a missing transitive dependency.
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

// First line only, then absolute paths stripped: ESM writes its paths into the first line.
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
