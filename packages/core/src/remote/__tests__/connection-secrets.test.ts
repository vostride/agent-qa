import {
  MissingSecretError,
  resolveSecretTemplatesInValue,
  SecretStore,
} from '@vostride/agent-qa-runner'
import { describe, expect, it } from 'vitest'

import { RemoteEntrySchema } from '../../schema/remote-schema.js'
import {
  connectionSecretMisuse,
  missingDeviceSecrets,
  missingDeviceSecretSentence,
  missingRemoteSecrets,
  missingRemoteSecretSentence,
  splitConnectionSecrets,
} from '../connection-secrets.js'

const grid = RemoteEntrySchema.parse({
  name: 'grid',
  protocol: 'playwright',
  url: 'ws://127.0.0.1:3000/',
  headers: { Authorization: 'Bearer {{secret:REMOTE_TOKEN}}' },
})
const farm = RemoteEntrySchema.parse({
  name: 'farm',
  protocol: 'cdp',
  url: 'http://127.0.0.1:9222',
  basicAuth: { user: '{{secret:FARM_USER}}', password: '{{secret:FARM_PASSWORD}}' },
})
const remotes = [grid, farm]
const config = { registry: { remotes } }

const store = new SecretStore({
  REMOTE_TOKEN: 'remote-token-value',
  FARM_USER: 'farm-user',
  FARM_PASSWORD: 'farm-password',
  LOGIN_PASSWORD: 'login-password',
})
const names = splitConnectionSecrets(store, config).connectionNames

const misuse = (name: string, file: string, place: string): string =>
  `${name} is a remote's or device's credential and only connects to it; ${file} uses it in ${place}. Use another secret there.`

describe("a remote's connection-only secrets", () => {
  it('leave the step store every secret no remote references', () => {
    const { stepStore, connectionNames } = splitConnectionSecrets(store, config)
    expect([...connectionNames].sort()).toEqual(['FARM_PASSWORD', 'FARM_USER', 'REMOTE_TOKEN'])
    const kept: string[] = []
    stepStore.forEachSecret((name) => kept.push(name))
    expect(kept).toEqual(['LOGIN_PASSWORD'])
    expect(store.has('REMOTE_TOKEN')).toBe(true)
  })

  it('cannot resolve in an expected value planned at run time, while the full store can', () => {
    const { stepStore } = splitConnectionSecrets(store, config)
    const planned = '{{secret:REMOTE_TOKEN}}'
    expect(() => resolveSecretTemplatesInValue(planned, stepStore)).toThrow(MissingSecretError)
    expect(() => resolveSecretTemplatesInValue(planned, stepStore)).toThrow(/REMOTE_TOKEN/)
    expect(resolveSecretTemplatesInValue(planned, store)).toBe('remote-token-value')
  })

  it("leave the step store a name only a device's capabilities or a target's app.ref references", () => {
    const deviceStore = new SecretStore({
      FARM_KEY: 'farm-key-value',
      SHOP_APK_SIGNATURE: 'apk-signature-value',
      LOGIN_PASSWORD: 'login-password',
    })
    const { stepStore, connectionNames } = splitConnectionSecrets(deviceStore, {
      registry: {
        devices: {
          'galaxy-farm': {
            platform: 'android',
            remote: 'farm',
            capabilities: { 'farm:options': { accessKey: '{{secret:FARM_KEY}}' } },
          },
        },
        targets: {
          shop: {
            platform: 'android',
            app: { ref: 'https://files.example.com/shop.apk?sig={{secret:SHOP_APK_SIGNATURE}}' },
          },
        },
      },
    })
    expect([...connectionNames]).toEqual(['FARM_KEY', 'SHOP_APK_SIGNATURE'])
    const kept: string[] = []
    stepStore.forEachSecret((name) => kept.push(name))
    expect(kept).toEqual(['LOGIN_PASSWORD'])
    expect(() => resolveSecretTemplatesInValue('{{secret:FARM_KEY}}', stepStore)).toThrow(
      MissingSecretError,
    )
    expect(
      connectionSecretMisuse({
        names: connectionNames,
        file: 'tests/login.yaml',
        steps: ['Type {{secret:FARM_KEY}} into the field'],
        target: 'https://app.test/?s={{secret:SHOP_APK_SIGNATURE}}',
      }),
    ).toEqual([
      misuse('FARM_KEY', 'tests/login.yaml', 'a step'),
      misuse('SHOP_APK_SIGNATURE', 'tests/login.yaml', 'its target url'),
    ])
  })

  it('refuse a bare step that names one', () => {
    expect(
      connectionSecretMisuse({
        names,
        file: 'tests/login.yaml',
        steps: ['Open the page', 'Type {{secret:REMOTE_TOKEN}} into the field'],
      }),
    ).toEqual([misuse('REMOTE_TOKEN', 'tests/login.yaml', 'a step')])
  })

  it("refuse a step object's text that names one", () => {
    expect(
      connectionSecretMisuse({
        names,
        file: 'tests/login.yaml',
        steps: [{ step: 'Verify the banner reads "{{secret:FARM_USER}}"', timeout: 5000 }],
      }),
    ).toEqual([misuse('FARM_USER', 'tests/login.yaml', 'a step')])
  })

  it("refuse a step's capture pattern that names one", () => {
    expect(
      connectionSecretMisuse({
        names,
        file: 'tests/login.yaml',
        steps: [
          {
            step: 'Read the order number',
            capture: {
              variable: 'order',
              method: 'regex',
              pattern: '{{secret:FARM_PASSWORD}}-(\\d+)',
            },
          },
        ],
      }),
    ).toEqual([misuse('FARM_PASSWORD', 'tests/login.yaml', 'a step')])
  })

  it('refuse a target url that names one', () => {
    expect(
      connectionSecretMisuse({
        names,
        file: 'tests/login.yaml',
        steps: [],
        target: 'https://app.test/?t={{secret:REMOTE_TOKEN}}',
      }),
    ).toEqual([misuse('REMOTE_TOKEN', 'tests/login.yaml', 'its target url')])
  })

  it('give one sentence per secret and place, however many steps repeat it', () => {
    expect(
      connectionSecretMisuse({
        names,
        file: 'tests/login.yaml',
        steps: ['Type {{secret:REMOTE_TOKEN}}', 'Type {{secret:REMOTE_TOKEN}} again'],
      }),
    ).toEqual([misuse('REMOTE_TOKEN', 'tests/login.yaml', 'a step')])
  })

  it('let a step use any other secret', () => {
    expect(
      connectionSecretMisuse({
        names,
        file: 'tests/login.yaml',
        steps: ['Type {{secret:LOGIN_PASSWORD}} into the password field'],
        target: 'https://app.test/{{secret:LOGIN_PASSWORD}}',
      }),
    ).toEqual([])
  })

  it('name each remote secret the store does not declare, with the configured secrets file', () => {
    const partial = new SecretStore({ FARM_USER: 'farm-user' })
    const missing = missingRemoteSecrets([grid, farm, grid], partial)
    expect(missing.map(({ remote, name }) => [remote.name, name])).toEqual([
      ['grid', 'REMOTE_TOKEN'],
      ['farm', 'FARM_PASSWORD'],
    ])
    expect(missingRemoteSecretSentence(missing[0]!, '.env.secrets.local')).toBe(
      'Remote grid (playwright ws://127.0.0.1:3000) needs REMOTE_TOKEN, which .env.secrets.local does not declare. Add it there.',
    )
    expect(missingRemoteSecrets(remotes, store)).toEqual([])
  })

  it('name each secret a used remote device needs that the store does not declare, naming the device', () => {
    const appiumFarm = RemoteEntrySchema.parse({
      name: 'farm',
      protocol: 'appium',
      url: 'https://farm.example.com/wd/hub',
      headers: { 'x-farm-token': '{{secret:FARM_TOKEN}}' },
    })
    const devices = {
      'galaxy-farm': {
        capabilities: { 'farm:options': { accessKey: '{{secret:FARM_KEY}}' } },
      },
      'pixel-farm': {},
    }
    const used = [
      { device: 'galaxy-farm', remote: appiumFarm },
      { device: 'pixel-farm', remote: appiumFarm },
      { device: 'galaxy-farm', remote: appiumFarm },
    ]
    const partial = new SecretStore({ FARM_TOKEN: 'farm-token' })
    const missing = missingDeviceSecrets(used, devices, partial)
    expect(missing.map(({ device, name }) => [device, name])).toEqual([['galaxy-farm', 'FARM_KEY']])
    expect(missingDeviceSecretSentence(missing[0]!, '.env.secrets.local')).toBe(
      'Device galaxy-farm on remote farm (appium https://farm.example.com:443) needs FARM_KEY, which .env.secrets.local does not declare. Add it there.',
    )
    expect(
      missingDeviceSecrets(used, devices, new SecretStore({})).map(({ device, name }) => [
        device,
        name,
      ]),
    ).toEqual([
      ['galaxy-farm', 'FARM_TOKEN'],
      ['galaxy-farm', 'FARM_KEY'],
      ['pixel-farm', 'FARM_TOKEN'],
    ])
    expect(
      missingDeviceSecrets(used, devices, new SecretStore({ FARM_TOKEN: 't', FARM_KEY: 'k' })),
    ).toEqual([])
  })
})
