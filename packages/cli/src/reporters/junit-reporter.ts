import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { quarantineAppliesToTest } from '@vostride/agent-qa-schema'
import type {
  QuarantineAppliedEntry,
  RunEventEnvelope,
  StepFinalizedPayload,
  TestFinishedPayload,
  TestStartedPayload,
} from '@vostride/agent-qa-schema'

// A durable artifact CI archives, so it stays masked and never restores originals.

export interface JunitReporterOptions {
  outputPath: string
  /** Injectable write target — defaults to fs. Receives (path, xmlString). */
  write?: (path: string, content: string) => Promise<void>
  // Snapshotted at construction, so the bus schemas stay untouched and the disposition is fixed.
  quarantined?: readonly QuarantineAppliedEntry[]
}

// First inside the testcase, where xunit2 puts properties; strict validators may still reject it.
export const JUNIT_QUARANTINE_MARKER_BLOCK =
  '      <properties>\n'
  + '        <property name="quarantined" value="true"/>\n'
  + '      </properties>\n'

export interface JunitReporterHandle {
  handler: (envelope: RunEventEnvelope) => void
  flush: () => Promise<void>
}

interface StepRecord {
  stepIndex: number
  stepText: string
  status: string
  durationMs: number
  error?: string
}

interface TestRecord {
  testIndex: number
  name: string
  filePath: string
  suiteId?: string
  suiteName?: string
  outcome: string
  durationMs: number
  failureSummary?: string
  steps: StepRecord[]
  // Beside `outcome`, never instead: a failed member never routes into `<skipped>`.
  quarantined: boolean
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

// Writes the file in `flush()`, never in the `runFinished` handler, because bus delivery is sync.
export function createJunitReporter(options: JunitReporterOptions): JunitReporterHandle {
  const writeTarget =
    options.write ??
    (async (path: string, content: string): Promise<void> => {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, content, 'utf-8')
    })

  const started = new Map<number, TestStartedPayload>()
  const stepText = new Map<string, string>() // `${testIndex}:${stepIndex}` -> text
  const stepsByTest = new Map<number, StepRecord[]>()
  const tests: TestRecord[] = []
  let suiteMode = false
  let suiteName: string | undefined

  function onTestStarted(payload: TestStartedPayload): void {
    started.set(payload.testIndex, payload)
    // a retry re-runs steps for the same test index — reset the bucket
    stepsByTest.set(payload.testIndex, [])
    if (payload.suiteId) {
      suiteMode = true
      suiteName ??= payload.suiteName ?? payload.suiteId
    }
  }

  function onStepFinalized(payload: StepFinalizedPayload): void {
    const bucket = stepsByTest.get(payload.testIndex) ?? []
    bucket.push({
      stepIndex: payload.stepIndex,
      stepText: stepText.get(`${payload.testIndex}:${payload.stepIndex}`) ?? `Step ${payload.stepIndex + 1}`,
      status: payload.status ?? 'passed',
      durationMs: payload.durationMs ?? 0,
      error: payload.error,
    })
    stepsByTest.set(payload.testIndex, bucket)
  }

  function onTestFinished(payload: TestFinishedPayload): void {
    const start = started.get(payload.testIndex)
    const name = start?.name ?? payload.name ?? `Test ${payload.testIndex + 1}`
    const filePath = start?.filePath ?? start?.name ?? payload.filePath ?? payload.name ?? ''
    tests.push({
      testIndex: payload.testIndex,
      name,
      filePath,
      suiteId: start?.suiteId,
      suiteName: start?.suiteName,
      outcome: payload.outcome,
      durationMs: payload.durationMs ?? 0,
      failureSummary: payload.failureSummary,
      steps: stepsByTest.get(payload.testIndex) ?? [],
      // Rendered only for a failed member: a green row cannot be a failure that did not count.
      quarantined:
        isFailed(payload.outcome)
        && quarantineAppliesToTest(options.quarantined, { filePath, testName: name }),
    })
  }

  function handler(envelope: RunEventEnvelope): void {
    switch (envelope.type) {
      case 'testStarted':
        onTestStarted(envelope.payload as TestStartedPayload)
        break
      case 'stepStarted': {
        const p = envelope.payload as { testIndex: number; stepIndex: number; stepText: string }
        stepText.set(`${p.testIndex}:${p.stepIndex}`, p.stepText)
        break
      }
      case 'stepFinalized':
        onStepFinalized(envelope.payload as StepFinalizedPayload)
        break
      case 'testRetryScheduled': {
        // a new attempt begins — drop the aborted attempt's steps so the durable
        // artifact records only the final attempt (parity with the console summary)
        const p = envelope.payload as { testIndex: number }
        stepsByTest.set(p.testIndex, [])
        break
      }
      case 'testFinished':
        onTestFinished(envelope.payload as TestFinishedPayload)
        break
      default:
        break
    }
  }

  function isFailed(outcome: string): boolean {
    return outcome === 'failed' || outcome === 'timeout'
  }

  function isSkipped(outcome: string): boolean {
    return outcome === 'skipped' || outcome === 'cancelled'
  }

  function stepSummary(test: TestRecord): string {
    if (test.steps.length === 0) return 'Steps: none recorded\n'
    const lines = ['Steps:']
    test.steps.forEach((step, index) => {
      lines.push(`${index + 1}. [${step.status.toUpperCase()}] ${step.stepText} (${(step.durationMs / 1000).toFixed(3)}s)`)
      if (step.error) lines.push(`   Error: ${step.error}`)
    })
    return `${lines.join('\n')}\n`
  }

  function failureMessage(test: TestRecord): string {
    if (test.failureSummary) return test.failureSummary
    const failedStep = test.steps.find(step => step.status === 'failed')
    if (failedStep?.error) return failedStep.error
    if (failedStep) return `Step failed: ${failedStep.stepText}`
    return 'Test failed'
  }

  function failureDetails(test: TestRecord): string {
    const lines = [`Test: ${test.name}`, `File: ${test.filePath}`]
    if (test.failureSummary) lines.push(`Failure summary: ${test.failureSummary}`)
    for (const step of test.steps.filter(s => s.status === 'failed')) {
      lines.push('')
      lines.push(`Failed step ${step.stepIndex + 1}: ${step.stepText}`)
      lines.push(`Duration: ${(step.durationMs / 1000).toFixed(3)}s`)
      lines.push(`Error: ${step.error ?? 'Unknown error'}`)
    }
    return `${lines.join('\n')}\n`
  }

  function buildTestCase(test: TestRecord, className: string): string {
    let xml = `    <testcase name="${escapeXml(test.name)}" classname="${escapeXml(className)}" time="${(test.durationMs / 1000).toFixed(3)}" file="${escapeXml(test.filePath)}">\n`
    // Additive only: `failures=` still counts this member, so CI shows a red row on a green build.
    if (test.quarantined) xml += JUNIT_QUARANTINE_MARKER_BLOCK
    if (isFailed(test.outcome)) {
      xml += `      <failure message="${escapeXml(failureMessage(test))}" type="TestFailure">\n`
      xml += escapeXml(failureDetails(test))
      xml += '      </failure>\n'
    } else if (isSkipped(test.outcome)) {
      xml += `      <skipped message="${escapeXml(test.outcome)}"/>\n`
    }
    xml += `      <system-out>${escapeXml(stepSummary(test))}</system-out>\n`
    xml += '    </testcase>\n'
    return xml
  }

  function buildXml(): string {
    const failures = tests.filter(t => isFailed(t.outcome)).length
    const skipped = tests.filter(t => isSkipped(t.outcome)).length
    const totalTime = tests.reduce((sum, t) => sum + t.durationMs, 0)

    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n'
    xml += `<testsuites name="agent-qa" tests="${tests.length}" failures="${failures}" skipped="${skipped}" time="${(totalTime / 1000).toFixed(3)}">\n`

    if (suiteMode) {
      // dual-mode: one suite-level document
      xml += `  <testsuite name="${escapeXml(suiteName ?? 'agent-qa')}" tests="${tests.length}" failures="${failures}" skipped="${skipped}" time="${(totalTime / 1000).toFixed(3)}">\n`
      for (const test of tests) xml += buildTestCase(test, suiteName ?? test.filePath)
      xml += '  </testsuite>\n'
    } else {
      for (const test of tests) {
        const testFailures = isFailed(test.outcome) ? 1 : 0
        const testSkipped = isSkipped(test.outcome) ? 1 : 0
        xml += `  <testsuite name="${escapeXml(test.name)}" tests="1" failures="${testFailures}" skipped="${testSkipped}" time="${(test.durationMs / 1000).toFixed(3)}" file="${escapeXml(test.filePath)}">\n`
        xml += buildTestCase(test, test.filePath)
        xml += '  </testsuite>\n'
      }
    }

    xml += '</testsuites>\n'
    return xml
  }

  async function flush(): Promise<void> {
    await writeTarget(options.outputPath, buildXml())
  }

  return { handler, flush }
}
