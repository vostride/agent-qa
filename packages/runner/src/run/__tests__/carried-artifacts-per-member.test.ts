// Two members share config, adapter and verifier; the second member's first step carries nothing.
import { describe, expect, it, vi } from 'vitest'
import type { LanguageModel } from 'ai'
import { asRef } from '@vostride/agent-qa-schema'
import type { DownloadEvidence } from '@vostride/agent-qa-schema'
import { makeScreenState } from '../../testing/screen-fixtures.js'
import { scriptedVerification } from '../../testing/condition-verdicts.js'
import type { ActionResult, PlatformAdapter } from '../../platform.js'
import type { CarriedLine, VerifierStepRecord } from '../../loop/step-record.js'
import type { Verifier } from '../../loop/types.js'
import { runMemberTest } from '../member-runner.js'
import type { MemberRunConfig } from '../member-runner.js'

const fakeModel = {} as unknown as LanguageModel

const INVOICE: DownloadEvidence = {
  suggestedFilename: 'invoice-1042.csv',
  extension: '.csv',
  size: 42,
  sha256: 'd'.repeat(64),
  state: 'completed',
}

describe('carried artifacts per test member', () => {
  it('each test member has its own cell', async () => {
    let executed = 0
    const adapter: PlatformAdapter = {
      platform: 'web',
      async setup() {},
      async cleanup() {},
      async observe() {
        return makeScreenState()
      },
      async execute(): Promise<ActionResult> {
        executed++
        return executed === 1 ? { success: true, metadata: { download: [INVOICE] } } : { success: true }
      },
    }
    const carried: { step: string; lines: CarriedLine[] }[] = []
    const verifier: Verifier = {
      async verify(step, _before, after, action, _shot, _signal, _note, _predicate, _author, _evidence, record?: VerifierStepRecord) {
        carried.push({ step, lines: record?.carried ?? [] })
        return { verification: scriptedVerification({ step, after, action, pass: true, reasoning: 'Done' }) }
      },
    }
    const config: MemberRunConfig = {
      adapter,
      planner: {
        async plan() {
          return { plan: { reasoning: 'Continue', action: { type: 'click', ref: asRef('e2') }, confidence: 1, stepComplete: true } }
        },
      },
      verifier,
      plannerModel: fakeModel,
      verifierModel: fakeModel,
      testIndex: 0,
      abortSignal: new AbortController().signal,
      sink: {
        stepStarted: vi.fn(),
        loopEmitFor: () => ({ stepFinalized: vi.fn(), subActionRecorded: vi.fn() }),
        hookStarted: vi.fn(),
        hookFinished: vi.fn(),
        testRetryScheduled: vi.fn(),
      },
    }

    const first = await runMemberTest(
      { testId: 't_export', name: 'Export', filePath: '/tests/export.yaml', steps: ['Export the invoice', 'Check the export'] },
      config,
    )
    const second = await runMemberTest(
      { testId: 't_dashboard', name: 'Dashboard', filePath: '/tests/dashboard.yaml', steps: ['Open the dashboard'] },
      config,
    )

    expect(first.status).toBe('passed')
    expect(second.status).toBe('passed')
    expect(carried.map((entry) => entry.step)).toEqual(['Export the invoice', 'Check the export', 'Open the dashboard'])
    expect(carried[0].lines).toEqual([])
    expect(carried[1].lines).toHaveLength(1)
    expect(carried[1].lines[0]).toMatchObject({ stepNumber: 1, actionIndex: 1 })
    expect(carried[1].lines[0].text).toContain('invoice-1042.csv')
    expect(carried[2].lines).toEqual([])
  })
})
