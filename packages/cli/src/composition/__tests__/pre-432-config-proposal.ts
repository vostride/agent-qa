// a config proposal as the pre-432 pipeline filed it, written to disk.
//
// The six config operations now write in the call and file nothing. Proposal records written
// before that still sit in `.agent-qa/proposals/`.
//
// RE-SPELLED 2026-10-01: the store, the payload schema and every verb that read
// such a record are deleted, so nothing can produce one and nothing reads one. The suites that keep
// a claim about a pre-432 record — that it is refused as an unknown function's input and left exactly
// as it was — plant it here as the bytes the old pipeline wrote, in the temp workspace they own.

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { ConfigStructuredValue } from '@vostride/agent-qa-agent'
import {
  base64Encode,
  renderConfigDiff,
  utf8Decode,
} from '@vostride/agent-qa-schema'
import type {
  ConfigChangeFile,
  ConfigDiffFileInput,
  CrossBoundaryReason,
} from '@vostride/agent-qa-schema'

import { createConfigFilesPort } from '../local-agent-host.js'

/** The pre-432 applyable payload's shape, spelled here now that its schema is deleted. */
export interface Pre432ConfigPayload {
  readonly schemaVersion: 1
  readonly payloadKind: 'applyable'
  readonly action: string
  readonly summaryLine: string
  readonly files: readonly ConfigChangeFile[]
  readonly shownDiffBase64: string
  readonly shownDiffDigest: string
  readonly crossBoundary: boolean
  readonly crossBoundaryReasons: readonly CrossBoundaryReason[]
}

export interface Pre432ConfigProposal {
  readonly proposalId: string
  readonly payload: Pre432ConfigPayload
  readonly shownDiff: string
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index])
}

/**
 * File a pre-432 `config.field.set`-style proposal over the config as it stands now.
 *
 * `edits` are applied to the config file through the shipped yaml port; `files` replace whole set
 * members (a hooks file, a `.gitignore`). `crossBoundaryReasons` is what the old classifier
 * recorded on the record — a historical fact the apply path still reads.
 */
export async function filePre432ConfigProposal(input: {
  readonly configPath: string
  readonly agentQaRoot: string
  readonly action?: string
  readonly edits?: readonly { readonly path: string; readonly value: ConfigStructuredValue }[]
  readonly files?: readonly { readonly path: string; readonly bytes: Uint8Array }[]
  readonly summaryLine?: string
  readonly crossBoundaryReasons?: readonly CrossBoundaryReason[]
  readonly surface?: string
  readonly now?: () => number
}): Promise<Pre432ConfigProposal> {
  const port = createConfigFilesPort(input.configPath)
  const set = await port.read()
  const config = set.files.find((file) => file.path === set.configFile)

  const written = new Map<string, Uint8Array>()
  let bytes = config?.bytes
  for (const edit of input.edits ?? []) {
    bytes = (await port.setField({
      ...(bytes === undefined ? {} : { bytes }),
      path: edit.path,
      value: edit.value,
    })).bytes
  }
  if (bytes !== undefined && config !== undefined && (input.edits ?? []).length > 0) {
    written.set(config.path, bytes)
  }
  for (const file of input.files ?? []) written.set(file.path, file.bytes)

  const committed = new Map(set.files.map((file) => [file.path, file.bytes]))
  const diffInput: ConfigDiffFileInput[] = []
  for (const [path, next] of written) {
    const before = committed.get(path)
    if (before !== undefined && sameBytes(before, next)) continue
    diffInput.push({ path, ...(before === undefined ? {} : { oldBytes: before }), newBytes: next })
  }
  const rendered = renderConfigDiff(diffInput)
  if (rendered.outcome !== 'changed') throw new Error('the pre-432 proposal fixture changes nothing')

  const digests = new Map(rendered.perFileDigests.map((digest) => [digest.path, digest]))
  const action = input.action ?? 'config.field.set'
  const firstEdit = input.edits?.[0]
  const reasons = [...(input.crossBoundaryReasons ?? [])]
  const payload: Pre432ConfigPayload = {
    schemaVersion: 1,
    payloadKind: 'applyable',
    action,
    summaryLine: input.summaryLine
      ?? (firstEdit === undefined ? `${action} change` : `set ${firstEdit.path} to ${String(firstEdit.value)}`),
    files: rendered.changes.map((change) => {
      const oldDigest = digests.get(change.path)?.oldDigest
      return {
        path: change.path,
        changeKind: change.changeKind,
        ...(oldDigest === undefined ? {} : { baseDigest: oldDigest }),
        newContentBase64: base64Encode(written.get(change.path) as Uint8Array),
      }
    }),
    shownDiffBase64: base64Encode(rendered.diffBytes),
    shownDiffDigest: rendered.diffDigest,
    crossBoundary: reasons.length > 0,
    crossBoundaryReasons: reasons,
  }

  const now = input.now ?? Date.now
  const proposalId = `prop_${now()}-${Math.floor(performance.now())}`
  const record = {
    schemaVersion: 1,
    id: proposalId,
    kind: 'config',
    origin: {
      emittedBy: action,
      at: now(),
      ...(input.surface === undefined ? {} : { surface: input.surface }),
    },
    payload,
  }
  const dir = join(input.agentQaRoot, 'proposals')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${proposalId}.json`), `${JSON.stringify(record, undefined, 2)}\n`, 'utf8')

  return { proposalId, payload, shownDiff: utf8Decode(rendered.diffBytes) }
}
