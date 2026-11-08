import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { get as httpsGet } from 'node:https'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  getAgentQaVersionCheckCachePath,
  readCachedAgentQaUpdateStatus,
  refreshAgentQaVersionCheckInBackground,
  type VersionCheckRequest,
} from '@vostride/agent-qa-core'
import { resolveIsCI } from './ci-env.js'
import { VERSION } from './index.js'

export const UPDATE_NOTICE_SHOWN_FILE = 'update-notice.json'

const RELEASES_URL = 'https://github.com/vostride/agent-qa/releases'
const NOTICE_INTERVAL_MS = 24 * 60 * 60 * 1000

export interface UpdateNoticeGate {
  env: NodeJS.ProcessEnv
  stdoutIsTTY: boolean
  stderrIsTTY: boolean
  json: boolean
  logLevel?: string
}

export interface UpdateNoticePrint {
  homeDir: string
  now: number
  currentVersion: string
  write: (text: string) => void
}

export type UpdateNoticeRun = UpdateNoticeGate &
  UpdateNoticePrint & {
    request?: VersionCheckRequest
  }

// The one gate for both the notice and the registry refresh: people at a terminal only.
export function updateNoticeApplies(gate: UpdateNoticeGate): boolean {
  return (
    gate.stdoutIsTTY &&
    gate.stderrIsTTY &&
    !resolveIsCI(gate.env) &&
    gate.json !== true &&
    gate.logLevel !== 'silent'
  )
}

export async function printUpdateNotice(input: UpdateNoticePrint): Promise<void> {
  try {
    const status = await readCachedAgentQaUpdateStatus({
      homeDir: input.homeDir,
      currentVersion: input.currentVersion,
    })
    const latestVersion = status.latestVersion?.trim()
    if (!status.updateAvailable || !latestVersion) return

    const shownPath = updateNoticeShownPath(input.homeDir)
    const shownAt = await readShownAt(shownPath)
    if (shownAt !== undefined && input.now - shownAt < NOTICE_INTERVAL_MS) return

    input.write(
      `agent-qa ${latestVersion} is out; you have ${status.installedVersion}. ` +
        'Update this project: npx agent-qa@latest init\n',
    )
    input.write(`Releases: ${RELEASES_URL}\n`)
    await writeShownAt(shownPath, input.now)
  } catch {
    // The notice is optional and never changes a command's outcome.
  }
}

export async function runUpdateNotice(input: UpdateNoticeRun): Promise<void> {
  if (!updateNoticeApplies(input)) return
  await printUpdateNotice(input)
  await refreshAgentQaVersionCheckInBackground({
    homeDir: input.homeDir,
    now: input.now,
    request: input.request ?? httpsGet,
  })
}

export async function processUpdateNotice(input: {
  json: boolean
  logLevel?: string
}): Promise<void> {
  await runUpdateNotice({
    env: process.env,
    stdoutIsTTY: process.stdout.isTTY === true,
    stderrIsTTY: process.stderr.isTTY === true,
    json: input.json,
    logLevel: input.logLevel,
    homeDir: homedir(),
    now: Date.now(),
    currentVersion: VERSION,
    write: (text) => {
      process.stderr.write(text)
    },
  })
}

function updateNoticeShownPath(homeDir: string): string {
  return join(dirname(getAgentQaVersionCheckCachePath(homeDir)), UPDATE_NOTICE_SHOWN_FILE)
}

async function readShownAt(path: string): Promise<number | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf-8')) as { shownAt?: unknown }
    return typeof parsed.shownAt === 'number' && Number.isFinite(parsed.shownAt)
      ? parsed.shownAt
      : undefined
  } catch {
    return undefined
  }
}

async function writeShownAt(path: string, shownAt: number): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify({ shownAt }), { encoding: 'utf-8', mode: 0o600 })
    await chmod(path, 0o600)
  } catch {
    // Without the record the notice shows again next time; nothing else depends on it.
  }
}
