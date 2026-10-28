// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { generateRunId } from '@vostride/agent-qa-ids'
import { afterEach, describe, expect, it } from 'vitest'
import type { RunArtifactResponse, RunRow } from '@/lib/api'
import { ArtifactTestTab } from '../artifact-test-tab'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const LOGIN_YAML = 'name: Login\nsteps:\n  - Click Sign in\n'
const CHECKOUT_YAML = 'name: Checkout\nsteps:\n  - Click Pay\n'

const run: RunRow = {
  id: generateRunId(), name: 'Login · Checkout', filePath: null, status: 'passed', duration: 1,
  attributes: {}, environment: null, metadata: null, startedAt: null, endedAt: null,
  failureSummary: null, errorLog: null, testId: null, suiteId: null,
  platform: 'web', testFileContent: null, modelName: null, llmProvider: null,
  attemptNumber: 1, retryCount: 0, maxRetries: 0,
  createdAt: '2026-10-17T00:00:00Z',
}

function member(index: number, name: string, testId: string, rawYaml: string, target: string, step: number) {
  return {
    index, name, testId, filePath: `tests/${testId}.yaml`, ref: { test: `tests/${testId}.yaml`, id: testId },
    rawYaml, resolvedDefinition: { name }, loadStatus: 'loaded',
    config: { runtime: { platform: 'web', targetName: target }, timeouts: { step } },
  }
}

function testsResponse(): RunArtifactResponse {
  return {
    run,
    artifact: {
      runId: run.id, kind: 'test', schemaVersion: 1,
      createdAt: run.createdAt, updatedAt: run.createdAt, finalizedAt: '2026-10-17T00:01:00Z',
      payload: {
        schemaVersion: 1,
        source: {
          kind: 'tests',
          members: [
            member(1, 'Checkout', 't_checkout', CHECKOUT_YAML, 'shop', 45000),
            member(0, 'Login', 't_login', LOGIN_YAML, 'staging', 30000),
          ],
        },
      },
    },
    missingSections: ['config'],
  }
}

let root: Root | undefined
let container: HTMLDivElement | undefined

afterEach(() => {
  act(() => root?.unmount())
  root = undefined
  container?.remove()
})

function mount(data: RunArtifactResponse): HTMLDivElement {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(<ArtifactTestTab response={data} />))
  return container
}

function open(card: Element, label: string) {
  const trigger = Array.from(card.querySelectorAll('button')).find((button) => button.textContent?.trim() === label)
  expect(trigger, `${label} trigger`).toBeDefined()
  act(() => trigger!.click())
}

describe('C444-ARTIFACT-MEMBERS', () => {
  it("the Test tab shows each member's source with that member", () => {
    const tab = mount(testsResponse())
    const cards = Array.from(tab.querySelectorAll('[data-suite-member-index]'))
    expect(cards.map((card) => card.getAttribute('data-suite-member-index'))).toEqual(['0', '1'])

    const expected = [
      { name: 'Login', testId: 't_login', yaml: LOGIN_YAML, target: 'staging', step: '30000' },
      { name: 'Checkout', testId: 't_checkout', yaml: CHECKOUT_YAML, target: 'shop', step: '45000' },
    ]
    cards.forEach((card, position) => {
      const want = expected[position]!
      const other = expected[1 - position]!
      expect(card.textContent).toContain(want.name)
      expect(card.textContent).toContain(want.testId)
      expect(card.textContent).toContain(`tests/${want.testId}.yaml`)
      expect(card.textContent).toContain(want.target)
      expect(card.textContent).not.toContain(other.target)
      open(card, 'Member snapshots')
      open(card, 'Raw test YAML')
      expect(card.querySelector('pre')?.textContent).toBe(want.yaml)
      expect(card.textContent).toContain(want.step)
      expect(card.textContent).not.toContain(other.step)
    })
    expect(tab.textContent).not.toContain('Raw member YAML')
  })
})
