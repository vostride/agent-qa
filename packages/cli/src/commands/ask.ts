// A thin client: `agent.ask` owns the turn, so the one-shot and the REPL run the same op.

import { dirname, resolve } from 'node:path'

import { AGENT_ASK_FUNCTION_ID, invokeFunction } from '@vostride/agent-qa-agent'
import { printRunText } from '@vostride/agent-qa-core/run-text-output'
import type { AgentAskResult, MaskFn } from '@vostride/agent-qa-schema'
import { Command } from 'commander'
import pc from 'picocolors'

import {
  createDeclaredSecretMask,
  DeclaredSecretsUnavailableError,
} from '../composition/declared-secrets.js'
import { CLI_FUNCTION_CALLER, composeCliLocalAgent } from '../composition/local-agent-host.js'
import { receiptLine } from './receipt-line.js'
import { renderClauseResults } from './result-render.js'

type AskErrorCode = 'missing-message' | 'fail-closed' | 'clause-failed'

class AskCommandError extends Error {
  constructor(
    readonly code: AskErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'AskCommandError'
  }
}

function globalOptions(command: Command): { config?: string } {
  return command.parent?.opts<{ config?: string }>() ?? {}
}

/** Everything the composition root needs, derived from one flag — the `fn.ts` derivation. */
function compositionInput(
  command: Command,
): { agentQaRoot: string; configPath: string } {
  const configPath = resolve(globalOptions(command).config ?? 'agent-qa.config.yaml')
  return {
    agentQaRoot: resolve(dirname(configPath), '.agent-qa'),
    configPath,
  }
}

function renderTurn(result: AgentAskResult): string {
  const lines = [pc.dim(`session ${result.sessionId} · turn ${result.turnId}`)]
  // A `--session` resume can land on a damaged log, so the refused line count is reported.
  if (result.refusedLineCount !== undefined) {
    lines.push(
      pc.yellow(`${result.refusedLineCount} line(s) of this session could not be read.`),
    )
  }
  if (result.receipts.length > 0) {
    lines.push(...result.receipts.map(receiptLine))
  }
  // The same payload block the REPL prints, so a scripted caller sees what the prompt shows.
  lines.push(...renderClauseResults(result.results, result.receipts.length))
  if (result.answer !== undefined) lines.push(result.answer)
  return lines.join('\n')
}

// Everything this file prints is masked and never restored.
function emitHuman(mask: MaskFn, text: string): void {
  printRunText(mask(text))
}

// The mid-turn render, on stdout and unconditional, piped stdin included.
function chatPresentThrough(mask: MaskFn): (text: string) => void {
  return (text) => {
    printRunText(mask(text), (block) => {
      process.stdout.write(`${block}\n`)
    })
  }
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
  const line = error instanceof AskCommandError
    ? `Ask error [${error.code}]: ${error.message}`
    : error instanceof Error
      ? `Ask error [${error.name}]: ${error.message}`
      : `Ask error: ${String(error)}`
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
  printRunText(pc.red(shown), (block) => console.error(block))
}

export function createAskCommand(): Command {
  return new Command('ask')
    .description('Ask agent-qa to do one thing and report what it did')
    .argument('[message...]', 'what to do, in words')
    .option('--session <id>', 'continue an existing chat session instead of starting one')
    .action(
      async (
        message: string[] | undefined,
        options: { session?: string },
        command: Command,
      ) => {
        let mask: MaskFn | undefined
        try {
          const utterance = (message ?? []).join(' ').trim()
          if (utterance === '') {
            throw new AskCommandError('missing-message', 'Say what you want done, e.g. agent-qa ask "status".')
          }

          const composition = compositionInput(command)
          const declaredSecrets = createDeclaredSecretMask(composition.configPath)
          // E3: refuse before a host is composed when the secrets file cannot be read.
          declaredSecrets.redactor()
          mask = declaredSecrets.mask
          const { registry } = composeCliLocalAgent({
            ...composition,
            declaredSecrets,
            chatPresent: chatPresentThrough(mask),
          })
          const result = (await invokeFunction(
            registry,
            AGENT_ASK_FUNCTION_ID,
            options.session === undefined
              ? { message: utterance }
              : { message: utterance, sessionId: options.session },
            CLI_FUNCTION_CALLER,
          )) as AgentAskResult

          emitHuman(mask, renderTurn(result))

          // Both non-success statuses raise; a refused-only turn exits 0, as the `fn` door does.
          if (result.status === 'fail_closed') {
            throw new AskCommandError(
              'fail-closed',
              result.unhandled?.reason
                ?? 'The turn was refused before anything ran, and nothing was carried out.',
            )
          }
          if (result.status === 'failed') {
            const failure = result.receipts.find((receipt) => receipt.status === 'failed')
            throw new AskCommandError(
              'clause-failed',
              `"${failure?.clause ?? utterance}" failed: ${failure?.outcome ?? 'unknown failure'}`,
            )
          }
        } catch (error) {
          reportError(error, mask)
        }
      },
    )
}
