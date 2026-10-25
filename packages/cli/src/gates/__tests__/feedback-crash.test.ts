import { spawn } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { createFeedbackPortForHost } from '../feedback-host.js'
import { markFixture, bundles, canonicalKnowledge, projectOutsideStores } from './feedback-fixture.js'

// The child is killed after evidence (`wording`) or after its fix was committed (`publication`).
async function killedAt(at: 'wording' | 'publication') {
  const f = markFixture()
  const ready = join(f.root, 'child-ready.json')
  const child = spawn(process.execPath, ['--experimental-transform-types',
    fileURLToPath(new URL('./fixtures/mark-crash-child.mjs', import.meta.url)),
    JSON.stringify({ configPath: f.configPath, agentQaRoot: f.agentQaRoot, runId: f.handoff.runId, ready, at })],
  { stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', bytes => { output += String(bytes) })
  child.stderr.on('data', bytes => { output += String(bytes) })
  const closed = new Promise<void>(resolve => child.on('close', () => resolve()))
  const kill = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await closed
  }
  const deadline = Date.now() + 15_000
  while (!existsSync(ready) && child.exitCode === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25))
  return { f, ready, output: () => output, kill }
}

it('recovers a killed real host after evidence with exactly one receipt', async () => {
  const run = await killedAt('wording')
  const { f } = run
  try {
    expect(existsSync(run.ready), run.output()).toBe(true)
    const before = projectOutsideStores(f)
    await run.kill()
    const result = await createFeedbackPortForHost(f.deps).mark({ runId: f.handoff.runId, kind: 'false-fail' })
    expect(result).toMatchObject({ kind: 'marked', receipt: { ordinal: 1, evidence: { confirmed: 1 } } })
    expect(projectOutsideStores(f)).toEqual(before)
    expect(readFileSync(join(f.runDir, 'marks.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1)
    expect(await createFeedbackPortForHost(f.deps).mark({ runId: f.handoff.runId, kind: 'false-fail' }))
      .toMatchObject({ kind: 'already-marked' })
  } finally {
    await run.kill()
    rmSync(f.root, { recursive: true, force: true })
  }
}, 30_000)

it('recovers a real host killed after its fix was published, landing the fix exactly once', async () => {
  const run = await killedAt('publication')
  const { f } = run
  try {
    expect(existsSync(run.ready), run.output()).toBe(true)
    await run.kill()
    // The fix is on disk and the receipt is not: nothing was checkpointed after the publication.
    expect(existsSync(join(f.runDir, 'marks.jsonl'))).toBe(false)
    const outside = projectOutsideStores(f)
    const knowledge = canonicalKnowledge(f.knowledgeRoot)
    const published = bundles(f.knowledgeRoot).map(row => row.id)
    expect(published).toHaveLength(2)

    // The retry reads the landed change back through the same operation identity.
    const result = await createFeedbackPortForHost(f.deps).mark({ runId: f.handoff.runId, kind: 'false-fail' })
    expect(result).toMatchObject({ kind: 'marked', receipt: { ordinal: 1, evidence: { confirmed: 1 },
      disposition: { kind: 'applied', fix: 'fact', change: { kind: 'knowledge' } } } })
    if (result.kind !== 'marked' || result.receipt.disposition.kind !== 'applied'
      || result.receipt.disposition.change.kind !== 'knowledge') throw new Error('expected an applied knowledge fix')
    expect(published).toEqual(expect.arrayContaining([...result.receipt.disposition.change.recordIds]))
    expect(projectOutsideStores(f), 'nothing outside the stores is written').toEqual(outside)
    expect(canonicalKnowledge(f.knowledgeRoot), 'the fix was not published twice').toEqual(knowledge)
    expect(bundles(f.knowledgeRoot)).toHaveLength(2)
    expect(readFileSync(join(f.runDir, 'marks.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1)
  } finally {
    await run.kill()
    rmSync(f.root, { recursive: true, force: true })
  }
}, 30_000)
