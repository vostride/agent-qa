// A registry debug surface: list what exists, invoke by id; it owns no capability of its own.

import { dirname, resolve } from 'node:path'

import { invokeFunction } from '@vostride/agent-qa-agent'
import type { FunctionDeclaration } from '@vostride/agent-qa-agent'
import type { RunExecutionPort } from '@vostride/agent-qa-agent-local'
import {
  guardJsonText,
  printRunText,
  reserveStdoutForData,
} from '@vostride/agent-qa-core/run-text-output'
import { maskPayloadTree, type MaskFn } from '@vostride/agent-qa-schema'
import { Command } from 'commander'
import pc from 'picocolors'

import {
  createDeclaredSecretMask,
  DeclaredSecretsUnavailableError,
} from '../composition/declared-secrets.js'
import {
  CLI_FUNCTION_CALLER,
  composeCliLocalAgent,
} from '../composition/local-agent-host.js'
import { resolveConfig, resolveConfiguredKnowledgeRoot } from '../config.js'
import { invokeViaDaemon } from '../daemon/client.js'

interface FnOptions {
  list?: boolean
  json?: boolean
  input?: string
  from?: string
  viaDaemon?: boolean
}

type FnErrorCode = 'invalid-input-json' | 'invalid-resume-token' | 'missing-function-id'

class FnCommandError extends Error {
  constructor(
    readonly code: FnErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'FnCommandError'
  }
}

function globalOptions(command: Command): { config?: string } {
  return command.parent?.opts<{ config?: string }>() ?? {}
}

/** Everything the composition root needs to build the registry, derived from one flag. */
function compositionInput(
  command: Command,
): { agentQaRoot: string; configPath: string } {
  const configPath = resolve(globalOptions(command).config ?? 'agent-qa.config.yaml')
  return {
    agentQaRoot: resolve(dirname(configPath), '.agent-qa'),
    configPath,
  }
}

function parsedInput(raw: string | undefined): unknown {
  if (raw === undefined) return {}
  try {
    return JSON.parse(raw) as unknown
  } catch (error) {
    throw new FnCommandError(
      'invalid-input-json',
      `--input must be valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

/**
 * Fold `--from <lastEventId>` into the op input.
 *
 * The flag is sugar over the `lastEventId` field a stream op already declares, so a
 * resumed invocation and a hand-written `--input` are the same call. Rejecting a
 * non-integer here rather than letting the zod contract report it keeps the message about
 * the flag the operator actually typed.
 */
function withResumeToken(input: unknown, from: string | undefined): unknown {
  if (from === undefined) return input

  const lastEventId = Number(from)
  if (!Number.isInteger(lastEventId) || lastEventId < 0) {
    throw new FnCommandError(
      'invalid-resume-token',
      `--from must be a non-negative whole event seq, got: ${from}`,
    )
  }
  return { ...(input as Record<string, unknown>), lastEventId }
}

function isStream(value: unknown): value is AsyncIterable<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function'
  )
}

/** The seq-stamped shape every stream element carries; `seq` doubles as the resume token. */
interface SeqStamped {
  seq?: number
  type?: string
}

// Keys `seq`, `ts`, `runId` and `type` stay; `runId`'s value is masked, as is every other member.
function streamLine(element: unknown, mask: MaskFn): unknown {
  if (typeof element !== 'object' || element === null || Array.isArray(element)) {
    return maskPayloadTree(element, mask)
  }
  const { seq, ts, runId, type, ...rest } = element as Record<string, unknown>
  return {
    seq,
    ts,
    runId: typeof runId === 'string' ? mask(runId) : maskPayloadTree(runId, mask),
    type,
    ...maskPayloadTree(rest, mask),
  }
}

// NDJSON under `--json`, as a stream has no closing bracket; human mode ends on the last seq.
async function renderStream(
  stream: AsyncIterable<unknown>,
  json: boolean,
  mask: MaskFn,
): Promise<void> {
  let count = 0
  let lastSeq: number | undefined

  for await (const element of stream) {
    count += 1
    const stamped = element as SeqStamped
    lastSeq = stamped.seq
    if (json) {
      console.log(guardJsonText(JSON.stringify(streamLine(element, mask))))
      continue
    }
    const label = `${pc.dim(`seq ${stamped.seq ?? '?'}`)}  ${pc.bold(stamped.type ?? 'event')}`
    printRunText(mask(label))
  }

  if (!json) {
    printRunText(mask(pc.dim(
      `${count} event${count === 1 ? '' : 's'} · last seq ${lastSeq ?? 'none'}`,
    )))
  }
}

// Keys and leaves are masked before serialization, so a JSON-special value cannot slip past.
function emitJson(mask: MaskFn, value: unknown): void {
  console.log(guardJsonText(JSON.stringify(maskPayloadTree(value, mask), null, 2)))
}

// Exported so the conformance suite drives the same render; it neither prints nor masks.
export function renderFnResult(result: unknown): string {
  return JSON.stringify(result, null, 2)
}

function emitHuman(mask: MaskFn, text: string): void {
  printRunText(mask(text))
}

// Identity and contract metadata only, never zod internals.
function declarationRow(declaration: FunctionDeclaration): {
  id: string
  summary: string
  resultKind: string
  bindingStatus: string
} {
  return {
    id: declaration.id,
    summary: declaration.summary,
    resultKind: declaration.resultKind,
    bindingStatus: declaration.bindingStatus,
  }
}

function renderListing(declarations: readonly FunctionDeclaration[]): string {
  if (declarations.length === 0) {
    return pc.dim('No functions are registered.')
  }
  return [
    pc.bold(`Registered functions (${declarations.length})`),
    '',
    ...declarations.flatMap((declaration) => [
      pc.bold(declaration.id),
      `  summary: ${declaration.summary}`,
      `  result kind: ${declaration.resultKind}`,
      `  binding: ${declaration.bindingStatus}`,
    ]),
  ].join('\n')
}

function printUnavailable(error: DeclaredSecretsUnavailableError): void {
  const [first, ...rest] = error.lines
  if (first === undefined) return
  printRunText([pc.red(first), ...rest.map((line) => pc.dim(line))].join('\n'),
    (text) => console.error(text))
}

function reportError(error: unknown, mask?: MaskFn): void {
  process.exitCode = 1
  if (error instanceof DeclaredSecretsUnavailableError) {
    printUnavailable(error)
    return
  }
  const line = error instanceof FnCommandError
    ? `Function error [${error.code}]: ${error.message}`
    : error instanceof Error
      ? `Function error [${error.name}]: ${error.message}`
      : `Function error: ${String(error)}`
  let shown = line
  if (mask !== undefined) {
    try {
      shown = mask(line)
    } catch (maskError) {
      if (!(maskError instanceof DeclaredSecretsUnavailableError)) throw maskError
      printUnavailable(maskError)
      return
    }
  }
  printRunText(pc.red(shown), (block) => console.error(block))
}

/**
 * The one seam this command takes from outside itself.
 *
 * Only the run-execution port, and only because executing a run means a browser and a provider.
 * Everything else the `fn` path touches — the registry, the gate, the readers, the audit sink —
 * is built by the real composition in every invocation including the tested ones, so a test
 * substituting this seam still crosses every boundary the command owns.
 */
export interface FnCommandDeps {
  runExecution?: RunExecutionPort
}

export function createFnCommand(deps: FnCommandDeps = {}): Command {
  return new Command('fn')
    .description('Invoke a registered agent function by id, or list the registry')
    .argument('[id]', 'dot-namespaced function id, e.g. runs.list')
    .option('--list', 'list every registered function instead of invoking one')
    .option('--json', 'emit machine-readable masked JSON')
    .option('--input <json>', 'JSON object passed as the function input (default {})')
    .option('--from <lastEventId>', 'resume a stream after this event seq')
    .option('--via-daemon', 'dispatch through the project daemon instead of in-process')
    .action(async (id: string | undefined, options: FnOptions, command: Command) => {
      let mask: MaskFn | undefined
      const releaseStdout = options.json === true ? reserveStdoutForData() : undefined
      try {
        const composition = compositionInput(command)
        const declaredSecrets = createDeclaredSecretMask(composition.configPath)
        // E3: refuse before a host is composed when the secrets file cannot be read.
        declaredSecrets.redactor()
        mask = declaredSecrets.mask
        const viaDaemon =
          options.viaDaemon === true || process.env.AGENT_QA_VIA_DAEMON === '1'
        const daemonKnowledgeRoot = viaDaemon
          ? resolveConfiguredKnowledgeRoot(
              await resolveConfig({
                configPath: composition.configPath,
                loadAuthPlugins: false,
              }),
              dirname(composition.configPath),
            )
          : undefined
        // Daemon routing is explicit: a live registration never changes the default route.
        const localRegistry = viaDaemon
          ? undefined
          : composeCliLocalAgent({
              ...composition,
              declaredSecrets,
              ...(deps.runExecution === undefined ? {} : { runExecution: deps.runExecution }),
            }).registry

        if (options.list === true) {
          const registry = localRegistry ?? composeCliLocalAgent({
            ...composition,
            declaredSecrets,
            ...(deps.runExecution === undefined ? {} : { runExecution: deps.runExecution }),
          }).registry
          const declarations = registry.list(CLI_FUNCTION_CALLER)
          if (options.json === true) {
            emitJson(mask, declarations.map(declarationRow))
            return
          }
          emitHuman(mask, renderListing(declarations))
          return
        }

        if (id === undefined) {
          throw new FnCommandError(
            'missing-function-id',
            'Provide a function id, or pass --list to see what is registered.',
          )
        }

        const input = withResumeToken(parsedInput(options.input), options.from)
        const result = viaDaemon
          ? await invokeViaDaemon({
              agentQaRoot: composition.agentQaRoot,
              knowledgeRoot: daemonKnowledgeRoot,
              functionId: id,
              input,
            })
          : await invokeFunction(localRegistry!, id, input, CLI_FUNCTION_CALLER)

        // Rendering follows the result, so the invoker needs no per-id knowledge of streaming ops.
        if (isStream(result)) {
          await renderStream(result, options.json === true, mask)
          return
        }

        if (options.json === true) {
          emitJson(mask, result)
          return
        }
        // The structure is masked first; the text mask alone misses escaped values.
        emitHuman(mask, renderFnResult(maskPayloadTree(result, mask)))
      } catch (error) {
        reportError(error, mask)
      } finally {
        releaseStdout?.()
      }
    })
}
