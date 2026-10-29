// `agent-qa ask "<message>"` — the one-shot chat verb.
//
// A THIN CLIENT, on `fn.ts`'s idiom and for its reason. It resolves a root, composes the local
// host, and calls `invokeFunction` with `agent.ask`. It owns no turn capability of its own: the
// routing, the execution and the session log all live behind a registered op, so this file could
// be deleted and every one of them would still be reachable from the MCP surface, the daemon and
// the scenario harness (§3's L10 law made structural by D-24).
//
// THE ONE-SHOT AND THE REPL ARE THE SAME TURN. D-01's two surfaces exist so scripting and
// conversation do not diverge, and the mechanism for that is not discipline — it is that both go
// through this same op with the same input contract. `ask` is a single-turn session on the same
// log grammar, which is why it needs no special case in the adapter.
//
// NOTHING ASKS. The command used to inherit a terminal confirm from
// `composeCliLocalAgent`, and a scripted `ask` in CI failed closed at the op gate. Both are gone: a
// clause runs once, at a terminal and in CI alike, and the receipt says what it did.
//
// IT STILL SHOWS WHAT A TURN RENDERS MID-TURN. This command binds
// `chatPresent` on `process.stdout` — through the declared mask, unconditional — so a scaffold or a
// fan-out report a turn produces is in the transcript beside the receipts, exactly as the REPL
// prints it. And where a proposal cannot be displayed at all, the route refuses before dispatch
// (`turn-engine.ts`'s displayability precondition).

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
  // no minting surface — nothing is filed for a door to be named on.
  return {
    agentQaRoot: resolve(dirname(configPath), '.agent-qa'),
    configPath,
  }
}

function renderTurn(result: AgentAskResult): string {
  const lines = [pc.dim(`session ${result.sessionId} · turn ${result.turnId}`)]
  // A `--session` resume can land on a damaged log, and a scripted caller that heard nothing about
  // it would carry on against a conversation quietly missing part of itself.
  if (result.refusedLineCount !== undefined) {
    lines.push(
      pc.yellow(`${result.refusedLineCount} line(s) of this session could not be read.`),
    )
  }
  if (result.receipts.length > 0) {
    lines.push(...result.receipts.map(receiptLine))
  }
  // 399.1: the same payload block the REPL prints, from the same module — the one-shot
  // and the conversation are the same turn, and a scripted caller that was shown less than the
  // person at the prompt would be the drift D-01 forbids.
  lines.push(...renderClauseResults(result.results, result.receipts.length))
  if (result.answer !== undefined) lines.push(result.answer)
  return lines.join('\n')
}

// everything this file prints is masked and never restored.
function emitHuman(mask: MaskFn, text: string): void {
  printRunText(mask(text))
}

// the mid-turn render, on stdout and unconditional (piped stdin included).
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

          // A scripted `ask` whose request was not carried out must not look like success to the
          // shell that called it. Both non-success statuses raise, so the exit code and the
          // rendered receipts agree — reporting one without the other is how a CI step goes green
          // on a turn that refused everything.
          //
          // WHAT THIS GATE NOW SEES, AND WHAT IT DELIBERATELY DOES
          // NOT. Nothing below changed; what changed is upstream. The turn aggregate is derived
          // from the receipt vocabulary rather than from whether the op threw, so a `failed`
          // receipt — thrown OR returned — reaches the `clause-failed` branch below. Until then
          // that branch was dead for every returned failure: a typed refusal returns, the flag was
          // set only in the engine's catch, and a turn carrying a `failed` receipt exited 0.
          //
          // A REFUSED-ONLY TURN DELIBERATELY KEEPS THE SUCCESS EXIT. `refused` means the control
          // worked and the op answered, so it is not a failure to stop or to raise on; and
          // the `fn` door was measured exiting 0 on the identical blocked payload. E2E-02 clause 2
          // makes door DISAGREEMENT the defect class, so moving this door alone would mint a parity
          // break inside the phase that exists to close one. The refusal reaches a reader on the
          // receipt word, the rendered payload beneath it, and `agent.ask`'s own outer verdict.
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
