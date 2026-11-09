import { askLatestAgentQaVersion, type LatestAgentQaAnswer } from '@vostride/agent-qa-core'

export const LATEST_VERSION_DEADLINE_MS = 1_500

export type LatestVersionAsk = (homeDir: string, now?: () => Date) => Promise<LatestAgentQaAnswer>

export const askLatestVersionByDefault: LatestVersionAsk = (homeDir, now) =>
  askLatestAgentQaVersion({
    homeDir,
    fetchImpl: globalThis.fetch,
    timeoutMs: LATEST_VERSION_DEADLINE_MS,
    ...(now === undefined ? {} : { now }),
  })
