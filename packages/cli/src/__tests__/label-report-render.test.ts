import { Command } from 'commander'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildEvalReport, type EvalBatchReport } from '@vostride/agent-qa-eval'
import { readFileSync } from 'node:fs'
import { createEvalCommand } from '../commands/eval.js'
import { renderReportLabelMetricLines } from '../eval-report-render.js'
import * as verbs from '../eval-session-composition.js'

afterEach(() => { process.exitCode = 0; vi.restoreAllMocks() })
const oldReport = () => JSON.parse(readFileSync(new URL('./fixtures/older-report/report.json', import.meta.url), 'utf8')) as EvalBatchReport

function measured() {
  const report = buildEvalReport([])
  report.headline.verifierFalsePassRate = { numerator: 2, denominator: 5, rate: 0.123 }
  report.recovery = { ...report.recovery, recoveredPositiveCount: 2, eligiblePositiveCount: 7,
    recoveryAccuracy: 0.234 }
  return report
}
const disclosure = [
  'verifierFalsePassRate: 2/5 (rate: 0.123)',
  'recovery.recoveryAccuracy: 2/7 (rate: 0.234)',
]

describe('report label metric lines', () => {
  it('copies the measured false-pass and recovery metrics without recalculating rates', () => {
    const report = measured(), before = JSON.stringify(report)
    expect(renderReportLabelMetricLines(report)).toEqual(disclosure)
    expect(JSON.stringify(report)).toBe(before)
  })
  it('distinguishes valid zero, empty denominators and absent historical fields', () => {
    const empty = buildEvalReport([])
    empty.headline.verifierFalsePassRate = { numerator: 0, denominator: 5, rate: 0 }
    expect(renderReportLabelMetricLines(empty)).toEqual([
      'verifierFalsePassRate: 0/5 (rate: 0)',
      'recovery.recoveryAccuracy: 0/0 (rate: unavailable (zero denominator))',
    ])
    expect(renderReportLabelMetricLines(oldReport())).toEqual([
      'verifierFalsePassRate: unavailable (not supplied)',
      'recovery.recoveryAccuracy: 0/0 (rate: unavailable (zero denominator))',
    ])
  })
  it('reports absent rates as unavailable even with nonzero denominators', () => {
    const report = buildEvalReport([])
    report.headline.verifierFalsePassRate = { numerator: 0, denominator: 3 }
    report.recovery.recoveredPositiveCount = 0
    report.recovery.eligiblePositiveCount = 4
    delete report.recovery.recoveryAccuracy
    expect(renderReportLabelMetricLines(report)).toEqual([
      'verifierFalsePassRate: 0/3 (rate: unavailable (not supplied))',
      'recovery.recoveryAccuracy: 0/4 (rate: unavailable (not supplied))',
    ])
  })
  it.each(['measured', 'empty', 'legacy'] as const)('actual console and JSON routes preserve %s DTO disclosure', async kind => {
    const report = kind === 'measured' ? measured() : kind === 'empty' ? buildEvalReport([]) : oldReport()
    vi.spyOn(verbs, 'resolveEvalSession').mockResolvedValue({} as verbs.EvalSession)
    const dto: verbs.ReportVerbResult = { report, batchKey: report.batchKey, entries: 0,
      stagedFile: '/fixture/.agent-qa/eval/reports/fixture.json', judgeIdentity: 'absent', notices: [] }
    vi.spyOn(verbs, 'runReportVerb').mockResolvedValue(dto)
    const lines: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...args) => { lines.push(args.join(' ')) })
    const program = () => new Command().addCommand(createEvalCommand())
    await program().parseAsync(['eval', 'report'], { from: 'user' })
    const text = lines.join('\n')
    if (kind === 'measured') for (const line of disclosure) expect(text).toContain(line)
    else expect(text).toContain(kind === 'empty'
      ? 'verifierFalsePassRate: 0/0 (rate: unavailable (zero denominator))'
      : 'verifierFalsePassRate: unavailable (not supplied)')
    lines.length = 0
    await program().parseAsync(['eval', 'report', '--json'], { from: 'user' })
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]!)).toEqual(dto)
    expect(process.exitCode ?? 0).toBe(0)
  })
})
