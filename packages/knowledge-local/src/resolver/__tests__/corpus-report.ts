// No clock and no run id, so an unchanged corpus writes a byte-identical report.

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export const CORPUS_POSTURES = ['full', 'floor'] as const

export type CorpusPosture = (typeof CORPUS_POSTURES)[number]

export interface CorpusScoreRow {
  readonly shortId: string
  readonly machineId: string
  /** The resolver's own normalised score for this candidate. */
  readonly score: number
}

export interface CorpusCaseRow {
  readonly caseId: string
  readonly category: string
  readonly posture: CorpusPosture
  /** The reference as it was actually put to the resolver, after address materialisation. */
  readonly query: string
  readonly outcome: 'resolved' | 'ambiguous' | 'none'
  readonly reason?: string
  /** The machine id of the resolved entity, when one was resolved. */
  readonly resolved?: string
  /** Every candidate the resolver ranked and could describe, best first. */
  readonly topScores: readonly CorpusScoreRow[]
}

export interface CorpusReport {
  readonly report: 'entity-resolution-corpus'
  readonly schemaVersion: 1
  readonly entityCount: number
  readonly caseCount: number
  readonly postures: readonly CorpusPosture[]
  /** The pinned rule the rows were decided under, so a row can be re-read years later. */
  readonly constants: Readonly<Record<string, number>>
  readonly cases: readonly CorpusCaseRow[]
}

/**
 * Every way this report can be malformed, as sentences.
 *
 * A list rather than a throw, because the suite asserts on the WHOLE list: a shape check that
 * stops at the first problem is a check whose later clauses were never exercised.
 */
export function reportShapeProblems(
  report: CorpusReport,
  expectedCaseIds: readonly string[],
): string[] {
  const problems: string[] = []

  if (report.report !== 'entity-resolution-corpus') problems.push('the report is not named')
  if (report.schemaVersion !== 1) problems.push('the report carries no schema version')
  if (report.postures.length !== CORPUS_POSTURES.length) {
    problems.push(`the report declares ${report.postures.length} postures, not ${CORPUS_POSTURES.length}`)
  }
  for (const posture of CORPUS_POSTURES) {
    if (!report.postures.includes(posture)) problems.push(`the report omits the ${posture} posture`)
  }
  if (report.caseCount !== expectedCaseIds.length) {
    problems.push(`the report counts ${report.caseCount} cases, not ${expectedCaseIds.length}`)
  }
  if (report.cases.length !== expectedCaseIds.length * CORPUS_POSTURES.length) {
    problems.push(
      `the report holds ${report.cases.length} rows, not ${expectedCaseIds.length * CORPUS_POSTURES.length}`,
    )
  }

  for (const caseId of expectedCaseIds) {
    for (const posture of CORPUS_POSTURES) {
      const rows = report.cases.filter((row) => row.caseId === caseId && row.posture === posture)
      if (rows.length === 0) problems.push(`${caseId} is missing under the ${posture} posture`)
      if (rows.length > 1) problems.push(`${caseId} appears ${rows.length} times under ${posture}`)
    }
  }

  for (const row of report.cases) {
    if (row.query === '' && row.caseId !== 'miss-blank') {
      problems.push(`${row.caseId}/${row.posture} logged no query`)
    }
    if (row.outcome === 'resolved' && row.resolved === undefined) {
      problems.push(`${row.caseId}/${row.posture} resolved without naming an entity`)
    }
    if (row.outcome !== 'resolved' && row.resolved !== undefined) {
      problems.push(`${row.caseId}/${row.posture} names a resolved entity it did not resolve`)
    }
    for (const score of row.topScores) {
      if (!(score.score >= 0 && score.score <= 1)) {
        problems.push(`${row.caseId}/${row.posture} logged ${score.score}, outside the [0, 1] scale`)
      }
    }
    const ordered = [...row.topScores].sort((left, right) => right.score - left.score)
    if (ordered.some((score, index) => score.score !== row.topScores[index]?.score)) {
      problems.push(`${row.caseId}/${row.posture} logged its candidates out of score order`)
    }
  }

  return problems
}

/** The artifact's path: under the package's own test-output directory, never inside `src`. */
export function corpusReportPath(): string {
  return fileURLToPath(new URL('../../../test-output/entity-resolution-report.json', import.meta.url))
}

export function writeCorpusReport(report: CorpusReport): string {
  const path = corpusReportPath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(report, undefined, 2)}\n`)
  return path
}
