// Console projections of EvalBatchReport label metrics. Every number lands verbatim from the DTO;
// absent measurements print as unavailable and no rate is inferred.

import type { EvalBatchReport } from '@vostride/agent-qa-eval'

const notSupplied = 'unavailable (not supplied)'

function metricLine(name: string, metric?: { numerator: number; denominator: number; rate?: number }): string {
  if (metric === undefined) return `${name}: ${notSupplied}`
  const rate = metric.denominator === 0 ? 'unavailable (zero denominator)' : metric.rate ?? notSupplied
  return `${name}: ${metric.numerator}/${metric.denominator} (rate: ${rate})`
}

export function renderReportLabelMetricLines(report: EvalBatchReport): string[] {
  const recovery = report.recovery
  return [
    metricLine('verifierFalsePassRate', report.headline.verifierFalsePassRate),
    metricLine('recovery.recoveryAccuracy', recovery === undefined ? undefined : {
      numerator: recovery.recoveredPositiveCount, denominator: recovery.eligiblePositiveCount,
      ...(recovery.recoveryAccuracy === undefined ? {} : { rate: recovery.recoveryAccuracy }),
    }),
  ]
}
