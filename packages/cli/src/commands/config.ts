import { Command } from 'commander'
import pc from 'picocolors'
import { parseDocument, Document } from 'yaml'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { MARKER_WRITTEN_BACK_SENTENCE, type MaskFn } from '@vostride/agent-qa-schema'
import { printRunText } from '@vostride/agent-qa-core/run-text-output'

import {
  createDeclaredSecretMask,
  DeclaredSecretsUnavailableError,
} from '../composition/declared-secrets.js'
import {
  ConfigFileNotFoundError,
  ConfigFileNotYamlError,
  formatConfigDebug,
  loadConfigFile,
  loadEnvOverrides,
  loadRequiredConfigFile,
  mergeConfigs,
} from '../config.js'

const DEFAULT_CONFIG_FILE = 'agent-qa.config.yaml'

// How `config show` prints a declared secret; written back, it would replace the value.
const SHOWN_MARKER = /\[secret:\w+\]/

// `--config` has a default, so `getOptionValueSource` tells a named path from the default.
function rootConfigPath(command: Command): { readonly path: string; readonly explicit: boolean } {
  let node: Command = command
  while (node.parent) node = node.parent
  const supplied = node.opts<{ config?: string }>().config
  const source = node.getOptionValueSource('config')
  return {
    path: supplied ?? DEFAULT_CONFIG_FILE,
    explicit: supplied !== undefined && source !== undefined && source !== 'default',
  }
}

// A filesystem fault reports its `code` and the path as typed, and exits non-zero.
function reportConfigFileFailure(verb: 'read' | 'write', configPath: string, err: unknown): void {
  const code = (err as NodeJS.ErrnoException).code ?? `${verb} failed`
  console.error(pc.red(`Could not ${verb} ${configPath}: ${code}`))
  process.exitCode = 1
}

function printUnavailable(error: DeclaredSecretsUnavailableError): void {
  process.exitCode = 1
  const [first, ...rest] = error.lines
  if (first === undefined) return
  printRunText([pc.red(first), ...rest.map((line) => pc.dim(line))].join('\n'),
    (text) => console.error(text))
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString('utf-8').trim()
}

function plainPrompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close()
      resolve(answer.trim())
    })
  })
}

async function getValue(key: string, providedValue: string | undefined): Promise<string | null> {
  if (providedValue !== undefined) return providedValue

  if (process.stdin.isTTY) {
    return plainPrompt(`Enter value for ${key}: `)
  }
  return readStdin()
}

async function setAction(key: string, value: string | undefined, command: Command): Promise<void> {
  const resolved = await getValue(key, value)
  if (!resolved) {
    console.error(pc.red('No value provided.'))
    return
  }
  // Refused before the file is read; the value is never echoed.
  if (SHOWN_MARKER.test(key) || SHOWN_MARKER.test(resolved)) {
    console.error(
      pc.red(`config set refused (marker_written_back): ${MARKER_WRITTEN_BACK_SENTENCE}`),
    )
    process.exitCode = 1
    return
  }

  const { path: configPath } = rootConfigPath(command)
  let doc: Document
  try {
    const content = await readFile(configPath, 'utf-8')
    doc = parseDocument(content)
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      doc = new Document({})
    } else {
      // A read fault reports through the same guard as the write, never Node's default printer.
      reportConfigFileFailure('read', configPath, err)
      return
    }
  }

  doc.setIn(key.split('.'), resolved)
  try {
    await writeFile(configPath, doc.toString())
  } catch (err: unknown) {
    reportConfigFileFailure('write', configPath, err)
    return
  }
  // Names the file as the person typed it; the line crosses the declared mask or drops the value.
  let line = `\u2713 ${key} saved to ${configPath}`
  try {
    line = createDeclaredSecretMask(configPath).mask(
      `\u2713 ${key} = ${resolved} saved to ${configPath}`,
    )
  } catch {
    // keep the value-free line
  }
  console.log(pc.green(line))
}

async function showAction(command: Command): Promise<void> {
  // A named config that is absent is refused; an unnamed absent config is a truthful empty table.
  const { path: configPath, explicit } = rootConfigPath(command)
  let fileConfig: unknown
  try {
    fileConfig = explicit
      ? await loadRequiredConfigFile(configPath)
      : await loadConfigFile(configPath)
  } catch (err: unknown) {
    if (err instanceof ConfigFileNotYamlError || err instanceof ConfigFileNotFoundError) {
      console.error(pc.red(err.message))
      process.exitCode = 1
      return
    }
    // A read fault with an errno `code` reports rather than reaching Node's default printer.
    if (typeof (err as NodeJS.ErrnoException).code === 'string') {
      reportConfigFileFailure('read', configPath, err)
      return
    }
    throw err
  }
  // A project with no config file declares no secrets file to mask.
  let mask: MaskFn = (text) => text
  if (explicit || existsSync(configPath)) {
    const declaredSecrets = createDeclaredSecretMask(configPath)
    try {
      declaredSecrets.redactor()
    } catch (err: unknown) {
      if (!(err instanceof DeclaredSecretsUnavailableError)) throw err
      printUnavailable(err)
      return
    }
    mask = declaredSecrets.mask
  }
  const envOverrides = loadEnvOverrides()
  // Merge env into file config (3-layer: file+env is the global config)
  const globalConfig = mergeConfigs(fileConfig, envOverrides, {})
  const table = formatConfigDebug(globalConfig, {}, {}, mask)
  console.log(pc.bold('\nResolved Configuration:\n'))
  printRunText(table, (text) => console.log(text))
  console.log()
}

export function createConfigCommand(): Command {
  const cmd = new Command('config').description('Manage configuration')

  // Commander passes `(...args, options, command)`; the arrow shows that arity at the seam.
  cmd
    .command('set <key> [value]')
    .description('Set a config value')
    .action((key: string, value: string | undefined, _options: unknown, command: Command) =>
      setAction(key, value, command))

  cmd
    .command('show')
    .description('Show resolved config with source attribution')
    .action((_options: unknown, command: Command) => showAction(command))

  return cmd
}
