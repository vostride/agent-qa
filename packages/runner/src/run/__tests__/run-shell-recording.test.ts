import { expect, test } from 'vitest'
import type { RecordingEntry, RunEventEnvelope, TestFinishedPayload } from '@vostride/agent-qa-schema'
import { startRun, type RunConfig } from '../shell.js'
import { SecretRedactor, SecretStore } from '../../loop/secrets.js'

const recording: RecordingEntry = {
  state: 'present', contentType: 'video/webm', byteLength: 123, durationMs: 56,
  ref: { id: `recording:${'a'.repeat(64)}`, sha: 'a'.repeat(64) },
}

async function run(failFast = false) {
  const events: RunEventEnvelope[] = []
  const executed: string[] = []
  const config: RunConfig = {
    runId: 'synthetic-recording-shell' as RunConfig['runId'],
    scope: { tier: 'suite', key: 'synthetic' }, executionContext: 'local-headless',
    buildOrdinal: 1, configDigests: { suiteConfigDigest: 'suite', testConfigDigest: 'test' },
    secretRedactor: new SecretRedactor(new SecretStore({ SYNTHETIC_KEY: 'synthetic-secret' })),
    members: ['first', 'second'].map(testId => ({ testId, name: testId, filePath: 'synthetic.yaml',
      ...(failFast ? { failFastGroup: 'group' } : {}) })),
    executor: async member => {
      executed.push(member.testId)
      return { name: member.name, filePath: 'synthetic.yaml', duration: 5,
        status: failFast ? 'failed' : 'passed',
        steps: [{ name: 'step', status: failFast ? 'failed' : 'passed', duration: 1 }],
        failureSummary: 'synthetic-secret',
        ...(member.testId === 'first' ? { recording } : {}),
      }
    },
  }
  const session = startRun(config)
  session.subscribe(1, event => events.push(event))
  await session.done
  const terminals = events.filter(event => event.type === 'testFinished')
    .map(event => event.payload as TestFinishedPayload)
  return { terminals, executed }
}

test('REC-SHELL-TESTFINISHED-CARRIES: recording survives the real bus mask walk and history stays absent', async () => {
  const { terminals } = await run()
  expect(terminals).toHaveLength(2)
  expect(terminals[0].recording).toEqual(recording)
  expect(terminals[0].failureSummary).toBe('[secret:SYNTHETIC_KEY]')
  expect(terminals[1]).not.toHaveProperty('recording')
})

test('REC-SHELL-SKIP-NOT-CAPTURED: group fail-fast publishes an explicit absence without execution', async () => {
  const { terminals, executed } = await run(true)
  expect(terminals[1].recording).toEqual({ state: 'absent', reason: 'not-captured' })
  expect(terminals[1].outcome).toBe('skipped')
  expect(executed).toEqual(['first'])
})
