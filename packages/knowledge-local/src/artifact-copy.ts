// DOM and accessibility snapshots pass through the caller's mask; other artifacts copy verbatim.

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { ArtifactRef, MaskFn } from '@vostride/agent-qa-schema'

export const ARTIFACT_STEP_CAP_BYTES = 2 * 1024 * 1024
export const ARTIFACT_RUN_CAP_BYTES = 25 * 1024 * 1024

export interface ArtifactCopyInput {
  ref: ArtifactRef
  sourcePath: string
  stepIndex: number
  role?: string
  originalName?: string
}

export interface CopiedArtifact {
  ref: ArtifactRef
  relPath: string
  bytes: number
  stepIndex: number
  role?: string
  originalName?: string
}

export type ArtifactCopySkipReason =
  | 'step-cap'
  | 'run-cap'
  | 'pruned-source'
  | 'sha-mismatch'

export interface SkippedArtifact<Reason extends string = ArtifactCopySkipReason> {
  ref: ArtifactRef
  stepIndex: number
  reason: Reason
}

export interface ArtifactCopyResult {
  copied: CopiedArtifact[]
  skipped: SkippedArtifact[]
  evidenceIncomplete: boolean
}

export interface ArtifactCopyOptions {
  /** Pre-copy refusals retained in the same inventory as copy-time refusals. */
  preSkipped?: readonly SkippedArtifact[]
  mask?: MaskFn
}

const ARTIFACT_SHA_RE = /^[0-9a-f]{64}$/
const TEXT_ARTIFACT_ROLES: ReadonlySet<string> = new Set(['dom-snapshot', 'ax-snapshot'])

function byteSha(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function copiedRow(
  input: ArtifactCopyInput,
  ref: ArtifactRef,
  bytes: number,
): CopiedArtifact {
  return {
    ref,
    relPath: `artifacts/${ref.sha}`,
    bytes,
    stepIndex: input.stepIndex,
    ...(input.role === undefined ? {} : { role: input.role }),
    ...(input.originalName === undefined ? {} : { originalName: input.originalName }),
  }
}

function maskTextArtifact(bytes: Buffer, role: string | undefined, mask: MaskFn | undefined): Buffer {
  if (mask === undefined || role === undefined || !TEXT_ARTIFACT_ROLES.has(role)) return bytes
  return Buffer.from(mask(bytes.toString('utf8')))
}

function skippedRow(
  input: ArtifactCopyInput,
  reason: ArtifactCopySkipReason,
): SkippedArtifact<ArtifactCopySkipReason> {
  return { ref: input.ref, stepIndex: input.stepIndex, reason }
}

export function copyArtifacts(
  inputs: readonly ArtifactCopyInput[],
  destArtifactsDir: string,
  options: ArtifactCopyOptions = {},
): ArtifactCopyResult {
  const copied: CopiedArtifact[] = []
  const skipped: SkippedArtifact[] = [...(options.preSkipped ?? [])]
  const copiedBytesByStep = new Map<number, number>()
  let copiedBytesForRun = 0

  mkdirSync(destArtifactsDir, { recursive: true })

  for (const input of inputs) {
    if (!ARTIFACT_SHA_RE.test(input.ref.sha)) {
      skipped.push(skippedRow(input, 'sha-mismatch'))
      continue
    }

    let sourceBytes: Buffer
    try {
      sourceBytes = readFileSync(input.sourcePath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        skipped.push(skippedRow(input, 'pruned-source'))
        continue
      }
      throw error
    }

    if (byteSha(sourceBytes) !== input.ref.sha) {
      skipped.push(skippedRow(input, 'sha-mismatch'))
      continue
    }

    const copyBytes = maskTextArtifact(sourceBytes, input.role, options.mask)
    const copiedRef = copyBytes.equals(sourceBytes)
      ? input.ref
      : { ...input.ref, sha: byteSha(copyBytes) }
    const targetPath = join(destArtifactsDir, copiedRef.sha)
    if (existsSync(targetPath)) {
      const existingBytes = readFileSync(targetPath)
      if (byteSha(existingBytes) !== copiedRef.sha || !existingBytes.equals(copyBytes)) {
        skipped.push(skippedRow(input, 'sha-mismatch'))
        continue
      }
      copied.push(copiedRow(input, copiedRef, copyBytes.byteLength))
      continue
    }

    const stepBytes = copiedBytesByStep.get(input.stepIndex) ?? 0
    if (stepBytes + copyBytes.byteLength > ARTIFACT_STEP_CAP_BYTES) {
      skipped.push(skippedRow(input, 'step-cap'))
      continue
    }
    if (copiedBytesForRun + copyBytes.byteLength > ARTIFACT_RUN_CAP_BYTES) {
      skipped.push(skippedRow(input, 'run-cap'))
      continue
    }

    try {
      writeFileSync(targetPath, copyBytes, { flag: 'wx' })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const existingBytes = readFileSync(targetPath)
      if (byteSha(existingBytes) !== copiedRef.sha || !existingBytes.equals(copyBytes)) {
        skipped.push(skippedRow(input, 'sha-mismatch'))
        continue
      }
      copied.push(copiedRow(input, copiedRef, copyBytes.byteLength))
      continue
    }

    copiedBytesByStep.set(input.stepIndex, stepBytes + copyBytes.byteLength)
    copiedBytesForRun += copyBytes.byteLength
    copied.push(copiedRow(input, copiedRef, copyBytes.byteLength))
  }

  return { copied, skipped, evidenceIncomplete: skipped.length > 0 }
}
