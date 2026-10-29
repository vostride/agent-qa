import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { slugBranch } from '@vostride/agent-qa-schema'
import { assertWithinKnowledgeRoot } from '../knowledge-containment.js'
import { withCurrentWriterAuthority, type CurrentWriterAuthority } from '../lease/writer-lease.js'
import { stripPolicyHtmlComments } from '../serving/policy-ladder.js'

export class PolicyTextRefusedError extends Error {
  constructor() {
    super('Policy text must not contain HTML comment delimiters or invalid marker identity')
    this.name = 'PolicyTextRefusedError'
  }
}

export function policySectionMarkers(recordId: string): { open: string; close: string } {
  if (!/^[A-Za-z0-9_.:-]+$/.test(recordId)) throw new PolicyTextRefusedError()
  return { open: `<!-- agent-qa:policy ${recordId} -->`, close: `<!-- /agent-qa:policy ${recordId} -->` }
}

export function policyShelfPath(knowledgeRoot: string, scope: string): string {
  return join(knowledgeRoot, 'policies', `${slugBranch(scope)}.md`)
}

export interface MaterializePolicyInput {
  writerAuthority: CurrentWriterAuthority
  knowledgeRoot: string
  recordId: string
  scope: string
  ruleText: string
  title?: string
  /** Recovery validates a previously authored section and must never recreate a missing one. */
  existingOnly?: boolean
}

export type MaterializeOutcome = { kind: 'written' | 'unchanged'; relPath: string; sectionBytes: number }

/**
 * The authored shelf is append-only under the caller's writer lease. An existing section ID
 * always wins, including when its human-edited body differs. Never rewrite that body.
 * The authored text is written as given; no detector scans it.
 */
export function materializePolicy(input: MaterializePolicyInput): MaterializeOutcome {
  return withCurrentWriterAuthority(input.knowledgeRoot, input.writerAuthority, () => materializeUnderAuthority(input))
}

function materializeUnderAuthority(input: MaterializePolicyInput): MaterializeOutcome {
  if ([input.ruleText, input.title ?? '', input.scope].some(text => /<!--|-->/.test(text))) {
    throw new PolicyTextRefusedError()
  }
  const { open, close } = policySectionMarkers(input.recordId)
  const path = policyShelfPath(input.knowledgeRoot, input.scope)
  // a `policies/` linked out of the knowledge root is refused before any write.
  assertWithinKnowledgeRoot(input.knowledgeRoot, dirname(path))
  const relPath = relative(input.knowledgeRoot, path)
  const section = `\n${open}\n${input.title ? `### ${input.title}\n` : ''}${input.ruleText.trim()}\n${close}\n`
  const sectionBytes = Buffer.byteLength(section)
  const exists = existsSync(path)
  const previous = exists ? readFileSync(path) : Buffer.alloc(0)
  const source = previous.toString('utf8')
  // Validate every existing section, including removed/other IDs, before trusting idempotency.
  // The serving parser also rejects nested and incomplete HTML comments.
  try { stripPolicyHtmlComments(source, relPath) } catch { throw new PolicyTextRefusedError() }
  const seen = new Set<string>()
  let pending: string | undefined
  for (const line of source.split(/\r?\n/)) {
    if (!line.includes('agent-qa:policy')) continue
    const marker = /^<!-- (\/?)agent-qa:policy ([A-Za-z0-9_.:-]+) -->$/.exec(line)
    if (marker === null) throw new PolicyTextRefusedError()
    const id = marker[2]!
    if (marker[1] === '') {
      if (pending !== undefined || seen.has(id)) throw new PolicyTextRefusedError()
      pending = id
    } else {
      if (pending !== id) throw new PolicyTextRefusedError()
      pending = undefined
      seen.add(id)
    }
  }
  if (pending !== undefined) throw new PolicyTextRefusedError()
  if (seen.has(input.recordId)) return { kind: 'unchanged', relPath, sectionBytes }
  if (input.existingOnly) throw new PolicyTextRefusedError()
  const text = `${exists ? '' : `# Policies — ${input.scope}\n`}${section}`
  mkdirSync(dirname(path), { recursive: true })
  const staged = `${path}.pending`
  let fd: number | undefined
  try {
    // Serialized by the existing writer transaction; a prior interrupted stage is replaceable.
    fd = openSync(staged, 'w', 0o600)
    writeFileSync(fd, Buffer.concat([previous, Buffer.from(text)]))
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(staged, path)
  } finally {
    if (fd !== undefined) closeSync(fd)
    rmSync(staged, { force: true })
  }
  return { kind: 'written', relPath, sectionBytes }
}
