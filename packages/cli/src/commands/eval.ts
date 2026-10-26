// The `agent-qa eval` family: extract, replay and report. Each action resolves the session, calls
// its verb pipeline and renders from the returned DTO; `--json` prints only the DTO.

import { Command, InvalidArgumentError } from 'commander'
import pc from 'picocolors'
import { installEvalWarningLogger } from '../eval-warning-logger.js'
import { renderReportEvidenceLines, renderReportLabelMetricLines } from '../eval-report-render.js'
import type {
  BaselineComparatorRefusal,
  EvalCorpusSource,
  ExtractVerbResult,
  ReplayVerbResult,
  ReportVerbResult,
  SeedPolicy,
} from '../eval-session-composition.js'

// The auth.ts parent-opts idiom: the global `--config` lives on the program two levels above a
// nested subcommand (program > eval > extract).
function getGlobalConfigPath(command: Command): string | undefined {
  return command.parent?.parent?.opts<{ config?: string }>().config
    ?? command.parent?.opts<{ config?: string }>().config
}

/** Typed integer flag parser (D-08): a non-integer `--k`/`--seed` is a loud invalid-value error. */
function parseIntegerFlag(flagName: string): (value: string) => number {
  return (value: string): number => {
    if (!/^-?\d+$/.test(value.trim())) {
      throw new InvalidArgumentError(`${flagName} must be an integer, got "${value}".`)
    }
    return Number.parseInt(value.trim(), 10)
  }
}

/**
 * Typed `--source` parser (413 D-08, the parseIntegerFlag idiom): anything but the two literals is
 * a loud InvalidArgumentError.
 *
 * It is applied inside the ACTION rather than as commander's own option parser, because commander
 * maps a parser throw to `Command.error()` → `process.exit(1)`, and this family's D-08 contract is
 * `process.exitCode = 1` with the message on stderr — never `process.exit` (which would also take
 * the whole vitest worker down with it).
 */
function parseSourceFlag(value: string | undefined): EvalCorpusSource | undefined {
  if (value === undefined) return undefined
  if (value !== 'staged' && value !== 'committed') {
    throw new InvalidArgumentError(
      `--source must be "staged" or "committed", got "${value}".`,
    )
  }
  return value
}

/** Validate inside the action against the lazily imported canonical vocabulary (D-08). */
function parseSeedPolicyFlag(
  value: string | undefined, policies: readonly SeedPolicy[],
): SeedPolicy | undefined {
  if (value === undefined) return undefined
  const policy = policies.find(candidate => candidate === value)
  if (policy === undefined) {
    throw new InvalidArgumentError(
      `--seed-policy must be "none" or "declared", got "${value}".`,
    )
  }
  return policy
}

/** Render a Record counter as `reason=count …`, honest 'none' when empty (D-04). */
function renderCounters(counters: Record<string, number>): string {
  const rendered = Object.entries(counters)
    .map(([name, count]) => `${name}=${count}`)
    .join(' ')
  return rendered === '' ? pc.dim('none') : rendered
}

/** Compact replay summary rendered from the DTO fields only — a faithful projection (D-04). */
function renderReplaySummary(result: ReplayVerbResult): void {
  console.log(
    pc.bold(`replay: batch ${result.batchKey}`)
      + pc.dim(` (swept ${result.swept}, replayed ${result.replayed}, scored ${result.scored})`),
  )
  const spend = result.spend
  console.log(
    `replay seed=${spend.seed ?? 'none'}: decisions=${spend.decisions}`
      + ` modelCalls=${spend.modelCalls} promptTokens=${spend.promptTokens}`
      + ` completionTokens=${spend.completionTokens} wallClock=${spend.wallClockMs}ms`
      + ` seedHonored=${spend.seedHonored ?? 'unknown'}`,
  )
  console.log(
    'spend: modelCalls includes planner, judge and retries; tokens are persisted reported usage'
      + ` (planner samples=${spend.sampleCount}, missingUsage=${spend.samplesMissingTokenUsage};`
      + ` judge outcomes=${spend.judgeCost.calls}, inputTokens=${spend.judgeCost.inputTokens},`
      + ` outputTokens=${spend.judgeCost.outputTokens}, missingUsage=${spend.judgeCost.outcomesMissingUsage})`,
  )
  console.log(`load refusals: ${renderCounters(result.loadRefusals)}`)
  console.log(`replay refusals: ${renderCounters(result.replayRefusals)}`)
  const judge = result.judge
  const zeroTies =
    judge.invoked === 0
    && judge.settled === 0
    && judge.abstained === 0
    && judge.errors === 0
    && judge.notInvoked === 0
  console.log(
    `judge: ${judge.configured ? 'configured' : 'not configured'} — `
      + `${judge.invoked} invoked, ${judge.settled} settled, ${judge.abstained} abstained, `
      + `${judge.errors} errors, ${judge.notInvoked} not-invoked`
      + (zeroTies ? pc.dim(' (0 ties)') : ''),
  )
  for (const notice of result.notices) {
    console.log(pc.dim(notice))
  }
  console.log(pc.dim(`replays root: ${result.replaysRoot}`))
}

/** Sum a per-TieCause disposition group into one scalar for the compact summary line (D-04). */
function sumCounts(counts: Record<string, number>): number {
  return Object.values(counts).reduce((total, count) => total + count, 0)
}

/**
 * Compact report summary rendered from the DTO fields only — a faithful projection (D-04).
 *
 * `renderBaselineComparatorRefusal` arrives as a PARAMETER rather than a module import: eval
 * core reaches this surface only through the ledgered composition root (FUNC-02, and that ledger
 * only ever shrinks), and the root is imported lazily per action so `agent-qa --help` never pays
 * for the eval stack. The refusal is printed red on the surface a person actually reads, because
 * a same-family report silently failing to become the comparator is exactly the repudiation
 * D-20 exists to prevent (ROOT-11).
 */
function renderReportSummary(
  result: ReportVerbResult,
  renderBaselineComparatorRefusal: (refusal: BaselineComparatorRefusal) => string,
): void {
  const report = result.report
  console.log(
    pc.bold(`report: batch ${result.batchKey}`)
      + pc.dim(result.committedFile === undefined ? ` (${result.entries} entries)` : ' (committed report)'),
  )
  const accuracy = report.headline.firstAttemptDecisionAccuracy
  console.log(
    'headline: firstAttemptDecisionAccuracy '
      + `${accuracy.numerator}/${accuracy.denominator}`
      + (accuracy.rate === undefined ? ' (rate: n/a)' : ` (rate: ${accuracy.rate})`),
  )
  const cost = report.headline.perDecisionCost
  console.log(
    `per-decision cost: decisions=${cost.decisionCount} promptTokens=${cost.promptTokens} `
      + `completionTokens=${cost.completionTokens} totalTokens=${cost.totalTokens} `
      + `durationMs=${cost.durationMs}`,
  )
  for (const line of renderReportLabelMetricLines(report)) console.log(line)
  console.log(`ties: ${renderCounters(report.honesty.tieCounts)}`)
  console.log(`refusals: ${renderCounters(report.honesty.refusalCounts)}`)
  const judge = report.honesty.judge
  console.log(
    `judge: ${sumCounts(judge.invoked)} invoked, ${sumCounts(judge.settled)} settled, `
      + `${sumCounts(judge.abstained)} abstained, ${sumCounts(judge.errors)} errors, `
      + `${sumCounts(judge.notInvoked)} not-invoked`,
  )
  console.log(`judge identity: ${result.judgeIdentity}`)
  console.log(`source: ${result.source}`)
  for (const notice of result.notices) {
    console.log(pc.dim(notice))
  }
  if (result.stagedFile !== undefined) console.log(pc.dim(`staged file: ${result.stagedFile}`))
  if (result.committedFile !== undefined) console.log(pc.dim(`committed file: ${result.committedFile}`))
  if (result.committed !== undefined) {
    // D-08: write conflicts are DATA — rendered loudly, never exit 1.
    if (result.committed.kind === 'committed') {
      console.log(
        `committed: json ${result.committed.json}, markdown ${result.committed.markdown}`,
      )
      console.log(pc.dim(`report dir: ${result.committed.reportDir}`))
    } else {
      console.log(pc.red(`commit write-conflict: ${result.committed.path}`))
    }
  }
  for (const line of renderReportEvidenceLines(result)) console.log(line)
  const baseline = result.baseline
  if (baseline !== undefined) {
    // D-08/D-19: every designation outcome is DATA — loud where it must be, exit 0 throughout.
    if (baseline.kind === 'written' || baseline.kind === 'unchanged') {
      console.log(pc.dim(`baseline file: ${baseline.path}`))
    } else if (baseline.kind === 'refused') {
      console.log(pc.red(renderBaselineComparatorRefusal(baseline.refusal)))
    } else {
      console.log(pc.red(`baseline write-conflict: ${baseline.path}`))
    }
  }
}

/** Compact picocolors summary rendered from the DTO fields only — a faithful projection (D-04). */
function renderExtractSummary(result: ExtractVerbResult): void {
  console.log(
    pc.bold(`extract: swept ${result.runsSwept} run(s)`)
      + pc.dim(` (${result.runsSkipped.length} skipped, ${result.runsFiltered} filtered)`),
  )
  for (const skip of result.runsSkipped) {
    console.log(pc.yellow(`  skipped ${skip.runSlug}: ${skip.reason}`))
  }
  console.log(`cassettes written: ${result.cassettesWritten}`)
  const counters = Object.entries(result.completeness)
    .map(([name, count]) => `${name}=${count}`)
    .join(' ')
  console.log(`completeness: ${counters === '' ? pc.dim('none') : counters}`)
  console.log(pc.dim(`cassettes root: ${result.cassettesRoot}`))
}

export function createEvalCommand(): Command {
  const cmd = new Command('eval')
    .description('Replay recorded runs offline: extract, replay, report')
  let restoreWarningLogger: (() => void) | undefined
  cmd.hook('preAction', () => { restoreWarningLogger = installEvalWarningLogger() })
  cmd.hook('postAction', () => { restoreWarningLogger?.() })

  cmd.addCommand(
    new Command('extract')
      .description('Extract staged cassette bundles from recorded run handoffs')
      .option('--run <slug>', 'narrow to one recorded run')
      .option('--product <slug>', 'narrow by product scope')
      .option('--json', 'emit the typed result DTO to stdout')
      .action(
        async (
          opts: { run?: string; product?: string; json?: boolean },
          command: Command,
        ) => {
          try {
            const configPath = getGlobalConfigPath(command)
            const { resolveEvalSession, runExtractVerb } = await import(
              '../eval-session-composition.js'
            )
            const session = await resolveEvalSession(
              configPath === undefined ? {} : { configPath },
            )
            const result = await runExtractVerb(session, {
              ...(opts.run === undefined ? {} : { run: opts.run }),
              ...(opts.product === undefined ? {} : { product: opts.product }),
            })
            if (opts.json) {
              // D-04/Pitfall 11: exactly one JSON document on stdout — typed skips are DATA
              // inside the DTO, and any notice belongs on stderr.
              console.log(JSON.stringify(result, null, 2))
            } else {
              renderExtractSummary(result)
            }
          } catch (err) {
            // D-08: EvalNamedInputError and config/session resolution errors are the only
            // failure modes — the command layer maps them all to exit code 1.
            console.error(pc.red(err instanceof Error ? err.message : String(err)))
            process.exitCode = 1
          }
        },
      ),
  )

  cmd.addCommand(
    new Command('replay')
      .description('Replay staged cassette bundles through the production planner stack')
      .option('--run <slug>', 'narrow to cassettes extracted from one recorded run')
      .option('--cassette <id>', 'replay exactly one staged cassette by id')
      .option('--product <slug>', 'narrow by product scope')
      .option('--judge <name>', 'replace the configured judges (repeat for a panel)', collectJudgeName)
      .option('--k <n>', 'sample budget per cassette', parseIntegerFlag('--k'))
      .option('--seed <n>', 'replay sampling seed', parseIntegerFlag('--seed'))
      .option('--json', 'emit the typed result DTO to stdout')
      .action(
        async (
          opts: {
            run?: string
            cassette?: string
            product?: string
            judge?: string[]
            k?: number
            seed?: number
            json?: boolean
          },
          command: Command,
        ) => {
          try {
            const configPath = getGlobalConfigPath(command)
            const { resolveEvalSession, runReplayVerb } = await import(
              '../eval-session-composition.js'
            )
            // D-03: judge/k/seed flags flow into the session's field-wise flag merge — the verb
            // itself takes no judge/k/seed parameters.
            const session = await resolveEvalSession({
              ...(configPath === undefined ? {} : { configPath }),
              flags: {
                ...(opts.judge === undefined ? {} : { judge: opts.judge }),
                ...(opts.k === undefined ? {} : { k: opts.k }),
                ...(opts.seed === undefined ? {} : { seed: opts.seed }),
              },
            })
            const result = await runReplayVerb(session, {
              ...(opts.run === undefined ? {} : { run: opts.run }),
              ...(opts.cassette === undefined ? {} : { cassette: opts.cassette }),
              ...(opts.product === undefined ? {} : { product: opts.product }),
            })
            if (opts.json) {
              // D-04/Pitfall 11: exactly one JSON document on stdout — refusal counters, judge
              // dispositions, and notices are DATA inside the DTO; progress already rode stderr.
              console.log(JSON.stringify(result, null, 2))
            } else {
              renderReplaySummary(result)
            }
          } catch (err) {
            // D-08: typed named-input/config/auth errors are the only failure modes — refusal
            // counters and judge errors are data and never reach this catch.
            console.error(pc.red(err instanceof Error ? err.message : String(err)))
            process.exitCode = 1
          }
        },
      ),
  )

  cmd.addCommand(
    new Command('report')
      .description('Assemble a replay report or designate an already-committed baseline')
      .option('--run <slug>', 'narrow to records extracted from one recorded run')
      .option('--cassette <id>', 'report over exactly one persisted record by cassette id')
      .option('--product <slug>', 'narrow by product scope')
      .option('--commit', 'also write report.json + report.md + decisions.json into the committed root (D-13)')
      .option(
        '--source <source>',
        'cassette source: staged (default) or committed (the whole agent-qa-eval corpus, D-08)',
        'staged',
      )
      .option(
        '--baseline',
        'with --commit or --from-committed, designate the per-profile baseline pointer under '
          + 'reports/baselines/ (D-19); refused for same-family reports (ROOT-11)',
      )
      .option('--from-committed <batchKey>', 'designate this committed report without replay assembly; requires --baseline and --seed-policy')
      .option('--seed-policy <none|declared>', 'explicit policy for --from-committed designation')
      .option('--json', 'emit the typed result DTO to stdout')
      .action(
        async (
          opts: {
            run?: string
            cassette?: string
            product?: string
            commit?: boolean
            source?: string
            baseline?: boolean
            fromCommitted?: string
            seedPolicy?: string
            json?: boolean
          },
          command: Command,
        ) => {
          try {
            const source = parseSourceFlag(opts.source)
            const configPath = getGlobalConfigPath(command)
            const { resolveEvalSession, runReportVerb, renderBaselineComparatorRefusal, SEED_POLICIES } =
              await import('../eval-session-composition.js')
            const seedPolicy = parseSeedPolicyFlag(opts.seedPolicy, SEED_POLICIES)
            const session = await resolveEvalSession(
              configPath === undefined ? {} : { configPath },
            )
            const result = await runReportVerb(
              session,
              {
                ...(opts.run === undefined ? {} : { run: opts.run }),
                ...(opts.cassette === undefined ? {} : { cassette: opts.cassette }),
                ...(opts.product === undefined ? {} : { product: opts.product }),
              },
              {
                ...(opts.commit === undefined ? {} : { commit: opts.commit }),
                ...(source === undefined ? {} : { source }),
                ...(opts.baseline === undefined ? {} : { baseline: opts.baseline }),
                ...(opts.fromCommitted === undefined ? {} : { fromCommitted: opts.fromCommitted }),
                ...(seedPolicy === undefined ? {} : { seedPolicy }),
              },
            )
            if (opts.json) {
              // D-04/Pitfall 11: exactly one JSON document on stdout — the committed outcome
              // (incl. write conflicts) is DATA inside the DTO (D-08).
              console.log(JSON.stringify(result, null, 2))
            } else {
              renderReportSummary(result, renderBaselineComparatorRefusal)
            }
          } catch (err) {
            // D-08: typed named-input/config errors are the only failure modes — write-conflict
            // committed outcomes are data and never reach this catch.
            console.error(pc.red(err instanceof Error ? err.message : String(err)))
            process.exitCode = 1
          }
        },
      ),
  )

  return cmd
}

function collectJudgeName(name: string, previous: string[] = []): string[] {
  return [...previous, name]
}
