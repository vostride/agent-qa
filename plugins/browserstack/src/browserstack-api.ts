import {
  createVendorApi,
  vendorFailureKind,
  type VendorApi,
  type VendorStatusKinds,
} from '@vostride/agent-qa-plugin-kit'
import type { BrowserStackOptions } from './options.js'

// BrowserStack's statuses all read as the kit's defaults; the client and the export share this map.
const BROWSERSTACK_STATUS_KINDS: VendorStatusKinds = {}

export type BrowserStackFailureKind = ReturnType<typeof vendorFailureKind>

export interface BrowserStackApiInput {
  apiUrl: string
  appApiUrl: string
  username: string
  accessKey: string
}

export interface AppSessionMark {
  status: 'passed' | 'failed'
  reason?: string
}

export interface BrowserStackApi {
  appSession(id: string, signal?: AbortSignal): Promise<unknown>
  markAppSession(id: string, mark: AppSessionMark, signal?: AbortSignal): Promise<void>
  runningBuilds(signal?: AbortSignal): Promise<unknown>
  runningBuildSessions(buildId: string, signal?: AbortSignal): Promise<unknown>
  webSession(id: string, signal?: AbortSignal): Promise<unknown>
  markWebSession(id: string, mark: AppSessionMark, signal?: AbortSignal): Promise<void>
  // Both plans answer undefined on 404: that product is not on the account.
  automatePlan(signal?: AbortSignal): Promise<unknown>
  appAutomatePlan(signal?: AbortSignal): Promise<unknown>
  recentApps(customId: string, signal?: AbortSignal): Promise<unknown>
  uploadApp(form: FormData, signal?: AbortSignal): Promise<unknown>
}

export function browserStackFailureKind(status: number | undefined): BrowserStackFailureKind {
  return vendorFailureKind(status, BROWSERSTACK_STATUS_KINDS)
}

export function createBrowserStackApi(input: BrowserStackApiInput): BrowserStackApi {
  const token = Buffer.from(`${input.username}:${input.accessKey}`).toString('base64')
  const client = (baseUrl: string) =>
    createVendorApi({
      vendor: 'BrowserStack',
      baseUrl,
      headers: { accept: 'application/json', authorization: `Basic ${token}` },
      kinds: BROWSERSTACK_STATUS_KINDS,
    })
  const automate = client(input.apiUrl)
  const app = client(input.appApiUrl)

  const readJson = async (api: VendorApi, response: Response, request: string) => {
    if (!response.ok) throw await api.failure(response, request)
    return api.json(response)
  }

  const sessionPath = (id: string) => `app-automate/sessions/${encodeURIComponent(id)}.json`
  const webSessionPath = (id: string) => `automate/sessions/${encodeURIComponent(id)}.json`

  const mark = async (
    api: VendorApi,
    path: string,
    request: string,
    body: AppSessionMark,
    signal?: AbortSignal,
  ) => {
    const response = await api.send('PUT', path, {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })
    if (!response.ok) throw await api.failure(response, request)
    await response.body?.cancel()
  }

  const plan = async (api: VendorApi, path: string, signal?: AbortSignal) => {
    const response = await api.send('GET', path, { signal })
    if (response.status === 404) {
      await response.body?.cancel()
      return undefined
    }
    return readJson(api, response, `GET /${path}`)
  }

  return {
    async appSession(id, signal) {
      const response = await app.send('GET', sessionPath(id), { signal })
      return readJson(app, response, 'GET /app-automate/sessions/{id}.json')
    },

    markAppSession(id, body, signal) {
      const request = 'PUT /app-automate/sessions/{id}.json'
      return mark(app, sessionPath(id), request, body, signal)
    },

    async runningBuilds(signal) {
      const path = 'automate/builds.json?limit=100&status=running'
      const response = await automate.send('GET', path, { signal })
      return readJson(automate, response, 'GET /automate/builds.json')
    },

    async runningBuildSessions(buildId, signal) {
      const build = encodeURIComponent(buildId)
      const path = `automate/builds/${build}/sessions.json?limit=100&status=running`
      const response = await automate.send('GET', path, { signal })
      return readJson(automate, response, 'GET /automate/builds/{id}/sessions.json')
    },

    async webSession(id, signal) {
      const response = await automate.send('GET', webSessionPath(id), { signal })
      return readJson(automate, response, 'GET /automate/sessions/{id}.json')
    },

    markWebSession(id, body, signal) {
      const request = 'PUT /automate/sessions/{id}.json'
      return mark(automate, webSessionPath(id), request, body, signal)
    },

    automatePlan(signal) {
      return plan(automate, 'automate/plan.json', signal)
    },

    appAutomatePlan(signal) {
      return plan(app, 'app-automate/plan.json', signal)
    },

    async recentApps(customId, signal) {
      const path = `app-automate/recent_apps/${encodeURIComponent(customId)}`
      const response = await app.send('GET', path, { signal })
      // An unknown custom id may answer 404 with a message, which means nothing is uploaded yet.
      if (response.status === 404) {
        await response.body?.cancel()
        return undefined
      }
      return readJson(app, response, 'GET /app-automate/recent_apps/{custom_id}')
    },

    async uploadApp(form, signal) {
      const response = await app.send('POST', 'app-automate/upload', { body: form, signal })
      return readJson(app, response, 'POST /app-automate/upload')
    },
  }
}

export function browserStackApiFor(options: BrowserStackOptions): BrowserStackApi {
  return createBrowserStackApi({
    apiUrl: options.apiUrl,
    appApiUrl: options.appApiUrl,
    username: options.username,
    accessKey: options.accessKey,
  })
}
