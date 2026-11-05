import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CANCEL_ANSWER_GRACE_MS } from '@vostride/agent-qa-plugin-kit'
import { afterEach, describe, expect, it } from 'vitest'
import {
  RECENT_APPS_ROUTE,
  startFakeBrowserStackApi,
  UPLOAD_ROUTE,
  uploadedField,
  type FakeBrowserStackApi,
  type FakeBrowserStackApiInput,
} from './fake-browserstack-api.js'
import {
  ACCESS_KEY,
  initializePlugin,
  loopbackOptions,
  startPluginProcess,
  USERNAME,
  type PluginProcess,
} from './plugin-process.js'

const BASIC = `Basic ${Buffer.from(`${USERNAME}:${ACCESS_KEY}`).toString('base64')}`

interface AppFile {
  path: string
  sha256: string
  size: number
  customId: string
}

const fakes: FakeBrowserStackApi[] = []
const plugins: PluginProcess[] = []
const dirs: string[] = []

afterEach(async () => {
  await Promise.all(plugins.splice(0).map((plugin) => plugin.close()))
  await Promise.all(fakes.splice(0).map((fake) => fake.close()))
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function appFile(content = 'an android build'): Promise<AppFile> {
  const dir = await mkdtemp(join(tmpdir(), 'agent-qa-browserstack-'))
  dirs.push(dir)
  const path = join(dir, 'shop.apk')
  await writeFile(path, content)
  const sha256 = createHash('sha256').update(content).digest('hex')
  return {
    path,
    sha256,
    size: Buffer.byteLength(content),
    customId: `agent-qa-${sha256.slice(0, 32)}`,
  }
}

async function browserStack(input?: FakeBrowserStackApiInput) {
  const api = await startFakeBrowserStackApi(input)
  fakes.push(api)
  const plugin = startPluginProcess()
  plugins.push(plugin)
  expect((await initializePlugin(plugin, loopbackOptions(api.url))).error).toBeUndefined()
  return { api, plugin }
}

function uploadParams(app: AppFile) {
  return {
    remote: 'browserstack-devices',
    settings: {},
    platform: 'android',
    path: app.path,
    sha256: app.sha256,
    size: app.size,
  }
}

describe('uploading an app to BrowserStack', () => {
  it('reuses the newest upload listed under the content custom id and uploads nothing', async () => {
    const app = await appFile()
    const { api, plugin } = await browserStack({
      recentApps: {
        [app.customId]: [
          {
            app_url: 'bs://older',
            custom_id: app.customId,
            uploaded_at: '2026-11-01 09:00:00 UTC',
          },
          {
            app_url: 'bs://newer',
            custom_id: app.customId,
            uploaded_at: '2026-11-04 09:00:00 UTC',
          },
        ],
      },
    })

    const answer = await plugin.call('uploadApp', uploadParams(app))

    expect(answer.result).toEqual({ ref: 'bs://newer' })
    expect(api.routeCalls(RECENT_APPS_ROUTE).map((request) => request.path)).toEqual([
      `/app-automate/recent_apps/${app.customId}`,
    ])
    expect(api.routeCalls(RECENT_APPS_ROUTE)[0]?.headers.authorization).toBe(BASIC)
    expect(api.uploads()).toEqual([])
  })

  it.each([
    ['an empty list', 'empty-list'],
    ['a no-results message', 'message'],
  ] as const)(
    'uploads the file once with its custom id when recent_apps answers %s',
    async (_, noRecentApps) => {
      const app = await appFile()
      const { api, plugin } = await browserStack({ noRecentApps })

      const answer = await plugin.call('uploadApp', uploadParams(app))

      expect(answer.result).toEqual({ ref: 'bs://uploaded-1' })
      const uploads = api.uploads()
      expect(uploads).toHaveLength(1)
      expect(uploadedField(uploads[0]!, 'custom_id')).toBe(app.customId)
      expect(uploadedField(uploads[0]!, 'file')).toBe('an android build')
      expect(uploads[0]?.headers['content-type']).toMatch(/^multipart\/form-data; boundary=/)
      expect(uploads[0]?.headers.authorization).toBe(BASIC)
    },
  )

  it('uses the first 32 hex digits of the SHA-256 as the custom id', async () => {
    const { api, plugin } = await browserStack()
    const app = await appFile()
    const sha256 = 'ab'.repeat(32)

    await plugin.call('uploadApp', { ...uploadParams(app), sha256 })

    expect(api.routeCalls(RECENT_APPS_ROUTE)[0]?.params.customId).toBe(
      `agent-qa-${'ab'.repeat(16)}`,
    )
    expect(uploadedField(api.uploads()[0]!, 'custom_id')).toBe(`agent-qa-${'ab'.repeat(16)}`)
  })

  it('uploads a second app with the same content no more than once', async () => {
    const app = await appFile()
    const { api, plugin } = await browserStack()

    const first = await plugin.call('uploadApp', uploadParams(app))
    const second = await plugin.call('uploadApp', uploadParams(app))

    expect(first.result).toEqual({ ref: 'bs://uploaded-1' })
    expect(second.result).toEqual({ ref: 'bs://uploaded-1' })
    expect(api.uploads()).toHaveLength(1)
  })

  it('reports the upload as progress: its size, then that it is done', async () => {
    const app = await appFile('a'.repeat(1_572_864))
    const { plugin } = await browserStack()

    const call = plugin.request('uploadApp', uploadParams(app))
    expect((await call.answered).error).toBeUndefined()

    expect(plugin.progress(call.id)).toEqual(['uploading app (1.5 MB)', 'app uploaded'])
  })

  it('stops the upload on cancel, answers -32800 within the grace and posts nothing more', async () => {
    const app = await appFile()
    const { api, plugin } = await browserStack({ routes: { [UPLOAD_ROUTE]: ['hold'] } })

    const call = plugin.request('uploadApp', uploadParams(app))
    await expect.poll(() => api.uploads().length).toBe(1)
    const cancelledAt = Date.now()
    plugin.cancel(call.id)
    const answer = await call.answered
    const waited = Date.now() - cancelledAt

    expect(answer.result).toBeUndefined()
    expect(answer.error?.code).toBe(-32800)
    expect(answer.error?.message).not.toMatch(/did not stop within/)
    expect(waited).toBeLessThan(CANCEL_ANSWER_GRACE_MS)
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(api.uploads()).toHaveLength(1)
  })

  it('answers a 401 with kind auth and never writes the access key', async () => {
    const app = await appFile()
    const { plugin } = await browserStack({
      routes: { [RECENT_APPS_ROUTE]: [{ status: 401, json: { message: 'Unauthorized' } }] },
    })

    const answer = await plugin.call('uploadApp', uploadParams(app))

    expect(answer.error?.data?.kind).toBe('auth')
    expect(answer.error?.message).toContain('401')
    expect(JSON.stringify(answer)).not.toContain(ACCESS_KEY)
    expect(plugin.stderr()).not.toContain(ACCESS_KEY)
  })

  it('answers a 401 on the upload itself with kind auth', async () => {
    const app = await appFile()
    const { plugin } = await browserStack({
      routes: { [UPLOAD_ROUTE]: [{ status: 401, json: { error: 'Invalid credentials' } }] },
    })

    const answer = await plugin.call('uploadApp', uploadParams(app))

    expect(answer.error?.data?.kind).toBe('auth')
    expect(plugin.stderr()).not.toContain(ACCESS_KEY)
  })

  it('refuses a SHA-256 that is not 64 hex digits, at its path', async () => {
    const app = await appFile()
    const { api, plugin } = await browserStack()

    const answer = await plugin.call('uploadApp', { ...uploadParams(app), sha256: 'not-a-hash' })

    expect(answer.error?.data).toMatchObject({ kind: 'refused', path: 'sha256' })
    expect(api.requests).toEqual([])
  })

  it('refuses an app path that cannot be read, at its path, before uploading', async () => {
    const app = await appFile()
    const { api, plugin } = await browserStack()

    const answer = await plugin.call('uploadApp', {
      ...uploadParams(app),
      path: join(app.path, '..', 'missing.apk'),
    })

    expect(answer.error?.data).toMatchObject({ kind: 'refused', path: 'path' })
    expect(api.uploads()).toEqual([])
  })
})
