// The run owns preparation independently of the runner's bounded observation of it.
// Intent is input, never authority: every path and capability comes from the current host.
import { closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync,
  readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { z } from 'zod'
import { canonicalJson, sha256hex } from '@vostride/agent-qa-schema'
import { completedRunHandoffPath, defaultCurationTailOperations } from './curation-tail.js'
import { runSafetyScope } from '@vostride/agent-qa-agent-local'
import type { PostVerdictHandoff, PostVerdictStepOptions } from './post-verdict-step.js'
import { ciResumeClause } from './resume-limit.js'

export const POST_VERDICT_PENDING_FILE = 'post-verdict-pending.json'
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const identitySchema = z.object({ schemaVersion: z.literal(2), runId: z.string().min(1),
  handoffDigest: digest, configDigest: digest }).strict()
type Identity = z.infer<typeof identitySchema>
const ownerSchema = identitySchema.extend({ pid: z.number().int().positive(), token: z.uuid() }).strict()
type Owner = z.infer<typeof ownerSchema>

export class PostVerdictContinuationRefused extends Error {
  readonly category: 'unsafe-path' | 'identity-conflict' | 'intent-invalid' | 'owner-busy' | 'queue-conflict'
  constructor(category: PostVerdictContinuationRefused['category']) {
    super(category)
    this.name = 'PostVerdictContinuationRefused'
    this.category = category
  }
}

export interface PostVerdictContinuationIdentity {
  readonly agentQaRoot: string
  readonly configPath: string
  readonly knowledgeRoot: string
  readonly runId: string
}

export function postVerdictPendingPath(input: Pick<PostVerdictContinuationIdentity, 'agentQaRoot' | 'runId'>): string {
  return join(dirname(completedRunHandoffPath(input.agentQaRoot, input.runId)), POST_VERDICT_PENDING_FILE)
}

function sync(dir: string): void {
  const fd = openSync(dir, 'r')
  try { fsyncSync(fd) } finally { closeSync(fd) }
}

/** No symlink ancestor below the trusted project; regular files only at read boundaries. */
function safePath(path: string, directory = false): void {
  const stat = lstatSync(path)
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) {
    throw new PostVerdictContinuationRefused('unsafe-path')
  }
}

function safeRun(input: PostVerdictContinuationIdentity): string {
  const root = resolve(input.agentQaRoot)
  const handoffPath = completedRunHandoffPath(root, input.runId)
  for (const path of [dirname(root), root, join(root, 'runs'), dirname(handoffPath)]) safePath(path, true)
  // State stores predate this journal; validate their ancestors/files before allowing their IO.
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) { safePath(path, true); walk(path) }
      else safePath(path)
    }
  }
  walk(dirname(handoffPath))
  safePath(handoffPath)
  safePath(input.configPath)
  return handoffPath
}

function identity(input: PostVerdictContinuationIdentity): Identity {
  const path = safeRun(input)
  const handoff = defaultCurationTailOperations().loadCompletedRunHandoff(path)
  if (String(handoff.runId) !== input.runId || handoff.gateRun || handoff.excludedFromOutcomes) {
    throw new PostVerdictContinuationRefused('identity-conflict')
  }
  return { schemaVersion: 2, runId: input.runId,
    handoffDigest: sha256hex(canonicalJson(handoff)),
    configDigest: sha256hex(canonicalJson({ configPath: resolve(input.configPath),
      config: sha256hex(readFileSync(input.configPath, 'utf8')),
      knowledgeRoot: resolve(input.knowledgeRoot) })) }
}

function readIntent(path: string): Identity | undefined {
  try {
    safePath(path)
    return identitySchema.parse(JSON.parse(readFileSync(path, 'utf8')))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    if (error instanceof PostVerdictContinuationRefused) throw error
    throw new PostVerdictContinuationRefused('intent-invalid')
  }
}

function same(a: Identity, b: Identity): boolean { return canonicalJson(a) === canonicalJson(b) }

function publishIntent(path: string, intent: Identity): void {
  const existing = readIntent(path)
  if (existing !== undefined) {
    if (!same(existing, intent)) throw new PostVerdictContinuationRefused('identity-conflict')
    return
  }
  const tmp = `${path}.${randomUUID()}.tmp`
  try {
    const fd = openSync(tmp, 'wx', 0o600)
    try { writeFileSync(fd, `${canonicalJson(intent)}\n`); fsyncSync(fd) } finally { closeSync(fd) }
    try { linkSync(tmp, path) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const raced = readIntent(path)
      if (raced === undefined || !same(raced, intent)) throw new PostVerdictContinuationRefused('identity-conflict')
    }
    sync(dirname(path))
  } finally { rmSync(tmp, { force: true }) }
}

function readOwner(lock: string, intent: Identity): Owner | undefined {
  try {
    safePath(lock, true)
    if (readdirSync(lock).join() !== 'owner.json') return undefined
    safePath(join(lock, 'owner.json'))
    const owner = ownerSchema.parse(JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8')))
    const { pid: _pid, token: _token, ...bound } = owner
    return same(bound, intent) ? owner : undefined
  } catch { return undefined }
}

function positivelyDead(pid: number): boolean {
  try { process.kill(pid, 0); return false }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' }
}

/** Nonblocking candidate/owner protocol. Retained nonempty dead generations fence ABA. */
function claim(lock: string, intent: Identity): { assertOwned(): void; release(): void } {
  const owner: Owner = { ...intent, pid: process.pid, token: randomUUID() }
  const candidate = `${lock}.candidate-${owner.token}`
  mkdirSync(candidate)
  let acquired = false
  try {
    const fd = openSync(join(candidate, 'owner.json'), 'wx', 0o600)
    try { writeFileSync(fd, `${canonicalJson(owner)}\n`); fsyncSync(fd) } finally { closeSync(fd) }
    sync(candidate)
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try { mkdirSync(lock) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        const current = readOwner(lock, intent)
        if (current === undefined || !positivelyDead(current.pid)) throw new PostVerdictContinuationRefused('owner-busy')
        try { renameSync(lock, `${lock}.dead-${current.token}`); sync(dirname(lock)); continue }
        catch { throw new PostVerdictContinuationRefused('owner-busy') }
      }
      renameSync(join(candidate, 'owner.json'), join(lock, 'owner.json'))
      sync(lock)
      sync(dirname(lock))
      acquired = true
      break
    }
    if (!acquired) throw new PostVerdictContinuationRefused('owner-busy')
  } finally { rmSync(candidate, { recursive: true, force: true }) }
  const assertOwned = () => {
    if (readOwner(lock, intent)?.token !== owner.token) throw new PostVerdictContinuationRefused('owner-busy')
  }
  return { assertOwned, release: () => {
    assertOwned()
    const released = `${lock}.released-${owner.token}`
    renameSync(lock, released)
    sync(dirname(lock))
    rmSync(released, { recursive: true })
    sync(dirname(lock))
  } }
}

const running = new Map<string, { intent: Identity; completion: Promise<'enqueued' | 'deduped'> }>()

export function ownPostVerdictContinuation(input: PostVerdictContinuationIdentity & {
  readonly queued: () => Promise<boolean>
  readonly enqueue: () => Promise<'enqueued' | 'deduped'>
}): Promise<'enqueued' | 'deduped'> {
  const path = postVerdictPendingPath(input)
  const intent = identity(input)
  const active = running.get(path)
  if (active !== undefined) {
    if (!same(active.intent, intent)) throw new PostVerdictContinuationRefused('identity-conflict')
    return active.completion
  }
  const existing = readIntent(path)
  if (existing !== undefined && !same(identity(input), existing)) throw new PostVerdictContinuationRefused('identity-conflict')
  const owner = claim(`${path}.owner`, intent)
  const completion = (async () => {
    try {
      owner.assertOwned()
      const published = identity(input)
      if (!same(published, intent)) throw new PostVerdictContinuationRefused('identity-conflict')
      publishIntent(path, published)
      owner.assertOwned()
      let result: 'enqueued' | 'deduped' = 'deduped'
      if (!await input.queued()) {
        owner.assertOwned()
        // Revalidate paths and source/config before publishing a job.
        if (!same(identity(input), published)) throw new PostVerdictContinuationRefused('identity-conflict')
        result = await input.enqueue()
        if (!await input.queued()) throw new PostVerdictContinuationRefused('queue-conflict')
      }
      owner.assertOwned()
      if (!same(identity(input), published)) throw new PostVerdictContinuationRefused('identity-conflict')
      const current = readIntent(path)
      if (current === undefined || !same(current, published)) throw new PostVerdictContinuationRefused('identity-conflict')
      rmSync(path)
      sync(dirname(path))
      return result
    } finally { owner.release() }
  })().finally(() => { running.delete(path) })
  running.set(path, { intent, completion })
  return completion
}

/** Deadline expiry observes the work; it never cancels or releases the producer. */
export async function waitForPostVerdictContinuation(
  completion: Promise<unknown> | undefined, deadlineMs: number, signal?: AbortSignal,
): Promise<boolean> {
  if (completion === undefined) return true
  if (signal?.aborted || Date.now() >= deadlineMs) return false
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  try {
    return await Promise.race([
      completion.then(() => true, () => true),
      new Promise<boolean>((done) => {
        timer = setTimeout(() => done(false), Math.max(0, deadlineMs - Date.now()))
        onAbort = () => done(false)
        signal?.addEventListener('abort', onAbort, { once: true })
        if (signal?.aborted) done(false)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort)
  }
}

export interface RecoverPendingPostVerdictOptions {
  readonly agentQaRoot: string
  readonly configPath: string
  readonly knowledgeRoot: string
  readonly deadlineMs: number
  readonly signal?: AbortSignal
  readonly log: { warn(message: string): void }
  readonly onEnqueued?: () => void
  /** 444 D-48: the recovering process's context, so a retry line never promises a CI resume. */
  readonly executionContext?: PostVerdictStepOptions['executionContext']
}

export interface PendingPostVerdictRecovery {
  readonly runId: string
  readonly pending: boolean
  readonly enqueued: boolean
  readonly detail?: string
}

/** Existing terminal/daemon drain cycles discover only recorded intents, in run order. */
export async function recoverPendingPostVerdictContinuations(input: RecoverPendingPostVerdictOptions): Promise<readonly PendingPostVerdictRecovery[]> {
  const results: PendingPostVerdictRecovery[] = []
  const runs = join(input.agentQaRoot, 'runs')
  let names: string[]
  try { safePath(input.agentQaRoot, true); safePath(runs, true); names = readdirSync(runs).sort() }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') input.log.warn('Post-verdict recovery refused: unsafe or unreadable run root.')
    return results
  }
  for (const name of names) {
    if (Date.now() >= input.deadlineMs || input.signal?.aborted) break
    const path = join(runs, name, POST_VERDICT_PENDING_FILE)
    let runId = name
    try {
      // A foreign/symlink directory is never followed, even for the initial intent read.
      safePath(join(runs, name), true)
      const intent = readIntent(path)
      if (intent === undefined) continue
      runId = intent.runId
      const bound = { ...input, runId }
      if (postVerdictPendingPath(bound) !== path || !same(identity(bound), intent)) {
        throw new PostVerdictContinuationRefused('identity-conflict')
      }
      // Live owners (including our own) have their own safety scope. Do not borrow or replay it.
      const active = running.get(path)
      const lock = `${path}.owner`
      let ownerPresent = false
      try { lstatSync(lock); ownerPresent = true } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      const owner = ownerPresent ? readOwner(lock, identity(bound)) : undefined
      if (active !== undefined || (ownerPresent && (owner === undefined || !positivelyDead(owner.pid)))) {
        results.push({ runId, pending: true, enqueued: false, detail: 'owner-busy' })
        input.log.warn(`Run ${runId}: preparation pending; owner busy or uncertain. Analysis is not yet queued. Intent: ${path}.`)
        continue
      }
      let handoff: PostVerdictHandoff | undefined
      // The operation runs to its end even if the caller's deadline expires.
      const completion = (async () => {
        const { resolveEvalSession } = await import('../eval-session-composition.js')
        // A config or secrets file the eval session cannot read refuses before any producer starts.
        await resolveEvalSession({ configPath: input.configPath })
        // Expired discovery must not start a new producer after its caller returned.
        if (Date.now() >= input.deadlineMs || input.signal?.aborted) return
        const { createPostVerdictStep } = await import('./post-verdict-step.js')
        const step = createPostVerdictStep({ ...bound, detach: true })
        handoff = step.handoff
        await runSafetyScope({ executionContext: 'local-headless' },
          async () => await step.port.run({} as Parameters<typeof step.port.run>[0]))
      })()
      const settled = await waitForPostVerdictContinuation(completion, input.deadlineMs, input.signal)
      const disclose = () => {
        if (handoff?.enqueueState === 'enqueued' || handoff?.enqueueState === 'deduped') input.onEnqueued?.()
        if (handoff?.enqueueState === 'failed' || handoff?.enqueueState === 'unbound') {
          const resumeClause = ciResumeClause(input.executionContext, 'any-host')
          input.log.warn(`Run ${runId}: preparation/enqueue failed or was refused (${handoff.failureDetail ?? 'recovery-error'}). Intent: ${path}; `
            + (resumeClause !== undefined ? `it ${resumeClause}.` : 'the next local run or daemon drain retries eligible pending work.'))
        }
      }
      if (settled) { await completion; disclose() }
      else void completion.then(disclose, () => input.log.warn(`Run ${runId}: preparation/enqueue failed (recovery-error). Intent retained at ${path}.`))
      const enqueued = handoff?.enqueueState === 'enqueued' || handoff?.enqueueState === 'deduped'
      results.push({ runId, pending: !enqueued, enqueued,
        ...(handoff?.failureDetail === undefined ? {} : { detail: handoff.failureDetail }) })
    } catch (error) {
      const detail = error instanceof PostVerdictContinuationRefused ? error.category : 'recovery-error'
      results.push({ runId, pending: true, enqueued: false, detail })
      input.log.warn(`Post-verdict preparation recovery refused (${detail}); intent retained at ${path}.`)
    }
  }
  return results
}
