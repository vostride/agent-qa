import { registerHooks } from 'node:module'
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'

// Run the actual host source with Node24, resolving its emitted .js names to local .ts.
registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context) }
  catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.startsWith('.') || !specifier.endsWith('.js')) throw error
    return nextResolve(specifier.slice(0, -3) + '.ts', context)
  }
} })
const input = JSON.parse(process.argv[2])
const { createFeedbackPortForHost } = await import('../../feedback-host.ts')
const { applyKnowledgeChange } = await import('@vostride/agent-qa-agent-local')

const ready = () => writeFileSync(input.ready, JSON.stringify({ pid: process.pid }), { flag: 'wx' })
const hang = () => new Promise(() => { setInterval(() => {}, 1000) })

// The host's own callbacks are the crash points. `wording` stops after evidence, before the fix
// is planned; `publication` stops after the real direct writer has committed the fix and before
// the host checkpoints it, so the retry must read the landed change back.
await createFeedbackPortForHost({ configPath: input.configPath, agentQaRoot: input.agentQaRoot,
  randomUuid: randomUUID,
  ...(input.at === 'publication'
    ? { applyKnowledgeChange: async change => { await applyKnowledgeChange(change); ready(); return await hang() } }
    : { word: async () => { ready(); return await hang() } }),
}).mark({ runId: input.runId, kind: 'false-fail' })
