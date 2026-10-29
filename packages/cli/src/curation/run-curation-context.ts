import { randomUUID } from 'node:crypto'
import {
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

import type { MaskFn } from '@vostride/agent-qa-schema'
import { z } from 'zod'

import {
  createDeclaredSecretMask,
  DeclaredSecretsUnavailableError,
} from '../composition/declared-secrets.js'
import { resolveConfig, resolveConfiguredKnowledgeRoot } from '../config.js'
import { completedRunDir } from './curation-tail.js'

export const RUN_CONFIG_RECORD_FILE = 'run-config.json'

const RUN_CONFIG_RECORD_SCHEMA_VERSION = 2

const runConfigRecordSchema = z
  .object({
    schemaVersion: z.literal(RUN_CONFIG_RECORD_SCHEMA_VERSION),
    runId: z.string().min(1),
    configPath: z.string().min(1),
  })
  .strict()

export type RunConfigRecord = z.infer<typeof runConfigRecordSchema>

export type RunCurationContext =
  { readonly mask: MaskFn; readonly knowledgeRoot: string } | { readonly handBack: string }

export class RunConfigRecordConflict extends Error {
  constructor(runId: string) {
    super(`Run ${runId} already records a different config.`)
    this.name = 'RunConfigRecordConflict'
  }
}

export function runConfigRecordPath(agentQaRoot: string, runId: string): string {
  return join(completedRunDir(agentQaRoot, runId), RUN_CONFIG_RECORD_FILE)
}

// A record that is absent, a symlink, not a file or not this run's is treated as absent.
export function readRunConfigRecord(
  agentQaRoot: string,
  runId: string,
): RunConfigRecord | undefined {
  const path = runConfigRecordPath(agentQaRoot, runId)
  try {
    if (!lstatSync(path).isFile()) return undefined
    const parsed = runConfigRecordSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')))
    if (!parsed.success) return undefined
    if (parsed.data.runId !== runId || !isAbsolute(parsed.data.configPath)) return undefined
    return parsed.data
  } catch {
    return undefined
  }
}

function syncDirectory(dir: string): void {
  const fd = openSync(dir, 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

// The same temp-and-link write as post-verdict-continuation.ts, so a reader never sees a partial
// record and an existing record is never replaced.
export function writeRunConfigRecord(agentQaRoot: string, runId: string, configPath: string): void {
  const path = runConfigRecordPath(agentQaRoot, runId)
  const record: RunConfigRecord = {
    schemaVersion: RUN_CONFIG_RECORD_SCHEMA_VERSION,
    runId,
    configPath: resolve(configPath),
  }
  const tmp = `${path}.${randomUUID()}.tmp`
  try {
    const fd = openSync(tmp, 'wx', 0o600)
    try {
      writeFileSync(fd, `${JSON.stringify(record)}\n`)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    try {
      linkSync(tmp, path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (readRunConfigRecord(agentQaRoot, runId)?.configPath !== record.configPath) {
        throw new RunConfigRecordConflict(runId)
      }
    }
    syncDirectory(dirname(path))
  } finally {
    rmSync(tmp, { force: true })
  }
}

// another run is curated only under its own config, read as it
// stands now, and only into the drainer's root (the drainer holds no other root's writer lease).
export async function resolveRunCurationContext(input: {
  readonly agentQaRoot: string
  readonly runId: string
  readonly drainerKnowledgeRoot: string
}): Promise<RunCurationContext> {
  const { runId } = input
  const record = readRunConfigRecord(input.agentQaRoot, runId)
  if (record === undefined) {
    return {
      handBack:
        `Run ${runId} has no config record (it ran before agent-qa recorded one), ` +
        'so no other run curates it.',
    }
  }
  const { configPath } = record
  let mask: MaskFn
  try {
    const declared = createDeclaredSecretMask(configPath)
    declared.redactor()
    mask = declared.mask
  } catch (error) {
    return {
      handBack:
        error instanceof DeclaredSecretsUnavailableError
          ? `Run ${runId} was recorded under ${configPath}, whose secrets file cannot be read, ` +
            'so it is left for a run that can mask it.'
          : `Run ${runId} was recorded under ${configPath}, which cannot be read, ` +
            'so it is left for a run that can mask it.',
    }
  }
  let knowledgeRoot: string
  try {
    const config = await resolveConfig({ configPath, loadAuthPlugins: false })
    knowledgeRoot = resolveConfiguredKnowledgeRoot(config, dirname(configPath))
  } catch {
    return {
      handBack:
        `Run ${runId} was recorded under ${configPath}, which cannot be read as an agent-qa ` +
        'config, so it is left for a run that can read it.',
    }
  }
  if (resolve(knowledgeRoot) !== resolve(input.drainerKnowledgeRoot)) {
    return {
      handBack:
        `Run ${runId} keeps its knowledge in ${knowledgeRoot}; ` +
        'it is left for a run of its own project.',
    }
  }
  return { mask, knowledgeRoot }
}
