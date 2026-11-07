// A CLI-only edit: no MCP tool, chat directive or dashboard route enables a plugin.

import { basename, dirname, relative, resolve } from 'node:path'

import { isNpmPackageName, PluginEntrySchema } from '@vostride/agent-qa-core'
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
import { redactInstallOutput, runInstallStep } from './package-install.js'
import {
  installedAgentQaVersion,
  parsePackageJson,
  planPackageJson,
  readProjectPackageJson,
} from './package-json-plan.js'
import {
  commandLine,
  detectPackageManager,
  managerEnv,
  parsePackageView,
  resolveInstallCommand,
  runFromHere,
  viewCommand,
  wasCancelled,
  type DetectedManager,
  type PackageManagerName,
} from './package-manager.js'
import { findProjectAgentQa, HANDED_OFF_ENV, runAsProjectAgentQa } from './project-agent-qa.js'
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
}

interface Requested {
  name: string
  version?: string
}

function refuse(line: string): never {
  throw new CliRefusal([pc.red(line)], 2)
}

function requestedPackage(argument: string): Requested {
  if (PATH_ARGUMENT.test(argument)) refuse(PATH_REFUSAL)
  const at = argument.lastIndexOf('@')
  const name = at > 0 ? argument.slice(0, at) : argument
  if (!isNpmPackageName(name)) refuse(`${argument} is not an npm package name.`)
  return at > 0 ? { name, version: argument.slice(at + 1) } : { name }
}

function isFirstParty(name: string): boolean {
  return name.startsWith(FIRST_PARTY_PREFIX) || name === SUBSCRIPTION_AUTH_PACKAGE
}

function entryNameOf(name: string): string {
  if (name === SUBSCRIPTION_AUTH_PACKAGE) return SUBSCRIPTION_AUTH_ENTRY_NAME
  const last = name.split('/').at(-1) ?? name
  return PLUGIN_PACKAGE.exec(last)?.[1] ?? last
}

function configPathOf(command: Command, host: ProjectHost): { given: string; path: string } {
  const given = command.optsWithGlobals<{ config?: string }>().config ?? DEFAULT_CONFIG
  const path = resolve(host.cwd, given)
  if (classifyInitPath(path) !== 'regular') {
    refuse(`No agent-qa config at ${given}. Run npx agent-qa init in the project's folder first.`)
  }
  return { given, path }
}

function firstPartyVersion(requested: Requested): string {
  const version = installedAgentQaVersion()
  if (requested.version !== undefined && requested.version !== version) {
    refuse(
      `${requested.name} runs only at agent-qa's version, ${version}. ` +
        `Run npx agent-qa plugins add ${requested.name}.`,
    )
  }
  return version
}

interface ConfigEdit {
  entryName: string
  content?: string
}

// parseDocument keeps the config's comments; an entry already declaring the package is kept.
function configWithEntry(text: string, given: string, packageName: string): ConfigEdit {
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

  const entryName = entryNameOf(packageName)
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

async function maskWith(configPath: string, text: string): Promise<string> {
  try {
    const secrets = await import('../composition/declared-secrets.js')
    return secrets.createDeclaredSecretMask(configPath).mask(text)
  } catch {
    return text
  }
}

interface Lookup {
  host: ProjectHost
  range: ProjectRange
  packageDir: string
  manager: DetectedManager
  requested: Requested
  mask: (text: string) => Promise<string>
}

async function lookupFailed(input: Lookup, reason: string, output: string, ran: string) {
  const name = input.requested.name
  console.log(`✗ Could not look up ${name}: ${reason}`)
  const lines = redactInstallOutput(await input.mask(output))
    .split(/\r?\n/u)
    .filter((line) => line.trim() !== '')
    .slice(-LOOKUP_OUTPUT_LINES)
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
  const view = viewCommand(resolved, manager, spec)
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

// Decided by real path, never by version, so a first-party pin always equals the agent-qa that
// will load it.
async function ranAsProjectAgentQa(
  host: ProjectHost,
  range: ProjectRange,
  found: { path: string; text: string | undefined },
): Promise<boolean> {
  if ((host.env[HANDED_OFF_ENV] ?? '') !== '') return false
  const fromDir = found.text === undefined ? range.start : dirname(found.path)
  const copy = await findProjectAgentQa(range, fromDir, host.io)
  if (copy === undefined) return false
  if (copy.realDir === (await host.io.realpath(host.runningPackageDir))) return false
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
  if (await ranAsProjectAgentQa(host, range, found)) return

  const pinned = firstParty ? firstPartyVersion(requested) : undefined
  const edit = configWithEntry(host.io.readText(config.path) ?? '', config.given, requested.name)
  if (found.text !== undefined) parsePackageJson(found.path, found.text)
  const manager = detectPackageManager({
    range,
    env: host.env,
    io: host.io,
    ...(opts.pm === undefined ? {} : { flag: opts.pm }),
  })
  const mask = (text: string) => maskWith(config.path, text)
  const version =
    pinned ??
    (await thirdPartyVersion({
      host,
      range,
      packageDir: dirname(found.path),
      manager,
      requested,
      mask,
    }))

  const packageJson = planPackageJson({
    ...found,
    folderName: basename(range.start),
    dependencies: [{ name: requested.name, version }],
  })
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
      pc.green(`✓ Added the plugins entry ${edit.entryName} for ${requested.name} ${version}.`),
    )
  } else {
    const kept = `✓ The plugins entry ${edit.entryName} already declares ${requested.name}`
    printRunText(pc.green(`${kept} ${version}.`))
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
