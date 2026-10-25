// The `agent-qa eval` command family (Phase 372, D-01): the CLI face of the offline eval
// substrate. 372-05 landed the family skeleton plus `extract`; 372-06 adds `replay`; seed/
// report join in 372-07 against this shape — no stub subcommands. The command layer is a thin
// projection: it resolves the session, calls the ONE verb pipeline in eval-session-composition,
// and renders FROM the returned DTO (D-04) — `--json` emits exactly the DTO on stdout with
// nothing else (Pitfall 11). Errors map to `process.exitCode = 1` (D-08), never `process.exit`.

import { Command, InvalidArgumentError } from 'commander'
import pc from 'picocolors'
import { installEvalWarningLogger } from '../eval-warning-logger.js'
import { renderCensusFloorLines, renderFloorSummary, renderReportEvidenceLines, renderReportLabelMetricLines } from '../eval-report-render.js'
import type {
  BaselineComparatorRefusal,
  CalibrateVerbResult,
  CensusVerbResult,
  EvalCorpusSource,
  ExtractVerbResult,
  ReplayVerbResult,
  ReportVerbResult,
  SeedPolicy,
  SeedVerbResult,
  SeedFromFeedbackVerbResult,
  AdversarialVerbResult,
} from '../eval-session-composition.js'

// The auth.ts parent-opts idiom: the global `--config` lives on the program two levels above a
// nested subcommand (program > eval > extract).
function getGlobalConfigPath(command: Command): string | undefined {
  return command.parent?.parent?.opts<{ config?: string }>().config
    ?? command.parent?.opts<{ config?: string }>().config
}

function renderFeedbackSeedSummary(result: SeedFromFeedbackVerbResult): void {
  if (result.kind === 'nothing-staged') { console.log(`no staged feedback under ${result.stagingDir}`); return }
  if (result.reason !== undefined) console.log(`feedback admission refused: ${result.reason}`)
  for (const entry of result.entries) console.log(`${result.kind === 'dry-run' ? 'would admit' : 'admitted'} ${entry.cassetteId} natural source=canary-feedback benefit=${entry.benefit} from ${entry.runId}#${entry.stepIndex}`)
  for (const refusal of result.refusals) console.log(`refused ${refusal.product}/${refusal.cassetteId}: ${refusal.kind}`)
  if (result.previousCorpusDigest !== undefined) console.log(`corpus digest ${result.previousCorpusDigest} → ${result.kind === 'dry-run' ? 'unchanged (dry-run)' : result.nextCorpusDigest ?? 'unavailable'}`)
  for (const failure of result.failures) console.log(`feedback ${failure.phase}: ${failure.reason}${'cassetteId' in failure && failure.cassetteId !== undefined ? ` (${failure.cassetteId})` : ''}`)
  console.log(`standing receipts that will read receipt-stale: ${result.staleReceipts === null ? 'unknown (final corpus digest unavailable)' : result.staleReceipts.length}`)
  for (const receipt of result.staleReceipts ?? []) console.log(`${receipt.candidateId} gate ${receipt.gate} ${receipt.verdict}`)
  if (result.failures.length && result.writesStarted) {
    console.log(`Writes began; inspect the admitted entries and remaining staging at ${result.stagingDir}. Resolve the reported filesystem issue, then preview remaining feedback with eval seed --from-feedback --dry-run. Recheck the corpus digest before measuring the floor.`)
  }
  console.log(`re-measure the floor: ${result.floorCommand}`)
}

/**
 * 422 D-01/D-02: faithful projection of the adversarial verb DTO — stage counts, the reviewed
 * batch digest the operator passes back to `--admit`, every typed refusal and skip, and the
 * floor re-measure command an admission owes (415 D-12 / 418 D-21 idiom).
 */
function renderAdversarialSummary(result: AdversarialVerbResult): void {
  if (result.retirement !== undefined) {
    console.log(`adversarial admission refused: retired ${result.product}/${result.batchDigest}`)
    console.log(`retirement record: ${result.retirement.retirementRecordPath}; writesStarted: false`)
    console.log('Retirement admits nothing; settled seeds and probe spend stay consumed. No new receipt or floor staleness was caused; existing stale evidence is not refreshed.')
    return
  }
  if (result.lifecycleBusy !== undefined) console.log(`batch lifecycle busy at ${result.lifecycleBusy.lockPath}; retry after its owner finishes`)
  if (result.reason !== undefined) console.log(`adversarial ${result.kind}: ${result.reason}`)
  if (result.kind === 'nothing-derived') console.log(`no new adversarial variants for ${result.product}`)
  if (result.tableVersion !== undefined) {
    console.log(`tables v${result.tableVersion} ${result.tableHash ?? ''}`.trimEnd())
  }
  for (const row of result.staged) {
    console.log(`staged ${row.cassetteId} ${adversarialProvenanceOf(row)} from ${row.seedCassetteId}`)
  }
  for (const row of result.admitted) {
    console.log(`admitted ${row.cassetteId} ${adversarialProvenanceOf(row)} from ${row.seedCassetteId}`)
  }
  // Four counts, four lines: an unchanged member moved no digest and a remaining one has not
  // landed, and folding either into "admitted" is how a partial admission reads as a whole one.
  for (const row of result.unchanged) console.log(`unchanged ${row.cassetteId} (already committed byte-identically)`)
  for (const row of result.remaining) console.log(`remaining ${row.cassetteId} (reviewed, not yet committed)`)
  for (const refusal of result.refusals) {
    console.log(`refused ${refusal.cassetteId}: ${refusal.detector} ${refusal.action} (seed ${refusal.seedCassetteId})`)
  }
  for (const row of result.settledRefusals) {
    console.log(`settled refusal ${row.seedCassetteId} ${row.mutator}: ${row.detector ?? 'policy'} (decided by an earlier refresh)`)
  }
  for (const skip of result.stagingSkips) console.log(`skipped ${skip.cassetteId}: ${skip.reason}`)
  const seedSkips = result.skips.reduce<Record<string, number>>((counts, skip) => {
    counts[skip.reason] = (counts[skip.reason] ?? 0) + 1
    return counts
  }, {})
  // D-09/D-10: what this refresh spent, and — when it spent nothing — WHY. An empty probe list
  // with no gap line cannot be told apart from a host that simply had nothing new to author.
  if (result.noProbeModel !== undefined) {
    console.log(`no probe model: ${result.noProbeModel.reason} (deterministic families are unaffected)`)
  }
  if (result.authoringModel !== undefined) {
    console.log(`probe author family ${result.authoringModel.family}`)
  }
  // `usageKnown` is a STATEMENT, and this is the line that has to make it. Printing the raw
  // totals unqualified when at least one answered call reported no usage renders an unknown
  // charge as a measured one, which is the single thing the field exists to prevent.
  console.log(
    `probe calls ${result.spend.modelCalls}/${result.probeCap.value} (${result.probeCap.source}); `
      + (result.spend.usageKnown
        ? `reported tokens ${result.spend.promptTokens} in, ${result.spend.completionTokens} out`
        : `reported tokens unavailable (at least one call reported no usage);`
          + ` partial totals ${result.spend.promptTokens} in, ${result.spend.completionTokens} out`),
  )
  for (const row of result.probeRefusals) {
    console.log(`probe refused ${row.seedCassetteId} ${row.kind} v${row.promptVersion}: ${row.reason}`)
  }
  const probeSkips = result.probeSkips.reduce<Record<string, number>>((counts, skip) => {
    counts[skip.reason] = (counts[skip.reason] ?? 0) + 1
    return counts
  }, {})
  if (result.probeSkips.length > 0) console.log(`probe tuples not authored ${renderCounters(probeSkips)}`)
  console.log(`seed cap ${result.cap.value} (${result.cap.source}); eligible ${result.eligibleSeeds}`)
  console.log(`seeds considered ${result.seedsConsidered}, deferred ${result.seedsDeferred}, skips ${renderCounters(seedSkips)}`)
  if (result.batchDigest !== undefined) {
    console.log(`batch ${result.batchDigest}`)
    if (result.admitted.length === 0 && result.staged.length > 0) {
      // The admit branch resolves the batch under `<stagingRoot>/<product>/<digest>`, so the
      // product has to ride the hint. Without it the CLI falls to its own `default` product and
      // a batch staged under any other one answers `batch-not-found` — a command that reads as
      // if it should work and cannot. Invisible on a `default` host, which is why it survived.
      console.log(`review ${result.stagingDir}/${result.batchDigest}, then admit with: eval adversarial --product ${result.product} --admit --batch ${result.batchDigest}`)
    }
  }
  if (result.previousCorpusDigest !== undefined) {
    console.log(`corpus digest ${result.previousCorpusDigest} → ${result.nextCorpusDigest ?? 'unchanged'}`)
  }
  if (result.admitted.length > 0) {
    // Disclosure, never repair: admission names the standing measurements its digest move
    // invalidated and hands back the command. It rewrites no floor and re-points no baseline —
    // silently re-measuring against the corpus the operator just changed would destroy the only
    // evidence the change mattered (415 D-12).
    console.log(`standing receipts that will read receipt-stale: ${result.staleReceipts === null ? 'unknown (final corpus digest unavailable)' : result.staleReceipts.length}`)
    for (const receipt of result.staleReceipts ?? []) {
      console.log(`${receipt.candidateId} gate ${receipt.gate} ${receipt.verdict}`)
    }
    console.log('the noise floor and any designated baseline were measured against the previous digest; neither is rewritten here')
    console.log(`re-measure the floor: ${result.floorCommand}`)
  }
  if (result.remaining.length > 0 && result.writesStarted) {
    console.log(`Writes began and ${result.remaining.length} reviewed case(s) did not land. The reviewed batch is still at ${result.stagingDir}/${result.batchDigest ?? ''}. Resolve the reported issue, then re-run: eval adversarial --admit --batch ${result.batchDigest ?? '<digest>'}`)
  }
}

/**
 * 422 D-05/D-11: one line, two provenance shapes.
 *
 * A table variant is named by its family and the entry that was drawn; a probe has neither and
 * is named by the frozen prompt generation it was authored under. Printing `undefined/kind` for
 * a probe would make a real derivation look like a broken one.
 */
function adversarialProvenanceOf(row: AdversarialVerbResult['staged'][number]): string {
  return row.mutator === undefined
    ? `probe/${row.kind} (prompt v${String(row.promptVersion ?? 0)})`
    : `${row.mutator}/${row.kind} (${row.tableEntryId ?? ''})`
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

/** Parse inside the action so an invalid protocol remains a typed invocation failure. */
function parseFloorSeeds(value: string | undefined): number[] | undefined {
  if (value === undefined) return undefined
  const seeds = value.split(',').map(parseIntegerFlag('--seeds'))
  if (new Set(seeds).size < 2) {
    throw new InvalidArgumentError('FLOOR_PROTOCOL_MINIMUM: --seeds requires at least two distinct integers')
  }
  return seeds
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

/**
 * Typed fraction flag reader (414 D-07, the parseSourceFlag idiom — validated inside the ACTION,
 * never as a commander option parser, so a bad value sets `process.exitCode = 1` rather than
 * calling `process.exit`).
 *
 * Only NUMBER-ness is decided here. RANGE is the partition manifest guard's job: it already pins
 * both fractions strictly inside (0, 1) for the committed document, and its TypeError lands in
 * the same catch. Re-deciding the range here would mint a second, drift-prone spelling of the
 * bound that actually governs the bytes.
 */
function parseFractionFlag(flagName: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    throw new Error(
      `${flagName} must be a number strictly between 0 and 1, got "${value}".`,
    )
  }
  return parsed
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
  console.log(`source: ${result.source}`)
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

/** Compact seed summary rendered from the DTO fields only — a faithful projection (D-04). */
function renderSeedSummary(result: SeedVerbResult): void {
  console.log(
    pc.bold(`seed: ${result.handoffsSeeded} handoff(s) seeded`)
      + pc.dim(
        ` (swept ${result.runsSwept}, ${result.runsSkipped.length} skipped, `
          + `${result.runsFiltered} filtered)`,
      ),
  )
  for (const skip of result.runsSkipped) {
    console.log(pc.yellow(`  skipped ${skip.runSlug}: ${skip.reason}`))
  }
  // 413 D-04: an excluded run is COUNTED and named with the verdicts that excluded it, and every
  // admitted run discloses the producer it was admitted under — never a silent filter.
  const excludedByClass: Record<string, number> = {}
  for (const excluded of result.runsExcluded) {
    for (const verdict of excluded.verdicts) {
      excludedByClass[verdict.class] = (excludedByClass[verdict.class] ?? 0) + 1
    }
  }
  console.log(
    `excluded: ${result.runsExcluded.length} (${renderCounters(excludedByClass)}), `
      + `admitted: ${result.runsAdmitted.length}`,
  )
  for (const excluded of result.runsExcluded) {
    console.log(
      pc.dim(
        `  excluded ${excluded.runSlug} [${excluded.product}]: `
          + excluded.verdicts.map(verdict => `${verdict.class}/${verdict.producer}`).join(' '),
      ),
    )
  }
  for (const notice of result.notices) {
    console.log(pc.dim(notice))
  }
  console.log(`cases: ${result.seededCount} seeded, ${result.unchangedCount} unchanged`)
  const refusalsByKind: Record<string, number> = {}
  for (const refusal of result.refusals) {
    refusalsByKind[refusal.kind] = (refusalsByKind[refusal.kind] ?? 0) + 1
  }
  console.log(`refusals: ${renderCounters(refusalsByKind)}`)
  console.log(
    `pairs: ${result.pairCounts.total} total (${result.pairCounts.sameState} same-state, `
      + `${result.pairCounts.differingState} differing-state), ${result.pairSkips} pair skips`,
  )
  console.log(`silver exclusions: ${result.silverExclusions}`)
  // 414 D-06/D-17: one line per product partition, carrying the salt DIGEST only — the raw salt
  // never leaves the committed manifest file. `- none` when empty, never a silent omission.
  console.log('partitions:')
  if (result.partitions.length === 0) {
    console.log(pc.dim('  - none'))
  }
  for (const partition of result.partitions) {
    console.log(
      `  ${partition.product}: held-out ${partition.heldOutFraction}, `
        + `private ${partition.privateFraction}, salt sha256 ${partition.saltDigest} `
        + `(${partition.outcome}, ${partition.path})`,
    )
  }
  // 414 D-02: every run the D-04 filter dropped left a committed provenance file — echo each.
  console.log('exclusions written:')
  if (result.exclusionsWritten.length === 0) {
    console.log(pc.dim('  - none'))
  }
  for (const exclusion of result.exclusionsWritten) {
    console.log(`  ${exclusion.path} (${exclusion.outcome})`)
  }
  console.log(`contracts: ${renderCounters(result.contracts)}`)
  console.log(`scaffold: ${renderCounters(result.scaffold)}`)
  console.log(pc.dim(`committed root: ${result.committedRoot}`))
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

/**
 * Compact census summary rendered from the DTO fields only — a faithful projection (D-04).
 *
 * D-16 discipline: every number is copied from the census or the committed floor disclosure;
 * nothing is summed, rated or derived at the console. The cross-check
 * reconciliation lines and any comparator refusal ride in `notices`, so a same-family report is
 * disclosed on EVERY census run to the person actually reading the output (D-20, T-413-22).
 */
function renderCensusSummary(result: CensusVerbResult): void {
  const census = result.census
  const products = Object.keys(census.products).sort()
  console.log(
    pc.bold(`census: corpus ${result.corpusDigest}`)
      + pc.dim(
        ` (${result.entryCount} entries, products ${products.length === 0 ? 'none' : products.join(', ')})`,
      ),
  )
  for (const product of products) {
    const block = census.products[product]!
    console.log(
      `${product}: total=${block.total} `
        + `tier1=${block.scorableByTier.tier1} tier2=${block.scorableByTier.tier2} `
        + `tier3=${block.scorableByTier.tier3} goldEvidence=${block.goldEvidence} `
        + `proof=${block.proofCoverage.numerator}/${block.proofCoverage.denominator} `
        + `populatedBrief=${block.briefContent['populated-brief']} `
        + `blobsLocal=${block.blobsPresentLocally.numerator}/${block.blobsPresentLocally.denominator} `
        + `runsExcluded=${renderCounters(block.runsExcluded)} `
        + `rungs=${renderCounters(block.rungMix)}`,
    )
    // 422 D-05/D-08: printed only when the product actually holds a committed adversarial
    // member. A line of zeros here would tell the reader a refresh happened and yielded nothing.
    // The table and probe arms stay side by side and are never added together.
    const mix = block.adversarialGenerationMix
    if (mix !== undefined) {
      console.log(
        `${product} adversarial generation: total=${mix.total} `
          + `provenance=${renderCounters(mix.byProvenance)} `
          + `tableVersions=${renderCounters({ ...mix.byTableVersion })} `
          + `mutators=${renderCounters(mix.byMutator)} `
          + `promptVersions=${renderCounters({ ...mix.byPromptVersion })} `
          + `authoringModels=${renderCounters({ ...mix.byAuthoringModel })}`,
      )
    }
  }
  const campaign = census.campaign
  if (!campaign.present) {
    console.log('campaign: none supplied')
  } else {
    console.log(
      `campaign: legs=${campaign.legs} seeded=${campaign.runsSeeded} `
        + `excluded=${campaign.runsExcluded} modelCalls=${campaign.modelCalls} `
        + `promptTokens=${campaign.promptTokens} completionTokens=${campaign.completionTokens} `
        + `wallClockMs=${campaign.wallClockMs}`,
    )
  }
  for (const line of renderCensusFloorLines(result)) console.log(line)
  for (const notice of result.notices) {
    // A comparator refusal is the one notice that must not read like housekeeping (ROOT-11).
    console.log(
      notice.startsWith('baseline comparator refused') ? pc.red(notice) : pc.dim(notice),
    )
  }
  if (result.committed !== undefined) {
    // 372 D-08: write conflicts are DATA — rendered loudly, never exit 1.
    if (result.committed.kind === 'committed') {
      console.log(
        `committed: json ${result.committed.json}, markdown ${result.committed.markdown}`,
      )
      console.log(pc.dim(`census dir: ${result.committed.censusDir}`))
    } else {
      console.log(pc.red(`commit write-conflict: ${result.committed.path}`))
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

function renderCalibrationSummary(result: Extract<CalibrateVerbResult, { artifact: unknown }>): void {
  const report = result.artifact
  console.log(`calibrate: ${result.kind} minGold=${report.minGold.value} (${report.minGold.source})`)
  console.log('Precision on selected operator marks; not an unbiased estimate for all runtime traffic.')
  for (const channel of ['recorded-verdict', 'self-heal-pair'] as const) {
    const row = report.channels[channel]
    console.log(`${channel}: ${row.status} n_gold=${row.n_gold} precision=${row.status === 'calibrated' ? row.precision : 'unavailable (below minimum)'} interval=${row.status === 'calibrated' ? `[${row.wilson95.lower},${row.wilson95.upper}]` : 'unavailable (below minimum)'}`)
  }
  for (const channel of ['user-mark', 'overturned-verdict'] as const) {
    const row = report.channels[channel]
    console.log(`${channel}: n_gold=${row.n_gold} precision=${row.precision}`)
  }
  for (const [name, row] of [['false-pass', report.verifierFalsePassRate], ['false-fail', report.verifierFalseFailRate]] as const) {
    console.log(`verifier ${name}: ${row.numerator}/${row.denominator} rate=${row.rate ?? 'unavailable (zero denominator)'}`)
  }
  console.log(`classifier grain: ${report.rootCauseClassifierGrain}`)
  for (const [producer, row] of Object.entries(report.rootCauseClassifierAccuracy)) {
    console.log(`${producer}: ${row.correct}/${row.n} accuracy=${row.accuracy ?? 'unavailable (zero denominator)'}`)
  }
  console.log(`SOFT refreshedCount=${result.refreshedCount}`)
  console.log('SOFT verdict and capability factors remain provisional evidence discounts, not measured recovery probabilities.')
}

export function createEvalCommand(): Command {
  const cmd = new Command('eval')
    .description('Eval corpus and release measurements: extract, replay, seed, calibrate, report, census, floor, gate')
  let restoreWarningLogger: (() => void) | undefined
  cmd.hook('preAction', () => { restoreWarningLogger = installEvalWarningLogger() })
  cmd.hook('postAction', () => { restoreWarningLogger?.() })

  cmd.addCommand(new Command('calibrate')
    .description('Preview label precision and SOFT weight refresh, or probe judge-panel agreement with --judge-panel; publish only with --commit')
    .option('--commit', 'publish checked label revisions and their calibration artifact, or reports/judge-calibration/<profile>.json with --judge-panel')
    .option('--replace', 'with --commit, replace the selected mode’s divergent calibration artifact')
    .option('--min-gold <n>', 'minimum joined gold sources per channel (recorded default: 20; minimum: 2)')
    .option('--judge-panel', 'probe the explicit judge panel against executable gold; preview incurs bounded model calls')
    .option('--min-n <n>', 'minimum independent judge observations (recorded default: 20; minimum: 2)')
    .option('--json', 'emit the typed result DTO to stdout')
    .action(async (opts: { commit?: boolean; replace?: boolean; minGold?: string; judgePanel?: boolean; minN?: string; json?: boolean }, command: Command) => {
      if (opts.judgePanel || opts.minN !== undefined) {
        let result: import('../eval-session-composition.js').JudgeCalibrateVerbResult | { kind: 'refused'; reason: string }
        const minN = opts.minN === undefined ? undefined : Number(opts.minN)
        if (!opts.judgePanel || opts.minGold !== undefined) {
          result = { kind: 'refused', reason: '--min-n requires --judge-panel; --min-gold is only for label calibration.' }
        } else if (opts.minN !== undefined && (!/^\d+$/.test(opts.minN.trim()) || !Number.isSafeInteger(minN) || minN! < 2)) {
          result = { kind: 'refused', reason: '--min-n must be a safe integer of at least 2.' }
        } else if (opts.replace && !opts.commit) {
          result = { kind: 'refused', reason: '--replace requires --commit.' }
        } else {
          try {
            const { resolveEvalSession, runJudgeCalibrateVerb } = await import('../eval-session-composition.js')
            const session = await resolveEvalSession({ configPath: getGlobalConfigPath(command) })
            result = await runJudgeCalibrateVerb(session, { minN, commit: opts.commit, replace: opts.replace })
          } catch {
            result = { kind: 'refused', reason: 'Judge calibration unavailable; check the selected config and local corpus permissions, then retry.' }
          }
        }
        if (opts.json) console.log(JSON.stringify(result, null, 2))
        else if (!('status' in result) && !('artifact' in result)) console.error(`calibrate: ${result.kind} — ${'reason' in result ? result.reason : result.path}`)
        else {
          const report = 'artifact' in result ? result.artifact : result
          console.log(`judge panel: ${report.status} n=${report.n} minN=${report.minN} (${report.minNSource})`)
          if (report.status === 'capability-gap') {
            console.log(`capability gap: ${report.reason}`)
            if (report.reason === 'panel-not-configured') console.log('Configure at least two explicit eval.judges entries naming registry.llms members.')
            for (const entry of 'entries' in result ? result.entries ?? [] : []) {
              if (entry.failures.length) console.log(`member ${entry.index + 1}: ${entry.name}${entry.modelId ? ` (${entry.modelId})` : ''}; credential=${entry.credential}; ${entry.failures.join(', ')}`)
            }
          }
          else {
            console.log(`selected=${report.counts.selected} admitted=${report.counts.admitted} eligible=${report.counts.eligible} refused=${report.counts.eligibilityRefused} attempted=${report.counts.attempted}`)
            console.log(`evidence-skipped=${report.counts.evidenceSkipped} truth-comparable=${report.counts.truthComparable} unresolved-truth=${report.counts.unresolvedTruth}; use --json for per-member denominators and skip reasons.`)
            console.log(`pooled agreement=${report.pooledAgreement ?? 'unavailable'} interval=${report.wilson95 ? `[${report.wilson95.lower},${report.wilson95.upper}]` : 'unavailable'}; abstention=${report.abstention.numerator}/${report.abstention.denominator}; member-pair disagreement=${report.disagreement.numerator}/${report.disagreement.denominator}`)
          }
          console.log(`probe calls: ${report.cost.usage.calls}; bound=${report.cost.callBound} (eligible executable decisions × one question × members × two swaps)`)
          // 422 D-12: the circularity disclosure, rendered by the composition root's single
          // function so the staged preview and the stored artifact print identical lines.
          const { renderJudgeTargetedCalibration } = await import('../eval-session-composition.js')
          for (const line of renderJudgeTargetedCalibration(report.judgeTargeted)) console.log(line)
          console.log('Agreement on selected executable gold; not a population accuracy estimate.')
          console.log('path' in result ? `artifact: ${result.kind} ${result.path}` : 'No committed artifact created.')
        }
        if (!('status' in result) && !('artifact' in result)) process.exitCode = 1
        return
      }
      let result: CalibrateVerbResult
      const minGold = opts.minGold === undefined ? undefined : Number(opts.minGold)
      if (opts.minGold !== undefined && (!/^\d+$/.test(opts.minGold.trim()) || !Number.isSafeInteger(minGold) || minGold! < 2)) {
        result = { kind: 'refused', reason: '--min-gold must be a safe integer of at least 2.' }
      } else if (opts.replace && !opts.commit) {
        result = { kind: 'refused', reason: '--replace requires --commit.' }
      } else {
        try {
          const { resolveEvalSession, runCalibrateVerb } = await import('../eval-session-composition.js')
          const session = await resolveEvalSession({ configPath: getGlobalConfigPath(command), keyOnly: true })
          result = await runCalibrateVerb(session, { commit: opts.commit, replace: opts.replace, minGold })
        } catch {
          result = { kind: 'refused', reason: 'Calibration unavailable; check the selected config and local corpus permissions, then retry.' }
        }
      }
      if (opts.json) console.log(JSON.stringify(result, null, 2))
      else if ('artifact' in result) renderCalibrationSummary(result)
      else console.error(`calibrate: ${result.kind} — ${result.reason}`)
      if (!('artifact' in result)) process.exitCode = 1
    }))

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
      .option(
        '--source <source>',
        'cassette source: staged (default) or committed (the whole agent-qa-eval corpus, D-08)',
        'staged',
      )
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
            source?: string
            json?: boolean
          },
          command: Command,
        ) => {
          try {
            const source = parseSourceFlag(opts.source)
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
            const result = await runReplayVerb(
              session,
              {
                ...(opts.run === undefined ? {} : { run: opts.run }),
                ...(opts.cassette === undefined ? {} : { cassette: opts.cassette }),
                ...(opts.product === undefined ? {} : { product: opts.product }),
              },
              { ...(source === undefined ? {} : { source }) },
            )
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
    new Command('seed')
      .description('Commit measurement corpus cases into the reviewed committed root (explicit, D-01)')
      .option('--from-feedback', 'admit the staged natural feedback batch')
      .option('--dry-run', 'preview feedback admission without writing')
      .option('--run <slug>', 'narrow to one recorded run')
      .option('--product <slug>', 'narrow by product scope')
      .option('--silver-cap <n>', 'per-test silver cap override', parseIntegerFlag('--silver-cap'))
      // 414 D-07: both fractions are plain STRINGS here and are validated inside the action
      // (413-06 house rule — a parser throw routes to process.exit(1), bypassing the D-08 catch).
      .option(
        '--held-out-fraction <f>',
        "share of the product's cassettes leaving natural — REQUIRED on a product's first "
          + 'partition (414 D-07)',
      )
      .option(
        '--private-fraction <f>',
        'share OF the held-out portion that is private — REQUIRED on first partition (414 D-07)',
      )
      .option('--json', 'emit the typed result DTO to stdout')
      .action(
        async (
          opts: {
            fromFeedback?: boolean
            dryRun?: boolean
            run?: string
            product?: string
            silverCap?: number
            heldOutFraction?: string
            privateFraction?: string
            json?: boolean
          },
          command: Command,
        ) => {
          try {
            if (opts.fromFeedback && (opts.run !== undefined || opts.heldOutFraction !== undefined || opts.privateFraction !== undefined || opts.silverCap !== undefined)) {
              throw new TypeError('--from-feedback admits staged feedback only; --run and partition flags do not apply')
            }
            if (opts.dryRun && !opts.fromFeedback) throw new TypeError('--dry-run requires --from-feedback')
            const heldOutFraction = parseFractionFlag('--held-out-fraction', opts.heldOutFraction)
            const privateFraction = parseFractionFlag('--private-fraction', opts.privateFraction)
            const configPath = getGlobalConfigPath(command)
            const { resolveEvalSession, runSeedVerb, runSeedFromFeedbackVerb, feedbackSeedHostOptions } = await import(
              '../eval-session-composition.js'
            )
            const session = await resolveEvalSession({
              ...(configPath === undefined ? {} : { configPath }),
              ...(opts.fromFeedback ? { keyOnly: true } : {}),
            })
            if (opts.fromFeedback) {
              const result = await runSeedFromFeedbackVerb(session, { ...feedbackSeedHostOptions(session),
                product: opts.product, dryRun: opts.dryRun === true })
              if (opts.json) console.log(JSON.stringify(result, null, 2))
              else renderFeedbackSeedSummary(result)
              if (result.kind === 'refused') process.exitCode = 2
              return
            }
            const result = await runSeedVerb(
              session,
              {
                ...(opts.run === undefined ? {} : { run: opts.run }),
                ...(opts.product === undefined ? {} : { product: opts.product }),
              },
              {
                ...(opts.silverCap === undefined ? {} : { silverPerTestCap: opts.silverCap }),
                ...(heldOutFraction === undefined ? {} : { heldOutFraction }),
                ...(privateFraction === undefined ? {} : { privateFraction }),
              },
            )
            if (opts.json) {
              // D-04/Pitfall 11: exactly one JSON document on stdout — refusals and skips are
              // DATA inside the DTO, never separate stream noise.
              console.log(JSON.stringify(result, null, 2))
            } else {
              renderSeedSummary(result)
            }
          } catch (err) {
            // D-08: typed named-input/config errors are the only failure modes — seeding
            // refusals are data and never reach this catch.
            console.error(pc.red(err instanceof Error ? err.message : String(err)))
            process.exitCode = 1
          }
        },
      ),
  )

  cmd.addCommand(
    new Command('adversarial')
      .description('Stage, admit, or retire one reviewed adversarial batch (422 D-01)')
      .option('--admit', 'commit the reviewed batch; requires --batch <digest>')
      .option('--retire', 'durably refuse the exact reviewed batch, retaining its audit bytes; requires --product and --batch')
      .option('--batch <digest>', 'the exact reviewed batch digest to admit')
      .option('--product <slug>', 'product partition to derive from (default: default)')
      .option(
        '--max-seeds <count>',
        'cap on NOVEL seeds this refresh derives from',
        parseIntegerFlag('--max-seeds'),
      )
      .option(
        '--max-probe-calls <count>',
        'cap on PROVIDER CALLS this refresh may make to author probes',
        parseIntegerFlag('--max-probe-calls'),
      )
      .option('--dry-run', 'derive and check without writing anything')
      .option('--json', 'emit the typed result DTO to stdout')
      .action(
        async (
          opts: { retire?: boolean; admit?: boolean; batch?: string; product?: string; maxSeeds?: number; maxProbeCalls?: number; dryRun?: boolean; json?: boolean },
          command: Command,
        ) => {
          try {
            if (opts.retire === true) {
              if (opts.admit === true || opts.maxSeeds !== undefined || opts.maxProbeCalls !== undefined || opts.dryRun === true) {
                throw new TypeError('--retire cannot be combined with --admit, --max-seeds, --max-probe-calls or --dry-run')
              }
              if (opts.product === undefined || opts.batch === undefined) throw new TypeError('--retire requires explicit --product <slug> and --batch <digest>')
              if (!/^[A-Za-z0-9_](?:[A-Za-z0-9._-]*[A-Za-z0-9_])?$/.test(opts.product) || opts.product.includes('..')) throw new TypeError('--retire requires an exact safe product slug')
              if (!/^[0-9a-f]{64}$/.test(opts.batch)) throw new TypeError('--retire requires an exact lowercase SHA256 batch digest')
              const { resolveEvalSession, runRetireAdversarialVerb } = await import('../eval-session-composition.js')
              const configPath = getGlobalConfigPath(command)
              const session = await resolveEvalSession({ ...(configPath === undefined ? {} : { configPath }), keyOnly: true })
              const result = runRetireAdversarialVerb(session, { product: opts.product, batch: opts.batch })
              if (opts.json) console.log(JSON.stringify(result, null, 2))
              else {
                console.log(`${result.alreadyRetired ? 'already retired' : 'retired'} ${result.product}/${result.batchDigest}`)
                console.log(`retained audit: ${result.retainedBatchDir}`)
                console.log(`retirement record: ${result.retirementRecordPath} (manifest SHA256 ${result.manifestSha256})`)
                console.log(`already committed cases preserved: ${result.alreadyCommittedCaseIds.length}`)
                for (const id of result.alreadyCommittedCaseIds) console.log(`preserved ${id}`)
                console.log('Retirement admits nothing; settled seeds and probe spend stay consumed. No new receipt or floor staleness was caused; existing stale evidence is not refreshed. Model calls: 0.')
              }
              return
            }
            // Staging is the default; admission is an explicit operator act naming ONE batch.
            if (opts.batch !== undefined && opts.admit !== true) {
              throw new TypeError('--batch applies to --admit only; staging derives its own batch digest')
            }
            if (opts.admit === true && opts.batch === undefined) {
              throw new TypeError('--admit requires --batch <digest>; admission never picks a batch for you')
            }
            // Admission commits an already-reviewed manifest and never derives, so a seed cap
            // there would be a cap on nothing — a silently ignored flag, which is worse than a
            // refused one.
            if (opts.maxSeeds !== undefined && opts.admit === true) {
              throw new TypeError('--max-seeds applies to staging only; admission derives nothing')
            }
            if (opts.maxSeeds !== undefined && opts.maxSeeds < 1) {
              throw new TypeError(`--max-seeds must be a positive integer, got "${opts.maxSeeds}".`)
            }
            // Same reasoning one budget over: admission authors nothing, so a probe-call cap
            // there would cap nothing. A silently ignored budget flag is worse than a refused one.
            if (opts.maxProbeCalls !== undefined && opts.admit === true) {
              throw new TypeError('--max-probe-calls applies to staging only; admission authors nothing')
            }
            if (opts.maxProbeCalls !== undefined && opts.maxProbeCalls < 1) {
              throw new TypeError(`--max-probe-calls must be a positive integer, got "${opts.maxProbeCalls}".`)
            }
            const configPath = getGlobalConfigPath(command)
            const { resolveEvalSession, runAdversarialVerb, adversarialHostOptions } = await import(
              '../eval-session-composition.js'
            )
            // 422 D-10: the STAGE branch may now author probes, so it needs a session that can
            // resolve credentials and mint a run masker. Admission derives nothing and authors
            // nothing, so it stays key-only — it must not read a secret it has no use for.
            const session = await resolveEvalSession({
              ...(configPath === undefined ? {} : { configPath }),
              keyOnly: opts.admit === true,
            })
            const result = await runAdversarialVerb(session, {
              ...adversarialHostOptions(session),
              ...(opts.product === undefined ? {} : { product: opts.product }),
              ...(opts.admit === undefined ? {} : { admit: opts.admit }),
              ...(opts.batch === undefined ? {} : { batch: opts.batch }),
              ...(opts.maxSeeds === undefined ? {} : { maxSeeds: opts.maxSeeds }),
              ...(opts.maxProbeCalls === undefined ? {} : { maxProbeCalls: opts.maxProbeCalls }),
              ...(opts.dryRun === undefined ? {} : { dryRun: opts.dryRun }),
            })
            if (opts.json) console.log(JSON.stringify(result, null, 2))
            else renderAdversarialSummary(result)
            if (result.kind === 'refused') process.exitCode = 2
          } catch (err) {
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

  cmd.addCommand(
    new Command('census')
      .description(
        'Derive the static per-product corpus census from the committed root (D-13/D-14)',
      )
      .option(
        '--commit',
        'also write census.json + census.md under reports/census/<corpus-digest>/ (D-15)',
      )
      .option(
        '--campaign <path>',
        'fold a guarded campaign manifest (excluded runs, repeats, cost line) into the census (D-16)',
      )
      .option('--json', 'emit the typed result DTO to stdout')
      .action(
        async (
          opts: { commit?: boolean; campaign?: string; json?: boolean },
          command: Command,
        ) => {
          try {
            const configPath = getGlobalConfigPath(command)
            const { resolveEvalSession, runCensusVerb } = await import(
              '../eval-session-composition.js'
            )
            const session = await resolveEvalSession(
              configPath === undefined ? {} : { configPath },
            )
            const result = await runCensusVerb(session, {
              ...(opts.commit === undefined ? {} : { commit: opts.commit }),
              ...(opts.campaign === undefined ? {} : { campaign: opts.campaign }),
            })
            if (opts.json) {
              // D-04/Pitfall 11: exactly one JSON document on stdout — cross-check refusals and
              // read refusals are DATA inside the DTO, never separate stream noise.
              console.log(JSON.stringify(result, null, 2))
            } else {
              renderCensusSummary(result)
            }
          } catch (err) {
            // D-08: a rejected --campaign manifest and a config/session failure are the only
            // failure modes — write-conflict outcomes are data (T-413-21/24).
            console.error(pc.red(err instanceof Error ? err.message : String(err)))
            process.exitCode = 1
          }
        },
      ),
  )

  cmd.addCommand(
    new Command('floor')
      .description('Measure the committed corpus noise floor with recorded repeats and seeds')
      .option('--repeats <n>', 'same-seed repeats (recorded default: 3; minimum: 3)')
      .option('--seeds <a,b>', 'distinct measurement seeds (recorded default: 11,29)')
      .option('--bootstrap-seed <n>', 'bootstrap seed (recorded default: 7)')
      .option('--commit', 'commit the measured per-profile floor through the write-once checkpoint')
      .option('--explanation <text>', 'operator explanation, required to commit a zero floor')
      .option('--classifier-repeatability <path>', 'guarded classifier measurement JSON, relative to config')
      .option('--from-measured <cost-log>', 'recover complete saved floor runs with original cost receipts and zero new model calls')
      .option('--json', 'emit the typed result DTO to stdout')
      .action(async (opts: {
        repeats?: string; seeds?: string; bootstrapSeed?: string; commit?: boolean
        explanation?: string; classifierRepeatability?: string; fromMeasured?: string; json?: boolean
      }, command: Command) => {
        try {
          const repeats = opts.repeats === undefined ? undefined : parseIntegerFlag('--repeats')(opts.repeats)
          const seeds = parseFloorSeeds(opts.seeds)
          const bootstrapSeed = opts.bootstrapSeed === undefined ? undefined
            : parseIntegerFlag('--bootstrap-seed')(opts.bootstrapSeed)
          const { resolveEvalSession, runFloorVerb } = await import('../eval-session-composition.js')
          const session = await resolveEvalSession({ configPath: getGlobalConfigPath(command), keyOnly: opts.fromMeasured !== undefined })
          const result = await runFloorVerb(session, {
            repeats, seeds, bootstrapSeed, commit: opts.commit,
            explanation: opts.explanation, classifierRepeatability: opts.classifierRepeatability,
            fromMeasured: opts.fromMeasured,
          })
          if (opts.json) {
            console.log(JSON.stringify(result, null, 2))
            for (const notice of result.notices) console.error(notice)
          } else {
            for (const line of renderFloorSummary(result)) console.log(line)
          }
        } catch (error) {
          console.error(pc.red(error instanceof Error ? error.message : String(error)))
          process.exitCode = 1
        }
      }),
  )

  cmd.addCommand(
    new Command('gate')
      .description('Compare one fresh committed-corpus replay or an identified saved report')
      .option('--report <batchKey>', 'compare a staged report with zero model calls; gate root first')
      .option('--staged-dir <dir>', 'with --report, read only this directory, relative to config')
      .option('--seed <n>', 'sampling seed (flag, config, measured floor, then recorded default 11)')
      .option('--judge <name>', 'replace the configured judges (repeat for a panel)', collectJudgeName)
      .option('--json', 'emit the typed result DTO to stdout')
      .action(async (opts: {
        report?: string; stagedDir?: string; seed?: string; judge?: string[]; json?: boolean
      }, command: Command) => {
        try {
          // Parse in the action: Commander option-parser exits would bypass the exit-2 catch.
          const seed = opts.seed === undefined ? undefined : parseIntegerFlag('--seed')(opts.seed)
          const { resolveEvalSession, runGateVerb } = await import('../eval-session-composition.js')
          const session = await resolveEvalSession({
            configPath: getGlobalConfigPath(command), flags: { judge: opts.judge },
            keyOnly: opts.report !== undefined,
          })
          const result = await runGateVerb(session, { report: opts.report, stagedDir: opts.stagedDir, seed })
          if (opts.json) {
            console.log(JSON.stringify(result, null, 2))
          } else if (result.kind === 'verdict') {
            for (const line of result.lines) console.log(line)
          } else {
            console.log(`release-gate: refused — ${result.refusal.path}: ${result.refusal.reason}`)
          }
          for (const notice of result.notices) console.error(notice)
          process.exitCode = result.kind === 'verdict' ? result.verdict.exit : 2
        } catch (error) {
          // An invocation failure is inconclusive, never a measured regression (exit 1).
          console.error(pc.red('release-gate: inconclusive — '
            + (error instanceof Error ? error.message : String(error))))
          process.exitCode = 2
        }
      }),
  )

  cmd.addCommand(
    new Command('replay-gate')
      .description(
        'Run Gate 1 for one candidate: cached baseline vs one served brief line; records the receipt',
      )
      .argument('<candidateId>')
      .option('--k <n>', 'cross-check samples per arm (odd, at least 3; flag, eval.k, default 3)')
      .option('--max-screens <n>', 'cap on replayed screens (flag, recorded default 64)')
      .option('--judge <name>', 'replace the configured judges (repeat for a disjoint panel)', collectJudgeName)
      .option('--dry-run', 'print the receipt without recording it')
      .option('--json', 'emit the schema-validated receipt DTO to stdout')
      .action(
        async (
          candidateId: string,
          opts: {
            k?: string
            maxScreens?: string
            judge?: string[]
            dryRun?: boolean
            json?: boolean
          },
          command: Command,
        ) => {
          try {
            const k = opts.k === undefined ? undefined : parseIntegerFlag('--k')(opts.k)
            const maxScreens =
              opts.maxScreens === undefined
                ? undefined
                : parseIntegerFlag('--max-screens')(opts.maxScreens)
            const { resolveEvalSession, runReplayGateVerb, serializeReplayGateReceipt } =
              await import('../eval-session-composition.js')
            const session = await resolveEvalSession({
              configPath: getGlobalConfigPath(command),
              flags: { judge: opts.judge },
              keyOnly: true,
            })
            const result = await runReplayGateVerb(session, candidateId, {
              k,
              maxScreens,
              dryRun: opts.dryRun,
              onProgress: (line) => console.error(line),
            })
            if (result.kind === 'receipt') {
              // GateReceiptSchema validation lives at the existing eval boundary.
              if (opts.json) console.log(serializeReplayGateReceipt(result.receipt))
              else {
                for (const line of result.lines) console.log(line)
                console.log(`recorded: ${result.recorded}`)
              }
            } else
              console.error(`replay-gate: refused — ${result.refusal.path}: ${result.refusal.reason}`)
            for (const notice of result.notices) console.error(notice)
            process.exitCode = result.exit
          } catch (error) {
            console.error(
              pc.red(
                'replay-gate: inconclusive — ' +
                  (error instanceof Error ? error.message : String(error)),
              ),
            )
            process.exitCode = 2
          }
        },
      ),
  )

  return cmd
}

function collectJudgeName(name: string, previous: string[] = []): string[] {
  return [...previous, name]
}
