import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { TestResult } from '../types/result.js'
import type { Reporter, RunSummary, SuiteSummary } from './types.js'
import type { SuiteDefinition } from '../suite/types.js'

export interface JUnitReporterOptions {
  outputPath: string
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

export class JUnitReporter implements Reporter {
  private outputPath: string
  private results: TestResult[] = []
  private inSuiteRun = false

  constructor(options: JUnitReporterOptions) {
    this.outputPath = options.outputPath
  }

  onSuiteStart(_suite: SuiteDefinition): void {
    this.inSuiteRun = true
  }

  onTestEnd(result: TestResult): void {
    this.results.push(result)
  }

  async onRunEnd(summary: RunSummary): Promise<void> {
    if (this.inSuiteRun) return
    if (this.results.length === 0) this.results = summary.results
    const xml = this.buildXml()
    await this.writeXml(xml)
  }

  async onSuiteEnd(summary: SuiteSummary): Promise<void> {
    const xml = this.buildSuiteXml(summary)
    await this.writeXml(xml)
  }

  private async writeXml(xml: string): Promise<void> {
    await mkdir(dirname(this.outputPath), { recursive: true })
    await writeFile(this.outputPath, xml, 'utf-8')
  }

  private buildXml(): string {
    const totalTests = this.results.length
    const totalFailures = this.results.reduce(
      (sum, r) => sum + (r.status === 'failed' ? 1 : 0),
      0,
    )
    const totalSkipped = this.results.reduce(
      (sum, r) => sum + (r.status === 'skipped' || r.status === 'cancelled' ? 1 : 0),
      0,
    )
    const totalTime = this.results.reduce((sum, r) => sum + r.duration, 0)

    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n'
    xml += `<testsuites name="agent-qa" tests="${totalTests}" failures="${totalFailures}" skipped="${totalSkipped}" time="${(totalTime / 1000).toFixed(3)}">\n`

    for (const result of this.results) {
      const failedTests = result.status === 'failed' ? 1 : 0
      const skippedTests = result.status === 'skipped' || result.status === 'cancelled' ? 1 : 0
      const runId = result.runId ? ` runId="${escapeXml(result.runId)}"` : ''
      xml += `  <testsuite name="${escapeXml(result.name)}" tests="1" failures="${failedTests}" skipped="${skippedTests}" time="${(result.duration / 1000).toFixed(3)}" file="${escapeXml(result.filePath)}"${runId}>\n`

      xml += this.buildTestCase(result)

      xml += '  </testsuite>\n'
    }

    xml += '</testsuites>\n'
    return xml
  }

  private buildSuiteXml(summary: SuiteSummary): string {
    const runId = summary.runId ? ` runId="${escapeXml(summary.runId)}"` : ''
    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n'
    xml += `<testsuites name="agent-qa" tests="${summary.tests.length}" failures="${summary.failed}" skipped="${summary.skipped}" time="${(summary.duration / 1000).toFixed(3)}">\n`
    xml += `  <testsuite name="${escapeXml(summary.name)}" tests="${summary.tests.length}" failures="${summary.failed}" skipped="${summary.skipped}" time="${(summary.duration / 1000).toFixed(3)}"${runId}>\n`

    for (const result of summary.tests) {
      xml += this.buildTestCase(result, summary.name)
    }

    xml += '  </testsuite>\n'
    xml += '</testsuites>\n'
    return xml
  }

  private buildTestCase(result: TestResult, className = result.filePath): string {
    const runId = result.runId ? ` runId="${escapeXml(result.runId)}"` : ''
    let xml = `    <testcase name="${escapeXml(result.name)}" classname="${escapeXml(className)}" time="${(result.duration / 1000).toFixed(3)}" file="${escapeXml(result.filePath)}"${runId}>\n`

    if (result.status === 'failed') {
      const message = escapeXml(this.getFailureMessage(result))
      xml += `      <failure message="${message}" type="TestFailure">\n`
      xml += escapeXml(this.buildFailureDetails(result))
      xml += '      </failure>\n'
    } else if (result.status === 'skipped' || result.status === 'cancelled') {
      xml += `      <skipped message="${escapeXml(result.status)}"/>\n`
    }

    xml += `      <system-out>${escapeXml(this.buildStepSummary(result))}</system-out>\n`
    xml += '    </testcase>\n'
    return xml
  }

  private getFailureMessage(result: TestResult): string {
    if (result.failureSummary) return result.failureSummary
    const failedStep = result.steps.find(step => step.status === 'failed')
    if (failedStep?.error) return failedStep.error
    if (failedStep) return `Step failed: ${failedStep.name}`
    return 'Test failed'
  }

  private buildFailureDetails(result: TestResult): string {
    const failedSteps = result.steps.filter(step => step.status === 'failed')
    const lines = [
      `Test: ${result.name}`,
      `File: ${result.filePath}`,
    ]

    if (result.runId) lines.push(`Run ID: ${result.runId}`)
    if (result.failureSummary) lines.push(`Failure summary: ${result.failureSummary}`)

    if (failedSteps.length === 0) {
      lines.push('Result status was failed, but no failed step was recorded.')
      return `${lines.join('\n')}\n`
    }

    failedSteps.forEach((step) => {
      const stepNumber = result.steps.indexOf(step) + 1
      lines.push('')
      lines.push(`Failed step ${stepNumber}: ${step.name}`)
      lines.push(`Duration: ${(step.duration / 1000).toFixed(3)}s`)
      lines.push(`Error: ${step.trace?.error || step.error || 'Unknown error'}`)

      if (step.trace) {
        lines.push(`Observation: ${step.trace.observation}`)
        lines.push(`Reasoning: ${step.trace.reasoning}`)
        lines.push(`Planned action: ${JSON.stringify(step.trace.plannedAction)}`)
      }
    })

    return `${lines.join('\n')}\n`
  }

  private buildStepSummary(result: TestResult): string {
    if (result.steps.length === 0) return 'Steps: none recorded\n'

    const lines = ['Steps:']

    result.steps.forEach((step, index) => {
      const status = step.status.toUpperCase()
      const duration = (step.duration / 1000).toFixed(3)
      lines.push(`${index + 1}. [${status}] ${step.name} (${duration}s)`)
      if (step.error) lines.push(`   Error: ${step.error}`)
    })

    return `${lines.join('\n')}\n`
  }
}
