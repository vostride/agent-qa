// A transport that keeps what the error reporter sends, and temporary projects to start it over.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ReportTransportFactory } from '../composition/error-reporting.js'

export type RecordedEnvelope = Parameters<ReturnType<ReportTransportFactory>['send']>[0]

export interface RecordingReportTransport {
  readonly transport: ReportTransportFactory
  readonly envelopes: RecordedEnvelope[]
}

// With `hang`, every send and flush stays pending and holds no handle, as on a dead network.
export function recordingReportTransport(
  options: { readonly hang?: boolean } = {},
): RecordingReportTransport {
  const envelopes: RecordedEnvelope[] = []
  const pending = () => new Promise<never>(() => {})
  const transport: ReportTransportFactory = () => ({
    send: (envelope) => {
      envelopes.push(envelope)
      return options.hang === true ? pending() : Promise.resolve({})
    },
    flush: () => (options.hang === true ? pending() : Promise.resolve(true)),
  })
  return { transport, envelopes }
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
