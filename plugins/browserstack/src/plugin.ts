import { definePlugin, PluginError, z } from '@vostride/agent-qa-plugin-kit'
import { checkAccount } from './check.js'
import { deviceAnswer, DeviceHandleSchema, deviceStarted, markAppSession } from './devices.js'
import {
  createTunnelManager,
  unavailableTunnelFactory,
  type TunnelFactory,
  type TunnelManager,
} from './local.js'
import { checkEndpoints, checkLocal, options, settings } from './options.js'
import { uploadApp } from './upload.js'
import { markWebSession, playwrightAnswer, WebHandleSchema, webStarted } from './web.js'

const HandleSchema = z.union([WebHandleSchema, DeviceHandleSchema])

export interface BrowserStackPluginInput {
  tunnelFactory?: TunnelFactory
}

export function createBrowserStackPlugin(input: BrowserStackPluginInput = {}) {
  const tunnelFactory = input.tunnelFactory ?? unavailableTunnelFactory
  let playwrightVersion = 'unknown'
  let tunnel: TunnelManager | undefined
  const appSessions = new Map<string, string>()
  const webSessions = new Map<string, string>()

  return definePlugin({
    options,
    settings,
    serves: ['playwright', 'appium'],
    runFacts: ['testName', 'runId', 'failure'],
    skill: './skill',

    initialize({ options, host }) {
      checkEndpoints(options)
      checkLocal(options)
      playwrightVersion = host.playwrightVersion
      tunnel = createTunnelManager({
        factory: tunnelFactory,
        accessKey: options.accessKey,
        local: options.local,
        localIdentifier: options.localIdentifier,
        localBinary: options.localBinary,
      })
    },

    check({ options }, ctx) {
      return checkAccount({ options, playwrightVersion, signal: ctx.signal })
    },

    async acquire({ options, settings, session, run }, ctx) {
      const localIdentifier = tunnel?.identifier
      const answer =
        session.platform === 'web'
          ? playwrightAnswer({
              options,
              settings,
              engine: session.engine,
              playwrightVersion,
              testName: run?.testName,
              runId: ctx.runFacts?.runId,
              localIdentifier,
            })
          : deviceAnswer({
              options,
              settings,
              platform: session.platform,
              capabilities: session.capabilities,
              testName: run?.testName,
              runId: ctx.runFacts?.runId,
              localIdentifier,
            })
      await tunnel?.ensure(ctx.signal, ctx.progress)
      return answer
    },

    uploadApp({ options, path, sha256, size }, ctx) {
      return uploadApp({ options, path, sha256, size, signal: ctx.signal, progress: ctx.progress })
    },

    async started({ options, handle, sessionId }, ctx) {
      const web = WebHandleSchema.safeParse(handle)
      if (web.success) {
        const { session, link } = await webStarted({
          options,
          handle: web.data,
          signal: ctx.signal,
        })
        if (session !== undefined) webSessions.set(web.data.id, session.hashedId)
        return link === undefined ? {} : { link }
      }
      const device = DeviceHandleSchema.safeParse(handle)
      if (!device.success) return {}
      if (sessionId !== undefined) appSessions.set(device.data.id, sessionId)
      return deviceStarted({ options, handle: device.data, sessionId, signal: ctx.signal })
    },

    async end({ options, handle, outcome, reason }, ctx) {
      const web = WebHandleSchema.safeParse(handle)
      if (web.success) {
        const sessionId = webSessions.get(web.data.id)
        if (sessionId === undefined) return
        await markWebSession({ options, sessionId, outcome, reason, signal: ctx.signal })
        return
      }
      const device = DeviceHandleSchema.safeParse(handle)
      if (!device.success) return
      const sessionId = appSessions.get(device.data.id)
      if (sessionId === undefined) return
      await markAppSession({ options, sessionId, outcome, reason, signal: ctx.signal })
    },

    release({ handle }) {
      const parsed = HandleSchema.safeParse(handle)
      if (!parsed.success) {
        throw new PluginError('A BrowserStack handle names its kind of session.', {
          kind: 'refused',
        })
      }
      if (parsed.data.kind === 'device') appSessions.delete(parsed.data.id)
      else webSessions.delete(parsed.data.id)
    },

    async shutdown() {
      await tunnel?.stop()
    },
  })
}

export default createBrowserStackPlugin()
