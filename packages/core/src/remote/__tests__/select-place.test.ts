import { DEFAULT_REMOTE_CONNECT_TIMEOUT_MS } from '@vostride/agent-qa-runner'
import { describe, expect, it } from 'vitest'

import { RemoteEntrySchema } from '../../schema/remote-schema.js'
import {
  runnerForPlaces,
  selectSuitePlace,
  selectWebPlace,
  type SelectWebPlaceInput,
  type SelectWebPlaceResult,
} from '../select-place.js'

const grid = RemoteEntrySchema.parse({
  name: 'grid',
  protocol: 'playwright',
  url: 'ws://127.0.0.1:3000/',
})
const farm = RemoteEntrySchema.parse({
  name: 'farm',
  protocol: 'playwright',
  url: 'wss://example.com/playwright',
  connectTimeout: '45s',
})
const devtools = RemoteEntrySchema.parse({
  name: 'devtools',
  protocol: 'cdp',
  url: 'http://127.0.0.1:9222',
})
const cloud = RemoteEntrySchema.parse({
  name: 'cloud',
  plugin: 'kernel',
  settings: { region: 'eu', auth: { token: '{{secret:KERNEL_TOKEN}}' } },
})
const fleet = RemoteEntrySchema.parse({
  name: 'fleet',
  plugin: 'kernel',
  connectTimeout: '45s',
  context: 'reuse',
})
const remotes = [grid, farm, devtools, cloud, fleet]

function web(input: Omit<SelectWebPlaceInput, 'remotes'>): SelectWebPlaceResult {
  return selectWebPlace({ remotes, ...input })
}

function placeName(result: SelectWebPlaceResult): string {
  if ('refusal' in result) throw new Error(`refused: ${result.refusal}`)
  return result.place.kind === 'local' ? 'local' : result.place.remote.name
}

function refusal(result: SelectWebPlaceResult): string {
  if (!('refusal' in result)) throw new Error(`placed: ${placeName(result)}`)
  return result.refusal
}

function connectTimeoutMs(result: SelectWebPlaceResult): number {
  if ('refusal' in result) throw new Error(`refused: ${result.refusal}`)
  if (result.place.kind !== 'remote') throw new Error('placed here')
  return result.place.remote.connectTimeoutMs
}

describe('where a web test runs', () => {
  it('takes the suite pick over the test pick over the config pick, and runs here with no pick', () => {
    expect(placeName(web({ suite: 'grid', test: 'farm', config: 'devtools' }))).toBe('grid')
    expect(placeName(web({ test: 'farm', config: 'devtools' }))).toBe('farm')
    expect(placeName(web({ config: 'devtools' }))).toBe('devtools')
    expect(placeName(web({}))).toBe('local')
  })

  it('runs here when local is picked at any level, whatever the levels below say', () => {
    expect(placeName(web({ suite: 'local', test: 'farm', config: 'grid' }))).toBe('local')
    expect(placeName(web({ test: 'local', config: 'grid' }))).toBe('local')
    expect(placeName(web({ config: 'local' }))).toBe('local')
  })

  it('runs every member of a suite that names a remote there, whatever the members pick', () => {
    const result = selectSuitePlace({
      remotes,
      suiteName: 'checkout',
      suiteFile: 'suites/checkout.suite.yaml',
      suite: 'grid',
      config: 'farm',
      members: [
        { file: 'tests/a.test.yaml', pick: 'farm' },
        { file: 'tests/b.test.yaml', pick: 'local' },
        { file: 'tests/c.test.yaml' },
      ],
    })
    expect(placeName(result)).toBe('grid')
  })

  it('runs a suite here when the suite picks local, whatever the members pick', () => {
    const result = selectSuitePlace({
      remotes,
      suiteName: 'checkout',
      suiteFile: 'suites/checkout.suite.yaml',
      suite: 'local',
      members: [{ file: 'tests/a.test.yaml', pick: 'farm' }],
    })
    expect(placeName(result)).toBe('local')
  })

  it('runs a suite with no pick where its members agree to run', () => {
    const agreeing = selectSuitePlace({
      remotes,
      suiteName: 'checkout',
      suiteFile: 'suites/checkout.suite.yaml',
      config: 'grid',
      members: [
        { file: 'tests/a.test.yaml', pick: 'farm' },
        { file: 'tests/b.test.yaml', pick: 'farm' },
      ],
    })
    expect(placeName(agreeing)).toBe('farm')

    const fromConfig = selectSuitePlace({
      remotes,
      suiteName: 'checkout',
      suiteFile: 'suites/checkout.suite.yaml',
      config: 'grid',
      members: [
        { file: 'tests/a.test.yaml', pick: 'grid' },
        { file: 'tests/b.test.yaml' },
      ],
    })
    expect(placeName(fromConfig)).toBe('grid')

    const here = selectSuitePlace({
      remotes,
      suiteName: 'checkout',
      suiteFile: 'suites/checkout.suite.yaml',
      members: [
        { file: 'tests/a.test.yaml', pick: 'local' },
        { file: 'tests/b.test.yaml' },
      ],
    })
    expect(placeName(here)).toBe('local')
  })

  it('refuses a suite with no pick whose members disagree, naming every member and its pick', () => {
    const result = selectSuitePlace({
      remotes,
      suiteName: 'checkout',
      suiteFile: 'suites/checkout.suite.yaml',
      config: 'grid',
      members: [
        { file: 'tests/a.test.yaml', pick: 'farm' },
        { file: 'tests/b.test.yaml' },
        { file: 'tests/c.test.yaml', pick: 'local' },
      ],
    })
    expect(refusal(result)).toBe(
      'Suite checkout runs its tests in one place, but tests/a.test.yaml picks farm, ' +
        'tests/b.test.yaml picks grid and tests/c.test.yaml picks local. ' +
        'Set use.browser.remote in the suite or make the tests agree.',
    )
  })

  it('refuses an unknown name in a test file, naming that file', () => {
    expect(refusal(web({ test: 'nope', file: 'tests/a.test.yaml' }))).toBe(
      'Unknown remote "nope" in tests/a.test.yaml. registry.remotes lists: grid, farm, devtools, cloud, fleet.',
    )
    const member = selectSuitePlace({
      remotes,
      suiteName: 'checkout',
      suiteFile: 'suites/checkout.suite.yaml',
      members: [
        { file: 'tests/a.test.yaml', pick: 'grid' },
        { file: 'tests/b.test.yaml', pick: 'nope' },
      ],
    })
    expect(refusal(member)).toBe(
      'Unknown remote "nope" in tests/b.test.yaml. registry.remotes lists: grid, farm, devtools, cloud, fleet.',
    )
  })

  it('refuses an unknown name in a suite file, naming the suite file', () => {
    const result = selectSuitePlace({
      remotes: [],
      suiteName: 'checkout',
      suiteFile: 'suites/checkout.suite.yaml',
      suite: 'nope',
      members: [{ file: 'tests/a.test.yaml' }],
    })
    expect(refusal(result)).toBe(
      'Unknown remote "nope" in suites/checkout.suite.yaml. registry.remotes lists no remotes.',
    )
  })

  it('refuses a cdp remote asked for firefox or webkit, and accepts it for chromium', () => {
    for (const engine of ['firefox', 'webkit'] as const) {
      const chromiumOnly = `Remote devtools serves Chromium only; this test asks for ${engine}.`
      expect(refusal(web({ test: 'devtools', engine }))).toBe(chromiumOnly)
      const suite = selectSuitePlace({
        remotes,
        suiteName: 'checkout',
        suiteFile: 'suites/checkout.suite.yaml',
        suite: 'devtools',
        members: [{ file: 'tests/a.test.yaml' }],
        engine,
      })
      expect(refusal(suite)).toBe(chromiumOnly)
      const members = selectSuitePlace({
        remotes,
        suiteName: 'checkout',
        suiteFile: 'suites/checkout.suite.yaml',
        members: [{ file: 'tests/a.test.yaml', pick: 'devtools' }],
        engine,
      })
      expect(refusal(members)).toBe(chromiumOnly)
    }
    expect(placeName(web({ test: 'devtools', engine: 'chromium' }))).toBe('devtools')
  })

  it('refuses an appium remote picked by a test, a suite or a suite member', () => {
    const appium = RemoteEntrySchema.parse({
      name: 'devices',
      protocol: 'appium',
      url: 'https://devices.example.com/wd/hub',
    })
    const withAppium = [...remotes, appium]
    const sentence =
      'Remote devices is an appium remote; use.browser.remote picks a playwright or cdp remote.'
    expect(refusal(selectWebPlace({ remotes: withAppium, test: 'devices' }))).toBe(sentence)
    const suite = selectSuitePlace({
      remotes: withAppium,
      suiteName: 'checkout',
      suiteFile: 'suites/checkout.suite.yaml',
      suite: 'devices',
      members: [{ file: 'tests/a.test.yaml' }],
    })
    expect(refusal(suite)).toBe(sentence)
    const member = selectSuitePlace({
      remotes: withAppium,
      suiteName: 'checkout',
      suiteFile: 'suites/checkout.suite.yaml',
      members: [{ file: 'tests/a.test.yaml', pick: 'devices' }],
    })
    expect(refusal(member)).toBe(sentence)
  })

  it('accepts a playwright remote for firefox', () => {
    expect(placeName(web({ test: 'grid', engine: 'firefox' }))).toBe('grid')
  })

  it('gives a remote without connectTimeout a 5-minute connect timeout and one with it that value', () => {
    expect(DEFAULT_REMOTE_CONNECT_TIMEOUT_MS).toBe(300000)
    expect(connectTimeoutMs(web({ test: 'grid' }))).toBe(300000)
    expect(connectTimeoutMs(web({ test: 'farm' }))).toBe(45000)
    const suiteOn = (suite: string) =>
      selectSuitePlace({
        remotes,
        suiteName: 'checkout',
        suiteFile: 'suites/checkout.suite.yaml',
        suite,
        members: [{ file: 'tests/a.test.yaml' }],
      })
    expect(connectTimeoutMs(suiteOn('grid'))).toBe(300000)
    expect(connectTimeoutMs(suiteOn('farm'))).toBe(45000)
  })
})

describe('a web test on a plugin remote', () => {
  it('gets a plugin place carrying the entry name, its settings and a 5-minute connect timeout', () => {
    const placed = web({ test: 'cloud' })
    if ('refusal' in placed) throw new Error(placed.refusal)
    expect(placed.place).toEqual({
      kind: 'remote',
      remote: {
        name: 'cloud',
        plugin: {
          entry: 'kernel',
          settings: { region: 'eu', auth: { token: '{{secret:KERNEL_TOKEN}}' } },
        },
        connectTimeoutMs: 300000,
      },
    })
  })

  it('takes its connectTimeout and context, and carries no settings it was not given', () => {
    const placed = web({ config: 'fleet' })
    if ('refusal' in placed) throw new Error(placed.refusal)
    expect(placed.place).toEqual({
      kind: 'remote',
      remote: {
        name: 'fleet',
        plugin: { entry: 'kernel' },
        connectTimeoutMs: 45000,
        context: 'reuse',
      },
    })
  })

  it('is placed for any engine, because what its plugin serves is checked at run start', () => {
    for (const engine of ['chromium', 'firefox', 'webkit'] as const) {
      expect(placeName(web({ test: 'cloud', engine }))).toBe('cloud')
    }
  })

  it('runs a whole suite there when the suite or its agreeing members pick it', () => {
    const picked = selectSuitePlace({
      remotes,
      suiteName: 'checkout',
      suiteFile: 'suites/checkout.suite.yaml',
      suite: 'cloud',
      members: [{ file: 'tests/a.test.yaml', pick: 'grid' }],
    })
    expect(placeName(picked)).toBe('cloud')
    expect(connectTimeoutMs(picked)).toBe(300000)

    const agreeing = selectSuitePlace({
      remotes,
      suiteName: 'checkout',
      suiteFile: 'suites/checkout.suite.yaml',
      config: 'cloud',
      members: [{ file: 'tests/a.test.yaml' }, { file: 'tests/b.test.yaml', pick: 'cloud' }],
    })
    expect(placeName(agreeing)).toBe('cloud')
  })
})

describe('the runner a run records', () => {
  it('is remote when any test runs on a remote, and local otherwise', () => {
    const here = { kind: 'local' } as const
    const placed = web({ config: 'grid' })
    if ('refusal' in placed) throw new Error(placed.refusal)

    expect(runnerForPlaces([here, placed.place, here])).toBe('remote')
    expect(runnerForPlaces([placed.place])).toBe('remote')
    expect(runnerForPlaces([here, here])).toBe('local')
    expect(runnerForPlaces([])).toBe('local')
  })

  it('is remote when a test runs on a plugin remote', () => {
    const placed = web({ test: 'cloud' })
    if ('refusal' in placed) throw new Error(placed.refusal)

    expect(runnerForPlaces([{ kind: 'local' }, placed.place])).toBe('remote')
  })
})
