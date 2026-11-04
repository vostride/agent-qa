import { RemoteRefusalError, SecretStore } from '@vostride/agent-qa-runner'
import type { RemoteDeviceConfig } from '@vostride/agent-qa-runner'
import { describe, expect, it } from 'vitest'

import { resolveRemoteDeviceConnection } from '../remote-device-connection.js'

const TOKEN = 'farm-token-value'
const PASSWORD = 'pässword-value'

function farm(extra: Partial<RemoteDeviceConfig> = {}): RemoteDeviceConfig {
  return {
    name: 'farm',
    protocol: 'appium',
    url: 'https://farm.example.com/wd/hub',
    connectTimeoutMs: 300_000,
    ...extra,
  }
}

describe('resolveRemoteDeviceConnection', () => {
  it('splits the url into explicit protocol, hostname, port and path', () => {
    expect(
      resolveRemoteDeviceConnection({
        remote: farm({ url: 'http://127.0.0.1:4723/wd/hub' }),
        device: 'galaxy-farm',
      }),
    ).toEqual({ protocol: 'http', hostname: '127.0.0.1', port: 4723, path: '/wd/hub', headers: {} })
  })

  it('takes the port from the scheme when the url names none, and / when it has no path', () => {
    const https = resolveRemoteDeviceConnection({ remote: farm(), device: 'galaxy-farm' })
    expect(https).toMatchObject({ protocol: 'https', port: 443, path: '/wd/hub' })
    const http = resolveRemoteDeviceConnection({
      remote: farm({ url: 'http://farm.example.com' }),
      device: 'galaxy-farm',
    })
    expect(http).toMatchObject({ protocol: 'http', port: 80, path: '/' })
  })

  it('resolves header references from the secrets and leaves the remote config unchanged', () => {
    const remote = farm({ headers: { 'x-farm-token': 'Bearer {{secret:FARM_TOKEN}}' } })
    const connection = resolveRemoteDeviceConnection({
      remote,
      device: 'galaxy-farm',
      secrets: new SecretStore({ FARM_TOKEN: TOKEN }),
    })
    expect(connection.headers).toEqual({ 'x-farm-token': `Bearer ${TOKEN}` })
    expect(remote.headers).toEqual({ 'x-farm-token': 'Bearer {{secret:FARM_TOKEN}}' })
  })

  it('turns basicAuth into a Basic Authorization header over the UTF-8 bytes', () => {
    const connection = resolveRemoteDeviceConnection({
      remote: farm({ basicAuth: { user: 'agent', password: '{{secret:FARM_PASSWORD}}' } }),
      device: 'galaxy-farm',
      secrets: new SecretStore({ FARM_PASSWORD: PASSWORD }),
    })
    const encoded = Buffer.from(`agent:${PASSWORD}`, 'utf8').toString('base64')
    expect(connection.headers).toEqual({ Authorization: `Basic ${encoded}` })
  })

  it('refuses a reference the secrets do not declare, naming the device, remote and file only', () => {
    const attempt = () =>
      resolveRemoteDeviceConnection({
        remote: farm({
          headers: { 'x-farm-token': '{{secret:FARM_TOKEN}}', 'x-other': '{{secret:DECLARED}}' },
        }),
        device: 'galaxy-farm',
        secrets: new SecretStore({ DECLARED: TOKEN }),
        secretsFile: '.env.secrets.local',
      })
    expect(attempt).toThrow(RemoteRefusalError)
    expect(attempt).toThrow(
      'Device galaxy-farm on remote farm (appium https://farm.example.com:443) needs FARM_TOKEN, which .env.secrets.local does not declare. Add it there.',
    )
    try {
      attempt()
    } catch (error) {
      expect((error as RemoteRefusalError).kind).toBeUndefined()
      expect(String((error as Error).stack)).not.toContain(TOKEN)
    }
  })

  it('names workspace.secretsFile when no secrets file is configured, and refuses without secrets', () => {
    expect(() =>
      resolveRemoteDeviceConnection({
        remote: farm({ headers: { 'x-farm-token': '{{secret:FARM_TOKEN}}' } }),
        device: 'galaxy-farm',
      }),
    ).toThrow(
      'Device galaxy-farm on remote farm (appium https://farm.example.com:443) needs FARM_TOKEN, which workspace.secretsFile does not declare. Add it there.',
    )
  })
})
