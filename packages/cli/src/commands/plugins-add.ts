// A CLI-only edit: no MCP tool, chat directive or dashboard route enables a plugin.

import { basename, dirname, resolve } from 'node:path'

import { isNpmPackageName, PluginEntrySchema } from '@vostride/agent-qa-core'
import { printRunText } from '@vostride/agent-qa-core/run-text-output'
import { SUBSCRIPTION_AUTH_ENTRY_NAME } from '@vostride/agent-qa-schema'
import { Command, Option } from 'commander'
import pc from 'picocolors'
import { isMap, isScalar, isSeq, parseDocument, Scalar, YAMLSeq, type YAMLMap } from 'yaml'

import { CliRefusal } from '../composition/cli-refusal.js'
import { classifyInitPath, writeScaffoldFileAtomic } from './init-filesystem.js'
import { isInitRefusal } from './init-refusal.js'
import { runInstallStep } from './package-install.js'
import {
  installedAgentQaVersion,
  planPackageJson,
  readProjectPackageJson,
} from './package-json-plan.js'
import { detectPackageManager, type PackageManagerName } from './package-manager.js'
import { projectHost, type ProjectHost } from './project-host.js'
import { projectRange } from './project-range.js'
import { SUBSCRIPTION_AUTH_PACKAGE } from './scaffold-content.js'

const DEFAULT_CONFIG = 'agent-qa.config.yaml'
const FIRST_PARTY_PREFIX = '@vostride/agent-qa-plugin-'
const PATH_ARGUMENT = /^[./~]|\\|^[A-Za-z]:/u
const PLUGIN_PACKAGE = /^agent-qa-plugin-(.+)$/u

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

async function addPlugin(
  argument: string,
  opts: AddOptions,
  command: Command,
  deps: PluginsAddDeps,
): Promise<void> {
  const host = projectHost(deps.host)
  const requested = requestedPackage(argument)
  if (!isFirstParty(requested.name)) {
    refuse(`${requested.name} is not a first-party plugin.`)
  }
  const version = firstPartyVersion(requested)
  const config = configPathOf(command, host)
  const edit = configWithEntry(host.io.readText(config.path) ?? '', config.given, requested.name)

  const range = await projectRange(dirname(config.path), host)
  const packageJson = planPackageJson({
    ...readProjectPackageJson(range, host.io),
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
  const manager = detectPackageManager({
    range,
    env: host.env,
    io: host.io,
    ...(opts.pm === undefined ? {} : { flag: opts.pm }),
  })
  const step = await runInstallStep({
    host,
    range,
    packageJson,
    manager,
    mode: 'run',
    mask: (text) => maskWith(config.path, text),
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
