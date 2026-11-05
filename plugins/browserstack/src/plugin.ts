import { definePlugin, PluginError, z } from '@vostride/agent-qa-plugin-kit'
import { checkEndpoints, options, settings } from './options.js'
import { playwrightAnswer } from './web.js'

const HandleSchema = z.object({ kind: z.literal('web') })

let playwrightVersion = 'unknown'

export default definePlugin({
  options,
  settings,
  serves: ['playwright'],
  runFacts: ['testName', 'runId', 'failure'],
  skill: './skill',

  initialize({ options, host }) {
    checkEndpoints(options)
    playwrightVersion = host.playwrightVersion
  },

  acquire({ options, settings, session, run }, ctx) {
    if (session.platform !== 'web') {
      throw new PluginError(
        `This BrowserStack plugin runs web sessions only, not ${session.platform}.`,
        { kind: 'refused' },
      )
    }
    return playwrightAnswer({
      options,
      settings,
      engine: session.engine,
      playwrightVersion,
      testName: run?.testName,
      runId: ctx.runFacts?.runId,
    })
  },

  release({ handle }) {
    if (!HandleSchema.safeParse(handle).success) {
      throw new PluginError('A BrowserStack handle names its kind of session.', { kind: 'refused' })
    }
  },
})
