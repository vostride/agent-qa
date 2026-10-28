// `agent-qa entities` — the entity addressing debug verb (Phase 387, D-20).
//
// It replaces `ids`, which minted id-agent word-ids from the terminal and therefore owned a
// capability the function layer now publishes. The machinery `ids` reached for did not go
// away — `packages/ids` is what the addressing ledger maps FROM — but the CLI no longer names
// it, because a surface that can mint an identifier is a surface with a private power (L10).
//
// Shaped after `fn.ts`, deliberately and almost line for line: resolve a project root, build
// the registry at the composition root, call `invokeFunction`, render what comes back. The
// only thing this file knows that `fn` does not is how to READ a resolution — which arm means
// what, and which fields a human needs to see in each. That is presentation, and presentation
// is the whole of what a surface is allowed to own.

import { dirname, resolve } from 'node:path'

import { invokeFunction } from '@vostride/agent-qa-agent'
import {
  guardJsonText,
  printRunText,
  reserveStdoutForData,
} from '@vostride/agent-qa-core/run-text-output'
import { maskPayloadTree } from '@vostride/agent-qa-schema'
import type {
  ActionRef,
  EntityCard,
  EntityCardResolution,
  KeyFact,
  MaskFn,
} from '@vostride/agent-qa-schema'
import { Command } from 'commander'
import pc from 'picocolors'

import {
  createDeclaredSecretMask,
  DeclaredSecretsUnavailableError,
  type DeclaredSecretMask,
} from '../composition/declared-secrets.js'
import {
  CLI_FUNCTION_CALLER,
  composeCliLocalAgent,
} from '../composition/local-agent-host.js'
import { resolveConfig, resolveConfiguredKnowledgeRoot } from '../config.js'
import { invokeViaDaemon } from '../daemon/client.js'

/**
 * The two capabilities this verb is a client of. The ids are all it knows: what parses an
 * address, which tier answers, and which store the descriptor came from are the function
 * layer's business, reached only through `invokeFunction`.
 *
 * Written as literals rather than imported from the agent barrel for the same reason
 * `knowledge-read.ts` writes its own: an id is a wire name, and a surface that could only
 * name a capability by importing its declaration would be coupled to the declaring module
 * rather than to the contract.
 */
const ENTITIES_RESOLVE_ID = 'entities.resolve'
const ENTITIES_GET_ID = 'entities.get'

interface EntitiesOptions {
  json?: boolean
  viaDaemon?: boolean
}

type EntitiesErrorCode = 'missing-ref'

class EntitiesCommandError extends Error {
  constructor(
    readonly code: EntitiesErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'EntitiesCommandError'
  }
}

function globalOptions(command: Command): { config?: string } {
  return command.parent?.parent?.opts<{ config?: string }>() ?? {}
}

/** Everything the composition root needs, derived from the one global flag (the fn.ts idiom). */
function compositionInput(command: Command): { agentQaRoot: string; configPath: string } {
  const configPath = resolve(globalOptions(command).config ?? 'agent-qa.config.yaml')
  return { agentQaRoot: resolve(dirname(configPath), '.agent-qa'), configPath }
}

/** The invocation's declared mask, refusing at start (E3) when the secrets file cannot be read. */
function declaredSecretsFor(command: Command): DeclaredSecretMask {
  const declaredSecrets = createDeclaredSecretMask(compositionInput(command).configPath)
  declaredSecrets.redactor()
  return declaredSecrets
}

// 2026-10-14 (441-14, D-07): everything this file prints is masked and never restored; JSON is
// masked leaf by leaf before it is serialized. 2026-10-15 (441-62, IN-A07): keys too.
function emitJson(mask: MaskFn, value: unknown): void {
  console.log(guardJsonText(JSON.stringify(maskPayloadTree(value, mask), null, 2)))
}

function emitHuman(mask: MaskFn, text: string): void {
  printRunText(mask(text))
}

/**
 * One invocation, routed the way the operator asked for it.
 *
 * `--via-daemon` resolves the knowledge root before going over the wire and does NOT compose a
 * local host first, exactly as `fn` does: composing one would open the project's stores in a
 * process that is about to ask another process to do the reading.
 */
async function invokeEntityOp(
  command: Command,
  options: EntitiesOptions,
  declaredSecrets: DeclaredSecretMask,
  functionId: string,
  ref: string,
): Promise<unknown> {
  const composition = compositionInput(command)
  const viaDaemon = options.viaDaemon === true || process.env.AGENT_QA_VIA_DAEMON === '1'
  if (viaDaemon) {
    const knowledgeRoot = resolveConfiguredKnowledgeRoot(
      await resolveConfig({ configPath: composition.configPath, loadAuthPlugins: false }),
      dirname(composition.configPath),
    )
    return invokeViaDaemon({
      agentQaRoot: composition.agentQaRoot,
      knowledgeRoot,
      functionId,
      input: { ref },
    })
  }
  return invokeFunction(
    composeCliLocalAgent({ ...composition, declaredSecrets }).registry,
    functionId,
    { ref },
    CLI_FUNCTION_CALLER,
  )
}

function renderKeyFact(fact: KeyFact): string {
  return `    ${fact.label}: ${fact.value}${fact.ref === undefined ? '' : ` ${pc.dim(fact.ref)}`}`
}

function renderAction(action: ActionRef): string {
  return `    ${action.label} ${pc.dim(`(${action.functionId})`)}`
}

/**
 * The full card. `url` is rendered only when the producer supplied one — D-10 keeps it absent
 * until a dashboard base URL is configured, and printing a placeholder here would put a dead
 * link in front of a reader who has no way to tell it from a live one.
 */
function renderCard(card: EntityCard, indent = ''): string {
  const lines = [
    `${indent}${pc.bold(card.id)}  ${pc.dim(card.uri)}`,
    `${indent}  title: ${card.title}`,
    `${indent}  kind: ${card.kind}`,
    `${indent}  status: ${card.status}`,
    ...(card.url === undefined ? [] : [`${indent}  url: ${card.url}`]),
    `${indent}  key facts (${card.keyFacts.length}):`,
    ...(card.keyFacts.length === 0
      ? [`${indent}    none`]
      : card.keyFacts.map((fact) => `${indent}${renderKeyFact(fact)}`)),
    `${indent}  actions (${card.actions.length}):`,
    ...(card.actions.length === 0
      ? [`${indent}    none`]
      : card.actions.map((action) => `${indent}${renderAction(action)}`)),
  ]
  return lines.join('\n')
}

/**
 * Render the resolution ARM FOR ARM, as an exhaustive switch.
 *
 * A default branch would have let a fourth arm added to the vocabulary later print as
 * something plausible; here it is a compile error. That matters more for this union than for
 * most: ENTY-01's never-guess contract is exactly the promise that a surface never renders a
 * maybe, and the three arms are how the contract reaches a human.
 */
function renderResolution(resolution: EntityCardResolution): string {
  switch (resolution.kind) {
    case 'resolved':
      return [
        pc.green(pc.bold(`Resolved (score ${resolution.score})`)),
        '',
        renderCard(resolution.card),
      ].join('\n')
    case 'ambiguous':
      return [
        pc.yellow(pc.bold(`Ambiguous — ${resolution.candidates.length} candidates`)),
        pc.dim('  Nothing was chosen. Re-ask with one of these addresses.'),
        '',
        ...resolution.candidates.flatMap((candidate) => [
          `  ${pc.bold(candidate.card.id)} ${pc.dim(`score ${candidate.score}`)}`,
          renderCard(candidate.card, '  '),
          '',
        ]),
      ].join('\n').trimEnd()
    case 'none':
      return [
        pc.red(pc.bold(`No match [${resolution.reason}]`)),
        ...(resolution.closestSuggestion === undefined
          ? []
          : [`  closest: ${resolution.closestSuggestion}`]),
      ].join('\n')
  }
}

function printUnavailable(error: DeclaredSecretsUnavailableError): void {
  const [first, ...rest] = error.lines
  if (first === undefined) return
  printRunText([pc.red(first), ...rest.map((line) => pc.dim(line))].join('\n'),
    (text) => console.error(text))
}

function reportError(action: 'resolve' | 'get', error: unknown, mask: MaskFn | undefined): void {
  process.exitCode = 1
  if (error instanceof DeclaredSecretsUnavailableError) {
    printUnavailable(error)
    return
  }
  const line = error instanceof EntitiesCommandError
    ? `Entities ${action} error [${error.code}]: ${error.message}`
    : error instanceof Error
      ? `Entities ${action} error [${error.name}]: ${error.message}`
      : `Entities ${action} error: ${String(error)}`
  // A refusal raised before the loader exists has nothing to mask with.
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
  printRunText(pc.red(shown), (text) => console.error(text))
}

function requireRef(ref: string | undefined, what: string): string {
  if (ref === undefined || ref.trim().length === 0) {
    throw new EntitiesCommandError('missing-ref', `Provide ${what}.`)
  }
  return ref
}

export function createEntitiesCommand(): Command {
  const command = new Command('entities')
    .description('Resolve and render entity cards through the agent function layer')

  command
    .command('resolve')
    .description('Resolve any reference — short-ID, agentqa:// URI, or free text — to a card')
    .argument('[ref]', 'short-ID (e.g. MEM-001), agentqa:// URI, or free text')
    .option('--json', 'emit machine-readable masked JSON')
    .option('--via-daemon', 'dispatch through the project daemon instead of in-process')
    .action(async (ref: string | undefined, options: EntitiesOptions, resolveCommand: Command) => {
      let mask: MaskFn | undefined
      const releaseStdout = options.json === true ? reserveStdoutForData() : undefined
      try {
        const declaredSecrets = declaredSecretsFor(resolveCommand)
        mask = declaredSecrets.mask
        const result = await invokeEntityOp(
          resolveCommand,
          options,
          declaredSecrets,
          ENTITIES_RESOLVE_ID,
          requireRef(ref, 'a reference to resolve'),
        ) as EntityCardResolution

        if (options.json === true) {
          emitJson(mask, result)
          return
        }
        emitHuman(mask, renderResolution(result))
      } catch (error) {
        reportError('resolve', error, mask)
      } finally {
        releaseStdout?.()
      }
    })

  command
    .command('get')
    .description('Render the entity card for one exact short-ID or agentqa:// URI')
    .argument('[id]', 'exact short-ID (e.g. MEM-001) or agentqa:// URI')
    .option('--json', 'emit machine-readable masked JSON')
    .option('--via-daemon', 'dispatch through the project daemon instead of in-process')
    .action(async (id: string | undefined, options: EntitiesOptions, getCommand: Command) => {
      let mask: MaskFn | undefined
      const releaseStdout = options.json === true ? reserveStdoutForData() : undefined
      try {
        const declaredSecrets = declaredSecretsFor(getCommand)
        mask = declaredSecrets.mask
        const card = await invokeEntityOp(
          getCommand,
          options,
          declaredSecrets,
          ENTITIES_GET_ID,
          requireRef(id, 'an exact entity address'),
        ) as EntityCard

        if (options.json === true) {
          emitJson(mask, card)
          return
        }
        emitHuman(mask, renderCard(card))
      } catch (error) {
        reportError('get', error, mask)
      } finally {
        releaseStdout?.()
      }
    })

  return command
}
