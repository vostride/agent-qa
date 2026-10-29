import pc from 'picocolors'
import { guardRunText, isGitHubActions } from '@vostride/agent-qa-core/run-text-output'
import type { RunTextEnv } from '@vostride/agent-qa-core/run-text-output'
import { quarantineAppliesToTest } from '@vostride/agent-qa-schema'
import type { QuarantineAppliedEntry } from '@vostride/agent-qa-schema'
import type {
  HookFinishedPayload,
  HookStartedPayload,
  RunEventEnvelope,
  RunFinishedPayload,
  RunStartedPayload,
  StepFinalizedPayload,
  StepStartedPayload,
  TestFinishedPayload,
  TestRetryScheduledPayload,
  TestStartedPayload,
} from '@vostride/agent-qa-schema'

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
  plain?: boolean
  logLevel?: string
  /** Injectable write target — every human write flows through here. */
  write?: (chunk: string) => void
  /** Test seam: override TTY detection (defaults to process.stdout.isTTY). */
  isTTY?: boolean
  columns?: number
  // Taken at construction from the set the verdict rule got, matched through schema's predicate.
  quarantined?: readonly QuarantineAppliedEntry[]
  env?: RunTextEnv
}

export const QUARANTINE_TEST_ANNOTATION = 'QUARANTINED — failed, not counted'

// Silent at zero, so a summary with nothing quarantined is unchanged.
export function renderQuarantineSummarySegment(count: number): string {
  if (count <= 0) return ''
  return ` · ${count} quarantined failure${count === 1 ? '' : 's'}`
}

// `handler` attaches to the session bus; `flush` is awaited after `session.done`.
export interface ConsoleReporterHandle {
  handler: (envelope: RunEventEnvelope) => void
  flush: () => Promise<void>
}

interface TestMeta {
  name: string
  filePath: string
}

// Pure accumulation from typed envelopes; payloads print as masked at their source.
export function createConsoleReporter(options: ConsoleReporterOptions = {}): ConsoleReporterHandle {
  const verbose = options.verbose ?? false
  const env = options.env ?? process.env
  const isTTY = options.isTTY ?? process.stdout.isTTY === true
  const plain = options.plain ?? (!isTTY || process.env.CI === 'true' || isGitHubActions(env))
  const colorize = plain ? false : (options.colorize ?? true)
  const canOverwrite = !plain && isTTY && options.logLevel !== 'debug'
  const sink = options.write ?? ((chunk: string) => void process.stdout.write(chunk))

  function emit(finalMasked: string): void {
    sink(finalMasked)
  }

  function transient(text: string): void {
    if (!canOverwrite) return
    emit(CLEAR_LINE + text)
  }

  function println(text: string): void {
    if (canOverwrite) {
      emit(CLEAR_LINE + text + '\n')
    } else {
      emit(text + '\n')
    }
  }

  // Run-derived lines print as one block, so under GitHub Actions they share one stop-commands pair.
  function printBlock(lines: readonly string[]): void {
    if (isGitHubActions(env)) {
      emit(guardRunText(`${lines.join('\n')}\n`, env))
      return
    }
    for (const line of lines) println(line)
  }

  function c(fn: (s: string) => string, text: string): string {
    return colorize ? fn(text) : text
  }

  // Accumulation state.
  let memberTestCount = 0
  let currentSuiteId: string | undefined
  let sawSuite = false

  // aggregate step tallies (flushed from per-test buckets at testFinished)
  let stepsPassed = 0
  let stepsFailed = 0
  let stepsSkipped = 0
  let stepsCancelled = 0
  let cacheHits = 0
  let cacheMisses = 0
  const cacheDisabledTests = new Set<number>()
  const cacheUsedTests = new Set<number>()

  // per-test buckets (reset on testStarted and testRetryScheduled)
  let ptPassed = 0
  let ptFailed = 0
  let ptSkipped = 0
  let ptCancelled = 0

  // test-level tallies
  let testsPassed = 0
  let testsFailed = 0
  let testsSkipped = 0
  let testsCancelled = 0
  let totalDurationMs = 0
  // Counted apart and never subtracted from `testsFailed`, so the member outcome stays true.
  let quarantinedFailures = 0

  const stepTextByIndex = new Map<number, string>()
  const testMeta = new Map<number, TestMeta>()
  const failedTests: { name: string; failureSummary?: string; quarantined: boolean }[] = []
  const hookPhaseStarted = new Set<string>()

  function resetPerTest(): void {
    ptPassed = 0
    ptFailed = 0
    ptSkipped = 0
    ptCancelled = 0
    stepTextByIndex.clear()
    hookPhaseStarted.clear()
  }

  function statusIcon(status: string | undefined): string {
    if (plain) {
      switch (status) {
        case 'passed':
        case 'healed':
          return 'ok'
        case 'failed':
          return 'x'
        case 'skipped':
          return 'skipped'
        case 'cancelled':
          return 'cancelled'
        default:
          return '-'
      }
    }
    switch (status) {
      case 'passed':
        return c(pc.green, '✓')
      case 'healed':
        return c(pc.yellow, '✓')
      case 'failed':
        return c(pc.red, '✗')
      case 'skipped':
        return c(pc.dim, '○')
      case 'cancelled':
        return c(pc.yellow, '⊘')
      default:
        return ' '
    }
  }

  function testBadge(status: 'running' | 'passed' | 'failed'): string {
    if (plain) return status === 'running' ? 'RUN' : status === 'passed' ? 'PASS' : 'FAIL'
    switch (status) {
      case 'running':
        return c(pc.bgYellow, c(pc.black, ' RUN  '))
      case 'passed':
        return c(pc.bgGreen, c(pc.black, ' PASS '))
      case 'failed':
        return c(pc.bgRed, c(pc.white, ' FAIL '))
    }
  }

  function formatStepsLine(): string {
    const total = stepsPassed + stepsFailed + stepsCancelled + stepsSkipped
    const parts: string[] = []
    if (stepsPassed > 0) parts.push(c(pc.green, `${stepsPassed} passed`))
    if (stepsFailed > 0) parts.push(c(pc.red, `${stepsFailed} failed`))
    if (stepsCancelled > 0) parts.push(c(pc.yellow, `${stepsCancelled} cancelled`))
    if (stepsSkipped > 0) parts.push(c(pc.dim, `${stepsSkipped} skipped`))
    parts.push(`${total} total`)
    return parts.join(', ')
  }

  // --- per-event handlers -----------------------------------------------------
  function onRunStarted(payload: RunStartedPayload): void {
    memberTestCount = payload.memberTestCount
    const model = process.env.AGENT_QA_LLM_MODEL
    const provider = process.env.AGENT_QA_LLM_PROVIDER
    const modelInfo = model
      ? `  ${c(pc.dim, `Model: ${model}${provider ? ` (${provider})` : ''}`)}\n`
      : ''
    const text = `\n${c(pc.bold, `Running ${memberTestCount} test(s)...`)}\n${modelInfo}`
    if (model) printBlock([text])
    else println(text)
  }

  function onTestStarted(payload: TestStartedPayload): void {
    resetPerTest()
    testMeta.set(payload.testIndex, {
      name: payload.name,
      filePath: payload.filePath ?? payload.name,
    })
    if (payload.suiteId && payload.suiteId !== currentSuiteId) {
      currentSuiteId = payload.suiteId
      sawSuite = true
      printBlock([`\n${c(pc.bold, `Suite: ${payload.suiteName ?? payload.suiteId}`)}`])
    }
    const indent = sawSuite ? '  ' : ''
    transient(`${indent}${testBadge('running')} ${payload.filePath ?? payload.name}`)
  }

  function onStepStarted(payload: StepStartedPayload): void {
    stepTextByIndex.set(payload.stepIndex, payload.stepText)
    transient(`${plain ? '->' : c(pc.dim, '→')} ${payload.stepText}`)
  }

  function onStepFinalized(payload: StepFinalizedPayload): void {
    const status = payload.status
    if (status === 'passed' || status === 'healed') ptPassed++
    else if (status === 'failed') ptFailed++
    else if (status === 'skipped') ptSkipped++
    else if (status === 'cancelled') ptCancelled++

    if (payload.cacheStatus === 'hit') cacheHits++
    else if (payload.cacheStatus === 'miss') cacheMisses++
    if (payload.cacheStatus === 'disabled') cacheDisabledTests.add(payload.testIndex)
    else cacheUsedTests.add(payload.testIndex)

    const stepText = stepTextByIndex.get(payload.stepIndex) ?? `Step ${payload.stepIndex + 1}`
    const dur = humanDuration(payload.durationMs ?? 0)
    const lines = [`${statusIcon(status)} ${stepText} ${c(pc.dim, dur)}`]
    if (status === 'failed' && payload.error) {
      lines.push(`  ${c(pc.red, 'Error:')} ${payload.error}`)
    }
    printBlock(lines)
  }

  function onHookStarted(payload: HookStartedPayload): void {
    const phaseKey = payload.phase === 'inline' ? `inline:${payload.hookName}` : payload.phase
    if (hookPhaseStarted.has(phaseKey)) return
    hookPhaseStarted.add(phaseKey)
    const label =
      payload.phase === 'setup'
        ? 'Running setup hooks'
        : payload.phase === 'teardown'
          ? 'Running teardown hooks'
          : `Running hook: ${payload.hookName}`
    const line = `${plain ? 'RUN' : c(pc.bold, '▶')} ${label}`
    if (payload.phase === 'inline') printBlock([line])
    else println(line)
  }

  function onHookFinished(payload: HookFinishedPayload): void {
    const icon = statusIcon(payload.status === 'passed' ? 'passed' : payload.status === 'failed' ? 'failed' : 'skipped')
    const lines = [`  ${icon} ${payload.hookName} ${c(pc.dim, humanDuration(payload.durationMs))}`]
    if (payload.status === 'failed' && payload.error) {
      lines.push(`    ${c(pc.red, 'Error:')} ${payload.error}`)
    }
    if (verbose && payload.variables && Object.keys(payload.variables).length > 0) {
      for (const [key, value] of Object.entries(payload.variables)) {
        lines.push(`    ${plain ? '->' : c(pc.dim, '↳')} ${key}=${value}`)
      }
    }
    printBlock(lines)
  }

  function onTestRetryScheduled(_payload: TestRetryScheduledPayload): void {
    // A new attempt drops the aborted attempt's steps, so the summary counts the final attempt.
    resetPerTest()
  }

  function onTestFinished(payload: TestFinishedPayload): void {
    // flush per-test buckets into the aggregate (retry-reset already dropped stale attempts)
    stepsPassed += ptPassed
    stepsFailed += ptFailed
    stepsSkipped += ptSkipped
    stepsCancelled += ptCancelled
    totalDurationMs += payload.durationMs ?? 0

    const meta = testMeta.get(payload.testIndex)
    const name = meta?.name ?? payload.name ?? `Test ${payload.testIndex + 1}`
    const outcome = payload.outcome
    const failed = outcome === 'failed' || outcome === 'timeout'
    const skipped = outcome === 'skipped'
    const cancelled = outcome === 'cancelled'
    if (failed) testsFailed++
    else if (skipped) testsSkipped++
    else if (cancelled) testsCancelled++
    else testsPassed++

    // Only a failed member carries the annotation; a passing one cannot be an uncounted failure.
    const quarantined =
      failed
      && quarantineAppliesToTest(options.quarantined, {
        filePath: meta?.filePath ?? payload.filePath ?? name,
        testName: name,
      })
    if (quarantined) quarantinedFailures++

    if (failed) failedTests.push({ name, failureSummary: payload.failureSummary, quarantined })

    const badge = failed
      ? testBadge('failed')
      : skipped || cancelled
        ? statusIcon(outcome)
        : testBadge('passed')
    const indent = sawSuite ? '  ' : ''
    const dur = skipped || cancelled ? `(${outcome})` : humanDuration(payload.durationMs ?? 0)
    // Empty at zero quarantined, so the line is unchanged for an unquarantined member.
    const disposition = quarantined ? ` ${c(pc.yellow, QUARANTINE_TEST_ANNOTATION)}` : ''
    printBlock([`${indent}${badge} ${name} ${c(pc.dim, dur)}${disposition}`])
    println('')
  }

  function formatCacheLine(): string {
    const disabled = cacheDisabledTests.size
    if (disabled > 0 && cacheUsedTests.size === 0) return 'disabled'
    const tally = `${cacheHits} hits, ${cacheMisses} misses`
    if (disabled === 0) return tally
    return `${tally} (disabled for ${disabled} ${disabled === 1 ? 'test' : 'tests'})`
  }

  function onRunFinished(_payload: RunFinishedPayload): void {
    println('')
    const total = testsPassed + testsFailed + testsSkipped + testsCancelled
    const cancelledSegment = testsCancelled > 0 ? `, ${testsCancelled} cancelled` : ''
    if (failedTests.length > 0) {
      println(c(pc.red, 'Failed tests:'))
      for (const failure of failedTests) {
        const disposition = failure.quarantined ? ` ${c(pc.yellow, QUARANTINE_TEST_ANNOTATION)}` : ''
        const lines = [`  ${plain ? 'x' : c(pc.red, '✗')} ${failure.name}${disposition}`]
        if (failure.failureSummary) {
          for (const line of failure.failureSummary.split('\n')) {
            lines.push(`    ${c(pc.dim, line)}`)
          }
        }
        printBlock(lines)
      }
    }
    const segments = `${cancelledSegment}${renderQuarantineSummarySegment(quarantinedFailures)}`
    println(`Tests:  ${testsPassed} of ${total} passed${segments}`)
    println(`Steps:  ${formatStepsLine()}`)
    println(`Cache:  ${formatCacheLine()}`)
    println(`Time:   ${humanDuration(totalDurationMs)}`)
    println('')
  }

  function handler(envelope: RunEventEnvelope): void {
    // The bus detaches a throwing subscriber, but a detached console mid-run is a UX
    // failure — guard so a single malformed envelope never blanks the terminal.
    try {
      switch (envelope.type) {
        case 'runStarted':
          onRunStarted(envelope.payload as RunStartedPayload)
          break
        case 'testStarted':
          onTestStarted(envelope.payload as TestStartedPayload)
          break
        case 'stepStarted':
          onStepStarted(envelope.payload as StepStartedPayload)
          break
        case 'stepFinalized':
          onStepFinalized(envelope.payload as StepFinalizedPayload)
          break
        case 'hookStarted':
          onHookStarted(envelope.payload as HookStartedPayload)
          break
        case 'hookFinished':
          onHookFinished(envelope.payload as HookFinishedPayload)
          break
        case 'testRetryScheduled':
          onTestRetryScheduled(envelope.payload as TestRetryScheduledPayload)
          break
        case 'testFinished':
          onTestFinished(envelope.payload as TestFinishedPayload)
          break
        case 'runFinished':
          onRunFinished(envelope.payload as RunFinishedPayload)
          break
        default:
          // verdict / diagnostics / sub-action ticks / chips — no console surface
          break
      }
    } catch {
      // swallow: never detach the console mid-run
    }
  }

  async function flush(): Promise<void> {
    // Console does no buffered I/O; the seam exists for interface uniformity.
  }

  return { handler, flush }
}
