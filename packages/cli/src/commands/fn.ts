// `agent-qa fn` — the generic function-layer invoker.
//
// A permanent registry debug/discovery surface: list what exists, invoke by id. It is a
// thin client by construction — it resolves a root, builds the registry at the composition
// root, and calls `invokeFunction`. It owns no capability of its own.

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
  // no minting surface — nothing is filed for a door to be named on.
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

// 2026-10-15 (441-68, GAP2-D3): `seq`, `ts`, `runId` and `type` keep their keys, so `seq` stays the
// resume token. `seq`, `ts` and `type` are code vocabulary and keep their values; a person can choose
// a run id, so it is masked. Every other member is masked keys and leaves.
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

/**
 * Render a stream as it arrives.
 *
 * `--json` emits NDJSON — one self-contained JSON document per line — because a stream has
 * no closing bracket to wait for, and that stays true when 386 attaches to a live run.
 * Human mode prints one line per event and closes with the last seq observed, which is
 * exactly the value to hand back as `--from` on the next invocation.
 */
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

// leaves are masked before serialization, so a declared value holding a
// JSON-special character can neither break the document nor slip past the mask.
// 2026-10-15 (441-62, GAP-D2): keys too.
function emitJson(mask: MaskFn, value: unknown): void {
  console.log(guardJsonText(JSON.stringify(maskPayloadTree(value, mask), null, 2)))
}

/**
 * The bytes `agent-qa fn` prints for a unary result — the honest baseline.
 *
 * PROMOTED TO AN EXPORT ON 2026-08-20 rather than copied (399.1 plan 06). It was one inline
 * expression until the conformance suite needed to drive this door's render for all 42 capabilities,
 * and the available shortcut was to write `JSON.stringify(result, null, 2)` a second time inside the
 * suite. That second spelling is the RC-2 defect in miniature: two renders of one door, free to
 * disagree, with the measured one green while the shipped one drops a field. There is one render
 * here and the suite drives it.
 *
 * IT DOES NOT PRINT AND IT DOES NOT MASK. The emitters below own both: each prints through the
 * command's declared mask, and nothing restores a value.
 */
export function renderFnResult(result: unknown): string {
  return JSON.stringify(result, null, 2)
}

function emitHuman(mask: MaskFn, text: string): void {
  printRunText(mask(text))
}

/**
 * The listing projection: identity and contract metadata only, never zod internals. No scope
 * column since 432-20: declarations carry no permission metadata.
 */
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
        // daemon routing is explicit. A live registration never changes the default,
        // while the explicit route does not compose a second local host before going over wire.
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

        // The registry knows which ops stream; the rendering follows the RESULT so
        // the invoker needs no per-id knowledge of its own.
        if (isStream(result)) {
          await renderStream(result, options.json === true, mask)
          return
        }

        if (options.json === true) {
          emitJson(mask, result)
          return
        }
        // 441-62 (CR-A01): mask the structure first; the text mask alone misses escaped values.
        emitHuman(mask, renderFnResult(maskPayloadTree(result, mask)))
      } catch (error) {
        reportError(error, mask)
      } finally {
        releaseStdout?.()
      }
    })
}
