// A transport that keeps what the error reporter sends, and temporary projects to start it over.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ReportTransportFactory } from '../composition/error-reporting.js'

export type RecordedEnvelope = Parameters<ReturnType<ReportTransportFactory>['send']>[0]

export interface RecordingReportTransport {
  readonly transport: ReportTransportFactory
  readonly envelopes: RecordedEnvelope[]
  // Settles every send and flush still pending, so a client on a hanging transport closes at once.
  release(): void
}

// A send is answered 200, as the ingest answers one it took. With `hang`, a send stays pending and
// holds no handle, as on a dead network, and a flush waits while a send is pending; with nothing
// sent, a flush returns at once.
export function recordingReportTransport(
  options: { readonly hang?: boolean } = {},
): RecordingReportTransport {
  const envelopes: RecordedEnvelope[] = []
  const held: Array<() => void> = []
  let sending = 0
  let released = false
  const hold = <T>(value: T): Promise<T> =>
    released
      ? Promise.resolve(value)
      : new Promise<T>((resolve) => {
          held.push(() => resolve(value))
        })
  const transport: ReportTransportFactory = () => ({
    send: (envelope) => {
      envelopes.push(envelope)
      if (options.hang !== true) return Promise.resolve({ statusCode: 200 })
      sending += 1
      return hold({ statusCode: 200 })
    },
    flush: () => (options.hang === true && sending > 0 ? hold(true) : Promise.resolve(true)),
  })
  return {
    transport,
    envelopes,
    release: () => {
      released = true
      for (const settle of held.splice(0)) settle()
    },
  }
}

export function serializedEnvelopes(envelopes: readonly RecordedEnvelope[]): string {
  return JSON.stringify(envelopes)
}

export interface ReportProject {
  readonly dir: string
  readonly configPath: string
  readonly secretsPath: string
}

const projectDirs: string[] = []

// A minimal valid config naming a secrets file, which holds `secrets` one per line.
export function projectWithPrivacy(
  options: {
    readonly privacy?: boolean
    readonly secrets?: Readonly<Record<string, string>>
  } = {},
): ReportProject {
  const dir = mkdtempSync(join(tmpdir(), 'agent-qa-error-reporting-'))
  projectDirs.push(dir)
  const configPath = join(dir, 'agent-qa.config.yaml')
  const secretsPath = join(dir, '.env.secrets.local')
  writeFileSync(
    configPath,
    `${JSON.stringify({
      workspace: {
        testMatch: ['tests/**/*.test.yaml'],
        suiteMatch: ['suites/**/*.suite.yaml'],
        hooksFile: 'hooks.yaml',
        envFile: '.env',
        secretsFile: '.env.secrets.local',
      },
      use: { mobile: { appState: 'reset' } },
      ...(options.privacy === true ? { analytics: { privacy: true } } : {}),
    })}\n`,
    'utf8',
  )
  const lines = Object.entries(options.secrets ?? {}).map(([name, value]) => `${name}=${value}\n`)
  writeFileSync(secretsPath, lines.join(''), 'utf8')
  return { dir, configPath, secretsPath }
}

export function removeReportProjects(): void {
  for (const dir of projectDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
}
