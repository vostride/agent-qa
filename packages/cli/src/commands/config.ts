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

// 441 GAP2-D8: how `config show` prints a declared secret. Written back, it would replace the value.
const SHOWN_MARKER = /\[secret:\w+\]/

/**
 * The path the person named, read off the ROOT program (395-24 · WR-03).
 *
 * Both verbs used to hardcode `'agent-qa.config.yaml'` while the root program had carried
 * `--config <path>` all along, so `agent-qa --config staging.yaml config set version 9` reported
 * `✓ version = 9 saved to agent-qa.config.yaml` and modified the file the person was explicitly
 * steering away from. A SILENT WRONG-FILE WRITE is the worst shape this bug takes: nothing in the
 * output said which file had actually changed.
 *
 * `config set` and `config show` are NESTED subcommands (`program -> config -> set`), so unlike
 * `ask.ts`'s `globalOptions` a single `.parent` hop lands on the `config` command, not the program.
 * Walking the chain to the root is the same derivation, generalized — and it is the whole chain
 * rather than two hops so a later regrouping of the verbs cannot silently reintroduce the default.
 *
 * AND IT ANSWERS BOTH FACTS AT ONCE (395-27 · WR-02). `showAction` needs to know not only WHICH
 * path resolved but whether the person NAMED it, because those two roads take opposite postures on
 * a file that is not there: a named file that is absent is a refusal, and a project that declares
 * no config at all is a truthful empty table. A second walk of the command chain to answer the
 * second half would be a second producer of the same fact, and this file's own comment above argues
 * against exactly that — so the walk stays ONE walk with TWO callers.
 *
 * EXPLICITNESS IS THE OPTION'S SOURCE, NOT WHETHER THE VALUE IS DEFINED. `cli.ts:43` declares
 * `.option('--config <path>', …, 'agent-qa.config.yaml')` WITH A DEFAULT, so `opts().config` is a
 * non-empty string in every invocation ever made — reading `!== undefined` answers "always yes" and
 * pushes the refusal onto every zero-config project in the world. Measured, not reasoned: the first
 * revision of this function did exactly that, and `config show` in an empty directory printed
 * `Config file not found: agent-qa.config.yaml` at exit 1. Commander's `getOptionValueSource`
 * distinguishes `'default'` from `'cli'`, which is the fact actually being asked for. The `??`
 * below is unreachable while that default stands and is kept so removing the default is not also a
 * silent change of path.
 */
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

// A filesystem fault reports its `code` and the path as typed, and exits non-zero (395-27 · WR-01).
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
      // AND THE READ REPORTS TOO, not only the write below it. `--config <a directory>` produced
      // `EISDIR` here and this arm rethrew it into the same default printer the write did — the
      // same crash, on the same verb, in the same function, one guard away. A guard given to one
      // sibling and not the other is the shape this arc has now filed six times (388/390/392/395),
      // and the two siblings here are in the same function, a dozen lines apart.
      reportConfigFileFailure('read', configPath, err)
      return
    }
  }

  doc.setIn(key.split('.'), resolved)
  try {
    await writeFile(configPath, doc.toString())
  } catch (err: unknown) {
    // THE FROZEN ITEM (395-27 · WR-01). The read above was guarded and this was bare, so a
    // person-supplied path with a directory that does not exist ended the process as an uncaught
    // rejection: `node:internal/fs/promises:642`, the absolute resolved path, and the frame list.
    // The success line below is NOT reached — a write that did not happen does not report one.
    reportConfigFileFailure('write', configPath, err)
    return
  }
  // THE SENTENCE NAMES THE FILE THAT CHANGED, not the default. Rendered exactly as the person typed
  // it (WR-07's discipline: a person-facing path is the one they can read), so the unflagged road
  // still says `agent-qa.config.yaml` and the flagged road says what it actually wrote.
  // 2026-10-15 (441-63, T-441-45): the line goes through the declared mask; without one it drops
  // the value rather than refusing a write that already happened.
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
  // THE OP REPORTS, IT DOES NOT CRASH (395-16 · CR-01). This await was bare, so an unreadable
  // committed config left the command as an uncaught rejection and Node's default printer rendered
  // the error with its whole cause chain — the one road a person reaches this error on was also the
  // one road that printed the most. The typed arm answers the error's own position-only sentence
  // and exits 1. (395-16 added "anything else rethrows: a filesystem fault is not this guard's
  // subject" — still true of the PARSE guard, and 395-27 gave the filesystem fault its own guard
  // below rather than leaving it to the printer.)
  //
  // AND IT DOES NOT DESCRIBE A FILE THAT IS NOT THERE (395-27 · WR-02). `loadConfigFile` swallows
  // `ENOENT` and answers `{}`, which is the RIGHT answer for a project that declares no config and
  // the WRONG one for a file the person explicitly named: `--config nope.yaml config show` printed
  // `(no config values)` at exit 0 — a read the person will believe they performed. So the loader
  // is chosen by whether the path was SUPPLIED, and the refusal happens before any table is
  // composed. `loadRequiredConfigFile` already owns the sentence for this fact and the live lane
  // matches it verbatim; minting a second wording for the same fact is how two surfaces start
  // disagreeing about one file.
  //
  // THE UNFLAGGED ROAD IS UNTOUCHED, on purpose and pinned by (W9-control): a project that
  // genuinely declares no configuration is not being lied to by an empty table, and widening the
  // refusal there would change behaviour in every zero-config project and in the live lane.
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
    // A NON-ENOENT READ FAULT REPORTS RATHER THAN CRASHING, for `setAction`'s reason: 395-16 wrote
    // "a filesystem fault is not this guard's subject" about the PARSE guard, and that is still
    // true — it is this one's. `--config <a directory>` reached Node's default printer here too.
    if (typeof (err as NodeJS.ErrnoException).code === 'string') {
      reportConfigFileFailure('read', configPath, err)
      return
    }
    throw err
  }
  // 2026-10-15 (441-20, D-01): a project with no config file declares no secrets file to mask.
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

  // THE ARITY IS SPELLED OUT AT THE SEAM, ON PURPOSE. Commander invokes an action with
  // `(...declaredArguments, options, command)`, and WR-01 was exactly this arity read wrong one file
  // over: `validate.ts` bound `(files, command)` for an argument-bearing command and silently held
  // the OPTIONS object where it expected the Command. Handing `.action` a bare function reference
  // hides that count behind the handler's own signature; an explicit arrow puts it where a reader
  // of the wiring can check it against the `.command(...)` string on the line above.
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
