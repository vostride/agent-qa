import {
  agentQaBreakingSteps,
  compareSemverVersions,
  validSemverVersion,
  type AgentQaBreakingStep,
} from '@vostride/agent-qa-core'
import { RELEASES_URL } from '../version-notice.js'

export const MIGRATE_GUIDE_BASE = 'https://vostride.com/docs/agent-qa/migrate/'

export interface VersionMove {
  from: string
  to: string
  breaking: boolean
  links: string[]
}

export function migrateGuideUrl(step: AgentQaBreakingStep): string {
  return `${MIGRATE_GUIDE_BASE}v${step.from}-to-v${step.to}`
}

export function releaseNotesUrl(version: string): string | undefined {
  const valid = validSemverVersion(version)
  return valid === undefined ? undefined : `${RELEASES_URL}/tag/v${valid}`
}

export function versionMove(from: string, to: string): VersionMove | undefined {
  const fromVersion = validSemverVersion(from)
  const toVersion = validSemverVersion(to)
  if (fromVersion === undefined || toVersion === undefined) return undefined
  if (compareSemverVersions(toVersion, fromVersion) !== 1) return undefined
  const steps = agentQaBreakingSteps(fromVersion, toVersion)
  if (steps.length > 0) {
    return { from: fromVersion, to: toVersion, breaking: true, links: steps.map(migrateGuideUrl) }
  }
  const notes = releaseNotesUrl(toVersion)
  return { from: fromVersion, to: toVersion, breaking: false, links: notes ? [notes] : [] }
}

export function guideLines(move: VersionMove): string[] {
  if (!move.breaking) return []
  return [
    `agent-qa ${move.to} can change your config. To upgrade, point your coding agent at`,
    ...move.links,
  ]
}
