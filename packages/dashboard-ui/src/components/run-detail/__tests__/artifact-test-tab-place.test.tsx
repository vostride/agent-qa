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

const FARM_ORIGIN = 'https://farm.example.com:443'
const DEVICE_LINE = `Ran on farm (appium ${FARM_ORIGIN}), Appium 2.11.3, real device`

const devicePlace = {
  place: 'remote',
  name: 'farm',
  protocol: 'appium',
  origin: FARM_ORIGIN,
  device: 'iphone-farm',
  appiumVersion: '2.11.3',
  sessionId: 'a1b2c3',
  deviceType: 'real device',
}

const APP_DATA_NOTE =
  'App data was not cleared: device iphone-farm is a real iPhone, and target shop-ios has no app.ref to reinstall from.'

const refusedDevicePlace = {
  place: 'remote',
  name: 'farm',
  protocol: 'appium',
  origin: FARM_ORIGIN,
  device: 'iphone-farm',
  failureKind: 'refused',
}

const pluginPlace = {
  ...remotePlace,
  name: 'cloud',
  origin: 'wss://connect.kernel.example.com:443',
  plugin: {
    entry: 'kernel',
    package: '@vostride/agent-qa-plugin-kernel',
    version: '1.4.0',
    protocol: 1,
    origin: 'first-party',
  },
  link: 'https://dashboard.kernel.example.com/sessions/s-81',
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

  it('a test that ran on a remote device names the server, its Appium version and the device type', () => {
    const card = memberCard(devicePlace)
    const line = card.querySelector('[data-member-place]')
    expect(line?.textContent).toBe(DEVICE_LINE)
    expect(line?.className).toContain('text-foreground')
  })

  it('a remote device without a recorded version or device type names only the server', () => {
    const { appiumVersion: _version, deviceType: _type, ...bare } = devicePlace
    const card = memberCard({ ...bare, deviceType: 'unknown' })
    expect(card.querySelector('[data-member-place]')?.textContent).toBe(
      `Ran on farm (appium ${FARM_ORIGIN})`,
    )
  })

  it('a test refused by its device server says the session was refused, as a failure', () => {
    const card = memberCard(refusedDevicePlace)
    const line = card.querySelector('[data-member-place]')
    expect(line?.textContent).toBe(`Could not run on farm (appium ${FARM_ORIGIN}): session refused`)
    expect(line?.className).toContain('text-destructive')
  })

  it('a test whose device session was lost says it ran there until then, as a failure', () => {
    const card = memberCard({ ...devicePlace, failureKind: 'lost' })
    const line = card.querySelector('[data-member-place]')
    expect(line?.textContent).toBe(`${DEVICE_LINE}, until the connection was lost`)
    expect(line?.className).toContain('text-destructive')
  })

  it('an iOS test launched here reads Ran on this machine with its device type', () => {
    const card = memberCard({ place: 'here', deviceType: 'simulator' })
    expect(card.querySelector('[data-member-place]')?.textContent).toBe('Ran on this machine, simulator')
  })

  it('a test launched here with an unknown device type reads Ran on this machine', () => {
    const card = memberCard({ place: 'here', deviceType: 'unknown' })
    expect(card.querySelector('[data-member-place]')?.textContent).toBe('Ran on this machine')
  })

  it("a test's place notes each show as their own line under the place line", () => {
    const second = 'The heartbeat missed one beat.'
    const card = memberCard({ ...devicePlace, notes: [APP_DATA_NOTE, second] })
    const config = card.querySelector('[data-member-config]')!
    const [line, ...rest] = Array.from(config.children)
    expect(line?.hasAttribute('data-member-place')).toBe(true)
    const notes = rest.slice(0, 2)
    expect(notes.map((note) => note.hasAttribute('data-place-note'))).toEqual([true, true])
    expect(notes.map((note) => note.textContent)).toEqual([APP_DATA_NOTE, second])
  })

  it('a place without notes shows nothing under the place line', () => {
    const card = memberCard(devicePlace)
    expect(card.querySelector('[data-place-note]')).toBeNull()
  })

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
    expect(tab.firstElementChild?.firstElementChild?.firstElementChild).toBe(line)
    expect(tab.querySelector('[data-place-note]')).toBeNull()
  })

  it("a one-test run shows its place's notes under the place line, above the test's source", () => {
    const tab = mount(response({
      source: { kind: 'test', rawYaml: 'name: Login\n', resolvedDefinition: { name: 'Login' } },
      config: { runtime: runtime({ ...devicePlace, notes: [APP_DATA_NOTE] }) },
    }))
    const block = tab.firstElementChild?.firstElementChild
    expect(block?.firstElementChild).toBe(tab.querySelector('[data-run-place]'))
    const notes = block?.querySelectorAll('[data-place-note]') ?? []
    expect(Array.from(notes, (note) => note.textContent)).toEqual([APP_DATA_NOTE])
    expect(notes[0]?.className).toContain('text-muted-foreground')
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

  it('a test a plugin served names the plugin and links its session page in a new tab without a referrer', () => {
    const tab = mount(response({
      source: { kind: 'test', rawYaml: 'name: Login\n', resolvedDefinition: { name: 'Login' } },
      config: { runtime: runtime(pluginPlace) },
    }))
    const block = tab.firstElementChild?.firstElementChild
    expect(block?.firstElementChild).toBe(tab.querySelector('[data-run-place]'))
    const served = block?.querySelector('[data-place-plugin]')
    expect(served?.textContent).toBe('Plugin kernel (@vostride/agent-qa-plugin-kernel 1.4.0)Session page')
    const link = served?.querySelector('a[data-place-link]')
    expect(link?.getAttribute('href')).toBe('https://dashboard.kernel.example.com/sessions/s-81')
    expect(link?.getAttribute('target')).toBe('_blank')
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer')
    expect(link?.textContent).toBe('Session page')

    const card = memberCard(pluginPlace)
    expect(card.querySelector('[data-place-plugin] a')?.getAttribute('rel')).toBe('noopener noreferrer')
  })

  it('a session link that is not http or https shows no link', () => {
    const card = memberCard({ ...pluginPlace, link: 'javascript:alert(1)' })
    expect(card.querySelector('[data-place-plugin]')?.textContent).toBe(
      'Plugin kernel (@vostride/agent-qa-plugin-kernel 1.4.0)',
    )
    expect(card.querySelector('[data-place-plugin] a')).toBeNull()
  })

  it('a test on a url remote shows no plugin line', () => {
    expect(memberCard(remotePlace).querySelector('[data-place-plugin]')).toBeNull()
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
