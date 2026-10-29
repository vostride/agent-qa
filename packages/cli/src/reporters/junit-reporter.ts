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

// NOTE: this is a DURABLE artifact (CI archives it) — it stays MASKED. Payload
// strings are written verbatim; the placeholders travel into the XML. This module never
// restores originals anywhere. (T-363-15.)

export interface JunitReporterOptions {
  outputPath: string
  /** Injectable write target — defaults to fs. Receives (path, xmlString). */
  write?: (path: string, content: string) => Promise<void>
  /**
   * The run-start quarantine snapshot, taken AT CONSTRUCTION.
   *
   * Snapshot-at-construction rather than a new bus payload field: the CLI already folds the ledger
   * once before `startRun` and holds the resolved set, so the bus schemas stay untouched and the
   * disposition is fixed for the whole run exactly as the runner's own copy is. Records are matched
   * through schema's ONE predicate, so this reporter and the aggregate verdict rule cannot disagree
   * about which member's failure was licensed.
   */
  quarantined?: readonly QuarantineAppliedEntry[]
}

/**
 * The exact bytes the marker adds to a `<testcase>`, exported so the suites can pin the
 * document difference rather than a substring of it.
 *
 * RESEARCH A1 [ASSUMED]: a testcase-level `<properties>` child is tolerated by pytest/Datadog/
 * CircleCI-style parsers but MAY be rejected by strict xunit2/Jenkins validators. It sits FIRST
 * inside the testcase, which is where the xunit2 schema puts properties, to give a strict validator
 * its best chance. The shape is deliberately ADDITIVE and SWAPPABLE — the contract is the real
 * `<failure>` beside it, which is pinned regardless of what happens to this block.
 */
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
  /**
   * the disposition, BESIDE `outcome` and never instead of it. Resolved once at
   * `testFinished` from the run-start snapshot; `outcome` is never rewritten and no failed member
   * is ever routed into the `<skipped>` branch — the test RAN, which is FLAK-02's whole point.
   */
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

/**
 * `createJunitReporter` — the bus-subscriber successor to core's `JUnitReporter`. Accumulates
 * testStarted/stepStarted/stepFinalized/testFinished into the v1 XML document model and writes
 * the file inside `flush()` — NEVER in the runFinished handler (Pitfall 6: bus delivery is sync
 * fire-and-forget; the CLI awaits flush after session.done before process.exit, so async writes
 * can't be lost). Dual-mode: a suite-grouped stream (testStarted carries suiteId) produces one
 * suite-level document.
 */
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
      // The disposition is only RENDERED for a member that actually failed: this marker means "this
      // red row did not fail the build", a claim a green row cannot make. Which tests are under
      // quarantine at all is `quarantine.list`'s question, not this artifact's.
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
    // additive, and additive only. The failure branch below is untouched, `failures=` on
    // both enclosing elements still counts this member, and nothing here can reach the skipped
    // branch — a CI UI that counts JUnit failures shows a red row on a green build, which is the
    // correct amount of red.
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
