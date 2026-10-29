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

// The composition contract: `attachRunSubscribers`, shared by both `startRun` sites.

// The confirm decorator is not exported; surviving human renders hold the masking claim.
describe('buildUnmaskingConfirm', () => {
  it('the confirm decorator is not exported, so nothing can wrap a prompt any more', () => {
    expect(Object.keys(runSessionComposition)).not.toContain('buildUnmaskingConfirm')
    // Non-vacuity: the namespace is the real module; the subscriber helper is the anchor.
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

    // Console, JUnit, wire and the extra subscriber each subscribe from seq 1.
    expect(session.subscribe).toHaveBeenCalledTimes(4)
    for (const call of session.subscribe.mock.calls) {
      expect(call[0]).toBe(1)
    }

    await flush()
    expect(extraFlush).toHaveBeenCalledTimes(1)
  })

  // A legacy live controller smuggled in is never bound.
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

// `attachRunSubscribers` builds both reporters, so both are observed rendering one snapshot.

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

// The run-session module's export controls.

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
      // The replay floor the drive subscribes the run's record at.
      'REPLAY_FROM_START',
      'attachRunSubscribers',
      // The run-completion analytics subscriber, shared like the reporters so both sites agree.
      'buildAnalyticsRunSubscriber',
    ].sort())
  })

  it('carries no re-export of any kind — a compatibility shim would defeat the move', () => {
    expect(moduleSource).not.toMatch(/^export\s+\*/m)
    expect(moduleSource).not.toMatch(/^export\s*(?:type\s*)?\{[^}]*\}\s*from/m)
  })
})

