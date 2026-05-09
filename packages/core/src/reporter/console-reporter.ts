import pc from 'picocolors'
import type { TestDefinition } from '../types/test.js'
import type { StepResult, TestResult } from '../types/result.js'
import type { Reporter, RunSummary, SuiteSummary, HookEvent, HookResultEvent } from './types.js'
import type { SuiteDefinition } from '../suite/types.js'

export function humanDuration(milliseconds: number): string {
  if (milliseconds < 1000) return `${milliseconds}ms`
  const totalSeconds = Math.floor(milliseconds / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes === 0) return `${seconds}s`
  return `${minutes}m ${seconds}s`
}

const CLEAR_LINE = '\x1B[2K\r'

export interface ConsoleReporterOptions {
  verbose?: boolean
  colorize?: boolean
  logLevel?: string
  plain?: boolean
}

export class ConsoleReporter implements Reporter {
  private verbose: boolean
  private colorize: boolean
  private plain: boolean
  private inSuite = false
  private hookPhaseStarted = new Set<string>()
  private lastHookPhase: string | null = null
  private canOverwrite: boolean
  private stepsPassed = 0
  private stepsFailed = 0
  private stepsSkipped = 0
  private cacheHits = 0
  private cacheMisses = 0
  private lastWriteLen = 0

  constructor(options: ConsoleReporterOptions = {}) {
    this.verbose = options.verbose ?? false
    this.plain = options.plain ?? (process.stdout.isTTY !== true || process.env.CI === 'true')
    this.colorize = this.plain ? false : (options.colorize ?? true)
    this.canOverwrite = !this.plain && process.stdout.isTTY === true && options.logLevel !== 'debug'
  }

  private c(fn: (s: string) => string, text: string): string {
    return this.colorize ? fn(text) : text
  }

  private stripAnsi(s: string): string {
    return s.replace(/\x1B\[[0-9;]*m/g, '')
  }

  private clearWrappedLines(): void {
    const cols = process.stdout.columns || 80
    if (this.lastWriteLen > cols) {
      const extraLines = Math.ceil(this.lastWriteLen / cols) - 1
      for (let i = 0; i < extraLines; i++) {
        process.stdout.write('\x1B[1A\x1B[2K')
      }
    }
  }

  private writeLine(text: string): void {
    if (this.canOverwrite) {
      this.clearWrappedLines()
      process.stdout.write(CLEAR_LINE + text)
      this.lastWriteLen = this.stripAnsi(text).length
    }
  }

  private printLine(text: string): void {
    if (this.canOverwrite) {
      this.clearWrappedLines()
      process.stdout.write(CLEAR_LINE + text + '\n')
      this.lastWriteLen = 0
    } else {
      console.log(text)
    }
  }

  private testBadge(status: 'running' | 'passed' | 'failed'): string {
    if (this.plain) {
      switch (status) {
        case 'running':
          return 'RUN'
        case 'passed':
          return 'PASS'
        case 'failed':
          return 'FAIL'
      }
    }
    switch (status) {
      case 'running':
        return this.c(pc.bgYellow, this.c(pc.black, ' RUN  '))
      case 'passed':
        return this.c(pc.bgGreen, this.c(pc.black, ' PASS '))
      case 'failed':
        return this.c(pc.bgRed, this.c(pc.white, ' FAIL '))
    }
  }

  private resetCounters(): void {
    this.stepsPassed = 0
    this.stepsFailed = 0
    this.stepsSkipped = 0
    this.cacheHits = 0
    this.cacheMisses = 0
  }

  private formatStepsLine(): string {
    const total = this.stepsPassed + this.stepsFailed + this.stepsSkipped
    const parts: string[] = []
    if (this.stepsPassed > 0) parts.push(this.c(pc.green, `${this.stepsPassed} passed`))
    if (this.stepsFailed > 0) parts.push(this.c(pc.red, `${this.stepsFailed} failed`))
    if (this.stepsSkipped > 0) parts.push(this.c(pc.dim, `${this.stepsSkipped} skipped`))
    parts.push(`${total} total`)
    return parts.join(', ')
  }

  private formatCacheLine(): string {
    return `${this.cacheHits} hits, ${this.cacheMisses} misses`
  }

  onSuiteStart(suite: SuiteDefinition): void {
    this.inSuite = true
    this.resetCounters()
    console.log(`\n${this.c(pc.bold, `Suite: ${suite.name}`)}`)
  }

  onRunStart(tests: TestDefinition[]): void {
    this.resetCounters()
    if (this.inSuite) return
    const model = process.env.AGENT_QA_LLM_MODEL
    const provider = process.env.AGENT_QA_LLM_PROVIDER
    const modelInfo = model ? `  ${this.c(pc.dim, `Model: ${model}${provider ? ` (${provider})` : ''}`)}\n` : ''
    console.log(this.c(pc.bold, `\nRunning ${tests.length} test(s)...\n`) + modelInfo)
  }

  onTestStart(test: TestDefinition, filePath: string): void {
    this.hookPhaseStarted.clear()
    this.lastHookPhase = null
    const badge = this.testBadge('running')
    const indent = this.inSuite ? '  ' : ''
    this.writeLine(`${indent}${badge} ${filePath}`)
  }

  onStepStart(step: string, _testName: string): void {
    if (this.lastHookPhase === 'setup') {
      console.log('')
      this.lastHookPhase = null
    }
    this.writeLine(`${this.plain ? '->' : this.c(pc.dim, '\u2192')} ${step}`)
  }

  onStepEnd(result: StepResult, _testName: string): void {
    if (result.status === 'passed' || result.status === 'healed') this.stepsPassed++
    else if (result.status === 'failed') this.stepsFailed++
    else if (result.status === 'skipped') this.stepsSkipped++
    else if (result.status === 'cancelled') this.stepsSkipped++

    if (result.trace?.subActions) {
      for (const sub of result.trace.subActions) {
        if (sub.cached) this.cacheHits++
        else this.cacheMisses++
      }
    }

    const icon = this.statusIcon(result.status)
    const dur = humanDuration(result.duration)
    this.printLine(`${icon} ${result.name} ${this.c(pc.dim, dur)}`)

    if (result.status === 'failed') {
      const errMsg = result.trace?.error || result.error || 'Unknown error'
      console.log(`  ${this.c(pc.red, 'Error:')} ${errMsg}`)
    }

    if (result.healingAttempts && result.healingAttempts.length > 0) {
      console.log(`  ${this.c(pc.yellow, `Healed after ${result.healingAttempts.length} attempt(s)`)}`)
    }

    if (result.trace?.subActions && result.trace.subActions.length > 0) {
      const subs = result.trace.subActions
      const succeeded = subs.filter(s => s.result === 'success').length
      const failed = subs.filter(s => s.result === 'failure').length
      const cachedCount = subs.filter(s => s.cached).length
      console.log(`  ${this.c(pc.dim, `Sub-actions: ${subs.length} total (${succeeded} succeeded, ${failed} failed${cachedCount > 0 ? `, ${cachedCount} cached` : ''})`)}`)

      if (this.verbose) {
        for (const sub of subs) {
          const icon = sub.result === 'success'
            ? (this.plain ? 'ok' : this.c(pc.green, '\u2713'))
            : (this.plain ? 'x' : this.c(pc.red, '\u2717'))
          const cache = sub.cached ? this.c(pc.cyan, ' [cached]') : ''
          console.log(`    ${icon} #${sub.index + 1}: ${JSON.stringify(sub.plannedAction)}${cache}`)
          if (sub.error) {
            console.log(`      ${this.c(pc.red, 'Error:')} ${sub.error}`)
          }
        }
      }
    }
  }

  onHookStart(event: HookEvent): void {
    const phaseKey = event.phase === 'inline' ? `inline:${event.hookName}` : event.phase
    if (!this.hookPhaseStarted.has(phaseKey)) {
      this.hookPhaseStarted.add(phaseKey)
      if (this.lastWriteLen > 0) {
        this.printLine('')
      }
      const label = event.phase === 'setup' ? 'Running setup hooks'
        : event.phase === 'teardown' ? 'Running teardown hooks'
        : `Running hook: ${event.hookName}`
      console.log(`${this.plain ? 'RUN' : this.c(pc.bold, '\u25B6')} ${label}`)
    }
  }

  onHookEnd(event: HookResultEvent): void {
    const icon = event.status === 'passed'
      ? (this.plain ? 'ok' : this.c(pc.green, '\u2713'))
      : (this.plain ? 'x' : this.c(pc.red, '\u2717'))
    const dur = humanDuration(event.duration)
    console.log(`  ${icon} ${event.hookName} ${this.c(pc.dim, dur)}`)
    if (event.status === 'failed' && event.error) {
      console.log(`    ${this.c(pc.red, 'Error:')} ${event.error}`)
    }
    if (this.verbose && event.variables && Object.keys(event.variables).length > 0) {
      for (const [key, value] of Object.entries(event.variables)) {
        console.log(`    ${this.plain ? '->' : this.c(pc.dim, '\u21B3')} ${key}=${value}`)
      }
    }
    this.lastHookPhase = event.phase
  }

  onTestEnd(result: TestResult): void {
    const badge = result.status === 'failed'
      ? this.testBadge('failed')
      : result.status === 'skipped'
        ? this.statusIcon('skipped')
        : result.status === 'cancelled'
          ? this.statusIcon('cancelled')
          : this.testBadge('passed')
    const indent = this.inSuite ? '  ' : ''
    const dur = result.status === 'skipped' ? '(skipped)' : humanDuration(result.duration)
    this.printLine(`${indent}${badge} ${result.name} ${this.c(pc.dim, dur)}`)
    if (result.runId) {
      console.log(`${indent}Run ID: ${result.runId}`)
    }
    console.log('')
  }

  onRunEnd(summary: RunSummary): void {
    if (this.inSuite) return
    this.printStandaloneSummary(summary)
  }

  onSuiteEnd(summary: SuiteSummary): void {
    const suiteStatus = summary.status === 'passed' ? this.c(pc.green, '1 passed') : this.c(pc.red, '1 failed')
    const suiteLine = `Suites:  ${suiteStatus}, 1 total`

    const total = summary.passed + summary.failed + summary.skipped
    const testLine = `Tests:   ${summary.passed} of ${total} passed`

    console.log('')

    if (summary.failed > 0) {
      this.printFailedTests(summary.tests)
    }

    console.log(suiteLine)
    console.log(testLine)
    console.log(`Steps:   ${this.formatStepsLine()}`)
    console.log(`Cache:   ${this.formatCacheLine()}`)
    console.log(`Time:    ${humanDuration(summary.duration)}`)
    console.log('')

    this.inSuite = false
  }

  private printStandaloneSummary(summary: RunSummary): void {
    console.log('')
    const total = summary.passed + summary.failed + summary.skipped

    if (summary.failed > 0) {
      this.printFailedTests(summary.results)
    }

    console.log(`Tests:  ${summary.passed} of ${total} passed`)
    console.log(`Steps:  ${this.formatStepsLine()}`)
    console.log(`Cache:  ${this.formatCacheLine()}`)
    console.log(`Time:   ${humanDuration(summary.duration)}`)
    console.log('')
  }

  private printFailedTests(results: TestResult[]): void {
    console.log(this.c(pc.red, 'Failed tests:'))
    for (const r of results) {
      if (r.status === 'failed') {
        const icon = this.plain ? 'x' : this.c(pc.red, '\u2717')
        console.log(`  ${icon} ${r.name}`)
        if (r.failureSummary) {
          for (const line of r.failureSummary.split('\n')) {
            console.log(`    ${this.c(pc.dim, line)}`)
          }
        }
      }
    }
  }

  private statusIcon(status: string): string {
    if (this.plain) {
      switch (status) {
        case 'passed':
        case 'healed':
          return 'ok'
        case 'failed':
          return 'x'
        case 'skipped':
        case 'cancelled':
          return 'skipped'
        default:
          return ' '
      }
    }
    switch (status) {
      case 'passed':
        return this.c(pc.green, '\u2713')
      case 'healed':
        return this.c(pc.yellow, '\u2713')
      case 'failed':
        return this.c(pc.red, '\u2717')
      case 'skipped':
        return this.c(pc.dim, '\u25CB')
      case 'cancelled':
        return this.c(pc.dim, '\u25CB')
      default:
        return ' '
    }
  }
}
