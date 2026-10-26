// The deterministic markdown projection of EvalBatchReport (Phase 372-07, D-13's rendered half —
// discharging 369 D-16's deferred rendering per D-04). A pure template over the DTO: every number
// lands verbatim, object keys iterate in sorted order, and NO Date usage or locale formatting can
// enter the output — two renders of the same DTO are byte-identical (RESEARCH Open Q3), so the
// write-once committed re-commit byte-compare (D-17) holds clean. Summary + counters only: the
// per-decision diff renderer stays JSON-DTO territory (369 D-16).

import type { EvalBatchReport } from '@vostride/agent-qa-eval'
import type { ReportVerbResult } from './eval-session-composition.js'

/** Console-only evidence disclosure; committed report markdown below remains byte-stable. */
export function renderReportEvidenceLines(result: ReportVerbResult): string[] {
  const lines: string[] = []
  if (result.committed?.kind === 'committed'
    && result.committed.decisions !== undefined && result.decisionVectorCount !== undefined) {
    lines.push(`decisions: ${result.decisionVectorCount} vectors (${result.committed.decisions})`)
  }
  if (result.baseline !== undefined && result.profileKey !== undefined) {
    lines.push(`baseline: ${result.profileKey} (${result.baseline.kind})`)
  }
  return lines
}

function counterLines(title: string, counts: Readonly<Record<string, number>>): string[] {
  const lines = [`### ${title}`, '']
  const keys = Object.keys(counts).sort()
  if (keys.length === 0) {
    lines.push('- none')
  } else {
    for (const key of keys) lines.push(`- ${key}: ${counts[key]}`)
  }
  lines.push('')
  return lines
}

function rateLine(
  name: string,
  metric: { numerator: number; denominator: number; rate?: number },
): string {
  const rate = metric.rate === undefined ? 'n/a (zero denominator)' : `${metric.rate}`
  return `- ${name}: ${metric.numerator}/${metric.denominator} (rate: ${rate})`
}

const notSupplied = 'unavailable (not supplied)'

function metricLine(name: string, metric?: { numerator: number; denominator: number; rate?: number }): string {
  if (metric === undefined) return `${name}: ${notSupplied}`
  const rate = metric.denominator === 0 ? 'unavailable (zero denominator)' : metric.rate ?? notSupplied
  return `${name}: ${metric.numerator}/${metric.denominator} (rate: ${rate})`
}

function recoveryLines(name: string, recovery?: EvalBatchReport['recovery']): string[] {
  const weightSum = recovery?.weightSum
  const weighted = weightSum === 0 ? 'unavailable (zero weightSum)' : recovery?.weightedAccuracy ?? notSupplied
  return [
    metricLine(`${name}.recoveryAccuracy`, recovery === undefined ? undefined : {
      numerator: recovery.recoveredPositiveCount, denominator: recovery.eligiblePositiveCount,
      ...(recovery.recoveryAccuracy === undefined ? {} : { rate: recovery.recoveryAccuracy }),
    }),
    `${name}.weightedAccuracy: ${weighted} (weightSum: ${weightSum ?? notSupplied})`,
    `${name}.pairsWithoutWeight: ${recovery?.pairsWithoutWeight ?? notSupplied}`,
  ]
}

function splitLines(name: string, cell?: EvalBatchReport['perSplit']['natural']): string[] {
  const cost = cell?.perDecisionCost
  return [
    metricLine(`${name}.firstAttemptDecisionAccuracy`, cell?.firstAttemptDecisionAccuracy),
    metricLine(`${name}.verifierFalsePassRate`, cell?.verifierFalsePassRate),
    ...recoveryLines(`${name}.recovery`, cell?.recovery),
    `${name}.perDecisionCost: ` + (cost === undefined ? notSupplied
      : `decisionCount=${cost.decisionCount} promptTokens=${cost.promptTokens} `
        + `completionTokens=${cost.completionTokens} totalTokens=${cost.totalTokens} durationMs=${cost.durationMs}`),
  ]
}

/** Shared text projection: absent historical measurements stay absent; no rates are inferred. */
export function renderReportLabelMetricLines(report: EvalBatchReport): string[] {
  // The batch currently copies false-pass calibration, not channel precision. If supplied by a
  // historical/future DTO, precision is copied too; never infer it as one minus false-pass rate.
  const calibration: (EvalBatchReport['calibration'] & { precision?: number }) | undefined = report.calibration
  return [
    metricLine('verifierFalsePassRate', report.headline.verifierFalsePassRate),
    `calibration.status: ${calibration?.status ?? notSupplied}`,
    `calibration.n_gold: ${calibration?.n_gold ?? notSupplied}`,
    `calibration.precision: ${calibration?.precision ?? notSupplied}`,
    metricLine('calibration.verifierFalsePassRate', calibration?.verifierFalsePassRate),
    ...recoveryLines('recovery', report.recovery),
    ...splitLines('perSplit.natural', report.perSplit?.natural),
    ...splitLines('perSplit.held-out.shared', report.perSplit?.['held-out']?.shared),
    ...splitLines('perSplit.held-out.private', report.perSplit?.['held-out']?.private),
    ...splitLines('perSplit.adversarial', report.perSplit?.adversarial),
    `perSplit.unassignedCount: ${report.perSplit?.unassignedCount ?? notSupplied}`,
  ]
}

/**
 * Render one EvalBatchReport DTO to its committed markdown projection. Locked structure (D-13):
 * H1 + Provenance, Headline, Honesty Counters (with the full judge disposition table incl.
 * notInvoked reasons and the distinct judge cost), Axis Distributions, Recovery. Every value is
 * projected verbatim from the DTO — the renderer never sums, rates, or re-derives anything.
 */
export function renderEvalReportMarkdown(report: EvalBatchReport): string {
  const lines: string[] = ['# Eval Baseline Report', '']

  // Provenance: batchKey + matcherVersion + the judge identity receipt (or its honest absence).
  lines.push('## Provenance', '')
  lines.push(`- batchKey: ${report.batchKey}`)
  lines.push(`- matcherVersion: ${report.matcherVersion}`)
  if (report.judgeIdentity === 'mixed') {
    // 413-15: the batch DID invoke judges, under differing identities — saying none were invoked
    // would be the untruth the `refuse-mixed-identity` decision removes. The ids are projected
    // verbatim from the DTO, already sorted and deduped by buildEvalReport.
    lines.push(
      '- judge: mixed identities across score records '
        + `(${(report.mixedJudgeModelIds ?? []).join(', ')}) `
        + '— no judge block, not a gate comparator',
    )
  } else if (report.judge === undefined) {
    lines.push('- judge: no judge invoked')
  } else {
    lines.push(
      '- judge: '
        + `judgeModelId=${report.judge.judgeModelId} `
        + `judgeFamily=${report.judge.judgeFamily} `
        + `judgeVersion=${report.judge.judgeVersion} `
        + `confidenceThreshold=${report.judge.confidenceThreshold}`,
    )
    // Owner override of D-10 (2026-07-12): when the identity block carries the marker, the
    // committed projection discloses the same-family judging condition — derived verbatim
    // from the DTO, exactly one line, never from a clock or locale.
    if (report.judge.familyOverride !== undefined) {
      lines.push(
        `- judge family override: ${report.judge.familyOverride} `
          + '(self-preference bias condition disclosed; owner override of D-10, 2026-07-12)',
      )
    }
  }
  const calibration = report.judge?.calibration
  if (calibration !== undefined) {
    lines.push('- judge calibration: ' + (calibration.status === 'capability-gap'
      ? `capability-gap reason=${calibration.reason}`
      : calibration.status === 'uncalibrated'
        ? `uncalibrated n=${calibration.n}` + (calibration.provenance === 'unavailable' ? ' (unavailable)' : ' (copied)')
        : `calibrated n=${calibration.n} pooledAgreement=${calibration.pooledAgreement} `
          + `wilson95=[${calibration.wilson95.lower},${calibration.wilson95.upper}] `
          + `halfWidth=${calibration.wilson95.halfWidth} (copied)`))
  }
  lines.push('')

  // Headline: accuracy WITH its denominator (D-14 honesty) + the per-decision cost fields.
  const headline = report.headline
  lines.push('## Headline', '')
  lines.push(rateLine('firstAttemptDecisionAccuracy', headline.firstAttemptDecisionAccuracy))
  lines.push('- perDecisionCost:')
  lines.push(`  - decisionCount: ${headline.perDecisionCost.decisionCount}`)
  lines.push(`  - promptTokens: ${headline.perDecisionCost.promptTokens}`)
  lines.push(`  - completionTokens: ${headline.perDecisionCost.completionTokens}`)
  lines.push(`  - totalTokens: ${headline.perDecisionCost.totalTokens}`)
  lines.push(`  - durationMs: ${headline.perDecisionCost.durationMs}`)
  lines.push('')
  lines.push('### Label metrics', '', ...renderReportLabelMetricLines(report).map(line => `- ${line}`), '')

  // Honesty counters: every group visible, judge dispositions per TieCause, distinct judge cost.
  const honesty = report.honesty
  lines.push('## Honesty Counters', '')
  lines.push(...counterLines('tieCounts', honesty.tieCounts))
  lines.push(...counterLines('unscorableIdentityCounts', honesty.unscorableIdentityCounts))
  lines.push(...counterLines('refusalCounts', honesty.refusalCounts))
  lines.push(...counterLines('missByFailureCounts', honesty.missByFailureCounts))
  lines.push(`- harnessErrorCount: ${honesty.harnessErrorCount}`, '')
  lines.push(...counterLines('neverScoredCounts', honesty.neverScoredCounts))
  lines.push(...counterLines('skippedCounts', honesty.skippedCounts))
  lines.push(...counterLines('judge invoked', honesty.judge.invoked))
  lines.push(...counterLines('judge settled', honesty.judge.settled))
  lines.push(...counterLines('judge abstained', honesty.judge.abstained))
  lines.push(...counterLines('judge errors', honesty.judge.errors))
  lines.push(...counterLines('judge notInvoked', honesty.judge.notInvoked))
  lines.push('### judge cost', '')
  lines.push(`- calls: ${honesty.judge.cost.calls}`)
  lines.push(`- inputTokens: ${honesty.judge.cost.inputTokens}`)
  lines.push(`- outputTokens: ${honesty.judge.cost.outputTokens}`)
  lines.push(`- outcomesMissingUsage: ${honesty.judge.cost.outcomesMissingUsage}`)
  lines.push('')

  // Axis distributions: the independent matcher axes, never folded into a scalar (MATCH-04).
  lines.push('## Axis Distributions', '')
  lines.push(...counterLines('elementIdentity', report.axisDistributions.elementIdentity))
  lines.push(...counterLines('value', report.axisDistributions.value))
  lines.push(...counterLines('opClass', report.axisDistributions.opClass))
  lines.push(...counterLines('sideEffect', report.axisDistributions.sideEffect))
  lines.push(...counterLines('loop', report.axisDistributions.loop))

  // Recovery: pair evidence + the D-08 negative buckets — zero states are stated, not implied.
  const recovery = report.recovery
  lines.push('## Recovery', '')
  lines.push(`- selfHealPairCount: ${recovery.selfHealPairCount}`)
  lines.push(`- recoveredPositiveCount: ${recovery.recoveredPositiveCount}`)
  lines.push(`- eligiblePositiveCount: ${recovery.eligiblePositiveCount}`)
  lines.push(
    `- recoveryAccuracy: ${recovery.recoveryAccuracy === undefined ? 'n/a (no eligible positives)' : recovery.recoveryAccuracy}`,
  )
  lines.push(`- negativeDecisionCount: ${recovery.negativeDecisionCount}`)
  lines.push(`- negativeFullMatchCount: ${recovery.negativeFullMatchCount}`)
  lines.push('')

  return lines.join('\n')
}
