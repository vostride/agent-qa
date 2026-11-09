// A CLI-only edit: no MCP tool, chat directive or dashboard route enables a plugin.

import { basename, dirname, relative, resolve } from 'node:path'

import {
  compareSemverVersions,
  isNpmPackageName,
  NameSlugSchema,
  PluginEntrySchema,
  pluginsAddLine,
} from '@vostride/agent-qa-core'
import { printRunText } from '@vostride/agent-qa-core/run-text-output'
import {
  PLUGIN_MANIFEST_FIELD,
  PluginManifestSchema,
} from '@vostride/agent-qa-plugin-kit/protocol'
import { SUBSCRIPTION_AUTH_ENTRY_NAME } from '@vostride/agent-qa-schema'
import { Command, Option } from 'commander'
import pc from 'picocolors'
import { isMap, isScalar, isSeq, parseDocument, Scalar, YAMLSeq, type YAMLMap } from 'yaml'

import { CliRefusal, PromptCancelled } from '../composition/cli-refusal.js'
import { classifyInitPath, writeScaffoldFileAtomic } from './init-filesystem.js'
import { isInitRefusal } from './init-refusal.js'
import {
  declaredList,
  installOutputMask,
  runInstallStep,
  shownOutput,
  type InstallOutputMask,
} from './package-install.js'
import {
  declaredSpec,
  installedAgentQaVersion,
  isNonRegistrySpec,
  parsePackageJson,
  planPackageJson,
  readProjectPackageJson,
} from './package-json-plan.js'
import {
  commandLine,
  detectPackageManager,
  managerEnv,
  parsePackageView,
  plainInstall,
  resolveInstallCommand,
  runFromHere,
  viewCommand,
  wasCancelled,
  withResolvedYarnLine,
  type DetectedManager,
  type PackageManagerName,
} from './package-manager.js'
import {
  findProjectAgentQa,
  HANDED_OFF_ENV,
  runAsProjectAgentQa,
  type ProjectAgentQa,
} from './project-agent-qa.js'
import { projectHost, type ProjectHost } from './project-host.js'
import { projectRange, type ProjectRange } from './project-range.js'
import { SUBSCRIPTION_AUTH_PACKAGE } from './scaffold-content.js'

const DEFAULT_CONFIG = 'agent-qa.config.yaml'
const FIRST_PARTY_PREFIX = '@vostride/agent-qa-plugin-'
const PATH_ARGUMENT = /^[./~]|\\|^[A-Za-z]:/u
const PLUGIN_PACKAGE = /^agent-qa-plugin-(.+)$/u
const EXACT_SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u
const MANIFEST_POSITION = `${PLUGIN_MANIFEST_FIELD}.plugin`
const LOOKUP_OUTPUT_LINES = 20

const PATH_REFUSAL =
  'agent-qa plugins add takes an npm package name. Add a path plugin by hand: under plugins in ' +
  'agent-qa.config.yaml, write - name: <name> with path: <folder>.'

export interface PluginsAddDeps {
  host?: Partial<ProjectHost>
}

interface AddOptions {
  pm?: PackageManagerName
  name?: string
}

interface Requested {
  name: string
  version?: string
}

function refuse(line: string): never {
  throw new CliRefusal([pc.red(line)], 2)
}

function requestedPackage(argument: string): Requested {
  if (argument.startsWith('-')) {
    refuse(`${argument} is not an npm package name: it starts with a hyphen.`)
  }
  if (PATH_ARGUMENT.test(argument)) refuse(PATH_REFUSAL)
  const at = argument.lastIndexOf('@')
  const name = at > 0 ? argument.slice(0, at) : argument
  if (!isNpmPackageName(name)) refuse(`${argument} is not an npm package name.`)
  return at > 0 ? { name, version: argument.slice(at + 1) } : { name }
}

function isFirstParty(name: string): boolean {
  return name.startsWith(FIRST_PARTY_PREFIX) || name === SUBSCRIPTION_AUTH_PACKAGE
}

export function pluginEntryName(packageName: string): string {
  if (packageName === SUBSCRIPTION_AUTH_PACKAGE) return SUBSCRIPTION_AUTH_ENTRY_NAME
  if (packageName.startsWith(FIRST_PARTY_PREFIX)) {
    return packageName.slice(FIRST_PARTY_PREFIX.length)
  }
  const last = packageName.split('/').at(-1) ?? packageName
  return (PLUGIN_PACKAGE.exec(last)?.[1] ?? last)
    .toLowerCase()
    .replace(/[^a-z0-9.-]/gu, '-')
    .replace(/^[^a-z0-9]+/u, '')
}

function configPathOf(command: Command, host: ProjectHost): { given: string; path: string } {
  const given = command.optsWithGlobals<{ config?: string }>().config ?? DEFAULT_CONFIG
  const path = resolve(host.cwd, given)
  if (classifyInitPath(path) !== 'regular') {
    refuse(`No agent-qa config at ${given}. Run npx agent-qa init in the project's folder first.`)
  }
  return { given, path }
}

function firstPartyVersion(
  requested: Requested,
  version: string,
  config: { path: string; cwd: string },
): string {
  if (requested.version !== undefined && requested.version !== version) {
    refuse(
      `${requested.name} runs only at agent-qa's version, ${version}. ` +
        `Run ${pluginsAddLine(requested.name, config.path, config.cwd)}.`,
    )
  }
  return version
}

// The agent-qa the install leaves in place loads the plugin: the exact version package.json
// declares, else the installed copy, else this one when the project declares none.
function loadingAgentQaVersion(input: {
  found: { path: string; text: string | undefined }
  copy: ProjectAgentQa | undefined
  range: ProjectRange
  manager: DetectedManager
  requested: Requested
}): string {
  const { found, copy, range, manager, requested } = input
  const declared = declaredSpec(found.text, 'agent-qa')
  if (declared !== undefined && EXACT_SEMVER.test(declared)) return declared
  if (copy !== undefined) return copy.version
  if (declared === undefined) return installedAgentQaVersion()
  const plain = plainInstall(manager.name)
  const install = runFromHere(
    commandLine(plain.command, plain.args),
    dirname(found.path),
    range.start,
  )
  refuse(
    `${relative(range.start, found.path) || 'package.json'} declares agent-qa as ${declared}, ` +
      `and none is installed, so the version ${requested.name} must match is not known. ` +
      `Run ${install}, then run this again.`,
  )
}

export interface ConfigEdit {
  entryName: string
  content?: string
}

// parseDocument keeps the config's comments; an entry already declaring the package is kept.
export function configWithEntry(
  text: string,
  given: string,
  packageName: string,
  chosenName: string | undefined,
): ConfigEdit {
  const doc = parseDocument(text)
  if (doc.errors.length > 0) refuse(`${given} is not valid YAML: ${doc.errors[0]!.message}`)
  if (!isMap(doc.contents)) refuse(`${given} must hold a YAML mapping.`)
  const current = doc.get('plugins', true)
  const absent = current === undefined || (isScalar(current) && current.value === null)
  if (!absent && !isSeq(current)) refuse(`plugins in ${given} is not a list.`)
  const plugins = absent ? new YAMLSeq() : (current as YAMLSeq)

  const existing = plugins.items.find(
    (item): item is YAMLMap => isMap(item) && item.get('package') === packageName,
  )
  const existingName = existing?.get('name')
  if (typeof existingName === 'string') return { entryName: existingName }

  const entryName = chosenName ?? pluginEntryName(packageName)
  const declared = plugins.items.flatMap((item) => {
    const name = isMap(item) ? item.get('name') : undefined
    return typeof name === 'string' ? [name] : []
  })
  if (declared.includes(entryName)) {
    refuse(
      `plugins already has an entry named ${entryName}. plugins lists: ${declared.join(', ')}. ` +
        'Pass --name <another name>.',
    )
  }
  if (!NameSlugSchema.safeParse(entryName).success) {
    refuse(
      `${entryName} is not a plugins entry name: use lowercase letters, digits, hyphens and ` +
        'dots, starting with a letter or digit. Pass --name <name>.',
    )
  }
  const checked = PluginEntrySchema.safeParse({ name: entryName, package: packageName })
  if (!checked.success) {
    const issue = checked.error.issues[0]?.message
    refuse(`${packageName} gives the plugins entry ${entryName}, which is not valid: ${issue}`)
  }
  const entry = doc.createNode({ name: entryName, package: packageName }) as YAMLMap
  const packageNode = entry.get('package', true)
  if (isScalar(packageNode)) packageNode.type = Scalar.QUOTE_DOUBLE
  if (plugins.items.length === 0) plugins.flow = false
  plugins.items.push(entry)
  if (absent) doc.set('plugins', plugins)
  return { entryName, content: doc.toString() }
}

interface Lookup {
  host: ProjectHost
  range: ProjectRange
  packageDir: string
  manager: DetectedManager
  requested: Requested
  mask: InstallOutputMask
}

async function lookupFailed(input: Lookup, reason: string, output: string, ran: string) {
  const name = input.requested.name
  console.log(`✗ Could not look up ${name}: ${reason}`)
  const lines = await shownOutput(output, input.mask, LOOKUP_OUTPUT_LINES)
  if (lines.length > 0) {
    printRunText(lines.map((line) => `  ${line}`).join('\n'), undefined, { env: input.host.env })
  }
  console.log(`  Run: ${ran}`)
  return new CliRefusal([], 3)
}

// The manifest is checked from the lookup's answer, so a package that is no valid out-of-process
// plugin never reaches package.json, node_modules or the config.
async function thirdPartyVersion(input: Lookup): Promise<string> {
  const { host, range, packageDir, manager, requested } = input
  const spec = `${requested.name}@${requested.version ?? 'latest'}`
  const resolved = await resolveInstallCommand(manager, { ...host, cwd: packageDir })
  const view = viewCommand(resolved, withResolvedYarnLine(manager, resolved), spec)
  const ran = runFromHere(commandLine(view.command, view.args), packageDir, range.start)
  const result = await host.run(view.command, view.args, {
    cwd: packageDir,
    env: managerEnv(manager.name, resolved.via, host.env),
    stdio: 'capture',
  })
  if (wasCancelled(result)) throw new PromptCancelled()
  if (result.missing === true) {
    throw await lookupFailed(input, `${view.command} was not found`, '', ran)
  }
  if (result.code !== 0) {
    const reason =
      result.code === null
        ? `${manager.name} stopped on ${result.signal ?? 'an unknown signal'}`
        : `${manager.name} exited ${result.code}`
    throw await lookupFailed(input, reason, result.output, ran)
  }
  const answer = parsePackageView(result.output)
  const version = answer?.version
  if (answer === undefined || typeof version !== 'string' || !EXACT_SEMVER.test(version)) {
    const reason = `${manager.name} answered without an exact version`
    throw await lookupFailed(input, reason, result.output, ran)
  }

  const field = answer[PLUGIN_MANIFEST_FIELD]
  const declared =
    field !== null && typeof field === 'object' && !Array.isArray(field)
      ? (field as Record<string, unknown>).plugin
      : undefined
  const parsed = declared === undefined ? undefined : PluginManifestSchema.safeParse(declared)
  if (parsed === undefined || !parsed.success) {
    const issue =
      parsed === undefined
        ? `${MANIFEST_POSITION} is missing`
        : [MANIFEST_POSITION, ...(parsed.error.issues[0]?.path ?? []).map(String)].join('.')
    refuse(
      `${requested.name}@${version} has no valid agent-qa plugin manifest (${issue}); ` +
        'nothing was changed.',
    )
  }
  if (parsed.data.runs === 'in-process') {
    refuse(
      `${requested.name} asks to run inside agent-qa's process, which only first-party plugins ` +
        'may do; nothing was changed.',
    )
  }
  return version
}

// Another copy at this version or newer takes over. An older copy may predate plugins add, so this
// one adds the plugin, pinned to that copy's version.
async function ranAsProjectAgentQa(
  host: ProjectHost,
  range: ProjectRange,
  copy: ProjectAgentQa | undefined,
): Promise<boolean> {
  if ((host.env[HANDED_OFF_ENV] ?? '') !== '') return false
  if (copy === undefined) return false
  if (copy.realDir === (await host.io.realpath(host.runningPackageDir))) return false
  if ((compareSemverVersions(copy.version, installedAgentQaVersion()) ?? -1) < 0) return false
  const where = relative(range.start, copy.dir) || '.'
  const line = `Running the project's agent-qa ${copy.version} (${where}) for plugins add.`
  await runAsProjectAgentQa(copy, host, line)
  return true
}

async function addPlugin(
  argument: string,
  opts: AddOptions,
  command: Command,
  deps: PluginsAddDeps,
): Promise<void> {
  const host = projectHost(deps.host)
  const requested = requestedPackage(argument)
  const firstParty = isFirstParty(requested.name)
  if (!firstParty && requested.version !== undefined && !EXACT_SEMVER.test(requested.version)) {
    refuse(`Give an exact version, such as ${requested.name}@1.2.3, or none to install the latest.`)
  }
  const config = configPathOf(command, host)
  const range = await projectRange(dirname(config.path), host)
  const found = readProjectPackageJson(range, host.io)
  const fromDir = found.text === undefined ? range.start : dirname(found.path)
  const copy = await findProjectAgentQa(range, fromDir, host.io)
  if (await ranAsProjectAgentQa(host, range, copy)) return

  const edit = configWithEntry(
    host.io.readText(config.path) ?? '',
    config.given,
    requested.name,
    opts.name,
  )
  if (found.text !== undefined) parsePackageJson(found.path, found.text)
  const manager = detectPackageManager({
    range,
    env: host.env,
    io: host.io,
    ...(opts.pm === undefined ? {} : { flag: opts.pm }),
  })
  const pinned = firstParty
    ? firstPartyVersion(
        requested,
        loadingAgentQaVersion({ found, copy, range, manager, requested }),
        { path: config.path, cwd: host.cwd },
      )
    : undefined
  const where = relative(range.start, found.path) || 'package.json'
  const declared = declaredSpec(found.text, requested.name)
  // The lookup checks a registry version, so a source the project chose by hand stays a hand edit.
  if (!firstParty && declared !== undefined && isNonRegistrySpec(declared)) {
    const byHand =
      edit.content === undefined
        ? ''
        : ` Add the entry by hand: under plugins in ${config.given}, write - name: ` +
          `${edit.entryName} with package: "${requested.name}".`
    refuse(
      `${where} declares ${requested.name} as ${declared}, which plugins add cannot check; ` +
        `nothing was changed.${byHand}`,
    )
  }
  const mask = installOutputMask(config.path, host.io)
  const lookup = (wanted: Requested) =>
    thirdPartyVersion({
      host,
      range,
      packageDir: dirname(found.path),
      manager,
      requested: wanted,
      mask,
    })
  const plan = (version: string) =>
    planPackageJson({
      ...found,
      folderName: basename(range.start),
      dependencies: [{ name: requested.name, version }],
    })
  let version = pinned ?? (await lookup(requested))
  let packageJson = plan(version)
  // Never lowered: a newer exact pin of a bare third-party package is checked and kept.
  if (
    !firstParty &&
    packageJson.entries[0]?.outcome === 'newer' &&
    requested.version === undefined &&
    declared !== undefined &&
    EXACT_SEMVER.test(declared)
  ) {
    version = await lookup({ name: requested.name, version: declared })
    packageJson = plan(version)
  }
  const entry = packageJson.entries[0]!
  if (entry.outcome === 'newer') {
    const must = firstParty ? `agent-qa ${version}, the version it must match` : version
    refuse(
      `${where} declares ${requested.name} at ${entry.spec}, newer than ${must}; ` +
        'nothing was changed. Change that entry, then run this again.',
    )
  }
  if (packageJson.changed) {
    writeScaffoldFileAtomic({
      root: packageJson.root,
      path: packageJson.path,
      content: packageJson.content,
      force: packageJson.existed,
    })
  }
  const step = await runInstallStep({
    host,
    range,
    packageJson,
    manager,
    mode: 'run',
    mask,
  })
  if (step.outcome === 'failed') throw new CliRefusal([], 3)

  if (edit.content !== undefined) {
    writeScaffoldFileAtomic({
      root: dirname(config.path),
      path: config.path,
      content: edit.content,
      force: true,
    })
    printRunText(
      pc.green(`✓ Added the plugins entry ${edit.entryName} for ${declaredList([entry])}.`),
    )
  } else {
    const kept = `✓ The plugins entry ${edit.entryName} already declares`
    printRunText(pc.green(`${kept} ${declaredList([entry])}.`))
  }
  printRunText(`Next: npx agent-qa plugins describe ${edit.entryName}`)
}

export function createPluginsAddCommand(deps: PluginsAddDeps = {}): Command {
  const cmd = new Command('add')
    .description('Declare, install and enable a plugin package in the plugins entries')
    .argument('<package>', 'an npm package name, optionally with an exact version (pkg@1.2.3)')
    .addOption(
      new Option(
        '--pm <name>',
        'package manager to install with (default: detected from the project)',
      ).choices(['npm', 'pnpm', 'yarn', 'bun']),
    )
    .option('--name <name>', 'the plugins entry name (default: taken from the package name)')
    .action(async (argument: string, opts: AddOptions, command: Command) => {
      try {
        await addPlugin(argument, opts, command, deps)
      } catch (error) {
        if (isInitRefusal(error)) {
          throw new CliRefusal([pc.red((error as Error).message)], 2, { cause: error })
        }
        throw error
      }
    })

  // Commander has printed its own line; a usage error exits 2, and help returns to exit 0.
  cmd.exitOverride((error) => {
    if (error.exitCode !== 0) throw new CliRefusal([], 2, { cause: error })
  })

  return cmd
}
