import { definePlugin, PluginError, z } from '@vostride/agent-qa-plugin-kit'
import { deviceAnswer, DeviceHandleSchema, deviceStarted, markAppSession } from './devices.js'
import { checkEndpoints, options, settings } from './options.js'
import { playwrightAnswer } from './web.js'

const HandleSchema = z.union([z.object({ kind: z.literal('web') }), DeviceHandleSchema])

let playwrightVersion = 'unknown'
const appSessions = new Map<string, string>()

export default definePlugin({
  options,
  settings,
  serves: ['playwright', 'appium'],
  runFacts: ['testName', 'runId', 'failure'],
  skill: './skill',

  initialize({ options, host }) {
    checkEndpoints(options)
    playwrightVersion = host.playwrightVersion
  },

  acquire({ options, settings, session, run }, ctx) {
    if (session.platform === 'web') {
      return playwrightAnswer({
        options,
        settings,
        engine: session.engine,
        playwrightVersion,
        testName: run?.testName,
        runId: ctx.runFacts?.runId,
      })
    }
    return deviceAnswer({
      options,
      settings,
      platform: session.platform,
      capabilities: session.capabilities,
      testName: run?.testName,
      runId: ctx.runFacts?.runId,
    })
  },

  async started({ options, handle, sessionId }, ctx) {
    const device = DeviceHandleSchema.safeParse(handle)
    if (!device.success) return {}
    if (sessionId !== undefined) appSessions.set(device.data.id, sessionId)
    return deviceStarted({ options, handle: device.data, sessionId, signal: ctx.signal })
  },

  async end({ options, handle, outcome, reason }, ctx) {
    const device = DeviceHandleSchema.safeParse(handle)
    if (!device.success) return
    const sessionId = appSessions.get(device.data.id)
    if (sessionId === undefined) return
    await markAppSession({ options, sessionId, outcome, reason, signal: ctx.signal })
  },

  release({ handle }) {
    const parsed = HandleSchema.safeParse(handle)
    if (!parsed.success) {
      throw new PluginError('A BrowserStack handle names its kind of session.', { kind: 'refused' })
    }
    if (parsed.data.kind === 'device') appSessions.delete(parsed.data.id)
  },
})
