import { dirname, resolve } from 'node:path'
import { invokeFunction, RUNS_MARK_FUNCTION_ID } from '@vostride/agent-qa-agent'
import { MARKS, RunsMarkOutcomeSchema, type RunsMarkOutcome } from '@vostride/agent-qa-schema'
import { Command, InvalidArgumentError, Option } from 'commander'
import { CLI_FUNCTION_CALLER, composeCliLocalAgent } from '../composition/local-agent-host.js'
import { registerRunReadCommands } from './runs-read.js'

export function renderMarkOutcome(dto: RunsMarkOutcome): string {
  if (dto.kind === 'already-marked') return `already marked: identical repeat — receipt ${dto.receipt.markId} #${dto.receipt.ordinal}`
  if (dto.kind === 'marked') {
    const r = dto.receipt
    const d = r.disposition
    const disposition = d.kind === 'quarantined' ? `quarantined: ${d.class}`
      : d.kind === 'applied' ? (d.change.kind === 'knowledge'
        ? `applied ${d.fix}: ${d.change.recordIds.length === 0 ? 'no record changed' : `changed ${d.change.recordIds.join(', ')}`}`
        : `applied ${d.fix}: wrote ${d.change.filePath}`)
      // A pre-432 receipt read back from an existing ledger; no writer produces it now.
      : d.kind === 'drafted' ? `drafted: ${d.fix} (recorded before fixes applied directly)`
      : d.kind === 'no-draftable-fix' ? 'no draftable fix'
      : d.kind === 'not-applied' ? `${d.fix} not applied: ${d.reason}`
      : `confirmed-bug: ${d.confirmedRecords} record(s) confirmed`
    return `marked ${r.kind} on ${r.runId} test ${r.testIndex}${r.stepIndex === undefined ? '' : ` step ${r.stepIndex}`} · ${disposition} · receipt ${r.markId} #${r.ordinal}`
  }
  if (dto.kind === 'ambiguous-address') return `ambiguous address on ${dto.runId}: ${dto.candidates.map(c => `test ${c.testIndex}${c.testId === undefined ? '' : ` (--test ${c.testId})`}`).join(', ')}`
  if (dto.kind === 'step-not-found') return `step ${dto.stepIndex} not found on ${dto.runId} test ${dto.testIndex} (${dto.stepCount} steps)`
  if (dto.kind === 'member-not-found') return `member ${dto.testId ?? '(unspecified)'} not found on ${dto.runId}`
  return `run not found: ${dto.runId}`
}

export function createRunsCommand(): Command {
  const command = new Command('runs').description('Review recorded runs')
  command.command('mark <runId>')
    .description('Mark a recorded outcome and apply its fix when attributable')
    .addOption(new Option('--kind <kind>', 'user mark').choices([...MARKS]).makeOptionMandatory())
    .option('--test <testId>', 'address one test in a multi-test run')
    .option('--step <n>', 'zero-based step index', value => {
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new InvalidArgumentError('step must be a non-negative integer')
      return Number(value)
    })
    .option('--note <text>', 'optional context')
    .option('--json', 'output the schema-validated receipt')
    .action(async (runId: string, options, cmd: Command) => {
      let host: ReturnType<typeof composeCliLocalAgent> | undefined
      try {
        const configPath = resolve(cmd.optsWithGlobals<{ config?: string }>().config ?? 'agent-qa.config.yaml')
        host = composeCliLocalAgent({ configPath, agentQaRoot: resolve(dirname(configPath), '.agent-qa') })
        const dto = RunsMarkOutcomeSchema.parse(await invokeFunction(host.registry, RUNS_MARK_FUNCTION_ID, {
          runId, kind: options.kind,
          ...(options.test === undefined ? {} : { testId: options.test }),
          ...(options.step === undefined ? {} : { stepIndex: options.step }),
          ...(options.note === undefined ? {} : { note: options.note }),
        }, CLI_FUNCTION_CALLER))
        console.log(options.json === true ? JSON.stringify(dto) : renderMarkOutcome(dto))
        if (dto.kind !== 'marked' && dto.kind !== 'already-marked') process.exitCode = 1
      } catch (error) {
        console.error(`agent-qa runs mark: ${error instanceof Error ? error.message : String(error)}`)
        process.exitCode = 1
      } finally { host?.close() }
    })
  registerRunReadCommands(command)
  return command
}
