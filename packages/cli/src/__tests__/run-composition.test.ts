import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { afterAll, describe, it, expect, vi } from 'vitest'
import type { RiskActionDescriptor } from '@vostride/agent-qa-schema'
import type { RunEventEnvelope } from '@vostride/agent-qa-schema'
import type { RunSubscriberHandle } from '@vostride/agent-qa-agent-local'
import * as runSessionComposition from '../run-session-composition.js'
import {
  attachRunSubscribers,
} from '../run-session-composition.js'
import { QUARANTINE_TEST_ANNOTATION } from '../reporters/console-reporter.js'
import { JUNIT_QUARANTINE_MARKER_BLOCK } from '../reporters/junit-reporter.js'
import { QUARANTINED_CHECKOUT, buildReporterFixture, createCapture } from './reporters/fixtures.js'

const roots: string[] = []

function track(path: string): string {
  roots.push(path)
  return path
}

afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

// 363-09 Task 2 / Task 1 — the composition swap seam: the D-11 unmasking confirm decorator and the
// shared `attachRunSubscribers` helper both startRun sites use (Pitfall 8). Reporter RENDERING is
// unit-tested in reporters/*.test.ts; here we pin the composition contract.

// RE-SPELLED 2026-10-01 (432-19, D-14/D-15; 432-14 deferred #3). `buildUnmaskingConfirm` unmasked
// the action name on a confirm prompt for the person reading it, paused the live line around the
// question and left the gate's masked record untouched. It had no production caller after 432-14,
// and the `ConfirmPort` it decorated is deleted with the gate, so it goes too. The masking claim it
// carried — a human-facing render unmasks exactly once while the record stays masked — is held by
// every surviving human render (`unmask-boundary-rollcall.test.ts`); what is pinned here is that the
// decorator cannot come back as an export of this module.
describe('buildUnmaskingConfirm', () => {
  it('the confirm decorator is not exported, so nothing can wrap a prompt any more', () => {
    expect(Object.keys(runSessionComposition)).not.toContain('buildUnmaskingConfirm')
    // Non-vacuity: the namespace is the real module, with its retained presentation symbols.
    // (2026-10-02, 432-42: the live pause controller left too; the subscriber helper is the anchor.)
    expect(typeof runSessionComposition.attachRunSubscribers).toBe('function')
    expect(Object.keys(runSessionComposition)).not.toContain('createLivePauseController')
  })
})

describe('attachRunSubscribers (bus composition swap)', () => {
  function fakeSession(): { subscribe: ReturnType<typeof vi.fn> } {
    return { subscribe: vi.fn((_from: number | undefined, _h: (e: RunEventEnvelope) => void) => () => {}) }
  }

  it('subscribes console + junit + wire + extra subscribers all from the replay-then-live floor (seq 1)', async () => {
    const session = fakeSession()
    const extraFlush = vi.fn().mockResolvedValue(undefined)
    const extra: RunSubscriberHandle = { handler: vi.fn(), flush: extraFlush }

    const { flush } = attachRunSubscribers({
      session: session as never,
      console: { verbose: false, write: () => {} },
      junitOutputPath: track(join(tmpdir(), `agent-qa-junit-${Date.now()}.xml`)),
      extraSubscribers: [extra],
    })

    // console + junit + wire + one extra = 4 subscriptions, every one from seq 1 (D-04 full replay).
    expect(session.subscribe).toHaveBeenCalledTimes(4)
    for (const call of session.subscribe.mock.calls) {
      expect(call[0]).toBe(1)
    }

    await flush()
    expect(extraFlush).toHaveBeenCalledTimes(1)
  })

  // the live seam is deleted, so the second half of this title is now its
  // absence — a legacy controller smuggled in is never bound (old title kept for the console half).
  it('skips the console subscriber and unbinds the live seam when console is false', async () => {
    const session = fakeSession()
    const bind = vi.fn()

    attachRunSubscribers({
      session: session as never,
      console: false,
      ...({ live: { bind, pauseLive() {}, resumeLive() {} } } as object),
    })

    // only the wire subscriber attaches (console skipped, no junit, no extras).
    expect(session.subscribe).toHaveBeenCalledTimes(1)
    // nothing binds a live seam any more, so a smuggled legacy controller is never touched.
    expect(bind).not.toHaveBeenCalled()
  })

  it('best-effort flush: a rejecting subscriber flush never rejects the combined flush', async () => {
    const session = fakeSession()
    const rejecting: RunSubscriberHandle = {
      handler: vi.fn(),
      flush: vi.fn().mockRejectedValue(new Error('posthog down')),
    }
    const settling: RunSubscriberHandle = { handler: vi.fn(), flush: vi.fn().mockResolvedValue(undefined) }

    const { flush } = attachRunSubscribers({
      session: session as never,
      console: false,
      extraSubscribers: [rejecting, settling],
    })

    await expect(flush()).resolves.toBeUndefined()
    // every subscriber's flush still ran despite the rejection (allSettled).
    expect(rejecting.flush).toHaveBeenCalledTimes(1)
    expect(settling.flush).toHaveBeenCalledTimes(1)
  })
})

// ---- 390 D-15/D-16: the run-start snapshot reaches BOTH reporters from ONE input --------------
//
// `attachRunSubscribers` is the single place either reporter is constructed (Pitfall 8), so it is
// the single place the disposition can be dropped. Pinned by OBSERVING both surfaces render it from
// one `quarantined` argument — a wiring test that only asserted the argument was accepted would
// stay green while a reporter silently ignored it.

describe('attachRunSubscribers threads the quarantine snapshot to both reporters', () => {
  it('renders the disposition on the console AND in the JUnit document from one input', async () => {
    const fixture = buildReporterFixture()
    const capture = createCapture()
    const junitPath = join(track(mkdtempSync(join(tmpdir(), 'agent-qa-390-07-'))), 'junit.xml')
    const handlers: ((envelope: RunEventEnvelope) => void)[] = []
    const session = {
      subscribe: vi.fn((_from: number | undefined, handler: (e: RunEventEnvelope) => void) => {
        handlers.push(handler)
        return () => {}
      }),
    }

    const { flush } = attachRunSubscribers({
      session: session as never,
      console: { plain: true, colorize: false, isTTY: false, write: capture.write },
      junitOutputPath: junitPath,
      quarantined: [QUARANTINED_CHECKOUT],
    })

    for (const envelope of fixture.envelopes) for (const handler of handlers) handler(envelope)
    await flush()

    expect(capture.output()).toContain(QUARANTINE_TEST_ANNOTATION)
    expect(readFileSync(junitPath, 'utf8')).toContain(JUNIT_QUARANTINE_MARKER_BLOCK)
  })

  it('BOTH startRun sites in run.ts pass the run-start snapshot', () => {
    const runSource = readFileSync(
      fileURLToPath(new URL('../commands/run.ts', import.meta.url)),
      'utf8',
    )
    const sourceFile = ts.createSourceFile(
      'run.ts',
      runSource,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    )
    const calls: ts.CallExpression[] = []
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'attachRunSubscribers'
      ) {
        calls.push(node)
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
    expect(calls).toHaveLength(2)
    // Bound: the AST argument object; only its own top-level properties count.
    const sites = calls.map((call) => {
      const arg = call.arguments[0]
      const passesQuarantined =
        arg !== undefined &&
        ts.isObjectLiteralExpression(arg) &&
        arg.properties.some(
          (prop) =>
            (ts.isShorthandPropertyAssignment(prop) || ts.isPropertyAssignment(prop)) &&
            (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) &&
            prop.name.text === 'quarantined',
        )
      const line = sourceFile.getLineAndCharacterOfPosition(call.getStart()).line + 1
      return { line, passesQuarantined }
    })
    expect(sites).toEqual(sites.map(({ line }) => ({ line, passesQuarantined: true })))
  })
})

// ---- 385-08: the dissection's two load-bearing controls ------------------------------

// Control 1 — the anti-shim pin. The dissection is only real if the moved symbols stopped being
// reachable through this path. A module that re-published them would leave every call site
// spelled exactly as before, which reads like a completed move and is not one: the subtree
// carve-out would then be scoping a file whose contents had gone somewhere else. So the export
// set of the CLI-side module is pinned by exact equality, and any re-export statement at all is
// an offender regardless of what it names.
describe('the CLI run-session module exports presentation ONLY', () => {
  const moduleSource = readFileSync(
    fileURLToPath(new URL('../run-session-composition.ts', import.meta.url)),
    'utf8',
  )

  it('exports exactly the presentation symbols and nothing else', () => {
    const declared = [...moduleSource.matchAll(/^export (?:async )?(?:function|const|interface|type|class)\s+(\w+)/gm)]
      .map(match => match[1])
      .sort()

    expect(declared).toEqual([
      'AttachRunSubscribersInput',
      // the replay floor the drive subscribes the run's record at.
      'REPLAY_FROM_START',
      'attachRunSubscribers',
      // the run-completion analytics subscriber factory. It belongs beside
      // `attachRunSubscribers` for that helper's own reason — `run.ts` has two `startRun` sites
      // (Pitfall 8), and a subscriber constructed separately at each is one that can be configured
      // differently at each. It is presentation in the same sense the reporters are: something a
      // host attaches to the bus and flushes, which a headless drainer would substitute.
      'buildAnalyticsRunSubscriber',
      // the per-run hook registrar's assembly left.
      // 'buildUnmaskingConfirm' left with the confirm port it decorated.
      // 'createLivePauseController' left with the pause seam it built.
    ].sort())
  })

  it('carries no re-export of any kind — a compatibility shim would defeat the move', () => {
    expect(moduleSource).not.toMatch(/^export\s+\*/m)
    expect(moduleSource).not.toMatch(/^export\s*(?:type\s*)?\{[^}]*\}\s*from/m)
  })
})

// Control 2, the describe 'human decoration composes OUTSIDE the
// pause timing', is deleted with the per-run hook registrar it drove.
