// The model-invocation counter, published as a durable artifact.
//
// The claim JOBQ-03 rests on is about a process that no longer exists: host one authored, host one
// died, host two must not author again. An in-process spy cannot say anything about that at all —
// its counter lives in the heap of whichever process is asserting, and a parent reading its own
// `vi.fn()` after spawning a child has measured nothing. So the count leaves the process the way
// every other durable fact in this phase does: as bytes on a device.
//
// Each invocation is one appended line, fsync'd on its own file descriptor before `generate`
// answers, with a best-effort parent-directory fsync so the file's own directory entry is durable
// the first time. That ordering is the whole point: a line that reached only the page cache would
// still be readable by the parent on this machine (SIGKILL does not drop the kernel's dirty pages),
// so the fsync is what makes the artifact a durability claim rather than a coincidence.
//
// The answer is a pure function of the request. An authored checkpoint is memoized and replayed, so
// a model whose text varied with the attempt, the clock or a sample would make an interrupted
// history differ from an uninterrupted one for a reason that has nothing to do with recovery — and
// the usual repair for a failing equality assertion is to loosen it.

import { closeSync, fsyncSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import type { JobModelCapability, JobModelOutput, JobModelRequest } from '@vostride/agent-qa-agent'
import type { JobKind } from '@vostride/agent-qa-schema'

import { DIRECTORY_FSYNC_SWALLOWED_CODES } from '../../store/job-checkpoint-store.js'

/** Named so the bytes a checkpoint carries say WHICH model authored them. */
export const KILL_MATRIX_MODEL_ID = 'kill-matrix-counting-model'

export interface JobModelInvocation {
  readonly pid: number
  readonly modelId: string
  readonly prompt: string
}

export interface JobCheckpointConsumption {
  readonly pid: number
  readonly jobId: string
  readonly checkpointId: string
}

function bestEffortFsyncDirectory(dir: string): void {
  let fd: number | undefined
  try {
    fd = openSync(dir, 'r')
    fsyncSync(fd)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    // The allowlist is IMPORTED, not restated. Re-deriving it by hand is exactly how a directory
    // fsync quietly becomes best-effort everywhere.
    if (!DIRECTORY_FSYNC_SWALLOWED_CODES.some((allowed) => allowed === code)) throw error
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/**
 * Append one JSON line and put it on the device before returning.
 *
 * Append rather than temp-then-rename because the artifact accumulates across TWO processes and a
 * rename would publish one writer's view over the other's. A single `write` of a short line is
 * atomic enough for the reader that matters here — the parent only ever reads it while no child is
 * running — and every line is fsync'd, so a torn tail cannot survive the kill either.
 */
export function appendDurableLine(path: string, record: unknown): void {
  const fd = openSync(path, 'a')
  try {
    writeFileSync(fd, `${JSON.stringify(record)}\n`, 'utf8')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  bestEffortFsyncDirectory(dirname(path))
}

/** Every line written so far. An absent file is zero lines, never an error. */
export function readDurableLines<T>(path: string): readonly T[] {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as T)
}

export function readInvocations(path: string): readonly JobModelInvocation[] {
  return readDurableLines<JobModelInvocation>(path)
}

export function readConsumptions(path: string): readonly JobCheckpointConsumption[] {
  return readDurableLines<JobCheckpointConsumption>(path)
}

export function recordConsumption(
  path: string,
  jobId: string,
  checkpointId: string,
): void {
  appendDurableLine(path, { pid: process.pid, jobId, checkpointId })
}

/** The prompt an authoring handler sends, so the artifact says WHICH checkpoint was authored. */
export function authorPromptFor(kind: JobKind, checkpointId: string): string {
  return `${kind}/${checkpointId}`
}

/** The inverse, used by the parent to read a checkpoint id back out of the artifact. */
export function checkpointIdOfPrompt(prompt: string): string {
  const separator = prompt.indexOf('/')
  if (separator < 0) throw new Error(`unusable kill-matrix author prompt: ${prompt}`)
  return prompt.slice(separator + 1)
}

/**
 * A capability that records every invocation before it answers.
 *
 * The recording happens FIRST. A counter incremented after the answer would miss an invocation
 * whose host died mid-generation, which is precisely the invocation an adversarial leg is about.
 */
export function createCountingModel(artifactPath: string): JobModelCapability {
  return {
    modelId: KILL_MATRIX_MODEL_ID,
    generate(request: JobModelRequest): Promise<JobModelOutput> {
      if (request.prompt.trim() === '') {
        throw new Error('the kill-matrix counting model was asked to author from an empty prompt')
      }
      appendDurableLine(artifactPath, {
        pid: process.pid,
        modelId: KILL_MATRIX_MODEL_ID,
        prompt: request.prompt,
      })
      return Promise.resolve({ text: `authored:${request.prompt}` })
    },
  }
}
