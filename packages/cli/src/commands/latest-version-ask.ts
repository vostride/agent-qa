import type { LatestAgentQaAnswer } from '@vostride/agent-qa-core'

export const LATEST_VERSION_DEADLINE_MS = 0

export type LatestVersionAsk = (homeDir: string) => Promise<LatestAgentQaAnswer>

export const askLatestVersionByDefault: LatestVersionAsk = async () => ({ source: 'none' })
