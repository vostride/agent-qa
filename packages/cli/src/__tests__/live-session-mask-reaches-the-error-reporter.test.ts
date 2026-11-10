// A live-editor session hands the dashboard its redactor, which learns what a remote plugin answers
// once the session has opened, and the dashboard command binds it on the error reporter.

import { randomBytes } from 'node:crypto'
import { join } from 'node:path'

import { pluginMaskName, RunSecretRedactor, SecretStore } from '@vostride/agent-qa-runner'
import { afterEach, describe, expect, it } from 'vitest'

import { bindLiveSessionMask } from '../commands/dashboard.js'
import {
  closeErrorReporting,
  errorReporter,
  settleReporting,
  startErrorReporting,
} from '../composition/error-reporting.js'
import type { ErrorReporter } from '../composition/error-reporting.js'
import {
  projectWithPrivacy,
  recordingReportTransport,
  removeReportProjects,
  serializedEnvelopes,
} from './error-report-recorder.js'
import type { RecordedEnvelope, RecordingReportTransport } from './error-report-recorder.js'

const INVENTED_DSN = 'http://key@127.0.0.1:9/1'
const ENTRY = 'farm'

afterEach(async () => {
  await closeErrorReporting()
  removeReportProjects()
})

async function startReporting(recorder: RecordingReportTransport): Promise<ErrorReporter> {
  const project = projectWithPrivacy()
  const reporter = await startErrorReporting({
    configPath: project.configPath,
    dsn: INVENTED_DSN,
    transport: recorder.transport,
    // Names no file, so no cell reads the auth store in the real home folder.
    authPath: join(project.dir, 'auth.json'),
  })
  if (reporter === undefined) throw new Error('reporting did not start over the project')
  return reporter
}

// Built at runtime: a report quotes the source lines around each stack frame, so a value spelled
// out in this file would reach the report from here.
function pluginAnswer(): { readonly url: string; readonly token: string } {
  const token = [ENTRY, 'token', randomBytes(6).toString('hex')].join('-')
  return { url: `wss://${ENTRY}.invalid/playwright?token=${token}`, token }
}

type EnvelopeItems = Array<[unknown, Array<[{ readonly type?: string }, unknown]>]>

interface ReportedError {
  readonly exception?: { readonly values?: ReadonlyArray<{ readonly value?: string }> }
}

// Each error report's messages, the cause first, read back from the JSON an envelope leaves as.
function reportedMessages(envelopes: readonly RecordedEnvelope[]): string[] {
  return (JSON.parse(serializedEnvelopes(envelopes)) as EnvelopeItems)
    .flatMap(([, items]) => items)
    .filter(([header]) => header.type === 'event')
    .map(([, payload]) =>
      ((payload as ReportedError).exception?.values ?? []).map((value) => value.value).join('\n'),
    )
}

// Replaces one marker word and counts the texts it was handed, so a cell reads which masks an
// envelope passed.
function markerMask(word: string): { readonly apply: (text: string) => string; calls: number } {
  const mask = {
    calls: 0,
    apply: (text: string) => {
      mask.calls += 1
      return text.replaceAll(word, `[${word} masked]`)
    },
  }
  return mask
}

describe('the mask a live-editor session hands the dashboard', () => {
  it('binds nothing with reporting off, and neither the binder nor the end it returns throws', () => {
    const mask = markerMask('alpha')

    const end = bindLiveSessionMask(mask.apply)

    expect(typeof end).toBe('function')
    expect(() => end()).not.toThrow()
    expect(mask.calls).toBe(0)
    expect(errorReporter()).toBeUndefined()
  })

  it('applies two bindings made through it to a report, and ending one leaves the other applied', async () => {
    const recorder = recordingReportTransport()
    const reporter = await startReporting(recorder)
    const alpha = markerMask('alpha')
    const beta = markerMask('beta')
    const reported = async (message: string): Promise<string[]> => {
      const before = recorder.envelopes.length
      reporter.capture(new Error(message))
      await settleReporting()
      return reportedMessages(recorder.envelopes.slice(before))
    }

    const endAlpha = bindLiveSessionMask(alpha.apply)
    const endBeta = bindLiveSessionMask(beta.apply)
    expect(await reported('alpha beta one')).toEqual(['[alpha masked] [beta masked] one'])

    endBeta()
    const alphaCalls = alpha.calls
    expect(await reported('alpha beta two')).toEqual(['[alpha masked] [beta masked] two'])
    expect(alpha.calls, 'the binding still open').toBeGreaterThan(alphaCalls)

    // The reporter keeps the binding that ended last, so ending alpha lets beta go.
    endAlpha()
    const betaCalls = beta.calls
    expect(await reported('alpha beta three')).toEqual(['[alpha masked] beta three'])
    expect(beta.calls, 'a binding that ended before the last one').toBe(betaCalls)
  })

  it('keeps a connection URL a plugin answered out of a report made while the session is bound and of one made just after it ended', async () => {
    const recorder = recordingReportTransport()
    const reporter = await startReporting(recorder)
    const redactor = new RunSecretRedactor(new SecretStore([]))
    const end = bindLiveSessionMask((text) => redactor.redactString(text))
    // The acquire answer arrives once the session has opened, and its mask values join the
    // session's redactor then.
    const { url, token } = pluginAnswer()
    redactor.addMaskExtras([
      [pluginMaskName(ENTRY), url],
      [pluginMaskName(ENTRY), token],
    ])

    reporter.capture(
      new Error(`the session at ${url} closed`, { cause: new Error(`no answer came from ${url}`) }),
    )
    end()
    reporter.capture(new Error(`the next session reused ${url}`))
    await settleReporting()

    const masked = `[secret:${pluginMaskName(ENTRY)}]`
    expect(reportedMessages(recorder.envelopes).sort()).toEqual([
      `no answer came from ${masked}\nthe session at ${masked} closed`,
      `the next session reused ${masked}`,
    ])
    const sent = serializedEnvelopes(recorder.envelopes)
    for (const value of [url, token]) {
      expect(sent.includes(value), 'an envelope holds what the plugin answered').toBe(false)
      const inJson = JSON.stringify(value).slice(1, -1)
      expect(sent.includes(inJson), 'an envelope holds it as a JSON string reads').toBe(false)
    }
  })
})
