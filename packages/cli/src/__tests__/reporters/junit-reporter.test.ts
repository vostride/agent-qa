import { describe, expect, it } from 'vitest'

import type { QuarantineAppliedEntry, RunEventEnvelope, RunEventType } from '@vostride/agent-qa-schema'

import {
  JUNIT_QUARANTINE_MARKER_BLOCK,
  createJunitReporter,
} from '../../reporters/junit-reporter.js'
import { QUARANTINED_CHECKOUT, QUARANTINED_ELSEWHERE, buildReporterFixture } from './fixtures.js'

async function runJunit(
  quarantined?: readonly QuarantineAppliedEntry[],
): Promise<{ path: string; xml: string; fixture: ReturnType<typeof buildReporterFixture> }> {
  const fixture = buildReporterFixture()
  let path = ''
  let xml = ''
  const reporter = createJunitReporter({
    outputPath: 'out/junit.xml',
    write: async (p: string, content: string) => {
      path = p
      xml = content
    },
    ...(quarantined === undefined ? {} : { quarantined }),
  })
  for (const envelope of fixture.envelopes) reporter.handler(envelope)
  await reporter.flush()
  return { path, xml, fixture }
}

describe('createJunitReporter', () => {
  it('writes file from testStarted.filePath and per-step status', async () => {
    const { xml } = await runJunit()
    // the file= attribute carries testStarted.filePath verbatim
    expect(xml).toContain('file="tests/login.yaml"')
    expect(xml).toContain('file="tests/checkout.yaml"')
    // every testcase carries a classname (suite name in dual-mode)
    expect(xml).toMatch(/classname="[^"]+"/)
    // per-step status appears in the system-out step summary
    expect(xml).toMatch(/\[PASSED\]/)
    expect(xml).toMatch(/\[FAILED\]/)
  })

  it('stays MASKED — placeholders preserved, originals never written', async () => {
    const { xml, fixture } = await runJunit()
    // the declared marker survives XML-escaping (441-33: `[secret:<name>]`, not the old `<SECRET_n>`)
    expect(xml).toMatch(/\[secret:\w+\]/)
    expect(xml).not.toContain(fixture.stepSecret)
    expect(xml).not.toContain(fixture.hookSecret)
    expect(xml).not.toContain(fixture.summarySecret)
  })

  it('emits a failure element for the failed member test', async () => {
    const { xml } = await runJunit()
    expect(xml).toContain('<failure')
    expect(xml).toContain('Checkout test')
  })

  it('dual-mode: a suite-grouped stream produces one suite-level document', async () => {
    const { xml } = await runJunit()
    // one suite-level <testsuite name="Auth"> holding both member testcases
    expect(xml).toContain('name="Auth"')
    const suiteOpens = xml.match(/<testsuite\s/g) ?? []
    expect(suiteOpens.length).toBe(1)
  })

  it('flush() resolves only after the XML is fully written to the injected target', async () => {
    const fixture = buildReporterFixture()
    let written = false
    let capturedXml = ''
    const reporter = createJunitReporter({
      outputPath: 'out/junit.xml',
      write: async (_p: string, content: string) => {
        await Promise.resolve()
        capturedXml = content
        written = true
      },
    })
    for (const envelope of fixture.envelopes) reporter.handler(envelope)
    expect(written).toBe(false)
    await reporter.flush()
    expect(written).toBe(true)
    expect(capturedXml).toContain('<testsuites')
  })
})

function abortSkippedStream(): RunEventEnvelope[] {
  let seq = 0
  const env = (type: RunEventType, payload: object): RunEventEnvelope =>
    ({ seq: seq++, ts: 1_000 + seq, runId: 'run-444.1-15', type, payload }) as RunEventEnvelope
  return [
    env('testStarted', { testId: 't0', testIndex: 0, name: 'Login flow', filePath: 'tests/login.yaml' }),
    env('testFinished', { testId: 't0', testIndex: 0, outcome: 'cancelled', durationMs: 500 }),
    env('testFinished', {
      testId: 't1',
      testIndex: 1,
      outcome: 'skipped',
      name: 'Checkout flow',
      filePath: 'tests/checkout.yaml',
    }),
  ]
}

async function junitOf(envelopes: readonly RunEventEnvelope[]): Promise<string> {
  let xml = ''
  const reporter = createJunitReporter({
    outputPath: 'out/junit.xml',
    write: async (_p: string, content: string) => {
      xml = content
    },
  })
  for (const envelope of envelopes) reporter.handler(envelope)
  await reporter.flush()
  return xml
}

describe('JUnit words for abort-skipped and cancelled members', () => {
  it('JUnit names an abort-skipped member by its test', async () => {
    const xml = await junitOf(abortSkippedStream())
    expect(xml).toContain(
      '    <testcase name="Checkout flow" classname="tests/checkout.yaml" time="0.000" file="tests/checkout.yaml">\n'
      + '      <skipped message="skipped"/>\n',
    )
    expect(xml).not.toContain('Test 2')
  })

  it('JUnit writes a cancelled member as skipped with the message cancelled', async () => {
    const xml = await junitOf(abortSkippedStream())
    expect(xml).toContain(
      '    <testcase name="Login flow" classname="tests/login.yaml" time="0.500" file="tests/login.yaml">\n'
      + '      <skipped message="cancelled"/>\n',
    )
    expect(xml).toContain('<testsuites name="agent-qa" tests="2" failures="0" skipped="2"')
  })
})

// ---- 390 D-15: the correct amount of red ------------------------------------------------------
//
// The whole point of FLAK-02 is that a quarantined test STILL RAN and STILL FAILED. A CI UI that
// counts JUnit failures must therefore see the failure — the row is red — while the build itself is
// green. The disposition is an ADDITIVE marker; it is never a `<skipped>`, never a rewritten
// `outcome`, and never a decremented `failures=` count.
//
// Every pin below is a DIFFERENTIAL over one envelope stream with the snapshot as the only varied
// input, because an assertion that nothing changed is only load-bearing if the same code path WOULD
// have changed under the other input.

describe('createJunitReporter — the quarantine marker', () => {
  it('keeps the REAL <failure> and adds the marker — never a <skipped>, never an outcome rewrite', async () => {
    const { xml } = await runJunit([QUARANTINED_CHECKOUT])
    // the failure element the CI UI counts is still there, unchanged in kind
    expect(xml).toContain('<failure message=')
    expect(xml).toContain('type="TestFailure"')
    // and the quarantined member was NOT routed into the skipped branch
    expect(xml).not.toContain('<skipped')
    // the marker itself
    expect(xml).toContain('<property name="quarantined" value="true"/>')
  })

  it('pins the quarantined testcase bytes EXACTLY — marker first, then the real failure', async () => {
    const { xml } = await runJunit([QUARANTINED_CHECKOUT])
    expect(xml).toContain(
      '    <testcase name="Checkout test" classname="Auth" time="1.500" file="tests/checkout.yaml">\n'
      + '      <properties>\n'
      + '        <property name="quarantined" value="true"/>\n'
      + '      </properties>\n'
      + '      <failure message=',
    )
  })

  it('the marker block is the ONLY byte difference, and it appears exactly once', async () => {
    const withoutSnapshot = (await runJunit()).xml
    const withSnapshot = (await runJunit([QUARANTINED_CHECKOUT])).xml

    // (a) the same stream DID change — the zero-quarantine pin below is about a reachable branch
    expect(withSnapshot).not.toBe(withoutSnapshot)
    // (b) exactly one testcase carries it (the failing member, not the passing one)
    expect(withSnapshot.split(JUNIT_QUARANTINE_MARKER_BLOCK)).toHaveLength(2)
    // (c) removing it reproduces the un-quarantined document BYTE for BYTE
    expect(withSnapshot.split(JUNIT_QUARANTINE_MARKER_BLOCK).join('')).toBe(withoutSnapshot)
  })

  it('emits zero new bytes when the snapshot is empty or addresses another test', async () => {
    const baseline = (await runJunit()).xml
    expect((await runJunit([])).xml).toBe(baseline)
    expect((await runJunit([QUARANTINED_ELSEWHERE])).xml).toBe(baseline)
    expect(baseline).not.toContain('quarantin')
  })

  it('leaves failures= truthful — a quarantined failure is still counted as red', async () => {
    const { xml } = await runJunit([QUARANTINED_CHECKOUT])
    // the fixture has exactly one failing member; the marker must not decrement anything
    expect(xml).toContain('<testsuites name="agent-qa" tests="2" failures="1" skipped="0"')
    expect(xml).toContain('failures="1"')
  })

  it('marks only the FAILED member — a passing test carrying an entry gains nothing', async () => {
    const { xml } = await runJunit([
      { ...QUARANTINED_CHECKOUT, filePath: 'tests/login.yaml', testName: 'Login test' },
    ])
    // Login test passed; its disposition is irrelevant and must never be rendered
    expect(xml).not.toContain('quarantin')
  })
})
