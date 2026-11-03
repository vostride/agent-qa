// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { generateRunId } from '@vostride/agent-qa-ids'
import { afterEach, describe, expect, it } from 'vitest'
import type { RunArtifactResponse, RunRow } from '@/lib/api'
import { ArtifactTestTab } from '../artifact-test-tab'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ORIGIN = 'ws://10.0.0.5:3000'
const REMOTE_LINE = `Ran on lab (playwright ${ORIGIN}), 131.0.6778.33`
const REFUSED_LINE = `Could not run on lab (playwright ${ORIGIN}): auth`
const DROPPED_LINES = {
  lost: `${REMOTE_LINE}, until the connection was lost`,
  ended: `${REMOTE_LINE}, until the remote ended the session`,
} as const

const remotePlace = {
  place: 'remote',
  name: 'lab',
  protocol: 'playwright',
  origin: ORIGIN,
  browserVersion: '131.0.6778.33',
  headless: 'decided by the remote',
  unsupported: [{ capability: 'launch flags', reason: 'the remote launches its own browser' }],
}

const refusedPlace = { place: 'remote', name: 'lab', protocol: 'playwright', origin: ORIGIN, failureKind: 'auth' }

function droppedPlace(failureKind: 'lost' | 'ended') {
  return { ...remotePlace, failureKind }
}

const run: RunRow = {
  id: generateRunId(), name: 'Login', filePath: null, status: 'passed', duration: 1,
  attributes: {}, environment: null, metadata: null, startedAt: null, endedAt: null,
  failureSummary: null, errorLog: null, testId: null, suiteId: null,
  platform: 'web', testFileContent: null, modelName: null, llmProvider: null,
  attemptNumber: 1, retryCount: 0, maxRetries: 0,
  createdAt: '2026-10-17T00:00:00Z',
}

function runtime(place: unknown) {
  return place === undefined ? { platform: 'web', targetName: 'staging' } : { platform: 'web', targetName: 'staging', place }
}

function response(payload: Record<string, unknown>): RunArtifactResponse {
  return {
    run,
    artifact: {
      runId: run.id, kind: 'test', schemaVersion: 1,
      createdAt: run.createdAt, updatedAt: run.createdAt, finalizedAt: '2026-10-17T00:01:00Z',
      payload: { schemaVersion: 1, ...payload },
    },
    missingSections: [],
  }
}

function membersResponse(place: unknown): RunArtifactResponse {
  return response({
    source: {
      kind: 'tests',
      members: [{
        index: 0, name: 'Login', testId: 't_login', filePath: 'tests/t_login.yaml',
        ref: { test: 'tests/t_login.yaml', id: 't_login' }, rawYaml: 'name: Login\n',
        resolvedDefinition: { name: 'Login' }, loadStatus: 'loaded',
        config: { runtime: runtime(place), timeouts: { step: 30000 } },
      }],
    },
  })
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

function open(scope: Element, label: string) {
  const trigger = Array.from(scope.querySelectorAll('button')).find((button) =>
    button.textContent?.trim() === label || button.querySelector('span')?.textContent === label)
  expect(trigger, `${label} trigger`).toBeDefined()
  act(() => trigger!.click())
}

function memberCard(place: unknown): Element {
  const tab = mount(membersResponse(place))
  const card = tab.querySelector('[data-suite-member-index="0"]')
  expect(card).not.toBeNull()
  open(card!, 'Member snapshots')
  return card!
}

describe("a test's place on the run page", () => {
  it('a test that ran on a remote names the remote, its protocol, origin and browser version', () => {
    const card = memberCard(remotePlace)
    const line = card.querySelector('[data-member-place]')
    expect(line?.textContent).toBe(REMOTE_LINE)
    expect(line?.querySelector('button, input, select, textarea, a')).toBeNull()
    const config = card.querySelector('[data-member-config]')!
    expect(config.firstElementChild).toBe(line)
    open(config, 'place')
    open(config, 'unsupported')
    open(config, '0')
    expect(config.textContent).toContain('decided by the remote')
    expect(config.textContent).toContain('launch flags')
  })

  it('a test launched here reads Ran on this machine', () => {
    const card = memberCard({ place: 'here' })
    expect(card.querySelector('[data-member-place]')?.textContent).toBe('Ran on this machine')
  })

  it('a test that ran on a remote reads in the plain text style', () => {
    const card = memberCard(remotePlace)
    expect(card.querySelector('[data-member-place]')?.className).toContain('text-foreground')
    expect(card.querySelector('[data-member-place]')?.className).not.toContain('text-destructive')
  })

  it('a test refused by its remote says it could not run there and why, as a failure', () => {
    const card = memberCard(refusedPlace)
    const line = card.querySelector('[data-member-place]')
    expect(line?.textContent).toBe(REFUSED_LINE)
    expect(line?.className).toContain('text-destructive')
    expect(line?.textContent).not.toContain('undefined')
    const config = card.querySelector('[data-member-config]')!
    open(config, 'place')
    expect(config.textContent).toContain('failureKind')
    expect(config.textContent).toContain('auth')
  })

  it.each(['lost', 'ended'] as const)(
    'a test whose remote session was %s says it ran there until then, as a failure',
    (kind) => {
      const card = memberCard(droppedPlace(kind))
      const line = card.querySelector('[data-member-place]')
      expect(line?.textContent).toBe(DROPPED_LINES[kind])
      expect(line?.className).toContain('text-destructive')
    },
  )

  it('an artifact without a place shows no place line', () => {
    const card = memberCard(undefined)
    expect(card.querySelector('[data-member-place]')).toBeNull()
    expect(card.querySelector('[data-member-config]')?.textContent).toContain('staging')
  })

  it("a one-test run shows its place above the test's source", () => {
    const tab = mount(response({
      source: { kind: 'test', rawYaml: 'name: Login\n', resolvedDefinition: { name: 'Login' } },
      config: { runtime: runtime(remotePlace) },
    }))
    const line = tab.querySelector('[data-run-place]')
    expect(line?.textContent).toBe(REMOTE_LINE)
    expect(tab.firstElementChild?.firstElementChild).toBe(line)
  })

  it.each([
    ['refused by its remote', refusedPlace, REFUSED_LINE],
    ['whose remote session was lost', droppedPlace('lost'), DROPPED_LINES.lost],
    ['whose remote ended the session', droppedPlace('ended'), DROPPED_LINES.ended],
  ] as const)('a one-test run %s shows that above its source, as a failure', (_how, place, text) => {
    const tab = mount(response({
      source: { kind: 'test', rawYaml: 'name: Login\n', resolvedDefinition: { name: 'Login' } },
      config: { runtime: runtime(place) },
    }))
    const line = tab.querySelector('[data-run-place]')
    expect(line?.textContent).toBe(text)
    expect(line?.className).toContain('text-destructive')
  })

  it('a one-test run without a place shows no place line', () => {
    const tab = mount(response({
      source: { kind: 'test', rawYaml: 'name: Login\n', resolvedDefinition: { name: 'Login' } },
      config: { runtime: runtime(undefined) },
    }))
    expect(tab.querySelector('[data-run-place]')).toBeNull()
    expect(tab.querySelector('[data-member-place]')).toBeNull()
  })
})
